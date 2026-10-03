'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/feedback.js');
const { triageIssue } = require('../scripts/triage-feedback.js');

// GitHub の Issue フォームが出力する本文と同じ形
function formBody({ rating = '', category = '', area = '', message = '', context = '' } = {}) {
  const v = (x) => x || '_No response_';
  return [
    `### 満足度\n\n${v(rating)}`,
    `### カテゴリ\n\n${v(category)}`,
    `### 該当箇所\n\n${v(area)}`,
    `### 内容\n\n${v(message)}`,
    `### 利用状況（自動入力）\n\n${context ? '```text\n' + context + '\n```' : '_No response_'}`,
  ].join('\n\n');
}

test('Issue フォームの本文を解析できる (未回答・コードブロックの扱い)', () => {
  const f = F.parseIssueForm(formBody({
    rating: '2 - 不満', category: '不具合', message: '1行目\n2行目', context: '画面: ラボで体験\nミッション: 7 / 11',
  }));
  assert.equal(f.rating, '2 - 不満');
  assert.equal(f.category, '不具合');
  assert.equal(f.area, '');
  assert.equal(f.message, '1行目\n2行目');
  assert.equal(f.context, '画面: ラボで体験\nミッション: 7 / 11');
});

test('カテゴリから課題の種類と優先度を判定する', () => {
  const bug = F.triage({ rating: '1 - とても不満', category: '不具合', area: 'ラボで体験 (シミュレーター)', message: 'ミッション7が進めません' });
  assert.equal(bug.actionable, true);
  assert.equal(bug.kind, 'bug');
  assert.equal(bug.priority, 'high');
  assert.deepEqual(bug.labels, ['bug', 'priority:high']);
  assert.equal(bug.area, 'lab');
  assert.equal(bug.title, '[課題] 不具合: ミッション7が進めません');

  assert.equal(F.triage({ category: '内容の誤り', message: 'BFD の説明が古いです' }).priority, 'medium');
  assert.equal(F.triage({ category: '改善要望', rating: '5', message: 'IPv6 のミッションもほしい' }).priority, 'low');
  assert.equal(F.triage({ category: '分かりにくい', rating: '2', message: 'RIB と FIB の違いが分からない' }).priority, 'medium');
});

test('感想・その他でもキーワードや低い満足度で課題として拾う', () => {
  const kw = F.triage({ category: '感想・その他', rating: '4', message: '楽しかったけど、伝播の説明が分かりにくいです' });
  assert.equal(kw.actionable, true);
  assert.equal(kw.kind, 'ux');
  assert.ok(kw.reasons.some((r) => r.includes('分かりにく')));

  const low = F.triage({ category: '感想・その他', rating: '1 - とても不満', message: 'うーん、いまいちでした' });
  assert.equal(low.actionable, true);
  assert.equal(low.kind, 'ux');

  const ok = F.triage({ category: '感想・その他', rating: '5 - とても良い', message: 'とても分かりやすくて楽しかったです！' });
  assert.equal(ok.actionable, false);
  assert.equal(ok.needsInfo, false);
});

test('内容が短すぎるときは追加情報を求める', () => {
  const r = F.triage({ category: '不具合', message: 'え' });
  assert.equal(r.actionable, false);
  assert.equal(r.needsInfo, true);
});

test('アプリから開く URL に各項目が入り、長すぎる場合は省略される', () => {
  const url = new URL(F.buildIssueUrl({ rating: 4, category: 'ux', area: 'lab', message: '説明が\n難しい', context: 'ctx' }));
  assert.equal(url.pathname, `/${F.REPO}/issues/new`);
  const p = url.searchParams;
  assert.equal(p.get('template'), 'feedback.yml');
  assert.equal(p.get('title'), '[フィードバック] 分かりにくい: 説明が');
  assert.equal(p.get('rating'), '4 - 良い');
  assert.equal(p.get('category'), '分かりにくい');
  assert.equal(p.get('area'), 'ラボで体験 (シミュレーター)');
  assert.equal(p.get('message'), '説明が\n難しい');

  const long = F.buildIssueUrl({ category: 'bug', area: 'lab', message: 'あ'.repeat(5000), context: 'い'.repeat(3000) });
  assert.ok(long.length <= 7500, `length ${long.length}`);
  assert.equal(new URL(long).searchParams.get('context'), '(長すぎるため省略)');

  // 生成した値は、そのまま判定で同じカテゴリ・箇所として読める
  const back = F.triage({ category: p.get('category'), area: p.get('area'), rating: p.get('rating'), message: p.get('message') });
  assert.equal(back.kind, 'ux');
  assert.equal(back.area, 'lab');
  assert.equal(back.rating, 4);
});

test('課題 Issue の本文はメンションを無効化し、元のフィードバックにリンクする', () => {
  const fields = { message: '@octocat さん、表示が崩れます', context: '```危険```' };
  const r = F.triage({ category: '不具合', ...fields });
  const body = F.buildTaskIssueBody(r, fields, 12);
  assert.ok(body.includes('| 元のフィードバック | #12 |'));
  assert.ok(!body.includes('@octocat'));
  assert.ok(body.includes('~~~text'));
});

// ---------- Actions スクリプト (GitHub API はモック) ----------
function fakeGitHub(issue) {
  const calls = [];
  let nextNumber = 100;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.endsWith(`/issues/${issue.number}`)) return issue;
    if (method === 'POST' && path.endsWith('/labels') && !path.includes('/issues/')) {
      const e = new Error('exists'); e.status = 422; throw e;
    }
    if (method === 'POST' && /\/issues$/.test(path)) return { number: nextNumber++, ...body };
    if (method === 'POST' && path.endsWith(`/issues/${issue.number}/labels`)) {
      issue.labels.push(...body.labels.map((name) => ({ name })));
      return [];
    }
    return {};
  };
  return { api, calls };
}

const repo = 'owner/repo';

test('課題ありのフィードバックから課題 Issue を起票し、元の Issue にコメントとラベルを付ける', async () => {
  const issue = { number: 7, labels: [{ name: 'feedback' }], body: formBody({ rating: '2 - 不満', category: '不具合', area: 'ラボで体験 (シミュレーター)', message: '停止ボタンが押せない' }) };
  const { api, calls } = fakeGitHub(issue);
  const out = await triageIssue({ api, repo, issueNumber: 7, log: () => {} });
  assert.equal(out.created.number, 100);
  const create = calls.find((c) => c.method === 'POST' && c.path === `/repos/${repo}/issues`);
  assert.deepEqual(create.body.labels, ['課題', 'from-feedback', 'bug', 'priority:high']);
  assert.ok(create.body.body.includes('#7'));
  const comment = calls.find((c) => c.path === `/repos/${repo}/issues/7/comments`);
  assert.ok(comment.body.body.includes('#100'));
  assert.ok(issue.labels.some((l) => l.name === 'triaged'));
  assert.ok(issue.labels.some((l) => l.name === 'feedback:issue-created'));

  // opened と labeled の 2 回目の実行では何もしない (重複起票しない)
  const again = await triageIssue({ api, repo, issueNumber: 7, log: () => {} });
  assert.equal(again.skipped, true);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === `/repos/${repo}/issues`).length, 1);
});

test('課題なしのフィードバックはお礼のコメントとラベルだけ付ける', async () => {
  const issue = { number: 8, labels: [{ name: 'feedback' }], body: formBody({ rating: '5 - とても良い', category: '感想・その他', message: 'とても楽しく学べました' }) };
  const { api, calls } = fakeGitHub(issue);
  const out = await triageIssue({ api, repo, issueNumber: 8, log: () => {} });
  assert.equal(out.created, null);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === `/repos/${repo}/issues`).length, 0);
  assert.ok(issue.labels.some((l) => l.name === 'feedback:no-action'));
});

test('feedback ラベルのない Issue や dry run では書き込まない', async () => {
  const plain = { number: 9, labels: [{ name: 'bug' }], body: 'x' };
  const a = fakeGitHub(plain);
  assert.equal((await triageIssue({ api: a.api, repo, issueNumber: 9, log: () => {} })).skipped, true);

  const fb = { number: 10, labels: [{ name: 'feedback' }], body: formBody({ category: '不具合', message: '表示されない' }) };
  const b = fakeGitHub(fb);
  const out = await triageIssue({ api: b.api, repo, issueNumber: 10, dryRun: true, log: () => {} });
  assert.equal(out.result.actionable, true);
  assert.ok(b.calls.every((c) => c.method === 'GET'));
});

test('index.html の GitHub リンクは JavaScript なしでも正しいリンク先を持つ', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const anchors = [...html.matchAll(/<a\b[^>]*data-gh-link="([^"]+)"[^>]*>/g)];
  assert.ok(anchors.length >= 4);
  const base = `https://github.com/${F.REPO}`;
  const expected = {
    repo: base,
    issues: `${base}/issues`,
    feedback: `${base}/issues?q=${encodeURIComponent('is:issue label:feedback')}`,
    tasks: `${base}/issues?q=${encodeURIComponent('is:issue is:open label:課題')}`,
  };
  for (const [tag, kind] of anchors.map((m) => [m[0], m[1]])) {
    const href = /href="([^"]+)"/.exec(tag);
    assert.ok(href, `${kind} に href がありません`);
    assert.equal(href[1], expected[kind], kind);
  }
});
