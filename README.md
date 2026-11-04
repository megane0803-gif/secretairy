# SecretAIry（セクレタイリー）

## 何か

1人で営業する美容室のための AI 秘書です。
お客様の予約は AI が「仮押さえ」まで。確定はオーナーがボタンを押します。
お客様・店・数字はすべて架空です（店の名前「omochi」も架空です）。

## この期間中に作成

2026年11月2日〜8日の大会の期間中に、新しく作った物です（最初のコミットは 2026年11月3日）。

## できること

- 予約チャット（AI は仮押さえまで。確定はオーナーの承認だけ）
- 1週間の予約台帳と、予約サイト（架空）
- カルテ自動作成（AI は案まで。言葉の門を通し、人が「保存」を押す）
- カルテ：録音からメモを作る（PC だけ。録音のファイル・画面の録音・録音フォルダから。2〜4時間の録音でも読めます。声はブラウザの中で Whisper が文字にします）
- 朝の要点（今日の予約・承認待ち・ToDo・前回の次回提案・空き枠）
- オーナーの承認（承認の箱。確定は人のボタンだけ）
- 広告の見直し（AI が案を1つ → プログラムの門 → 承認の箱）
- 経理：架空の10月の売上（見るだけ）と、通販の明細の仕分け（購入先ごとの「自動のルール」。AI は使いません）
- ToDo：メモを投げる（AI が短いタスクの文に直す）・カルテの次回話すこと・広告の判定日・予約の「別の日時を案内」・LINE の一言を1つの一覧に。並べ方はプログラム（期限あり → 次回話すこと → 投げたメモ → 期限なし）。ホームに「今やる3件」
- LINE（オーナー側）：画面の合言葉でオーナーの LINE とつなぎ、一言で仮押さえ・ToDo・カルテのメモを頼む。承認待ちを LINE で押す。朝の要点を LINE に送る（画面を開いている間だけ動きます）
- ルール：オーナーが足す・直す・消す（ぶつかったら厳しい方）。🔒 鍵つきの2つ（確定は人・健康や医療の判断はしない）は緩められません

タブ：ホーム・予約・カルテ・広告・経理・ToDo・発信・ルール。くわしくは [仕様書](docs/SPEC.md)。

## AI の費用

AI の費用は1店あたり多くて月3,000円ほど（試算）。お店の月額に含め、使いすぎない上限つき。

上限はどれも `config/ai.json` と `config/line.json` にあります（お客様の1回の文の長さ・返事の長さ・1回の相談で道具を呼ぶ回数・LINE の1日の送る通数 など）。AI を呼ぶ窓口は全部 `/api/ai/` の下にあり、Vercel の Firewall で `/api/ai/` を1分10回までにしています。

## 動かし方

```bash
npm install
npm run dev
```

http://localhost:3000 を開きます。AI の鍵が無くても、各画面の「決まった返事（AI なし）」で同じ流れを試せます。

```bash
npm test           # テスト（Claude・LINE・Redis は呼びません）
npm run typecheck  # 型の確認
npm run build      # 本番ビルド
```

### 公開 URL

- 公開 URL：https://secretairy.vercel.app （Vercel）
- LINE の Webhook の URL：`https://secretairy.vercel.app/api/line`（LINE Developers の Messaging API の設定に入れる）

### 環境変数

手元では `.env.local`、Vercel では環境変数に入れます。中身はリポジトリに書きません（`.env` で始まるファイルはコミットしません）。

| 名前 | 要る？ | 中身 |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI を使うとき | Claude API の鍵 |
| `ANTHROPIC_MODEL` | 任意 | 予約チャット・広告の見直しのモデル名を差しかえる（無ければ `config/ai.json`） |
| `ANTHROPIC_KARTE_MODEL` | 任意 | カルテのモデル名を差しかえる |
| `ANTHROPIC_LINE_MODEL` | 任意 | LINE の一言の振り分けのモデル名を差しかえる |
| `LINE_CHANNEL_SECRET` | LINE を使うとき | LINE のチャネルの秘密。届いた知らせの署名を確かめる |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE を使うとき | LINE に返事・送るときの鍵 |
| `LINE_OWNER_PASSCODE` | 任意 | オーナー用の合言葉。あれば「LINE とつなぐ」を押す時にこの合言葉を求める。無ければ求めない |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | LINE を使うとき | Upstash Redis（Vercel がつないだときに自動で入る名前。`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` でも読む） |

## データの置き場所

データはサーバーに保存しません。`config/`・`seed/` が最初の状態で、画面で触った後の変化は見ている人のブラウザの中だけに残ります（公開 URL を見た人どうしでデータが混ざらないように）。

- 例外は LINE のつなぎだけ：Redis に「合言葉のつなぎ」と「画面が受け取りに来るまでの LINE の知らせ」を期限つきで置きます。お客様の記録・台帳・日誌は置きません。
- AI を呼ぶ窓口は、ブラウザから要るデータとルールを毎回受け取り、答えを返すだけで、受け取った物を残しません。
- 録音からメモを作るときの、文字・要点・画面で録った区切りは、ブラウザの中（IndexedDB）に残します。声も文字もサーバーには残しません。
- ホームの「最初に戻す」1回で、予約・カルテ（録音から作った文字と要点も）・広告・経理・LINE の預かりが全部最初に戻ります（日誌・ルールのタブの変更・LINE のつなぎは残ります）。

| ファイル | 中身 |
|---|---|
| `config/shop.json` | 店名・営業時間・席数など |
| `config/menus.json` | メニュー |
| `config/ai.json` | AI のモデル名と上限 |
| `config/karte.json` | カルテの見出し |
| `config/recording.json` | 録音からメモを作る：受ける形・上限（4時間半・300MB）・区切りの長さ・黙っている所の見分け方・Whisper のモデル |
| `config/ads.json` | 広告の札・売りのメニュー・架空の町の名前 |
| `config/accounting.json` | 経理の札（「会計（架空）」など） |
| `config/line.json` | LINE のつなぎ：合言葉の期限・つながる時間・1日に送る上限など |
| `config/posts.json` | 発信の下書きの種類（指示文・材料の欄・長さの目安）・言葉の門の言葉 |
| `config/tabs.json` | タブを出す・隠す |
| `config/rules.seed.json` | 例のルール（ルールはルールのタブから変えます） |

## LINE とつなぐ（オーナー側）

- ホームの「LINE とつなぐ」で6けたの合言葉が出ます（10分・1回だけ）。店の LINE 公式アカウントにオーナーの LINE から送るとつながります。
- 環境変数 `LINE_OWNER_PASSCODE` があるときは、「LINE とつなぐ」を押す前にオーナー用の合言葉を入れます（何回もまちがえると10分ほど受けません）。無ければ今のまま、画面の合言葉だけでつなげます。
- LINE のボタンで確定してよいのは、合言葉でつないだ LINE の人が押した物だけです。一言や AI の答えからは確定しません。
- 画面は開いている間、数秒ごとに受け取りに行きます（`config/line.json` の `pollSeconds`）。

## 録音からメモを作る（カルテのタブ・PC だけ）

声はこの PC のブラウザの外に出しません。文字にした中身は、要点とカルテを作るために Claude に送ります。

録音は、お客様の了解を得てから行ってください。

- 入口は3つ：ファイルを選ぶ（落としてもよい）・「録音」ボタン（PC につないだマイクから、ブラウザが録る）・「録音フォルダを選ぶ」（PC の Chrome・Edge だけ。画面を開いている間、入った新しい録音を読む）。
- 2〜4時間の録音でも読めます（受けるのは4時間半・300MBまで。`config/recording.json`）。10分くらいずつに区切って読み、黙っている所や音だけの所は飛ばします。
- 文字にするのは、ブラウザの中（Web Worker）で動かす Whisper です。WebGPU が使えれば大きめのモデル（large-v3-turbo）、使えなければ小さいモデル（base）に自動で切り替えます。初回はモデルの読み込みに時間がかかります（大きさは画面に出します）。2回目からはブラウザに覚えさせます。
- 区切りごとの文字を Claude（Haiku）が短い要点にし（雑談は捨てる）、全部の要点を施術のメモに入れて、今までどおり「カルテにする」→ 言葉の門 →「保存」（人）です。お客様の名字は〔お客様〕に置きかえてから送ります。
- 途中で止めても、済んだ区切りの文字はブラウザの中（IndexedDB）に残り、続きから再開できます。ホームの「最初に戻す」で消えます。

おすすめは、本体に録音できる胸元のワイヤレスマイク。作者のお店では、これで施術中の会話を録り、終わったら PC に移して置いています。録音できないマイクでも、受信機を PC につないで画面の録音ボタンで録れます。受けるのは m4a・mp3・wav・aac です。

## 使った物と権利

### ライブラリ

| 名前 | 使い道 | ライセンス |
|---|---|---|
| [Next.js](https://nextjs.org/)（`next`） | 画面とサーバーの窓口 | MIT |
| [React](https://react.dev/)（`react`・`react-dom`） | 画面 | MIT |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)（`@anthropic-ai/sdk`） | Claude API を呼ぶ | Apache-2.0 |
| [TypeScript](https://www.typescriptlang.org/) | 型 | Apache-2.0 |
| [tsx](https://github.com/privatenumber/tsx) | テストを動かす | MIT |
| `@types/node`・`@types/react`・`@types/react-dom` | 型の定義 | MIT |
| [Transformers.js](https://github.com/huggingface/transformers.js)（`@huggingface/transformers`） | ブラウザの中（Web Worker）で Whisper を動かし、録音を文字にする | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)（`onnxruntime-web`。Transformers.js が中で使う） | モデルを WebGPU・WebAssembly で動かす | MIT |

### モデル（録音を文字にする）

| 名前 | 使い道 | ライセンス |
|---|---|---|
| [Whisper](https://github.com/openai/whisper)（OpenAI） | 声を文字にするモデル（日本語） | MIT（コードとモデルの重み） |
| [onnx-community/whisper-large-v3-turbo](https://huggingface.co/onnx-community/whisper-large-v3-turbo) | WebGPU が使える PC で使う（Whisper large-v3-turbo を ONNX にした物） | MIT |
| [onnx-community/whisper-base](https://huggingface.co/onnx-community/whisper-base) | WebGPU が使えない PC で使う（Whisper base を ONNX にした物） | MIT |

モデルは、初回に Hugging Face から読み込んで、ブラウザに覚えさせます（読み込むだけで、声や文字は送りません）。

ほかに、これらが中で使うライブラリがあります（`package-lock.json`）。LINE と Upstash Redis は SDK を使わず、それぞれの公開の API を `fetch` で呼んでいます。

### サービス

| 名前 | 使い道 | 権利・決まり |
|---|---|---|
| Claude API（Anthropic） | 予約チャット・カルテの案・録音の要点・広告の案・LINE の一言の振り分け | Anthropic の利用規約に従って使う |
| LINE Messaging API（LINE ヤフー） | オーナーの LINE とのつなぎ | LINE 公式アカウントの規約に従って使う |
| Vercel | 公開（ホスティング）・Firewall | Vercel の利用規約に従って使う |
| Upstash Redis（Vercel からつなぐ） | LINE のつなぎと預かり（期限つき） | Upstash の利用規約に従って使う |
| Hugging Face Hub | 録音を文字にするモデル（Whisper）を、ブラウザが初回に読み込む | 各モデルのライセンス（上の表）に従って使う |

画面にも README にも、実在の会計サービス・カード会社・広告サービスの名前は出していません（「会計（架空）」などの札）。お客様・店・住所・数字はすべて架空で、実在の人や店とは関係ありません。

## ライセンス

[MIT](LICENSE)（仮に置いています。後で変えることがあります）。

## 文書

- [仕様書](docs/SPEC.md)
- [開発のきまり（CLAUDE.md）](CLAUDE.md)
