# Route Server Lab — VPC Route Server 体験ゲーム

AWS の **VPC Route Server** を、ブラウザ上で手を動かしながら学べるシミュレーターです。
初学者がつまずきやすい「Route Server / エンドポイント / ピア / 伝播 / RIB・FIB / BFD / 経路の永続化」を、
構成図とパケットのアニメーションで体験できます。

## 遊び方

ビルドは不要です。`index.html` をブラウザで開くか、ローカルサーバーを起動してください。

```bash
npm start            # = python3 -m http.server 8000
# → http://localhost:8000 を開く
```

GitHub Pages などの静的ホスティングにそのまま置いても動きます。

## 構成

| タブ | 内容 |
| --- | --- |
| 1. しくみを知る | Route Server の役割、構成要素、経路選択、BFD、経路の永続化の解説 |
| 2. ラボで体験 | 構成図付きのシミュレーター。11 個のミッションを順にクリアしていきます |
| 3. 理解度クイズ | 8 問の確認クイズ (解説付き) |

### ミッション

1. Route Server を作成する
2. VPC に関連付ける
3. 2 つの AZ にエンドポイントを作る
4. ルートテーブルへの伝播を有効にする
5. アプライアンス (Firewall-A / B) と BGP ピアを張る
6. 通信が流れることを確認する (MED によるベストパス選択)
7. Firewall-A を停止してフェイルオーバーを観察する (ブラックホール期間の体感)
8. BFD で切替を 3 秒以内にする
9. MED / AS_PATH プリペンドで優先度を変える
10. エンドポイント障害に耐える構成を確認する
11. 経路の永続化 (Persist routes) を試す

各操作には対応する AWS CLI コマンド (`create-route-server`、`create-route-server-peer` など) がイベントログに表示されます。
「完成構成で自由に遊ぶ」でミッションをスキップして自由に実験することもできます。

## 開発

```
index.html        画面
css/style.css     スタイル (白基調)
assets/aws/       構成図用の AWS Architecture Icons
js/sim.js         シミュレーションエンジン (DOM 非依存、Node.js でもテスト可能)
js/app.js         UI・ミッション・クイズ・フィードバックフォーム
js/feedback.js    フィードバックの選択肢・URL 生成・判定ルール (ブラウザと Actions で共用)
scripts/triage-feedback.js          フィードバックを判定して課題 Issue を起票するスクリプト
.github/ISSUE_TEMPLATE/feedback.yml フィードバック用の Issue フォーム
.github/workflows/feedback-triage.yml 判定を実行する GitHub Actions
test/             テスト
```

```bash
npm test
```

## フィードバック → 課題 Issue の起票

```
アプリの「💬 フィードバック」
   │  満足度・カテゴリ・該当箇所・内容・利用状況を入力
   ▼
GitHub の Issue フォーム (feedback.yml) が入力済みで開く → 利用者が送信
   │  feedback ラベル付きの Issue が作成される
   ▼
GitHub Actions (feedback-triage.yml) がルールで判定
   ├─ 課題あり → 課題 Issue を起票 (ラベル: 課題 / from-feedback / 種類 / 優先度)
   │             元のフィードバックにお礼と課題 Issue へのリンクをコメント
   ├─ 課題なし → お礼をコメントし feedback:no-action ラベル
   └─ 内容不足 → 詳しく教えてほしいとコメントし needs-info ラベル
```

- 送信には GitHub アカウントが必要です。Issue は公開されます。
- 判定ルールは `js/feedback.js` の `triage()` にあります。
  - カテゴリが「不具合」「内容の誤り」「分かりにくい」「改善要望」なら課題とします。
  - 「感想・その他」でも、内容にキーワード (「動かない」「間違い」「分かりにくい」「ほしい」など) を含むか、満足度が 2 以下なら課題とします。
  - 優先度は種類と満足度で決めます (不具合・内容の誤り × 満足度 2 以下 = 高)。
- 判定済みの Issue には `triaged` ラベルが付き、二重に起票されません。判定し直すときは `triaged` ラベルを外し、Actions の「フィードバックの判定と課題の起票」を Issue 番号を指定して手動実行します。
- 必要なラベルは初回実行時に自動で作成されます。シークレットの追加は不要です (Actions 標準の `GITHUB_TOKEN` を使います)。
- 判定だけを試す: `DRY_RUN=1 GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo ISSUE_NUMBER=1 node scripts/triage-feedback.js`

## 構成図について

構成図は AWS Architecture Icons (Light BG 版) の作図ルールに沿って、
AWS Cloud → Region → VPC → Availability Zone → Private subnet のグループを入れ子にして描いています。
VPC Route Server には専用アイコンがないため、Amazon VPC の Router アイコンで表しています。
Route Server エンドポイントはサブネット内の ENI として作られるため、Elastic network interface アイコンを使っています。

## 注意

学習用に単純化したシミュレーターです。検知時間 (BFD 1 秒 / キープアライブ 30 秒) やタイブレークなどは
説明のための値で、実際の AWS の挙動とは異なります。正確な仕様は AWS 公式ドキュメントを参照してください。
