/*
 * フィードバック関連の共通ロジック
 *
 * - ブラウザ: アプリ内フォームの選択肢と、GitHub の Issue フォームを開く URL の組み立て
 * - GitHub Actions (Node.js): Issue フォームの本文の解析と、課題かどうかのルール判定
 *
 * 選択肢をここに一元化しているので、.github/ISSUE_TEMPLATE/feedback.yml の
 * 項目名 (label) と id を変えるときは、この FIELDS も合わせて変更してください。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FeedbackKit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const REPO = 'MASAKIOKUDA-eng/-vpc-route-server-game';
  const TEMPLATE = 'feedback.yml';

  // Issue フォームの id と、本文に出力される見出し (label)
  const FIELDS = {
    rating: '満足度',
    category: 'カテゴリ',
    area: '該当箇所',
    message: '内容',
    context: '利用状況（自動入力）',
  };

  const RATINGS = [
    { value: 5, label: '5 - とても良い' },
    { value: 4, label: '4 - 良い' },
    { value: 3, label: '3 - ふつう' },
    { value: 2, label: '2 - 不満' },
    { value: 1, label: '1 - とても不満' },
  ];

  const CATEGORIES = [
    { id: 'bug', label: '不具合', hint: '動かない・表示が崩れる・ミッションをクリアできない など' },
    { id: 'content', label: '内容の誤り', hint: '解説・クイズ・構成図の内容が AWS の仕様と違う など' },
    { id: 'ux', label: '分かりにくい', hint: '説明や操作が理解しにくい・次に何をすればいいか迷う など' },
    { id: 'enhancement', label: '改善要望', hint: 'こんな機能やミッションがほしい など' },
    { id: 'other', label: '感想・その他', hint: '良かった点、その他なんでも' },
  ];

  const AREAS = [
    { id: 'learn', label: 'しくみを知る (解説)' },
    { id: 'lab', label: 'ラボで体験 (シミュレーター)' },
    { id: 'quiz', label: '理解度クイズ' },
    { id: 'other', label: '全体・その他' },
  ];

  // 課題の種類と、課題 Issue に付けるラベル
  const KINDS = {
    bug: { label: '不具合', labels: ['bug'] },
    content: { label: '内容の誤り', labels: ['content'] },
    ux: { label: '分かりにくさ', labels: ['ux'] },
    enhancement: { label: '改善要望', labels: ['enhancement'] },
  };

  // カテゴリが「感想・その他」でも課題として拾うためのキーワード
  const KEYWORDS = {
    bug: ['バグ', '不具合', '動かない', '動きません', '表示されない', '表示されません', 'エラー', '崩れ', '固まる', '固まり', 'フリーズ', 'クリアできない', 'クリアできません', '進めない', '進めません', '押せない', '反応しない'],
    content: ['間違', '誤り', '誤字', '正しくない', '仕様と違', '事実と違', '古い情報'],
    ux: ['分かりにく', 'わかりにく', '分かりづら', 'わかりづら', '難し', '理解でき', '迷っ', '迷う', '不親切', '見づら', '見にく', '読みにく'],
    enhancement: ['欲しい', 'ほしい', '追加して', 'してほしい', 'あると良い', 'あるといい', 'あると嬉しい', '対応して', '機能が欲', '増やして'],
  };
  const KEYWORD_ORDER = ['bug', 'content', 'ux', 'enhancement'];

  const NO_RESPONSE = '_No response_';
  const MAX_URL = 7500;

  // ---------- ブラウザ: Issue フォームを開く URL ----------
  function buildIssueUrl(input, repo = REPO) {
    const category = CATEGORIES.find((c) => c.id === input.category) || CATEGORIES[CATEGORIES.length - 1];
    const area = AREAS.find((a) => a.id === input.area) || AREAS[AREAS.length - 1];
    const rating = RATINGS.find((r) => r.value === Number(input.rating));
    const message = String(input.message || '').trim();
    const firstLine = message.split(/\r?\n/)[0].slice(0, 40);
    const params = new URLSearchParams({
      template: TEMPLATE,
      title: `[フィードバック] ${category.label}: ${firstLine || '(内容なし)'}`,
      rating: rating ? rating.label : '',
      category: category.label,
      area: area.label,
      message,
      context: String(input.context || ''),
    });
    let url = `https://github.com/${repo}/issues/new?${params.toString()}`;
    // URL が長すぎると GitHub が開けないので、利用状況 → 内容の順に削る
    if (url.length > MAX_URL) {
      params.set('context', '(長すぎるため省略)');
      url = `https://github.com/${repo}/issues/new?${params.toString()}`;
    }
    if (url.length > MAX_URL) {
      const over = url.length - MAX_URL;
      const trimmed = message.slice(0, Math.max(0, message.length - Math.ceil(over / 3) - 20));
      params.set('message', `${trimmed}\n(長すぎるため以降を省略)`);
      url = `https://github.com/${repo}/issues/new?${params.toString()}`;
    }
    return url;
  }

  // ---------- Actions: Issue フォーム本文の解析 ----------
  // GitHub の Issue フォームは「### 見出し\n\n値」の形で本文を出力する
  function parseIssueForm(body) {
    const out = {};
    const byLabel = Object.fromEntries(Object.entries(FIELDS).map(([id, label]) => [label, id]));
    const sections = String(body || '').replace(/\r\n/g, '\n').split(/^###\s+/m).slice(1);
    for (const sec of sections) {
      const nl = sec.indexOf('\n');
      const heading = (nl === -1 ? sec : sec.slice(0, nl)).trim();
      const value = (nl === -1 ? '' : sec.slice(nl + 1)).trim();
      const id = byLabel[heading];
      if (!id) continue;
      // render: text の項目はコードブロックで囲まれて出力されるので外す
      const unfenced = value.replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1').trim();
      out[id] = unfenced === NO_RESPONSE ? '' : unfenced;
    }
    return out;
  }

  function parseRating(text) {
    const m = /[1-5]/.exec(String(text || ''));
    return m ? Number(m[0]) : null;
  }

  function matchByLabel(list, text) {
    const t = String(text || '').trim();
    if (!t) return null;
    return list.find((x) => t === x.label || t.includes(x.label) || x.label.includes(t)) || null;
  }

  function findKeyword(message) {
    for (const kind of KEYWORD_ORDER) {
      const hit = KEYWORDS[kind].find((k) => message.includes(k));
      if (hit) return { kind, keyword: hit };
    }
    return null;
  }

  function summarize(message, max = 40) {
    const line = message.split('\n').map((l) => l.trim()).find((l) => l) || '';
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }

  // ---------- Actions: ルールによる判定 ----------
  function triage(fields) {
    const message = String(fields.message || '').trim();
    const rating = parseRating(fields.rating);
    const category = matchByLabel(CATEGORIES, fields.category);
    const area = matchByLabel(AREAS, fields.area);
    const reasons = [];
    const base = { rating, category: category ? category.id : null, area: area ? area.id : null, message, reasons };

    if (message.length < 4) {
      reasons.push('内容が空、または短すぎるため課題かどうか判定できません');
      return { ...base, actionable: false, needsInfo: true, kind: null, labels: [], priority: null, title: null };
    }

    let kind = null;
    if (category && KINDS[category.id]) {
      kind = category.id;
      reasons.push(`カテゴリが「${category.label}」`);
    } else {
      const hit = findKeyword(message);
      if (hit) {
        kind = hit.kind;
        reasons.push(`内容にキーワード「${hit.keyword}」を含む`);
      } else if (rating !== null && rating <= 2) {
        kind = 'ux';
        reasons.push(`満足度が ${rating} (2 以下)`);
      }
    }

    if (!kind) {
      reasons.push('課題を示すカテゴリ・キーワード・低い満足度のいずれにも当てはまりません');
      return { ...base, actionable: false, needsInfo: false, kind: null, labels: [], priority: null, title: null };
    }

    let priority = kind === 'bug' || kind === 'content' ? 'medium' : 'low';
    if (rating !== null && rating <= 2) {
      priority = kind === 'bug' || kind === 'content' ? 'high' : 'medium';
      if (!reasons.some((r) => r.startsWith('満足度'))) reasons.push(`満足度が ${rating} (2 以下) のため優先度を上げる`);
    }

    return {
      ...base,
      actionable: true,
      needsInfo: false,
      kind,
      labels: [...KINDS[kind].labels, `priority:${priority}`],
      priority,
      title: `[課題] ${KINDS[kind].label}: ${summarize(message)}`,
    };
  }

  const PRIORITY_LABEL = { high: '高', medium: '中', low: '低' };

  // メンション (@user) で通知が飛ばないようにし、引用として整形する
  function quote(text) {
    return String(text).replace(/@/g, '@​').split('\n').map((l) => `> ${l}`).join('\n');
  }

  function fence(text) {
    return `~~~text\n${String(text).replace(/~~~/g, '~ ~ ~').replace(/@/g, '@​')}\n~~~`;
  }

  function buildTaskIssueBody(result, fields, sourceNumber) {
    const area = AREAS.find((a) => a.id === result.area);
    const rows = [
      ['種類', KINDS[result.kind].label],
      ['優先度', PRIORITY_LABEL[result.priority]],
      ['該当箇所', area ? area.label : '(未指定)'],
      ['満足度', result.rating === null ? '(未回答)' : String(result.rating)],
      ['元のフィードバック', `#${sourceNumber}`],
    ];
    return [
      `<!-- feedback-triage: source=#${sourceNumber} -->`,
      '## フィードバックの内容',
      '',
      quote(result.message),
      '',
      '| 項目 | 内容 |',
      '| --- | --- |',
      ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      '',
      '## 課題と判定した理由',
      '',
      ...result.reasons.map((r) => `- ${r}`),
      '',
      '## 利用状況',
      '',
      fields.context ? fence(fields.context) : '(なし)',
      '',
      '---',
      `このIssueはフィードバック #${sourceNumber} からルールに基づいて自動で起票されました。判定が誤っている場合は閉じてください。`,
    ].join('\n');
  }

  return {
    REPO, TEMPLATE, FIELDS, RATINGS, CATEGORIES, AREAS, KINDS, KEYWORDS, PRIORITY_LABEL,
    buildIssueUrl, parseIssueForm, parseRating, triage, buildTaskIssueBody, summarize,
  };
});
