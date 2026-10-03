(function () {
  'use strict';

  const S = window.RouteServerSim;
  const T = S.TOPOLOGY;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = S.createState();
  let speed = 1;
  let paused = false;
  let subTab = 'rt';
  let missionIdx = 0;
  let missionStart = { failovers: 0 };
  let missionDone = false;
  let freeMode = false;

  const form = {
    rsAsn: 65000, rsPersist: false, rsDuration: 1,
    epSubnet: 'subnet-appl-a',
    peerEp: '', peerAppl: 'appl-a', peerAsn: 65001, peerLiveness: 'bgp-keepalive',
    modPersist: false, modDuration: 1,
  };

  // ================= ミッション =================
  const bothClientsOk = (s, via) => ['client-a', 'client-c'].every((id) => {
    const last = s.traffic[id] && s.traffic[id].last;
    return last && last.ok && (!via || last.via === via);
  });
  const fibFor = (s) => s.fib.find((r) => r.prefix === T.prefix);
  const newFailovers = (s) => s.failovers.slice(missionStart.failovers);

  const MISSIONS = [
    {
      title: 'Route Server を作成しよう',
      desc: 'まずは本体を作ります。Route Server は Amazon 側の BGP ASN を持ちます。',
      goal: 'コンソールの「① Route Server」で ASN 65000 を指定して作成する',
      hint: 'ASN はプライベート ASN (64512〜65534 など) を使うのが一般的です。経路の永続化はあとで試すので今はオフのままで OK。',
      check: (s) => !!s.routeServer,
      done: 'Route Server ができました。ただし、まだどの VPC とも結びついていません。',
    },
    {
      title: 'VPC に関連付けよう',
      desc: 'Route Server は VPC に「関連付け (associate)」して初めて、その VPC で使えるようになります。',
      goal: '「① Route Server」の「VPC に関連付け」を実行する',
      hint: 'CLI では aws ec2 associate-route-server です。',
      check: (s) => s.routeServer && s.routeServer.associated,
      done: 'VPC と関連付けられました。次は BGP の「話し相手」を置きます。',
    },
    {
      title: '2 つの AZ にエンドポイントを作ろう',
      desc: 'エンドポイントはサブネット内に作られ、アプライアンスと BGP を話す窓口になります。1 つだけだとその AZ が落ちたときに全部止まってしまいます。',
      goal: 'AZ-a と AZ-c のアプライアンス用サブネットに 1 つずつエンドポイントを作成する',
      hint: '「② エンドポイント」でサブネットを切り替えて 2 回作成します。',
      check: (s) => { const az = new Set(Object.values(s.endpoints).map((e) => e.az)); return az.has('a') && az.has('c'); },
      done: '冗長なエンドポイントが揃いました。図の紫の丸がエンドポイントです。',
    },
    {
      title: 'ルートテーブルへの伝播を有効にしよう',
      desc: 'Route Server が学んだ経路を「どのルートテーブルに書き込むか」を指定します。ワークロード (App-A / App-C) の通信を制御したいので、それぞれのサブネットのルートテーブルを選びます。',
      goal: 'rtb-work-a と rtb-work-c の両方で伝播を有効化する',
      hint: '片方だけにすると、もう片方のサブネットには経路が入りません。試しに片方だけにしてみるのも勉強になります。',
      check: (s) => T.routeTables.every((r) => s.propagations[r]),
      done: '伝播先が決まりました。でもまだ経路は 1 本も届いていません。経路を広告するのはアプライアンスです。',
    },
    {
      title: 'アプライアンスと BGP ピアを張ろう',
      desc: 'Firewall-A (AS65001) と Firewall-B (AS65002) をピアとして登録します。ピアを作るとエンドポイントとの間で BGP セッションが確立し、アプライアンスが 192.168.100.10/32 (サービス用 VIP) を広告し始めます。',
      goal: '両方のアプライアンスについて、BGP セッションを 1 本以上「確立 (Established)」させる',
      hint: 'ピア ASN はアプライアンス側の ASN (A=65001 / B=65002) です。間違えるとセッションが張れません。' +
        '障害検知は今回はあえて「BGP キープアライブ」にしておくと、次のミッションで違いを体感できます。' +
        'おすすめ: 各アプライアンスを「両方のエンドポイント」とピアにする (計 4 本)。',
      check: (s) => Object.keys(s.appliances).every((a) => Object.values(s.peers).some((p) => p.applianceId === a && p.state === 'established')),
      done: 'BGP が確立し、経路がルートテーブルに入りました！「RIB / FIB」タブで、受け取った全経路 (RIB) とベストパス (FIB) を見比べてみましょう。',
    },
    {
      title: '通信が流れることを確認しよう',
      desc: 'App-A / App-C は 1 秒ごとに 192.168.100.10 へ通信しています。ルートテーブルのターゲットは Firewall-A の ENI になっているはずです。なぜ A が選ばれたのでしょう？',
      goal: 'App-A と App-C の両方が Firewall-A 経由で通信できている状態にする',
      hint: 'A も B も同じプレフィックスを広告していますが、MED が小さい (A=100, B=200) Firewall-A がベストパスに選ばれます。',
      check: (s) => bothClientsOk(s, 'appl-a'),
      done: 'パケットは Route Server を通らず、ルートテーブル → Firewall-A の ENI へ直接届いていることに注目！ Route Server は経路を決めるだけの存在です。',
    },
    {
      title: '障害発生！ Firewall-A を停止しよう',
      desc: 'アクティブ側が突然クラッシュしたらどうなるでしょう？「⑤ アプライアンス」で Firewall-A を停止し、時間を進めて観察します。',
      goal: 'Firewall-A を停止し、経路が Firewall-B に切り替わって通信が復旧するのを確認する',
      hint: 'BGP キープアライブだと検知まで約 30 秒かかり、その間はルートテーブルに A への経路が残ったまま＝ブラックホールになります。「+30 秒」や 5x/20x で時間を進めてみましょう。',
      check: (s) => newFailovers(s).some((f) => f.from === 'appl-a') && bothClientsOk(s, 'appl-b'),
      done: '自動でフェイルオーバーしました！ スクリプトを 1 行も書かずに、ルートテーブルのターゲットが B の ENI に書き換わりました。',
    },
    {
      title: 'BFD で切り替えを速くしよう',
      desc: 'キープアライブでは検知が遅く、しばらく通信が止まりました。BFD を使うと障害を高速に検知できます。',
      goal: 'BFD を使ったピアで再びフェイルオーバーさせ、切替時間を 3 秒以内にする',
      hint: 'ピアの障害検知方式は後から変更できないので、「④ BGP ピア」で既存のピアを削除し、BFD で作り直します。' +
        'Firewall-A を起動 → セッション確立を待つ → A に戻ったら (MED が小さいので自動で戻ります) もう一度 A を停止。',
      check: (s) => newFailovers(s).some((f) => f.duration <= 3),
      done: '劇的に速くなりました！ 本番では BFD の利用が推奨されるパターンが多いです。',
    },
    {
      title: '経路の優先度を変えてみよう',
      desc: '両方のアプライアンスが正常なまま、メンテナンスのため Firewall-B をアクティブにしたくなりました。BGP の属性で優先度を変えられます。',
      goal: 'Firewall-A と B が両方稼働中の状態で、ベストパスを Firewall-B にする',
      hint: '方法は 2 つ: ① Firewall-B の MED を A より小さくする (例: 50)、② Firewall-A の AS_PATH プリペンドを増やして経路を「長く」見せる。AS_PATH の長さは MED より先に比較されます。',
      check: (s) => s.appliances['appl-a'].up && s.appliances['appl-b'].up && s.appliances['appl-a'].advertise &&
        fibFor(s) && fibFor(s).applianceId === 'appl-b' && !fibFor(s).persisted,
      done: 'ルートテーブルには手を触れず、アプライアンス側の BGP 設定だけで経路を切り替えられました。',
    },
    {
      title: 'エンドポイント障害に耐えよう',
      desc: '「⑥ 障害注入」で片方のエンドポイントを落としても通信を継続できるでしょうか？',
      goal: 'エンドポイントを 1 つ停止した状態で、両方の App が通信できていること',
      hint: '各アプライアンスが「両方のエンドポイント」とピアを張っていれば、片方が落ちてももう片方から経路を学習し続けます。ピアが 1 本しかないアプライアンスはエンドポイント障害で経路が消えてしまいます。',
      check: (s) => Object.values(s.endpoints).some((e) => !e.up) && fibFor(s) && !fibFor(s).persisted && bothClientsOk(s),
      done: 'これがエンドポイントを複数 AZ に置き、ピアを冗長に張る理由です。',
    },
    {
      title: '経路の永続化 (Persist routes) を試そう',
      desc: '全てのエンドポイントとの BGP セッションが同時に切れた場合、通常は経路がすべて消えて通信が止まります。経路の永続化を有効にしておくと、直前の経路を保持し続けます。',
      goal: '経路の永続化を有効にした上で全エンドポイントを停止し、それでも通信が続くことを確認する',
      hint: '「① Route Server」の「経路の永続化」で有効化 → modify-route-server を実行 → 「⑥ 障害注入」で全エンドポイントを停止。永続化なしで試して違いを比べるのもおすすめです。',
      check: (s) => s.routeServer && s.routeServer.persist && Object.values(s.endpoints).length > 0 &&
        Object.values(s.endpoints).every((e) => !e.up) && fibFor(s) && fibFor(s).persisted && bothClientsOk(s),
      done: 'アプライアンス自体は生きているので、保持した経路で通信を継続できました。エンドポイントを戻すと、指定時間後に保持が解除されます。',
    },
  ];

  function startMission(i) {
    missionIdx = i;
    missionDone = false;
    missionStart = { failovers: state.failovers.length };
  }

  function checkMission() {
    if (freeMode || missionDone || missionIdx >= MISSIONS.length) return;
    if (MISSIONS[missionIdx].check(state)) {
      missionDone = true;
      toast(`🎉 ミッション ${missionIdx + 1} クリア！`);
    }
  }

  function renderMission() {
    const panel = $('#mission-panel');
    let html;
    if (freeMode || missionIdx >= MISSIONS.length) {
      html = `
        <div class="mission-head"><h3>${freeMode ? '🧪 自由モード' : '🏆 全ミッションクリア！'}</h3></div>
        <p class="mission-desc">${freeMode ? '完成済みの構成 (BFD・両エンドポイントとピア) から自由に実験できます。' : 'おめでとうございます！ VPC Route Server の主要な動きを一通り体験しました。'}</p>
        <div class="mission-goal"><strong>試してみよう</strong>
          <ul style="margin:4px 0 0;padding-left:1.2em">
            <li>A と B を両方停止すると？</li>
            <li>広告停止 (WITHDRAW) とクラッシュの違いは？</li>
            <li>伝播を片方だけ無効にすると？</li>
            <li>永続化あり／なしで全エンドポイント障害を比較</li>
          </ul>
        </div>
        <div class="btn-group" style="margin-top:10px">
          <button class="btn" data-mission="restart">ミッションを最初から</button>
          <button class="btn primary" data-goto="quiz">クイズに挑戦 →</button>
          <button class="btn" data-open-feedback>💬 感想を送る</button>
        </div>`;
    } else {
      const m = MISSIONS[missionIdx];
      const dots = MISSIONS.map((_, i) => `<span class="${i < missionIdx || (i === missionIdx && missionDone) ? 'done' : i === missionIdx ? 'current' : ''}">${i + 1}</span>`).join('');
      html = `
        <div class="mission-head">
          <span class="mission-count">ミッション ${missionIdx + 1} / ${MISSIONS.length}</span>
        </div>
        <div class="progress"><div style="width:${((missionIdx + (missionDone ? 1 : 0)) / MISSIONS.length) * 100}%"></div></div>
        <h3 class="mission-title">${m.title}</h3>
        <p class="mission-desc">${m.desc}</p>
        <div class="mission-goal"><strong>目標:</strong> ${m.goal}</div>
        <details class="hint-box"><summary>ヒント</summary><p style="margin:6px 0 0">${m.hint}</p></details>
        ${missionDone ? `<div class="mission-done"><strong>クリア！</strong> ${m.done}</div>
          <div style="margin-top:10px;text-align:right"><button class="btn primary" data-mission="next">次のミッションへ →</button></div>` : ''}
        <div class="mission-list">${dots}</div>`;
    }
    setHTML(panel, html);
  }

  // ================= コンソール (操作パネル) =================
  function opt(value, label, selected) {
    return `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
  }

  function renderConsole() {
    const panel = $('#console-panel');
    if (panel.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    const rs = state.routeServer;
    const eps = Object.values(state.endpoints);
    if (!eps.find((e) => e.id === form.peerEp)) form.peerEp = eps[0] ? eps[0].id : '';
    const durations = [1, 2, 3, 4, 5];
    let h = '<h3>コンソール</h3><p class="cli-note" style="margin:-4px 0 10px">各操作に対応する AWS CLI コマンドがイベントログに表示されます。</p>';

    // ① Route Server
    h += '<div class="console-section"><h4>① Route Server</h4>';
    if (!rs) {
      h += `
        <div class="field"><label for="f-asn">Amazon 側 ASN</label><input id="f-asn" type="number" data-form="rsAsn" value="${esc(form.rsAsn)}"></div>
        <div class="field"><label for="f-persist">経路の永続化</label>
          <select id="f-persist" data-form="rsPersist">${opt('false', '無効', form.rsPersist)}${opt('true', '有効', form.rsPersist)}</select></div>
        ${form.rsPersist === true || form.rsPersist === 'true' ? `<div class="field"><label for="f-dur">保持解除まで</label><select id="f-dur" data-form="rsDuration">${durations.map((d) => opt(d, `${d} 分`, form.rsDuration)).join('')}</select></div>` : ''}
        <button class="btn primary" data-action="create-rs">create-route-server</button>`;
    } else {
      h += `<div class="row"><span class="mono grow">${esc(rs.id)} · ASN ${rs.asn}</span>
        ${rs.associated ? '<span class="tag ok">VPC に関連付け済み</span>' : '<button class="btn primary small" data-action="associate">VPC に関連付け</button>'}</div>
        <div class="row"><span class="grow">経路の永続化: ${rs.persist ? `<span class="tag warn">有効 (${rs.duration} 分)</span>` : '<span class="tag">無効</span>'}</span></div>
        <div class="row">
          <select data-form="modPersist" aria-label="経路の永続化">${opt('false', '無効にする', form.modPersist)}${opt('true', '有効にする', form.modPersist)}</select>
          <select data-form="modDuration" aria-label="保持解除までの時間">${durations.map((d) => opt(d, `${d} 分`, form.modDuration)).join('')}</select>
          <button class="btn small" data-action="modify-persist">modify-route-server</button>
        </div>`;
    }
    h += '</div>';

    // ② エンドポイント
    h += '<div class="console-section"><h4>② エンドポイント</h4>';
    for (const e of eps) {
      h += `<div class="row"><span class="mono grow">${esc(e.id)}</span><span class="tag rs">AZ-${e.az}</span><span class="mono">${e.ip}</span></div>`;
    }
    const applSubnets = Object.entries(T.subnets).filter(([, s]) => s.role === 'appliance');
    h += `<div class="row"><select class="grow" data-form="epSubnet" aria-label="サブネット">${applSubnets.map(([id, s]) => opt(id, `${id} (AZ-${s.az}, ${s.cidr})`, form.epSubnet)).join('')}</select>
      <button class="btn small primary" data-action="create-ep">作成</button></div></div>`;

    // ③ 伝播
    h += '<div class="console-section"><h4>③ ルートテーブルへの伝播</h4>';
    for (const rtb of T.routeTables) {
      const on = !!state.propagations[rtb];
      h += `<div class="row"><span class="mono grow">${rtb}</span>${on ? '<span class="tag rs">有効</span>' : '<span class="tag">無効</span>'}
        <button class="btn small ${on ? '' : 'primary'}" data-action="prop" data-rtb="${rtb}" data-on="${on ? 0 : 1}">${on ? '無効化' : '有効化'}</button></div>`;
    }
    h += '</div>';

    // ④ ピア
    h += '<div class="console-section"><h4>④ BGP ピア</h4>';
    for (const p of Object.values(state.peers)) {
      const a = state.appliances[p.applianceId];
      const ep = state.endpoints[p.endpointId];
      h += `<div class="row"><span class="grow">${esc(a.name)} ⇔ EP AZ-${ep.az} <span class="tag">${p.liveness === 'bfd' ? 'BFD' : 'keepalive'}</span> ${peerTag(p)}</span>
        <button class="btn small danger-ghost" data-action="del-peer" data-id="${p.id}" aria-label="ピア削除">削除</button></div>`;
    }
    h += `
      <div class="field"><label for="f-pep">エンドポイント</label><select id="f-pep" data-form="peerEp">${eps.length ? eps.map((e) => opt(e.id, `${e.id} (AZ-${e.az})`, form.peerEp)).join('') : '<option value="">(まだありません)</option>'}</select></div>
      <div class="field"><label for="f-pappl">ピアアドレス</label><select id="f-pappl" data-form="peerAppl">${Object.values(state.appliances).map((a) => opt(a.id, `${a.ip} (${a.name})`, form.peerAppl)).join('')}</select></div>
      <div class="field"><label for="f-pasn">ピア ASN</label><input id="f-pasn" type="number" data-form="peerAsn" value="${esc(form.peerAsn)}"></div>
      <div class="field"><label for="f-plive">障害検知</label><select id="f-plive" data-form="peerLiveness">${opt('bgp-keepalive', 'BGP キープアライブ (遅い)', form.peerLiveness)}${opt('bfd', 'BFD (速い)', form.peerLiveness)}</select></div>
      <button class="btn primary" data-action="create-peer">create-route-server-peer</button></div>`;

    // ⑤ アプライアンス
    h += '<div class="console-section"><h4>⑤ アプライアンス (BGP 広告する側)</h4>';
    for (const a of Object.values(state.appliances)) {
      h += `<div class="appl-card">
        <div class="appl-head"><span>${esc(a.name)} <span class="mono" style="font-weight:400">AS${a.asn}</span></span>
          <button class="btn small ${a.up ? 'danger' : 'ok'}" data-action="appl-power" data-id="${a.id}">${a.up ? '■ 停止 (クラッシュ)' : '▶ 起動'}</button></div>
        <div class="row"><span class="grow">広告: <span class="mono">${esc(a.prefix)}</span></span>
          <button class="btn small" data-action="appl-adv" data-id="${a.id}">${a.advertise ? '広告を停止' : '広告を再開'}</button></div>
        <div class="field"><label for="f-med-${a.id}">MED</label><input id="f-med-${a.id}" type="number" min="0" data-appl="${a.id}" data-field="med" value="${a.med}"></div>
        <div class="field"><label for="f-pp-${a.id}">AS_PATH<br>プリペンド</label><select id="f-pp-${a.id}" data-appl="${a.id}" data-field="prepend">${[0, 1, 2, 3].map((n) => opt(n, `${n} 回`, a.prepend)).join('')}</select></div>
      </div>`;
    }
    h += '</div>';

    // ⑥ 障害注入
    h += '<div class="console-section"><h4>⑥ 障害注入</h4>';
    if (!eps.length) h += '<p class="cli-note">エンドポイントを作成すると操作できます。</p>';
    for (const e of eps) {
      h += `<div class="row"><span class="grow">エンドポイント AZ-${e.az} ${e.up ? '<span class="tag ok">正常</span>' : '<span class="tag err">障害中</span>'}</span>
        <button class="btn small ${e.up ? 'danger' : 'ok'}" data-action="ep-power" data-id="${e.id}">${e.up ? '障害を起こす' : '復旧する'}</button></div>`;
    }
    h += '</div>';
    setHTML(panel, h);
  }

  function peerTag(p) {
    if (p.state === 'established') {
      return p.pendingDownAt !== null ? '<span class="tag warn">確立 (無応答…)</span>' : '<span class="tag ok">確立</span>';
    }
    if (p.state === 'connecting') return '<span class="tag warn">接続中</span>';
    return '<span class="tag err">ダウン</span>';
  }

  function doAction(res, okMsg) {
    if (!res.ok) toast(res.error, true);
    else if (okMsg) toast(okMsg);
    renderAll(true);
  }

  function onConsoleClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;
    const id = btn.dataset.id;
    switch (a) {
      case 'create-rs':
        return doAction(S.createRouteServer(state, { asn: form.rsAsn, persist: String(form.rsPersist) === 'true', duration: form.rsDuration }));
      case 'associate': return doAction(S.associateRouteServer(state));
      case 'modify-persist': return doAction(S.modifyPersist(state, String(form.modPersist) === 'true', form.modDuration));
      case 'create-ep': {
        const res = S.createEndpoint(state, form.epSubnet);
        if (res.ok) {
          const other = Object.keys(T.subnets).find((k) => T.subnets[k].role === 'appliance' && !Object.values(state.endpoints).some((x) => x.subnetId === k));
          if (other) form.epSubnet = other;
        }
        return doAction(res);
      }
      case 'prop': return doAction(S.setPropagation(state, btn.dataset.rtb, btn.dataset.on === '1'));
      case 'create-peer':
        return doAction(S.createPeer(state, { endpointId: form.peerEp, applianceId: form.peerAppl, peerAsn: form.peerAsn, liveness: form.peerLiveness }));
      case 'del-peer': return doAction(S.deletePeer(state, id));
      case 'appl-power': return doAction(S.setAppliance(state, id, { up: !state.appliances[id].up }));
      case 'appl-adv': return doAction(S.setAppliance(state, id, { advertise: !state.appliances[id].advertise }));
      case 'ep-power': return doAction(S.setEndpointUp(state, id, !state.endpoints[id].up));
      default:
    }
  }

  function onConsoleChange(e) {
    const el = e.target;
    if (el.dataset.form) {
      const key = el.dataset.form;
      form[key] = el.type === 'number' ? Number(el.value) : el.value;
      if (key === 'peerAppl') form.peerAsn = state.appliances[el.value].asn;
      if (key === 'rsPersist') form.rsPersist = el.value === 'true';
      el.blur();
      renderConsole();
    } else if (el.dataset.appl) {
      doAction(S.setAppliance(state, el.dataset.appl, { [el.dataset.field]: Number(el.value) }));
    }
  }

  // ================= 構成図 (SVG) =================
  // AWS アーキテクチャアイコン (AWS Architecture Icons, Light BG) の作図ルールに合わせた配置
  const ICON = (name) => `assets/aws/${name}.svg`;
  const POS = {
    rs: { x: 480, y: 136 },
    ep: { a: { x: 380, y: 290 }, c: { x: 580, y: 290 } },
    appl: { 'appl-a': { x: 150, y: 306 }, 'appl-b': { x: 810, y: 306 } },
    client: { 'client-a': { x: 124, y: 512 }, 'client-c': { x: 836, y: 512 } },
    rtb: { 'rtb-work-a': { x: 323, y: 456 }, 'rtb-work-c': { x: 637, y: 456 } },
  };
  const AZ_NAME = { a: 'ap-northeast-1a', c: 'ap-northeast-1c' };

  function img(name, cx, cy, size, extra = '') {
    return `<image href="${ICON(name)}" x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" ${extra}/>`;
  }

  // AWS のグループ: 枠線 + 左上のグループアイコン + ラベル
  function group(cls, x, y, w, h, icon, label, sub) {
    let g = `<rect class="grp ${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
    const tx = icon ? x + 32 : x + 10;
    if (icon) g += `<image href="${ICON(icon)}" x="${x}" y="${y}" width="24" height="24"/>`;
    g += `<text class="grp-label" x="${tx}" y="${y + 17}">${label}${sub ? ` <tspan class="grp-sub">${sub}</tspan>` : ''}</text>`;
    return g;
  }

  function bgpPath(appl, az) {
    const a = POS.appl[appl.id];
    const e = POS.ep[az];
    const dir = appl.az === 'a' ? 1 : -1;
    if (appl.az === az) return `M${a.x + 24 * dir},${a.y - 6} L${e.x - 20 * dir},${e.y}`;
    // 別 AZ のエンドポイントへはサブネット下側を回り込む曲線で描く
    return `M${a.x + 24 * dir},${a.y + 10} Q${480 - 110 * dir},400 ${e.x - 18 * dir},${e.y + 10}`;
  }

  function renderDiagram() {
    const s = state;
    const rs = s.routeServer;
    const best = fibFor(s);
    let g = '';
    g += '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8c4fff"/></marker></defs>';
    g += '<rect x="0" y="0" width="960" height="680" fill="#ffffff"/>';

    // グループ (AWS Cloud > Region > VPC > AZ > Private subnet)
    g += group('grp-cloud', 10, 10, 940, 660, 'group-aws-cloud', 'AWS Cloud');
    g += group('grp-region', 26, 44, 908, 614, 'group-region', 'Region', 'ap-northeast-1 (東京)');
    g += group('grp-vpc', 42, 78, 876, 568, 'group-vpc', 'VPC', `${T.vpc.cidr} · ${T.vpc.id}`);
    for (const [az, x] of [['a', 58], ['c', 492]]) {
      g += group('grp-az', x, 200, 410, 432, null, 'Availability Zone', AZ_NAME[az]);
      const appl = T.subnets[`subnet-appl-${az}`];
      const work = T.subnets[`subnet-work-${az}`];
      g += group('grp-private', x + 14, 230, 382, 184, 'group-private-subnet', 'Private subnet', `subnet-appl-${az} · ${appl.cidr}`);
      g += group('grp-private', x + 14, 424, 382, 194, 'group-private-subnet', 'Private subnet', `subnet-work-${az} · ${work.cidr}`);
    }

    // 伝播 (Route Server → ルートテーブル)
    for (const rtb of T.routeTables) {
      if (!s.propagations[rtb] || !rs) continue;
      const endX = rtb === 'rtb-work-a' ? 447 : 513;
      g += `<path class="prop-link" d="M480,176 V520 H${endX}" marker-end="url(#arrow)"/>`;
    }

    // エンドポイント ⇔ Route Server
    for (const ep of Object.values(s.endpoints)) {
      const p = POS.ep[ep.az];
      g += `<path class="ep-link ${ep.up ? '' : 'down'}" d="M${p.x},${p.y - 20} L${ep.az === 'a' ? 462 : 498},156"/>`;
    }

    // BGP セッション
    for (const peer of Object.values(s.peers)) {
      const appl = s.appliances[peer.applianceId];
      const ep = s.endpoints[peer.endpointId];
      const cls = peer.state === 'established' ? (peer.pendingDownAt !== null ? 'connecting' : 'established') : peer.state;
      g += `<path class="bgp ${cls}" d="${bgpPath(appl, ep.az)}"><title>${peer.id}: ${peer.state}</title></path>`;
    }

    // VPC Route Server (専用アイコンがないため Amazon VPC Router アイコンで表現)
    if (rs) {
      g += `<rect class="rs-box" x="392" y="100" width="176" height="96" rx="4"/>`;
      g += img('vpc-router', 480, 132, 40);
      g += `<text class="d-name" x="480" y="168" text-anchor="middle">VPC Route Server</text>`;
      g += `<text class="d-sub" x="480" y="182" text-anchor="middle">AS${rs.asn} · ${rs.associated ? 'VPC に関連付け済み' : '未関連付け'}</text>`;
      if (rs.persist) g += `<text class="d-sub" x="480" y="194" text-anchor="middle" style="fill:${s.persisted ? '#b35c00' : '#5f6b7a'}">${s.persisted ? '経路を永続化して保持中' : '経路の永続化: 有効'}</text>`;
    } else {
      g += `<rect class="rs-box ghost" x="392" y="100" width="176" height="96" rx="4"/>`;
      g += img('vpc-router', 480, 132, 40, 'opacity="0.25"');
      g += `<text class="d-sub" x="480" y="172" text-anchor="middle">VPC Route Server (未作成)</text>`;
    }

    // Route Server エンドポイント (サブネット内の ENI)
    for (const az of ['a', 'c']) {
      const p = POS.ep[az];
      const ep = Object.values(s.endpoints).find((e) => e.az === az);
      if (ep) {
        g += img('elastic-network-interface', p.x, p.y, 36, ep.up ? '' : 'opacity="0.35"');
        if (!ep.up) g += crossMark(p.x, p.y, 12);
        g += `<text class="d-name" x="${p.x}" y="${p.y + 32}" text-anchor="middle">RS エンドポイント</text>`;
        g += `<text class="d-sub" x="${p.x}" y="${p.y + 45}" text-anchor="middle">${ep.ip}${ep.up ? '' : ' (障害)'}</text>`;
      } else {
        g += `<rect class="slot" x="${p.x - 18}" y="${p.y - 18}" width="36" height="36" rx="4"/>`;
        g += `<text class="d-sub" x="${p.x}" y="${p.y + 32}" text-anchor="middle">エンドポイント未作成</text>`;
      }
    }

    // アプライアンス (EC2 インスタンス上のファイアウォール)
    for (const a of Object.values(s.appliances)) {
      const p = POS.appl[a.id];
      const active = best && best.applianceId === a.id && a.up;
      if (active) g += `<rect class="active-ring" x="${p.x - 30}" y="${p.y - 30}" width="60" height="60" rx="6"/>`;
      g += img('ec2-instance', p.x, p.y, 44, a.up ? '' : 'opacity="0.35"');
      if (!a.up) g += crossMark(p.x, p.y, 14);
      g += `<text class="d-name" x="${p.x}" y="${p.y + 44}" text-anchor="middle">${esc(a.name)}</text>`;
      g += `<text class="d-sub" x="${p.x}" y="${p.y + 58}" text-anchor="middle">${a.ip} · AS${a.asn}</text>`;
      g += `<text class="d-sub" x="${p.x}" y="${p.y + 71}" text-anchor="middle">${a.eni}</text>`;
      const status = !a.up ? ['停止中', '#d13212'] : active ? ['ACTIVE', '#1d8102'] : [a.advertise ? 'スタンバイ' : '広告停止', '#5f6b7a'];
      g += `<text x="${p.x}" y="${p.y + 88}" text-anchor="middle" style="fill:${status[1]};font-size:12px;font-weight:700">${status[0]}</text>`;
    }

    // ルートテーブル
    for (const rtb of T.routeTables) {
      const p = POS.rtb[rtb];
      const table = s.routeTables[rtb] || { routes: [{ dest: T.vpc.cidr, target: 'local' }] };
      const w = 246;
      const x = p.x - w / 2;
      const h = 44 + table.routes.length * 16;
      g += `<rect class="rtb-box ${s.propagations[rtb] ? 'propagated' : ''}" x="${x}" y="${p.y}" width="${w}" height="${h}" rx="4"/>`;
      g += `<image href="${ICON('route-table')}" x="${x + 8}" y="${p.y + 8}" width="24" height="24"/>`;
      g += `<text class="d-name" x="${x + 38}" y="${p.y + 20}">Route table</text>`;
      g += `<text class="d-sub" x="${x + 38}" y="${p.y + 32}">${rtb}${s.propagations[rtb] ? ' · 伝播: 有効' : ''}</text>`;
      table.routes.forEach((r, i) => {
        const target = r.target === 'local' ? 'local' : `${r.target}${r.persisted ? ' *' : ''}`;
        const style = r.origin === 'route-server' ? `style="fill:${r.persisted ? '#b35c00' : '#8c4fff'};font-weight:700"` : '';
        g += `<text class="d-mono" ${style} x="${x + 10}" y="${p.y + 54 + i * 16}">${r.dest} → ${target}</text>`;
      });
    }

    // ワークロード (EC2 インスタンス)
    for (const c of Object.values(s.clients)) {
      const p = POS.client[c.id];
      const last = s.traffic[c.id] && s.traffic[c.id].last;
      g += img('ec2-instance', p.x, p.y, 44);
      g += `<text class="d-name" x="${p.x}" y="${p.y + 44}" text-anchor="middle">${c.name}</text>`;
      g += `<text class="d-sub" x="${p.x}" y="${p.y + 58}" text-anchor="middle">${c.ip}</text>`;
      if (last) g += `<text x="${p.x}" y="${p.y + 76}" text-anchor="middle" style="fill:${last.ok ? '#1d8102' : '#d13212'};font-size:12px;font-weight:700">${last.ok ? '通信OK' : '通信NG'}</text>`;
    }

    setHTML($('#diagram-static'), g);
  }

  function crossMark(x, y, r) {
    return `<g class="svg-x"><line x1="${x - r}" y1="${y - r}" x2="${x + r}" y2="${y + r}"/><line x1="${x - r}" y1="${y + r}" x2="${x + r}" y2="${y - r}"/></g>`;
  }

  // ---------- パケットアニメーション ----------
  const packets = [];
  const lastSent = {};
  const lastSpawn = {};

  function spawnPackets() {
    for (const [id, t] of Object.entries(state.traffic)) {
      if (lastSent[id] === t.sent) continue;
      lastSent[id] = t.sent;
      const now = performance.now();
      if (lastSpawn[id] && now - lastSpawn[id] < 350) continue;
      lastSpawn[id] = now;
      const last = t.last;
      const c = POS.client[id];
      const rtbId = T.subnets[state.clients[id].subnetId].routeTable;
      const r = POS.rtb[rtbId];
      const pts = [{ x: c.x, y: c.y }, { x: r.x, y: r.y + 20 }];
      if (last.via) {
        const a = POS.appl[last.via];
        pts.push({ x: a.x, y: a.y + 22 });
      }
      packets.push({ pts, ok: last.ok, born: now, dur: 900 });
    }
  }

  function pointAt(pts, f) {
    const segs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      segs.push(d);
      total += d;
    }
    let dist = f * total;
    for (let i = 0; i < segs.length; i++) {
      if (dist <= segs[i]) {
        const k = segs[i] ? dist / segs[i] : 0;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
      }
      dist -= segs[i];
    }
    return pts[pts.length - 1];
  }

  function animate(now) {
    let g = '';
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      const f = (now - p.born) / p.dur;
      if (f > 1.35) { packets.splice(i, 1); continue; }
      const pos = pointAt(p.pts, Math.min(1, f));
      if (f >= 1 && !p.ok) {
        g += `<g transform="translate(${pos.x},${pos.y})"><line class="svg-x" x1="-8" y1="-8" x2="8" y2="8"/><line class="svg-x" x1="-8" y1="8" x2="8" y2="-8"/></g>`;
      } else if (f < 1) {
        g += `<circle class="pkt ${p.ok ? 'ok' : 'ng'}" cx="${pos.x}" cy="${pos.y}" r="6"/>`;
      }
    }
    $('#diagram-packets').innerHTML = g;
    requestAnimationFrame(animate);
  }

  function renderStrip() {
    let h = '';
    for (const c of Object.values(state.clients)) {
      const t = state.traffic[c.id];
      const hist = t ? t.history.slice(-45) : [];
      const cells = hist.map((x) => `<span class="${!x.ok ? 'ng' : x.via === 'appl-a' ? 'ok-a' : 'ok-b'}" title="t=${x.t}s"></span>`).join('');
      h += `<div class="strip-row"><strong>${c.name}</strong><div class="strip-cells">${cells}</div>
        <div class="strip-status">${t && t.last ? esc(t.last.reason) : '通信待機中…'}</div></div>`;
    }
    h += '<div class="strip-row"><span></span><span class="cli-note">1 秒ごとの通信結果: <span class="tag ok">A 経由</span> <span class="tag info">B 経由</span> <span class="tag err">失敗</span></span></div>';
    setHTML($('#traffic-strip'), h);
  }

  // ================= 下部タブ =================
  function renderSub() {
    const el = $('#sub-content');
    const s = state;
    let h = '';
    if (subTab === 'rt') {
      h += '<p class="hint">Route Server が書き込んだ経路は紫色です。ターゲットがアプライアンスの ENI になっていることに注目してください。</p><div class="rtb-grid">';
      for (const rtb of T.routeTables) {
        const t = s.routeTables[rtb] || { routes: [{ dest: T.vpc.cidr, target: 'local', origin: 'local' }] };
        const subnet = Object.keys(T.subnets).find((k) => T.subnets[k].routeTable === rtb);
        h += `<div class="rtb-card"><h4><span class="mono">${rtb}</span>${s.propagations[rtb] ? '<span class="tag rs">伝播: 有効</span>' : '<span class="tag">伝播: 無効</span>'}<span class="cli-note">(${subnet})</span></h4>
          <div class="tbl-wrap"><table class="data"><thead><tr><th>送信先</th><th>ターゲット</th><th>種類</th></tr></thead><tbody>`;
        for (const r of t.routes) {
          const kind = r.origin === 'local' ? 'local' : r.persisted ? 'Route Server (永続化)' : 'Route Server';
          const name = r.applianceId ? ` <span class="cli-note">(${esc(s.appliances[r.applianceId].name)})</span>` : '';
          h += `<tr class="${r.origin === 'route-server' ? `rs-route${r.persisted ? ' persisted' : ''}` : ''}"><td class="mono">${r.dest}</td><td class="mono">${r.target}${name}</td><td>${kind}</td></tr>`;
        }
        h += '</tbody></table></div></div>';
      }
      h += '</div>';
    } else if (subTab === 'rib') {
      h += '<p class="hint">RIB = 受け取った全経路。FIB = 各プレフィックスのベストパス (AS_PATH が短い → MED が小さい → ピア IP が小さい)。FIB がルートテーブルに反映されます。</p>';
      h += `<h4>RIB (${s.rib.length} 件)</h4>`;
      if (!s.rib.length) h += '<p class="hint">まだ経路を受信していません。</p>';
      else {
        const sorted = [...s.rib].sort(S.compareRoutes);
        h += '<div class="tbl-wrap"><table class="data"><thead><tr><th></th><th>プレフィックス</th><th>ネクストホップ</th><th>アプライアンス</th><th>受信 EP</th><th>AS_PATH</th><th>MED</th></tr></thead><tbody>';
        for (const r of sorted) {
          const isBest = s.fib.some((f) => !f.persisted && f.peerId === r.peerId && f.prefix === r.prefix);
          h += `<tr class="${isBest ? 'best' : ''}"><td>${isBest ? '<span class="tag ok">BEST</span>' : ''}</td><td class="mono">${esc(r.prefix)}</td><td class="mono">${r.nextHopEni}</td>
            <td>${esc(s.appliances[r.applianceId].name)}</td><td>AZ-${s.endpoints[r.endpointId].az}</td><td class="mono">${r.asPath.join(' ')}</td><td class="mono">${r.med}</td></tr>`;
        }
        h += '</tbody></table></div>';
      }
      h += `<h4>FIB (${s.fib.length} 件)</h4>`;
      if (!s.fib.length) h += '<p class="hint">FIB は空です。</p>';
      else {
        h += '<div class="tbl-wrap"><table class="data"><thead><tr><th>プレフィックス</th><th>ネクストホップ</th><th>アプライアンス</th><th>状態</th></tr></thead><tbody>';
        for (const r of s.fib) {
          h += `<tr class="best"><td class="mono">${esc(r.prefix)}</td><td class="mono">${r.nextHopEni}</td><td>${esc(s.appliances[r.applianceId].name)}</td>
            <td>${r.persisted ? '<span class="tag warn">永続化で保持中</span>' : '<span class="tag ok">有効</span>'}</td></tr>`;
        }
        h += '</tbody></table></div>';
      }
    } else if (subTab === 'peers') {
      const peers = Object.values(s.peers);
      h += `<p class="hint">検知時間 (このラボ): BFD ${S.DETECT_SECONDS.bfd} 秒 / BGP キープアライブ ${S.DETECT_SECONDS['bgp-keepalive']} 秒。相手が無応答になってから検知するまで、セッションは「確立」のままです。</p>`;
      if (!peers.length) h += '<p class="hint">ピアはまだありません。</p>';
      else {
        h += '<div class="tbl-wrap"><table class="data"><thead><tr><th>ピア ID</th><th>アプライアンス</th><th>エンドポイント</th><th>ピア ASN</th><th>障害検知</th><th>状態</th><th>詳細</th></tr></thead><tbody>';
        for (const p of peers) {
          const a = s.appliances[p.applianceId];
          const ep = s.endpoints[p.endpointId];
          let detail = esc(p.reason || '');
          if (p.pendingDownAt !== null) detail = `あと約 ${Math.max(0, Math.ceil(p.pendingDownAt - s.time + 0.25))} 秒で障害を検知`;
          h += `<tr><td class="mono">${p.id}</td><td>${esc(a.name)} (${a.ip})</td><td class="mono">${ep.ip} (AZ-${ep.az})</td><td class="mono">${p.peerAsn}</td>
            <td>${p.liveness === 'bfd' ? 'BFD' : 'BGP キープアライブ'}</td><td>${peerTag(p)}</td><td>${detail}</td></tr>`;
        }
        h += '</tbody></table></div>';
      }
      if (s.failovers.length) {
        h += '<h4>フェイルオーバー履歴</h4><div class="tbl-wrap"><table class="data"><thead><tr><th>時刻</th><th>切替</th><th>停止から切替まで</th></tr></thead><tbody>';
        for (const f of s.failovers.slice(-6).reverse()) {
          h += `<tr><td class="mono">${fmtTime(f.at)}</td><td>${esc(s.appliances[f.from].name)} → ${esc(s.appliances[f.to].name)}</td><td class="mono">${f.duration} 秒</td></tr>`;
        }
        h += '</tbody></table></div>';
      }
    } else {
      h += '<div class="log" id="log">';
      for (const l of s.log.slice(-200)) {
        h += `<div class="${l.level}"><span class="t">${fmtTime(l.t)}</span><span class="m">${esc(l.msg)}</span></div>`;
      }
      if (!s.log.length) h += '<p class="hint">操作するとここにログと CLI コマンドが表示されます。</p>';
      h += '</div>';
    }
    const logEl = $('#log');
    const stick = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
    if (setHTML(el, h) && subTab === 'log') {
      const nl = $('#log');
      if (nl && stick) nl.scrollTop = nl.scrollHeight;
    }
  }

  // ================= 共通 =================
  function setHTML(el, html) {
    if (el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  }

  function fmtTime(t) {
    const s = Math.floor(t);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  let toastTimer;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 3800 : 2400);
  }

  function renderAll() {
    checkMission();
    $('#clock').textContent = fmtTime(state.time);
    renderDiagram();
    renderStrip();
    renderSub();
    renderConsole();
    renderMission();
    spawnPackets();
  }

  function renderSpeed() {
    document.querySelectorAll('.speed').forEach((b) => b.classList.toggle('active', !paused && Number(b.dataset.speed) === speed));
    $('#btn-pause').classList.toggle('active', paused);
    $('#btn-pause').textContent = paused ? '▶ 再開' : '⏸ 一時停止';
  }

  function reset() {
    state = S.createState();
    for (const k of Object.keys(lastSent)) delete lastSent[k];
    packets.length = 0;
    form.peerEp = '';
    form.epSubnet = 'subnet-appl-a';
    freeMode = false;
    startMission(0);
    renderAll();
  }

  // ================= クイズ =================
  const QUIZ = [
    {
      q: 'VPC Route Server が主に解決してくれる課題はどれ？',
      opts: ['VPC 間の通信を暗号化すること', 'アプライアンスの状態に合わせて VPC ルートテーブルを BGP で動的に更新すること', 'インターネットゲートウェイの帯域を増やすこと', 'EC2 インスタンスを自動で再起動すること'],
      a: 1,
      ex: 'Route Server はアプライアンスから BGP で受け取った経路をもとに、ルートテーブルのターゲットを自動で更新します。これまで Lambda などで自作していたフェイルオーバー処理を置き換えられます。',
    },
    {
      q: 'App から Firewall へ流れる実際のパケットの経路として正しいのは？',
      opts: ['App → Route Server → Firewall', 'App → Route Server エンドポイント → Firewall', 'App → (ルートテーブルのターゲット) Firewall の ENI', 'App → インターネットゲートウェイ → Firewall'],
      a: 2,
      ex: 'Route Server はコントロールプレーン (経路を決める係) です。データはルートテーブルに書かれたアプライアンスの ENI へ直接届き、Route Server やエンドポイントは経由しません。',
    },
    {
      q: 'RIB と FIB の説明として正しいのは？',
      opts: ['RIB はベストパスだけ、FIB は全経路', 'RIB は受信した全経路、FIB はそこから選ばれたベストパスで、ルートテーブルに反映される', 'どちらも同じもの', 'FIB はアプライアンス側だけが持つ'],
      a: 1,
      ex: 'Route Server はピアから受け取った全経路を RIB に持ち、ベストパスを選んだ結果が FIB です。FIB の内容が伝播先のルートテーブルに書き込まれます。',
    },
    {
      q: 'ルートテーブル rtb-X に経路が入ってこない。まず確認すべきことは？',
      opts: ['rtb-X に対して Route Server の伝播が有効か', 'rtb-X にインターネットゲートウェイがあるか', 'Route Server の ASN が 65000 か', 'rtb-X のサブネットに EC2 がいるか'],
      a: 0,
      ex: '経路は「伝播 (propagation) を有効化したルートテーブル」にだけ書き込まれます。',
    },
    {
      q: '同じプレフィックスを A と B が広告している。B を優先させたいときに B 側で行う設定は？',
      opts: ['MED を A より大きくする', 'MED を A より小さくする', 'AS_PATH プリペンドを増やす', 'BFD を無効にする'],
      a: 1,
      ex: 'MED は小さいほど優先されます。逆に AS_PATH プリペンドを増やすと経路が長く見え、優先度は下がります (A 側でプリペンドを増やすのは有効な手段です)。',
    },
    {
      q: 'BFD を使う一番の目的は？',
      opts: ['経路を暗号化するため', 'より多くの経路を広告するため', 'ピアの障害を高速に検知し、切替までの通信断を短くするため', 'ASN を自動で割り当てるため'],
      a: 2,
      ex: 'BGP キープアライブだけだとホールドタイムが切れるまで障害を検知できず、その間はブラックホールになります。BFD はより短い間隔で死活監視を行います。',
    },
    {
      q: 'エンドポイントとピアの冗長化について、最も適切な構成は？',
      opts: ['エンドポイントは 1 つで十分', '異なる AZ にエンドポイントを置き、各アプライアンスを複数のエンドポイントとピアにする', 'アプライアンスごとに別の Route Server を作る', 'エンドポイントはワークロードと同じサブネットにしか置けない'],
      a: 1,
      ex: 'エンドポイントの 1 つが使えなくなっても、もう一方のエンドポイントから経路を学習し続けられるようにするのが基本の冗長構成です。',
    },
    {
      q: '経路の永続化 (Persist routes) を有効にすると？',
      opts: ['全ての BGP セッションが切れても、直前の経路を RIB/FIB に保持し続ける', 'アプライアンスが落ちても絶対に通信が止まらない', '経路がディスクにバックアップされ再作成時に復元される', 'BGP セッションが切れなくなる'],
      a: 0,
      ex: '全セッション断のときに経路を保持し、セッション復旧後は 1〜5 分の指定時間を待ってから保持を解除します。アプライアンス自体が落ちているなら、保持した経路の先はブラックホールになり得る点に注意しましょう。',
    },
  ];
  const quizAnswers = {};

  function renderQuiz() {
    let h = '';
    QUIZ.forEach((item, i) => {
      const ans = quizAnswers[i];
      h += `<div class="q"><h3>Q${i + 1}. ${item.q}</h3><div class="opts">`;
      item.opts.forEach((o, j) => {
        let cls = '';
        if (ans !== undefined) {
          if (j === item.a) cls = 'correct';
          else if (j === ans) cls = 'wrong';
        }
        h += `<button class="opt ${cls}" data-q="${i}" data-o="${j}" ${ans !== undefined ? 'disabled' : ''}>${String.fromCharCode(65 + j)}. ${o}</button>`;
      });
      h += '</div>';
      if (ans !== undefined) h += `<div class="explain">${ans === item.a ? '⭕ 正解！' : '❌ 不正解。'} ${item.ex}</div>`;
      h += '</div>';
    });
    $('#quiz').innerHTML = h;
    const answered = Object.keys(quizAnswers).length;
    const correct = Object.entries(quizAnswers).filter(([i, a]) => QUIZ[i].a === a).length;
    $('#quiz-score').innerHTML = answered === QUIZ.length
      ? `スコア: ${correct} / ${QUIZ.length} ${correct === QUIZ.length ? '🏆 完璧です！' : ''}<div style="margin-top:10px"><button class="btn" id="quiz-retry">もう一度挑戦</button> <button class="btn" data-open-feedback>💬 感想を送る</button></div>`
      : `${answered} / ${QUIZ.length} 問回答済み`;
  }

  // ================= フィードバック =================
  const FB = window.FeedbackKit;
  const VIEW_TO_AREA = { learn: 'learn', lab: 'lab', quiz: 'quiz' };
  let fbRating = null;

  function feedbackContext() {
    const rs = state.routeServer;
    const peers = Object.values(state.peers);
    const mission = freeMode ? '自由モード'
      : missionIdx >= MISSIONS.length ? '全ミッションクリア'
        : `${missionIdx + 1} / ${MISSIONS.length} 「${MISSIONS[missionIdx].title}」${missionDone ? ' (クリア済み)' : ''}`;
    const answered = Object.keys(quizAnswers).length;
    const correct = Object.entries(quizAnswers).filter(([i, a]) => QUIZ[i].a === a).length;
    return [
      `画面: ${{ learn: 'しくみを知る', lab: 'ラボで体験', quiz: '理解度クイズ' }[currentView] || currentView}`,
      `ミッション: ${mission}`,
      `シミュレーション時間: ${fmtTime(state.time)}`,
      `構成: Route Server ${rs ? `作成済み (${rs.associated ? 'VPC 関連付け済み' : '未関連付け'}${rs.persist ? ', 永続化あり' : ''})` : '未作成'}` +
        ` / エンドポイント ${Object.keys(state.endpoints).length} / ピア ${peers.length} (確立 ${peers.filter((p) => p.state === 'established').length})` +
        ` / 伝播 ${Object.keys(state.propagations).length}`,
      `クイズ: ${answered} / ${QUIZ.length} 問回答 (正解 ${correct})`,
      `画面サイズ: ${window.innerWidth}x${window.innerHeight}`,
      `ブラウザ: ${navigator.userAgent}`,
    ].join('\n');
  }

  function renderFeedbackForm() {
    $('#fb-stars').innerHTML = FB.RATINGS.slice().reverse().map((r) =>
      `<button type="button" class="fb-star" data-rating="${r.value}" aria-pressed="${fbRating === r.value}">${esc(r.label)}</button>`).join('');
    const cat = $('#fb-category').value;
    const hint = FB.CATEGORIES.find((c) => c.id === cat);
    $('#fb-category-hint').textContent = hint ? hint.hint : '';
    const ctx = $('#fb-context');
    ctx.hidden = !$('#fb-include-context').checked;
    ctx.textContent = feedbackContext();
  }

  function openFeedback() {
    const dlg = $('#feedback-dialog');
    if (!$('#fb-category').options.length) {
      $('#fb-category').innerHTML = FB.CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
      $('#fb-area').innerHTML = FB.AREAS.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
    }
    $('#fb-area').value = VIEW_TO_AREA[currentView] || 'other';
    renderFeedbackForm();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    $('#fb-message').focus();
  }

  function submitFeedback() {
    const message = $('#fb-message').value.trim();
    if (!message) {
      toast('内容を入力してください', true);
      return false;
    }
    const url = FB.buildIssueUrl({
      rating: fbRating,
      category: $('#fb-category').value,
      area: $('#fb-area').value,
      message,
      context: $('#fb-include-context').checked ? feedbackContext() : '',
    });
    window.open(url, '_blank', 'noopener');
    toast('GitHub の画面で内容を確認して送信してください');
    $('#fb-message').value = '';
    fbRating = null;
    return true;
  }

  // GitHub のリポジトリ・Issue ページへのリンク (リポジトリ名は feedback.js の REPO に一元化)
  function initGitHubLinks() {
    const base = `https://github.com/${FB.REPO}`;
    const q = (query) => `${base}/issues?q=${encodeURIComponent(query)}`;
    const links = {
      repo: base,
      issues: `${base}/issues`,
      feedback: q('is:issue label:feedback'),
      tasks: q('is:issue is:open label:課題'),
    };
    document.querySelectorAll('[data-gh-link]').forEach((a) => { a.href = links[a.dataset.ghLink]; });
  }

  function initFeedback() {
    initGitHubLinks();
    const dlg = $('#feedback-dialog');
    $('#btn-feedback').addEventListener('click', openFeedback);
    $('#fb-stars').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rating]');
      if (!b) return;
      const v = Number(b.dataset.rating);
      fbRating = fbRating === v ? null : v;
      renderFeedbackForm();
    });
    $('#fb-category').addEventListener('change', renderFeedbackForm);
    $('#fb-include-context').addEventListener('change', renderFeedbackForm);
    $('#feedback-form').addEventListener('submit', (e) => {
      const submitter = e.submitter;
      if (submitter && submitter.value === 'cancel') return;
      if (!submitFeedback()) e.preventDefault();
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }

  // ================= 初期化 =================
  let currentView = 'learn';

  function showView(name) {
    currentView = name;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
    window.scrollTo(0, 0);
  }

  function init() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-open-feedback]')) openFeedback();
      const go = e.target.closest('[data-goto]');
      if (go) showView(go.dataset.goto);
      const m = e.target.closest('[data-mission]');
      if (m) {
        if (m.dataset.mission === 'next') startMission(missionIdx + 1);
        if (m.dataset.mission === 'restart') reset();
        renderAll();
      }
      const q = e.target.closest('.opt');
      if (q) { quizAnswers[q.dataset.q] = Number(q.dataset.o); renderQuiz(); }
      if (e.target.id === 'quiz-retry') { for (const k of Object.keys(quizAnswers)) delete quizAnswers[k]; renderQuiz(); }
    });
    document.querySelectorAll('.subtab').forEach((b) => b.addEventListener('click', () => {
      subTab = b.dataset.sub;
      document.querySelectorAll('.subtab').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      renderSub();
    }));
    const cp = $('#console-panel');
    cp.addEventListener('click', onConsoleClick);
    cp.addEventListener('change', onConsoleChange);
    cp.addEventListener('focusout', () => setTimeout(renderConsole, 0));

    document.querySelectorAll('.speed').forEach((b) => b.addEventListener('click', () => {
      speed = Number(b.dataset.speed);
      paused = false;
      renderSpeed();
    }));
    $('#btn-pause').addEventListener('click', () => { paused = !paused; renderSpeed(); });
    $('#btn-skip').addEventListener('click', () => { S.step(state, 30); renderAll(); });
    $('#btn-reset').addEventListener('click', () => {
      if (confirm('ラボをリセットして最初からやり直しますか？')) reset();
    });
    $('#btn-quick').addEventListener('click', () => {
      S.quickSetup(state, { liveness: 'bfd' });
      freeMode = true;
      toast('完成構成を作成しました (BFD / 両エンドポイントとピア)');
      renderAll();
    });

    let lastReal = performance.now();
    setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - lastReal) / 1000);
      lastReal = now;
      if (!paused) S.step(state, dt * speed);
      renderAll();
    }, 100);

    initFeedback();
    startMission(0);
    renderSpeed();
    renderQuiz();
    renderAll();
    requestAnimationFrame(animate);
  }

  init();
})();
