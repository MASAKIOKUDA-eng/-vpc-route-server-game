#!/usr/bin/env node
/*
 * フィードバック Issue を判定し、課題があれば課題 Issue を起票する (GitHub Actions から実行)
 *
 * 環境変数:
 *   GITHUB_TOKEN       Issue の読み書き権限を持つトークン (Actions の secrets.GITHUB_TOKEN)
 *   GITHUB_REPOSITORY  owner/repo (Actions が自動で設定)
 *   GITHUB_EVENT_PATH  イベントのペイロード (Actions が自動で設定)
 *   ISSUE_NUMBER       手動実行 (workflow_dispatch) で判定し直す Issue 番号 (任意)
 *   DRY_RUN=1          GitHub に書き込まず、判定結果だけを表示する
 */
'use strict';

const fs = require('fs');
const F = require('../js/feedback.js');

const LABELS = {
  feedback: { color: '0e8a16', description: 'アプリ利用者からのフィードバック' },
  triaged: { color: 'c5def5', description: 'フィードバックの自動判定が完了' },
  'feedback:issue-created': { color: 'd93f0b', description: 'フィードバックから課題 Issue を起票済み' },
  'feedback:no-action': { color: 'cfd3d7', description: 'フィードバックに課題は見つからなかった' },
  'needs-info': { color: 'fbca04', description: '判定に必要な情報が不足している' },
  '課題': { color: 'b60205', description: 'フィードバックから起票された改善課題' },
  'from-feedback': { color: 'bfdadc', description: 'フィードバックをもとに自動起票' },
  bug: { color: 'd73a4a', description: '不具合' },
  content: { color: '5319e7', description: '解説・クイズ・構成図の内容の誤り' },
  ux: { color: '1d76db', description: '分かりにくさの改善' },
  enhancement: { color: 'a2eeef', description: '改善要望' },
  'priority:high': { color: 'b60205', description: '優先度: 高' },
  'priority:medium': { color: 'fbca04', description: '優先度: 中' },
  'priority:low': { color: '0e8a16', description: '優先度: 低' },
};

function githubApi(token, fetchImpl = fetch) {
  return async function api(method, path, body) {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}: ${data && data.message}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

async function ensureLabels(api, repo, names) {
  for (const name of names) {
    const def = LABELS[name] || { color: 'ededed', description: '' };
    try {
      await api('POST', `/repos/${repo}/labels`, { name, ...def });
    } catch (e) {
      if (e.status !== 422) throw e; // 422 = 既に存在する
    }
  }
}

/**
 * 1 件のフィードバック Issue を処理する。
 * 戻り値: { skipped, reason } または { result, created }
 */
async function triageIssue({ api, repo, issueNumber, dryRun = false, log = console.log }) {
  // イベントのペイロードは古い場合があるので、常に最新の Issue を取得する
  const issue = await api('GET', `/repos/${repo}/issues/${issueNumber}`);
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  if (issue.pull_request) return { skipped: true, reason: 'Pull Request のため対象外' };
  if (!labels.includes('feedback')) return { skipped: true, reason: 'feedback ラベルがないため対象外' };
  if (labels.includes('triaged')) return { skipped: true, reason: '判定済みのため対象外' };

  const fields = F.parseIssueForm(issue.body);
  const result = F.triage(fields);
  log(`#${issueNumber}: ${result.actionable ? `課題あり (${result.kind}, priority:${result.priority})` : '課題なし'}`);
  for (const r of result.reasons) log(`  - ${r}`);
  if (dryRun) return { result, created: null };

  let created = null;
  const reasons = result.reasons.map((r) => `- ${r}`).join('\n');
  if (result.actionable) {
    const taskLabels = ['課題', 'from-feedback', ...result.labels];
    await ensureLabels(api, repo, [...taskLabels, 'triaged', 'feedback:issue-created']);
    created = await api('POST', `/repos/${repo}/issues`, {
      title: result.title,
      body: F.buildTaskIssueBody(result, fields, issueNumber),
      labels: taskLabels,
    });
    await api('POST', `/repos/${repo}/issues/${issueNumber}/comments`, {
      body: `フィードバックありがとうございます！\n\n内容を確認し、改善の課題として #${created.number} を起票しました。\n\n**判定理由**\n${reasons}`,
    });
    await api('POST', `/repos/${repo}/issues/${issueNumber}/labels`, { labels: ['triaged', 'feedback:issue-created'] });
  } else {
    const label = result.needsInfo ? 'needs-info' : 'feedback:no-action';
    await ensureLabels(api, repo, ['triaged', label]);
    const body = result.needsInfo
      ? `フィードバックありがとうございます！\n\n内容が短いため、課題かどうかを自動で判定できませんでした。よろしければ、困ったことや気づいたことをもう少し詳しくコメントで教えてください。\n\n**判定理由**\n${reasons}`
      : `フィードバックありがとうございます！\n\n自動判定では、すぐに対応が必要な課題は見つかりませんでした。いただいた内容は今後の改善の参考にします。\n\n**判定理由**\n${reasons}`;
    await api('POST', `/repos/${repo}/issues/${issueNumber}/comments`, { body });
    await api('POST', `/repos/${repo}/issues/${issueNumber}/labels`, { labels: ['triaged', label] });
  }
  return { result, created };
}

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY と GITHUB_TOKEN が必要です');
  let issueNumber = Number(process.env.ISSUE_NUMBER) || null;
  if (!issueNumber && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    issueNumber = event.issue && event.issue.number;
  }
  if (!issueNumber) throw new Error('対象の Issue 番号が分かりません');

  const out = await triageIssue({ api: githubApi(token), repo, issueNumber, dryRun: process.env.DRY_RUN === '1' });
  if (out.skipped) {
    console.log(`#${issueNumber}: スキップ (${out.reason})`);
    writeSummary(`#${issueNumber}: スキップ (${out.reason})`);
  } else if (out.created) {
    writeSummary(`#${issueNumber} → 課題 #${out.created.number} を起票しました (${out.result.kind}, priority:${out.result.priority})`);
  } else {
    writeSummary(`#${issueNumber}: ${out.result.actionable ? '課題あり (dry run)' : '課題なし'}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { triageIssue, githubApi, ensureLabels, LABELS };
