'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../js/sim.js');

function ready(liveness = 'bfd', opts = {}) {
  const s = Sim.createState();
  Sim.createRouteServer(s, { asn: 65000, persist: !!opts.persist, duration: opts.duration || 1 });
  Sim.quickSetup(s, { liveness });
  Sim.step(s, 5);
  return s;
}

const fibNext = (s) => s.fib.map((r) => r.applianceId);

test('手順を飛ばすとエラーになる', () => {
  const s = Sim.createState();
  assert.equal(Sim.associateRouteServer(s).ok, false);
  Sim.createRouteServer(s, { asn: 65000 });
  assert.equal(Sim.createEndpoint(s, 'subnet-appl-a').ok, false);
  assert.equal(Sim.createRouteServer(s, { asn: 65000 }).ok, false);
});

test('全ピア確立後、MED が小さい Firewall-A が選ばれ両ルートテーブルに入る', () => {
  const s = ready();
  assert.equal(Object.values(s.peers).filter((p) => p.state === 'established').length, 4);
  assert.equal(s.rib.length, 4);
  assert.deepEqual(fibNext(s), ['appl-a']);
  for (const rtb of Object.values(s.routeTables)) {
    assert.equal(rtb.routes.find((r) => r.origin === 'route-server').target, 'eni-0aaa1111');
  }
  assert.equal(Sim.probe(s, 'client-a').ok, true);
  assert.equal(Sim.probe(s, 'client-c').ok, true);
});

test('伝播を有効化していないルートテーブルには経路が入らない', () => {
  const s = ready();
  Sim.setPropagation(s, 'rtb-work-c', false);
  assert.equal(Sim.probe(s, 'client-a').ok, true);
  assert.equal(Sim.probe(s, 'client-c').ok, false);
});

test('BFD では約 1 秒、キープアライブでは約 30 秒でフェイルオーバーする', () => {
  for (const [liveness, max] of [['bfd', 3], ['bgp-keepalive', 35]]) {
    const s = ready(liveness);
    Sim.setAppliance(s, 'appl-a', { up: false });
    assert.equal(Sim.probe(s, 'client-a').ok, false, '検知までの間はブラックホール');
    Sim.step(s, 40);
    assert.deepEqual(fibNext(s), ['appl-b']);
    const f = s.failovers[0];
    assert.ok(f && f.duration <= max, `${liveness}: ${f && f.duration}`);
    assert.equal(f.from, 'appl-a');
    assert.equal(f.to, 'appl-b');
    if (liveness === 'bgp-keepalive') {
      assert.ok(f.duration > 3);
      const o = s.outages.find((x) => x.clientId === 'client-a');
      assert.ok(o && o.fromVia === 'appl-a' && o.toVia === 'appl-b' && o.duration >= 25);
    }
  }
});

test('MED と AS_PATH プリペンドで優先度を変えられる', () => {
  const s = ready();
  Sim.setAppliance(s, 'appl-b', { med: 50 });
  assert.deepEqual(fibNext(s), ['appl-b']);
  Sim.setAppliance(s, 'appl-b', { prepend: 2 });
  assert.deepEqual(fibNext(s), ['appl-a'], 'AS_PATH 長が MED より優先される');
});

test('ピア ASN が一致しないとセッションは確立しない', () => {
  const s = Sim.createState();
  Sim.createRouteServer(s, { asn: 65000 });
  Sim.associateRouteServer(s);
  const ep = Sim.createEndpoint(s, 'subnet-appl-a').id;
  Sim.createPeer(s, { endpointId: ep, applianceId: 'appl-a', peerAsn: 65099, liveness: 'bfd' });
  Sim.step(s, 10);
  assert.equal(Object.values(s.peers)[0].state, 'down');
  assert.equal(s.rib.length, 0);
});

test('エンドポイント 1 つの障害では経路は残る', () => {
  const s = ready();
  const ep = Object.values(s.endpoints)[0].id;
  Sim.setEndpointUp(s, ep, false);
  Sim.step(s, 2);
  assert.deepEqual(fibNext(s), ['appl-a']);
  assert.equal(s.rib.length, 2);
});

test('経路の永続化: 全セッション断でも経路を保持し、復旧後に指定時間で解除', () => {
  const noPersist = ready('bfd');
  for (const ep of Object.keys(noPersist.endpoints)) Sim.setEndpointUp(noPersist, ep, false);
  Sim.step(noPersist, 2);
  assert.equal(noPersist.fib.length, 0);

  const s = ready('bfd', { persist: true, duration: 1 });
  for (const ep of Object.keys(s.endpoints)) Sim.setEndpointUp(s, ep, false);
  Sim.step(s, 2);
  assert.equal(s.fib.length, 1);
  assert.equal(s.fib[0].persisted, true);
  assert.equal(Sim.probe(s, 'client-a').ok, true);

  for (const ep of Object.keys(s.endpoints)) Sim.setEndpointUp(s, ep, true);
  Sim.step(s, 5);
  assert.ok(s.persisted, '解除待ち');
  Sim.step(s, 60);
  assert.equal(s.persisted, null);
  assert.equal(s.fib[0].persisted, false);
});

test('CIDR ユーティリティ', () => {
  assert.equal(Sim.cidrContains('10.0.0.0/16', '10.0.5.1'), true);
  assert.equal(Sim.cidrContains('10.0.0.0/16', '192.168.100.10'), false);
  assert.equal(Sim.cidrContains('0.0.0.0/0', '1.2.3.4'), true);
  assert.equal(Sim.isValidCidr('192.168.100.10/32'), true);
  assert.equal(Sim.isValidCidr('300.1.1.1/32'), false);
});
