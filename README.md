# SecretAIry（セクレタイリー）

架空の美容室「omochi」のための AI 秘書です。AI は予約の「仮押さえ」や案づくりまで。**確定するのは、いつも人のボタン**です。

> 今は骨組みの段階です。画面の形と設定の置き場所だけがあり、中身はこれから作ります。

## できること（予定）

- 予約チャット（AI は仮押さえまで）
- 1週間の予約台帳
- カルテ自動作成（案を作り、人が承認）
- 朝の要点
- オーナーの承認（確定は人のボタンだけ）
- LINE（オーナー側）：画面の合言葉でオーナーの LINE とつなぎ、一言で仮押さえ・ToDo・カルテのメモを頼む。承認待ちを LINE に届けて押す。朝の要点を LINE に送る（画面を開いている間だけ動きます）
- 経理：架空の10月の売上（見るだけ）と、通販の明細の仕分け。購入先ごとの「自動のルール」で分け、ルールの無い物だけ人が店用か私用を選んで「会計（架空）」に登録します（AI は使いません）

タブ：ホーム・予約・カルテ・広告・経理・ToDo・発信・ルール

## 動かし方

```bash
npm install
npm run dev
```

http://localhost:3000 を開きます。

ルールの判定のテスト：

```bash
npm test
```

## 店の設定

店ごとに変わる物は `config/` にあります。

データはサーバーに保存しません。`config/` が最初の状態で、画面で触った後の変化は見ている人のブラウザの中だけに残ります。

| ファイル | 中身 |
|---|---|
| `config/shop.json` | 店名・営業時間・席数など |
| `config/menus.json` | メニュー |
| `config/karte.json` | カルテの見出し |
| `config/tabs.json` | タブを出す・隠す |
| `config/accounting.json` | 経理の札（「会計（架空）」など） |
| `config/line.json` | LINE のつなぎ：合言葉の期限・つながる時間・1日に送る上限など |
| `config/rules.seed.json` | 例のルール（ルールはルールのタブから変えます） |

架空のお客様・予約などの最初の状態は `seed/` にあります（お客様はみな架空です）。

## LINE とつなぐ（オーナー側）

Vercel の環境変数に入れる物（リポジトリには書きません。手元では `.env.local`）：

| 名前 | 中身 |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE のチャネルの秘密。届いた知らせの署名を確かめる |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE に返事・送るときの鍵 |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis（Vercel がつないだときに自動で入る名前。`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` でも読む） |

- LINE の Webhook の URL は `https://<公開URL>/api/line`。
- Redis に置くのは「合言葉のつなぎ」と「画面が受け取りに来るまでの LINE の知らせ」だけ（どれも期限つき）。お客様の記録や台帳は置きません。
- ホームの「LINE とつなぐ」で6けたの合言葉が出ます。店の LINE 公式アカウントにオーナーの LINE から送るとつながります。
- 画面は開いている間、数秒ごとに受け取りに行きます（`config/line.json` の `pollSeconds`）。Redis の命令は1回に2〜3つ使います。

## 文書

- [仕様書](docs/SPEC.md)
- [開発のきまり（CLAUDE.md）](CLAUDE.md)
