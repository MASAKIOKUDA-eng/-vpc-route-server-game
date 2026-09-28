/*
 * VPC Route Server シミュレーションエンジン
 *
 * ブラウザでは window.RouteServerSim として、Node.js では require() で読み込めます。
 * 秒数などの値は学習用に単純化した概算値であり、実際の AWS の挙動・タイマー値とは異なります。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RouteServerSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 障害を検知するまでの時間 (シミュレーション秒)
  const DETECT_SECONDS = { bfd: 1, 'bgp-keepalive': 30 };
  // BGP セッションが確立するまでの時間 (シミュレーション秒)
  const ESTABLISH_SECONDS = 3;
  const TICK = 0.25;

  const TOPOLOGY = {
    vpc: { id: 'vpc-0a1b2c3d4e5f', cidr: '10.0.0.0/16' },
    subnets: {
      'subnet-appl-a': { az: 'a', cidr: '10.0.11.0/24', role: 'appliance', label: 'アプライアンス用サブネット (AZ-a)' },
      'subnet-appl-c': { az: 'c', cidr: '10.0.12.0/24', role: 'appliance', label: 'アプライアンス用サブネット (AZ-c)' },
      'subnet-work-a': { az: 'a', cidr: '10.0.21.0/24', role: 'workload', routeTable: 'rtb-work-a', label: 'ワークロード用サブネット (AZ-a)' },
      'subnet-work-c': { az: 'c', cidr: '10.0.22.0/24', role: 'workload', routeTable: 'rtb-work-c', label: 'ワークロード用サブネット (AZ-c)' },
    },
    routeTables: ['rtb-work-a', 'rtb-work-c'],
    destination: '192.168.100.10',
    prefix: '192.168.100.10/32',
  };

  // ---------- IP ユーティリティ ----------
  function ipToInt(ip) {
    return ip.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
  }
  function parseCidr(cidr) {
    const [ip, len] = cidr.split('/');
    return { base: ipToInt(ip), len: Number(len) };
  }
  function cidrContains(cidr, ip) {
    const { base, len } = parseCidr(cidr);
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return ((ipToInt(ip) & mask) >>> 0) === ((base & mask) >>> 0);
  }
  function isValidCidr(cidr) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr).trim());
    if (!m) return false;
    return m.slice(1, 5).every((o) => Number(o) <= 255) && Number(m[5]) <= 32;
  }

  // ---------- 状態 ----------
  function createState() {
    return {
      time: 0,
      seq: 0,
      routeServer: null,
      endpoints: {},
      propagations: {},
      peers: {},
      appliances: {
        'appl-a': {
          id: 'appl-a', name: 'Firewall-A', az: 'a', subnetId: 'subnet-appl-a', ip: '10.0.11.10',
          eni: 'eni-0aaa1111', asn: 65001, up: true, advertise: true, prefix: TOPOLOGY.prefix, prepend: 0, med: 100,
        },
        'appl-b': {
          id: 'appl-b', name: 'Firewall-B', az: 'c', subnetId: 'subnet-appl-c', ip: '10.0.12.10',
          eni: 'eni-0bbb2222', asn: 65002, up: true, advertise: true, prefix: TOPOLOGY.prefix, prepend: 0, med: 200,
        },
      },
      clients: {
        'client-a': { id: 'client-a', name: 'App-A', subnetId: 'subnet-work-a', ip: '10.0.21.50' },
        'client-c': { id: 'client-c', name: 'App-C', subnetId: 'subnet-work-c', ip: '10.0.22.50' },
      },
      rib: [],
      fib: [],
      persisted: null,
      routeTables: {},
      traffic: {},
      outages: [],
      failovers: [],
      log: [],
    };
  }

  function newId(state, prefix) {
    state.seq += 1;
    const hex = (0x1a2b0000 + state.seq * 0x1f3d).toString(16).padStart(8, '0');
    return `${prefix}-0${hex}`;
  }

  function log(state, level, msg) {
    state.log.push({ t: state.time, level, msg });
    if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
  }

  function fail(msg) {
    return { ok: false, error: msg };
  }

  // ---------- 操作 (AWS API に相当) ----------
  function createRouteServer(state, opts = {}) {
    if (state.routeServer) return fail('Route Server はすでに作成されています。');
    const asn = Number(opts.asn);
    if (!Number.isInteger(asn) || asn < 1 || asn > 4294967294) return fail('Amazon 側 ASN には 1〜4294967294 の整数を指定してください。');
    const persist = !!opts.persist;
    const duration = clampDuration(opts.duration);
    const id = newId(state, 'rs');
    state.routeServer = { id, asn, associated: false, persist, duration };
    const cli = `aws ec2 create-route-server --amazon-side-asn ${asn} --persist-routes ${persist ? 'enable' : 'disable'}` +
      (persist ? ` --persist-routes-duration ${duration}` : '');
    log(state, 'cmd', cli);
    log(state, 'ok', `Route Server ${id} (ASN ${asn}) を作成しました。まだ VPC には関連付けられていません。`);
    return { ok: true, cli, id };
  }

  function clampDuration(d) {
    const n = Math.round(Number(d));
    if (!Number.isFinite(n)) return 1;
    return Math.min(5, Math.max(1, n));
  }

  function modifyPersist(state, persist, duration) {
    const rs = state.routeServer;
    if (!rs) return fail('先に Route Server を作成してください。');
    rs.persist = !!persist;
    rs.duration = clampDuration(duration);
    if (!rs.persist && state.persisted) {
      state.persisted = null;
      log(state, 'warn', '経路の永続化を無効にしたため、保持していた経路を破棄しました。');
    }
    const cli = `aws ec2 modify-route-server --route-server-id ${rs.id} --persist-routes ${rs.persist ? 'enable' : 'disable'}` +
      (rs.persist ? ` --persist-routes-duration ${rs.duration}` : '');
    log(state, 'cmd', cli);
    log(state, 'info', rs.persist
      ? `経路の永続化を有効化しました (復旧後 ${rs.duration} 分待ってから解除)。`
      : '経路の永続化を無効化しました。');
    recompute(state);
    return { ok: true, cli };
  }

  function associateRouteServer(state) {
    const rs = state.routeServer;
    if (!rs) return fail('先に Route Server を作成してください。');
    if (rs.associated) return fail('すでに VPC に関連付けられています。');
    rs.associated = true;
    const cli = `aws ec2 associate-route-server --route-server-id ${rs.id} --vpc-id ${TOPOLOGY.vpc.id}`;
    log(state, 'cmd', cli);
    log(state, 'ok', `Route Server を ${TOPOLOGY.vpc.id} に関連付けました。`);
    return { ok: true, cli };
  }

  function createEndpoint(state, subnetId) {
    const rs = state.routeServer;
    if (!rs) return fail('先に Route Server を作成してください。');
    if (!rs.associated) return fail('エンドポイントを作る前に Route Server を VPC に関連付けてください。');
    const subnet = TOPOLOGY.subnets[subnetId];
    if (!subnet) return fail('サブネットを選択してください。');
    if (Object.values(state.endpoints).some((e) => e.subnetId === subnetId)) {
      return fail('このシミュレーターでは 1 サブネットにつきエンドポイントは 1 つまでです。');
    }
    const id = newId(state, 'rse');
    const base = subnet.cidr.split('.').slice(0, 3).join('.');
    const ip = `${base}.5`;
    state.endpoints[id] = { id, subnetId, az: subnet.az, ip, up: true };
    const cli = `aws ec2 create-route-server-endpoint --route-server-id ${rs.id} --subnet-id ${subnetId}`;
    log(state, 'cmd', cli);
    log(state, 'ok', `エンドポイント ${id} を ${subnetId} (AZ-${subnet.az}) に作成しました。IP: ${ip}`);
    return { ok: true, cli, id };
  }

  function setPropagation(state, rtbId, enabled) {
    const rs = state.routeServer;
    if (!rs) return fail('先に Route Server を作成してください。');
    if (!rs.associated) return fail('伝播を設定する前に Route Server を VPC に関連付けてください。');
    if (!TOPOLOGY.routeTables.includes(rtbId)) return fail('ルートテーブルが見つかりません。');
    const verb = enabled ? 'enable' : 'disable';
    if (!!state.propagations[rtbId] === !!enabled) return fail(`すでに${enabled ? '有効' : '無効'}です。`);
    if (enabled) state.propagations[rtbId] = true;
    else delete state.propagations[rtbId];
    const cli = `aws ec2 ${verb}-route-server-propagation --route-server-id ${rs.id} --route-table-id ${rtbId}`;
    log(state, 'cmd', cli);
    log(state, 'ok', `${rtbId} への経路伝播を${enabled ? '有効' : '無効'}にしました。`);
    recompute(state);
    return { ok: true, cli };
  }

  function createPeer(state, opts = {}) {
    const rs = state.routeServer;
    if (!rs) return fail('先に Route Server を作成してください。');
    const ep = state.endpoints[opts.endpointId];
    if (!ep) return fail('エンドポイントを選択してください。');
    const appl = state.appliances[opts.applianceId];
    if (!appl) return fail('ピア (アプライアンス) を選択してください。');
    const peerAsn = Number(opts.peerAsn);
    if (!Number.isInteger(peerAsn) || peerAsn < 1 || peerAsn > 4294967294) return fail('ピア ASN には 1〜4294967294 の整数を指定してください。');
    const liveness = opts.liveness === 'bfd' ? 'bfd' : 'bgp-keepalive';
    if (Object.values(state.peers).some((p) => p.endpointId === ep.id && p.applianceId === appl.id)) {
      return fail('このエンドポイントとアプライアンスの組み合わせのピアは既に存在します。');
    }
    const id = newId(state, 'rsp');
    state.peers[id] = {
      id, endpointId: ep.id, applianceId: appl.id, peerAsn, liveness,
      state: 'connecting', pendingUpAt: null, pendingDownAt: null, reason: '',
    };
    const cli = `aws ec2 create-route-server-peer --route-server-endpoint-id ${ep.id} --peer-address ${appl.ip} ` +
      `--bgp-options PeerAsn=${peerAsn},PeerLivenessDetection=${liveness}`;
    log(state, 'cmd', cli);
    log(state, 'ok', `ピア ${id} を作成しました (${appl.name} ⇔ ${ep.id}, ${liveness === 'bfd' ? 'BFD' : 'BGP キープアライブ'})。`);
    return { ok: true, cli, id };
  }

  function deletePeer(state, peerId) {
    const peer = state.peers[peerId];
    if (!peer) return fail('ピアが見つかりません。');
    delete state.peers[peerId];
    const cli = `aws ec2 delete-route-server-peer --route-server-peer-id ${peerId}`;
    log(state, 'cmd', cli);
    log(state, 'warn', `ピア ${peerId} を削除しました。このピアから学習した経路は取り消されます。`);
    recompute(state);
    return { ok: true, cli };
  }

  function setAppliance(state, id, patch) {
    const appl = state.appliances[id];
    if (!appl) return fail('アプライアンスが見つかりません。');
    if ('up' in patch && !!patch.up !== appl.up) {
      appl.up = !!patch.up;
      appl.downAt = appl.up ? null : state.time;
      log(state, appl.up ? 'ok' : 'error', appl.up
        ? `${appl.name} が起動しました。BGP セッションの再確立を待ちます。`
        : `${appl.name} が停止しました (クラッシュ)。Route Server はまだ気づいていません…`);
    }
    if ('advertise' in patch && !!patch.advertise !== appl.advertise) {
      appl.advertise = !!patch.advertise;
      log(state, 'info', `${appl.name}: ${appl.prefix} の広告を${appl.advertise ? '開始' : '停止 (WITHDRAW 送信)'}しました。`);
    }
    if ('med' in patch) {
      const med = Math.max(0, Math.min(4294967295, Math.round(Number(patch.med)) || 0));
      if (med !== appl.med) {
        appl.med = med;
        log(state, 'info', `${appl.name}: MED を ${med} に変更して再広告しました。`);
      }
    }
    if ('prepend' in patch) {
      const prepend = Math.max(0, Math.min(5, Math.round(Number(patch.prepend)) || 0));
      if (prepend !== appl.prepend) {
        appl.prepend = prepend;
        log(state, 'info', `${appl.name}: AS_PATH プリペンドを ${prepend} 回に変更して再広告しました。`);
      }
    }
    if ('prefix' in patch && patch.prefix !== appl.prefix) {
      if (!isValidCidr(patch.prefix)) return fail('プレフィックスは 192.168.100.10/32 のような CIDR 形式で指定してください。');
      appl.prefix = patch.prefix.trim();
      log(state, 'info', `${appl.name}: 広告するプレフィックスを ${appl.prefix} に変更しました。`);
    }
    recompute(state);
    return { ok: true };
  }

  function setEndpointUp(state, endpointId, up) {
    const ep = state.endpoints[endpointId];
    if (!ep) return fail('エンドポイントが見つかりません。');
    if (ep.up === !!up) return { ok: true };
    ep.up = !!up;
    log(state, up ? 'ok' : 'error', up
      ? `エンドポイント ${ep.id} (AZ-${ep.az}) が復旧しました。`
      : `エンドポイント ${ep.id} (AZ-${ep.az}) で障害が発生しました (メンテナンス/AZ 障害を想定)。`);
    recompute(state);
    return { ok: true };
  }

  // ---------- 時間の経過 ----------
  function step(state, seconds) {
    let remaining = seconds;
    while (remaining > 1e-9) {
      const dt = Math.min(TICK, remaining);
      const before = Math.floor(state.time + 1e-9);
      state.time = Math.round((state.time + dt) * 1000) / 1000;
      remaining -= dt;
      updatePeers(state);
      recompute(state);
      const after = Math.floor(state.time + 1e-9);
      if (after > before) sendTraffic(state);
    }
  }

  function peerHealthy(state, peer) {
    const rs = state.routeServer;
    const ep = state.endpoints[peer.endpointId];
    const appl = state.appliances[peer.applianceId];
    if (!rs || !rs.associated || !ep || !appl) return { ok: false, reason: '構成不足' };
    if (!ep.up) return { ok: false, reason: 'エンドポイント障害' };
    if (!appl.up) return { ok: false, reason: `${appl.name} 無応答` };
    if (peer.peerAsn !== appl.asn) return { ok: false, reason: `ASN 不一致 (${appl.name} は AS${appl.asn})`, asnMismatch: true };
    return { ok: true };
  }

  function updatePeers(state) {
    for (const peer of Object.values(state.peers)) {
      const h = peerHealthy(state, peer);
      const appl = state.appliances[peer.applianceId];
      if (peer.state === 'established') {
        if (h.ok) {
          peer.pendingDownAt = null;
          continue;
        }
        const ep = state.endpoints[peer.endpointId];
        // エンドポイント側の障害はセッションが即座に切れるものとして扱う
        const delay = ep && !ep.up ? 0 : DETECT_SECONDS[peer.liveness];
        if (peer.pendingDownAt === null) peer.pendingDownAt = state.time + delay - TICK;
        if (state.time >= peer.pendingDownAt) {
          peer.state = 'down';
          peer.reason = h.reason;
          peer.pendingDownAt = null;
          const how = ep && !ep.up ? 'エンドポイント障害によりセッション断'
            : peer.liveness === 'bfd' ? 'BFD が障害を検知' : 'BGP ホールドタイマー満了';
          log(state, 'error', `BGP ダウン: ${appl.name} ⇔ ${peer.endpointId} (${how})。経路を取り消します。`);
        }
      } else {
        peer.pendingDownAt = null;
        if (!h.ok) {
          if (h.asnMismatch && peer.reason !== h.reason) {
            log(state, 'error', `BGP OPEN 失敗: ${peer.id} のピア ASN ${peer.peerAsn} が ${appl.name} の ASN ${appl.asn} と一致しません。ピアを作り直してください。`);
          }
          peer.pendingUpAt = null;
          peer.state = peer.state === 'connecting' && !h.asnMismatch ? 'connecting' : 'down';
          peer.reason = h.reason;
          continue;
        }
        if (peer.pendingUpAt === null) peer.pendingUpAt = state.time + ESTABLISH_SECONDS - TICK;
        peer.state = 'connecting';
        peer.reason = 'セッション確立中';
        if (state.time >= peer.pendingUpAt) {
          peer.state = 'established';
          peer.reason = '';
          peer.pendingUpAt = null;
          log(state, 'ok', `BGP 確立: ${appl.name} (AS${appl.asn}) ⇔ ${peer.endpointId} [${peer.liveness === 'bfd' ? 'BFD' : 'keepalive'}]`);
        }
      }
    }
  }

  // ---------- 経路計算 (RIB → FIB → ルートテーブル) ----------
  function buildRib(state) {
    const rib = [];
    for (const peer of Object.values(state.peers)) {
      if (peer.state !== 'established') continue;
      const appl = state.appliances[peer.applianceId];
      if (!appl.advertise) continue;
      rib.push({
        prefix: appl.prefix,
        peerId: peer.id,
        endpointId: peer.endpointId,
        applianceId: appl.id,
        nextHopIp: appl.ip,
        nextHopEni: appl.eni,
        asPath: Array(1 + appl.prepend).fill(appl.asn),
        med: appl.med,
      });
    }
    return rib;
  }

  // 経路選択: AS_PATH が短い → MED が小さい → ピア IP が小さい
  function compareRoutes(a, b) {
    if (a.asPath.length !== b.asPath.length) return a.asPath.length - b.asPath.length;
    if (a.med !== b.med) return a.med - b.med;
    const ia = ipToInt(a.nextHopIp);
    const ib = ipToInt(b.nextHopIp);
    if (ia !== ib) return ia - ib;
    return a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0;
  }

  function selectBest(rib) {
    const byPrefix = new Map();
    for (const r of rib) {
      const cur = byPrefix.get(r.prefix);
      if (!cur || compareRoutes(r, cur) < 0) byPrefix.set(r.prefix, r);
    }
    return [...byPrefix.values()].map((r) => ({ ...r, persisted: false }));
  }

  function recompute(state) {
    const rs = state.routeServer;
    const prevFib = state.fib;
    state.rib = buildRib(state);
    let fib = selectBest(state.rib);

    // 経路の永続化 (persist routes)
    const peers = Object.values(state.peers);
    const allDown = peers.length > 0 && peers.every((p) => p.state !== 'established');
    if (rs && rs.persist) {
      if (allDown) {
        if (!state.persisted && prevFib.length > 0) {
          state.persisted = { routes: prevFib.map((r) => ({ ...r, persisted: true })), unpersistAt: null };
          log(state, 'warn', `全ての BGP セッションが切断されました。永続化設定により FIB の経路を保持します。`);
        } else if (state.persisted && state.persisted.unpersistAt !== null) {
          state.persisted.unpersistAt = null;
        }
      } else if (state.persisted) {
        if (state.persisted.unpersistAt === null) {
          state.persisted.unpersistAt = state.time + rs.duration * 60;
          log(state, 'info', `BGP セッションが再確立しました。${rs.duration} 分後に保持中の経路を解除します。`);
        } else if (state.time >= state.persisted.unpersistAt) {
          state.persisted = null;
          log(state, 'info', '保持していた経路の永続化を解除しました。');
        }
      }
      if (state.persisted) {
        const live = new Set(fib.map((r) => r.prefix));
        for (const r of state.persisted.routes) if (!live.has(r.prefix)) fib.push(r);
      }
    } else if (state.persisted) {
      state.persisted = null;
    }

    fib.sort((a, b) => (a.prefix < b.prefix ? -1 : 1));
    logFibChanges(state, prevFib, fib);
    state.fib = fib;
    state.routeTables = buildRouteTables(state);
  }

  function logFibChanges(state, prev, next) {
    const pm = new Map(prev.map((r) => [r.prefix, r]));
    const nm = new Map(next.map((r) => [r.prefix, r]));
    for (const [prefix, r] of nm) {
      const old = pm.get(prefix);
      const name = state.appliances[r.applianceId].name;
      if (!old) log(state, 'ok', `FIB: ${prefix} → ${r.nextHopEni} (${name}) を追加。伝播先ルートテーブルに反映します。`);
      else if (old.nextHopEni !== r.nextHopEni) {
        log(state, 'warn', `FIB: ${prefix} のネクストホップを ${r.nextHopEni} (${name}) に切り替えました。`);
        const from = state.appliances[old.applianceId];
        if (!from.up && from.downAt !== null && from.downAt !== undefined) {
          const duration = Math.round((state.time - from.downAt) * 100) / 100;
          state.failovers.push({ prefix, from: from.id, to: r.applianceId, at: state.time, duration });
          log(state, 'ok', `フェイルオーバー完了: ${from.name} 停止から約 ${duration} 秒で ${name} に切り替わりました。`);
        }
      }
    }
    for (const prefix of pm.keys()) {
      if (!nm.has(prefix)) log(state, 'warn', `FIB: ${prefix} を削除しました (有効な経路なし)。`);
    }
  }

  function buildRouteTables(state) {
    const tables = {};
    for (const rtb of TOPOLOGY.routeTables) {
      const routes = [{ dest: TOPOLOGY.vpc.cidr, target: 'local', origin: 'local' }];
      if (state.routeServer && state.routeServer.associated && state.propagations[rtb]) {
        for (const r of state.fib) {
          routes.push({
            dest: r.prefix, target: r.nextHopEni, origin: 'route-server',
            applianceId: r.applianceId, persisted: r.persisted,
          });
        }
      }
      tables[rtb] = { id: rtb, propagated: !!state.propagations[rtb], routes };
    }
    return tables;
  }

  // ---------- データプレーン ----------
  function lookup(state, rtbId, ip) {
    const table = state.routeTables[rtbId] || buildRouteTables(state)[rtbId];
    let best = null;
    for (const r of table.routes) {
      if (!cidrContains(r.dest, ip)) continue;
      if (!best || parseCidr(r.dest).len > parseCidr(best.dest).len) best = r;
    }
    return best;
  }

  function probe(state, clientId) {
    const client = state.clients[clientId];
    const rtbId = TOPOLOGY.subnets[client.subnetId].routeTable;
    const route = lookup(state, rtbId, TOPOLOGY.destination);
    if (!route || route.target === 'local') {
      return { ok: false, rtbId, reason: `${rtbId} に ${TOPOLOGY.destination} 宛の経路がありません` };
    }
    const appl = Object.values(state.appliances).find((a) => a.eni === route.target);
    if (!appl) return { ok: false, rtbId, reason: 'ターゲット ENI が見つかりません' };
    if (!appl.up) {
      return { ok: false, rtbId, via: appl.id, reason: `ブラックホール: ${appl.name} は停止中なのに経路が残っています` };
    }
    return { ok: true, rtbId, via: appl.id, reason: `${appl.name} 経由で到達` };
  }

  function sendTraffic(state) {
    for (const id of Object.keys(state.clients)) {
      const res = probe(state, id);
      const t = state.traffic[id] || (state.traffic[id] = { history: [], sent: 0, okCount: 0, outageStart: null, last: null });
      t.sent += 1;
      if (res.ok) t.okCount += 1;
      t.history.push({ t: state.time, ok: res.ok, via: res.via || null });
      if (t.history.length > 60) t.history.shift();
      const prev = t.last;
      t.last = { ...res, t: state.time };
      if (!res.ok && prev && prev.ok && t.outageStart === null) {
        t.outageStart = state.time;
        t.outageFrom = prev.via;
      }
      if (res.ok && t.outageStart !== null) {
        const outage = { clientId: id, start: t.outageStart, end: state.time, duration: state.time - t.outageStart, fromVia: t.outageFrom, toVia: res.via };
        state.outages.push(outage);
        t.outageStart = null;
        log(state, 'ok', `${state.clients[id].name}: 通信が復旧しました (停止時間 約 ${outage.duration} 秒)。`);
      }
    }
  }

  // ---------- 便利機能 ----------
  function quickSetup(state, opts = {}) {
    const liveness = opts.liveness || 'bfd';
    if (!state.routeServer) createRouteServer(state, { asn: 65000, persist: false, duration: 1 });
    if (!state.routeServer.associated) associateRouteServer(state);
    for (const subnetId of ['subnet-appl-a', 'subnet-appl-c']) {
      if (!Object.values(state.endpoints).some((e) => e.subnetId === subnetId)) createEndpoint(state, subnetId);
    }
    for (const rtb of TOPOLOGY.routeTables) if (!state.propagations[rtb]) setPropagation(state, rtb, true);
    for (const ep of Object.values(state.endpoints)) {
      for (const appl of Object.values(state.appliances)) {
        if (!Object.values(state.peers).some((p) => p.endpointId === ep.id && p.applianceId === appl.id)) {
          createPeer(state, { endpointId: ep.id, applianceId: appl.id, peerAsn: appl.asn, liveness });
        }
      }
    }
    recompute(state);
    return { ok: true };
  }

  return {
    TOPOLOGY, DETECT_SECONDS, ESTABLISH_SECONDS,
    createState, step, recompute,
    createRouteServer, associateRouteServer, createEndpoint, setPropagation,
    createPeer, deletePeer, setAppliance, setEndpointUp, modifyPersist, quickSetup,
    probe, lookup, compareRoutes, selectBest, cidrContains, isValidCidr,
  };
});
