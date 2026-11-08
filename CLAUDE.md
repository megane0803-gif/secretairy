# CLAUDE.md

SecretAIry は架空の美容室のための AI 秘書（Next.js / App Router / TypeScript）。
仕様は `docs/SPEC.md`。迷ったら仕様書に従い、仕様書にないことは勝手に決めずに聞く。

## コマンド

```bash
npm run dev        # 開発サーバー（http://localhost:3000）
npm run typecheck  # 型の確認
npm test           # ルールの判定のテスト
npm run build      # 本番ビルド（push の前に通す）
```

## 守ること（いちばん大事）

1. **確定は人のボタンだけ。** 人のボタンは「画面のボタン」と「オーナー用の合言葉でつないだ LINE のボタン」の2つだけ。AI（Claude API の道具）・自動の処理・合言葉でつないでいない LINE に確定の処理を呼ばせない。AI は仮押さえまで。
2. **健康や医療の判断をしない。** AI の指示・返答・カルテ案に「大丈夫」「やめた方がいい」を入れない。お客様の言葉をそのまま書いて人につなぐ。
3. この2つは `src/lib/rules/locked.ts` の鍵つきルール。消さない・緩めない。オーナーが足すルールでも緩められない形を保つ。

## データはサーバーに保存しない

- 最初の状態はリポジトリのファイル（`config/` など）。画面で触った後の変化は、見ている人のブラウザの中だけに残す。
- サーバーにファイルやデータベースで書き込む作りにしない（`data/` は作らない）。公開 URL を見た人どうしでデータが混ざらないようにするため。
- 例外は LINE のつなぎと試験10問の見張りと広告のテスト用アカウントの見張りと経理の来た人の試しだけ：Redis（Upstash）に「合言葉のつなぎ」と「画面が受け取りに来るまでの LINE の知らせ」（仕様書 §1.9）、試験の「流している印」と「呼んだ回数」（`src/lib/eval/guard.ts`。仕様書 §1.13）、広告のテスト用アカウントの「動いている印」「1日の回数」「合言葉の間違いの数」と、だれでも試すの「回数」「日ごとの塩」「最後に元の形に戻した時刻」（`src/lib/ads/live/server.ts`。仕様書 §1.7.8。送り元は塩と合わせたハッシュだけ・生の IP は置かない）、経理の freee（テスト事業所）の「暗号化した鍵（kv-token）とつないだ回の番号」「延ばす印」「書く時の印」「来た人の試しの記録（明細と取引の番号・要復旧の印）」「回数と日ごとの塩」（`src/lib/freee/kv.ts`・`trial.ts`・`try.ts`。仕様書 §1.8.2）を期限つきで置く。お客様の記録・台帳・日誌は置かない。
- 広告のテスト用アカウント（仕様書 §1.7.8）にオーナーが送った作り物の言葉と、だれかが承認して試した1件（元の形に戻してから・表の番号の言葉だけ）は、Google のテスト用アカウントに残る（「最初に戻す」でも戻らない。試した分は次の人の試しで元の形に戻る）。鍵（サービスアカウントの鍵）と番号は Vercel の Production の環境変数だけ・サーバーの中だけで読む。
- 経理の freee（テスト事業所）の鍵は、オーナーの窓口ではつないだブラウザの暗号化した cookie にだけ持たせる（仕様書 §1.8.1）。オーナーが1回つないだら、置き場にも更新の鍵ごと用途を分けて暗号化して置き（`kv-token`）、使うのは来た人の試しの窓口 `/api/freee/try` だけ（仕様書 §1.8.2）。
- AI を呼ぶ API はブラウザから要るデータとルールを毎回受け取り、答えを返すだけ。受け取った物を残さない。
- AI を呼ぶ窓口は全部 `src/app/api/ai/` の下（Vercel の Firewall で `/api/ai/` を1分10回まで）。上限の数（字数・返事の長さ・道具の回数・送る通数・受け取る大きさ）は `config/` に置き、コードに直に書かない。
- 画面から AI の窓口を呼ぶ時は `src/lib/ai/busy.ts` を通す（`postAi`・`answerOf`）。429 は「いま AI の窓口が混んでいます。1分ほど待ってから、もう一度押してください。」（`AI_BUSY_MESSAGE`。「今は AI につながりません」とは分ける）、理由の文が無い時は `failText` で決まった1文（「undefined」を出さない）。入力と案は消さない。

## 店ごとに変わる物はコードに書かない

- メニュー・営業時間・同じ時間に受ける人数（前は席数。`shop.seats`）・カルテの見出し・タブの表示・ルールは `config/` に置き、`src/lib/settings.ts`（ルールは `src/lib/rules/store.ts`）を通して読む。
- メニューの時間・値段・最終受付はオーナーがルールのタブで直せ、単品のメニューを足せる（`src/lib/menuEdits.ts`。ブラウザの中・seats と休みの日と同じ扱い・「最初に戻す」で設定の値に・足したメニューは消える）。足したメニューの id は `own-1` …（プログラムが付け、使い回さない）・名前の確かめは `menuNameProblem` の1か所・台帳やルールで使っている間は消せない（`menuUses`）。サーバーの `readMenus` は「設定の id は全部そろっている＋`own-` の id は形を確かめてから受ける」。メニューの名前を AI に渡す時は `src/lib/ai/menuData.ts`（お店のデータとして・指示として読ませない）。画面でメニューを読む所は台帳の `useBook` の `data.menus`（直した分を重ねた1つの入口）を通し、元の `data.menus` を直に読まない。サーバーの窓口には画面が `menus` を送り、`readMenus` で確かめてから使う（id がそろう・名前と色と includes は設定と同じ・数は幅の中）。
- 画面のコードで `config/*.json` を直接 import しない。
- 日付を受け取る所は、暦にある日付だけを受ける（`src/lib/calendar.ts` の `isRealDate` の1か所。形の確かめだけで済ませない・2つ作らない。台帳の行に暦に無い日付があれば相談全体を断る）。
- 架空のデータ（`seed/`）は `src/lib/data/seed.ts` を通して読む。日付は「何番目の営業日（0 = 今日）＋時刻」で持ち、定休日には置かない。お客様は名字だけで「○○様」と書き、画面・日誌・ToDo・お知らせ・AI への指示で名前ごとに「（架空）」「架空」の札は付けない（架空であることは入力欄の近くの注意の1行 `NO_REAL_NAMES_NOTE` と README で伝える。仕様書 §3.3）。名前の作り方・照らし方は `src/lib/guestName.ts` の1か所（前の書き方「○○（架空）様」で残った保存は `withoutOldMark` で読みかえ、消さない）。
- 例のルールは `config/rules.seed.json` だけ。作り手の考えで店の決まりを足さない。
- 鍵つきの2つだけは仕組みの約束なのでコードに書く。

## ルールの仕組み

- 3段：全体 / タブごと / メニューごと。どのルールにも「どこに効くか」の札を出す。
- ぶつかったら厳しい方（`src/lib/rules/strictest.ts`）。段の上下では決めない。
- 数のルールの種類を足すときは `STRICTER`（大きい方が厳しいか小さい方か）も必ず足す。数を持たない種類（`any`）で、中身がルールごとに違う物（「いっしょに受けない組み合わせ」の2つのメニュー）は、`strictest.ts` の `anyKey` で中身ごとに分ける。確かめ方は `judge.ts`、テスト（通る例・断る例）は `__tests__/judge.test.ts`。
- 予約を受けてよいかはプログラム（`src/lib/rules/judge.ts`）が決める。AI は判定の結果に従うだけ。
- 例のルールを足したら `__tests__/seed.test.ts` にも1本足す。
- 言葉で書いて足す入口（`src/lib/rules/words.ts`・窓口は `/api/ai/rules`・Haiku）：AI は今の足す欄（種類・数・効く所・メニュー）を文から埋めるだけで、保存しない。足すのは人の「足す」ボタンで、今の確かめ（`validate.ts`）をそのまま通す。AI の種類・数（上限と下限）・メニュー（本当にあるか）はサーバーでも確かめ、聞き返しの答えもサーバーを通す。文の全部を1つの種類で最後まで言えた時だけ埋める。迷ったら埋めない（AI が「表せない所なし」と返しても、プログラムが「前」の字・ほかの種類の手がかり・「、」の後ろの別の決まり・AI が読んでいない言葉を見つけたら、埋めずに「この部分はまだ足せません」。表せた所だけ埋めない・文のルールに逃がさない・英字の名前を出さない）。単位・効く所・メニューがあいまいなら聞き返す。数は「3時間（180分）」で読み直し、もとの文と並べて出す。🔒 を緩める文は AI に送らずに断って日誌に1行。今の種類に当てはまらない文は「まだ足せません」（新しい種類は作らない）。AI が使えない時は言葉の欄だけ出さない。テストでは `scriptRuleReader` に置きかえる（`__tests__/words.test.ts`）。
- 足したルールは再起動なしで次の判定から効くこと。

## 画面の決まり

- PC は「左にタブ・真ん中にページ・右の列」の3列、スマホは1列。横にはみ出さない。
- タブの画面は `src/components/TabPage.tsx` で包む（承認待ちの1行・表示スイッチ・右の列が付く）。スマホで右の列の場所を変える口は3つ（`rightFirstOnPhone`＝上・`rightAfterOnPhone`＝何個目の欄の後・`rightMidOnPhone`＝札 `after-right-sp` の欄だけを後へ。予約タブ）。
- 右の列：ホームは承認BOX・LINE とつなぐ・日誌、ほかはそのタブの入力欄。
- 数字は大きく（`BigNumber`）、量は小さい棒（`MiniBar`）、プログラムの確認は ✓（`Checked`）、細かい所は畳む（`Fold`）。部品は `src/components/parts.tsx`。
- AI の案は大きいカード1枚：「前 → 後」と理由1文、ボタンは「確定」「やめる」（予約の仮押さえの行は「承認／直す／見送り」。仕様書 §1.3）。
- 画面の言葉はやさしく。言い換え表は `docs/SPEC.md` §3.3。
- 色・角の丸み・見出しの字は `globals.css` の変数で書き、直に書かない（見た目の切りかえ（スマート・夜・和紙・ポップ。`src/lib/look.ts`・仕様書 §3.5）に付いてくるように）。だれの3色は表示用の `--who-*-shown` を通す（`--who-ai` などの値は変えない）。
- ホームの欄は「題名＋1行の説明＋だれの札（AI・人・外・プログラム）」（`SectionHead`・`Panel` の `tag`／`desc`）。細かい欄は開け閉めでき、見る人のブラウザに欄ごとに覚える（`RememberFold`・`src/lib/home/`。閉じても中身の部品は外さない）。仕様書 §1.6。

## 置き場所

```
config/            店ごとの設定（JSON）
seed/              架空のデータの最初の状態（お客様・予約・広告・経理・ToDo）
docs/SPEC.md       仕様書
src/app/<tab>/     8つのタブの画面
src/components/    共通の部品
src/app/api/ai/    AI を呼ぶ窓口（サーバーの側。受け取った物は残さない）
src/lib/           設定の読み込み・ルール（言葉で書いて足す入口は rules/words.ts）
src/lib/ai/        予約チャットの道具・流れ・料金の答え（prices.ts）・決まった返事（テスト用）
src/lib/book/      台帳・承認BOX・保存したカルテ・「翌日へ」（ブラウザの中に残す形）・予約サイトから入る予約（site.ts。承認BOXは通さない・AI なし）・台帳の帯の色（menuColor.ts。メニューごと・config/menus.json の color・値は globals.css の --menu-*。だれは帯の頭の札だけ）・台帳から入れる予約（owner.ts。オーナーの「入れる」ボタンだけ・確定・承認BOXは通さない・judgeSlot で入れる前と保存の直前・オーナーのルールだけはもう一度押せば入れる）・「予約を入れる」1枚の3つの段（ownerFlow.ts。①お客様を選ぶ pickCustomer.ts（並べ方2つ・前回からの間・50音の行）→ ②メニュー menuPick.ts（前回・よく使う・全部。book.data.menus から）→ ③確かめて入れる。選び直したら先を消す）・予約サイトで止めた時間（siteStops.ts。予約サイトだけに効く）・承認の時の確かめ（approve.ts。休みの日と過ぎた時刻は確定しない）・台帳の予約を押して開く1枚・取り消す・日時とメニューを変える（change.ts。確定で開始前だけ・仮押さえは承認BOX・judgeSlot は自分の1件だけ外す。最初の予約を直した分は state の seedResEdits）・台帳を組み立てる1か所（assemble.ts の assembleBook。useBook・ledgerView・bookView がみな通す）・休みにする日の予約の ToDo（holiday.ts）・休みにする・戻す流れの1か所（holidayFlow.ts。月のカレンダーの「休みを決める」と休みの日の一覧が使う。休みにできる範囲は今日を含む aheadDays 日で、台帳で見られる範囲とは別）
src/lib/karte/     カルテ：見出しに分ける・整える（tidy.ts。重ねない・次回の希望は次回提案にも）・言葉の門・保存と ToDo・Claude（Haiku）と決まった返事・人が直す（edit.ts。案も保存したカルテも最初の状態のカルテも。人の行は門を通さない）・お客様一覧（customers.ts）
src/lib/recording/ カルテの「録音からメモを作る」（PC だけ）：区切る・黙っている所を飛ばす・Whisper（Web Worker）・要点（Haiku）・フォルダ・画面の録音（IndexedDB に残す）
src/lib/ads/       広告の数・門・道具・流れ・決まった返事・広告の承認BOX（ブラウザの中に残す形）・売りの言葉（featured.ts）・足す案の候補と門（add.ts）と1回（addPick.ts）・窓口の中身（serve.ts）・本物の検索広告へ渡す形（connect.ts。書き出しと結果の読み込み）
src/lib/ads/team/  広告の案の「AI のチーム」の会議：リサーチャー（research.ts。プログラム）・欄ごとの言葉の門（gate.ts）・流れ（run.ts）・決まった返事（script.ts）・会議の印（state.ts）
src/lib/accounting/ 経理：売上の数・日報（daily.ts。オーナーがその日の売上を入れる・このブラウザだけ・どこにも送らない・上限は config/accounting.json の daily・書く所は dailyStore.ts・1日の売上の内訳（技術・店販。なくてもよい・3つとも・合わなければ保存しない）は checkSplit・「日報を入れる」のボタンは dailyOpen.ts を通して売上の欄の1枚を開く（1枚は1つだけ））・通販の明細の仕分け（自動のルール）・門・登録（ブラウザの中に残す形。AI は使わない）
src/lib/todo/      ToDo：入口ごとの鍵・並べ方（items.ts。Claude は並べない）・枠が埋まった時・メモを投げる（Haiku は文だけ・門・決まった返事）・メモの期限（due.ts。プログラムが読む）
src/lib/todo/kinds.ts ToDo の種類の箱（お客様・仕入れと材料・お店のこと・お金と事務・広告・その他）：出どころからプログラムが決める（todoKind。画面に依らない）。投げたメモだけ送る時に選んだ種類（選ばなければ その他）。AI には決めさせない・送らない
src/lib/posts/     発信：「下書きを保存」の1回（save.ts。書けた時だけ日誌・保存できた時だけ③と②の欄を空にする）・言葉の門・日時を入れる（台帳と設定から。本当に空いている時間・材料の時期）・お休みの日付は材料から読む（closed.ts。全部読み切れなければ読めないと出す）・ぶつかったら確かめての注意・発信だけの数の見方（postNumbersWritten）・指示文・流れ（作り直し1回）・決まった返事・保存した下書き（ブラウザの中に残す形）
src/lib/posts/team/ 発信の下書きの「AI のチーム」：候補にしてよいかの確かめ（gate.ts。1回だけ出てくる1文まるごと・数字・日付・印・URL なし・置きかえた後の全文）・リサーチャー（research.ts。プログラム。画面で今の台帳と設定から毎回）・指示（prompt.ts）・流れ（run.ts）・決まった返事（script.ts）・下書きの番号・版・会議の番号と「入れる」（state.ts）
src/lib/line/      LINE のつなぎ（オーナー側）：署名・Redis・つなぎと預かり（bridge）・一言の振り分け（sort）・画面での入れ方（apply）・ボタンの分を書く（press。書けた時だけ日誌と確定の返事・「最初に戻す」の印が違えば書かない）
src/app/api/line/  LINE の窓口（Webhook・つなぐ・受け取り・送る）。画面の処理と混ぜない
src/lib/freee/     経理の freee（テスト事業所）：暗号化した cookie（seal.ts。用途 state・token・kv-token）・API（api.ts。公式の定義で確かめた形だけ）・照らし合わせと状態の分け方（match.ts）・窓口の中身と守り（server.ts）・画面の記録（state.ts）・1件ずつ送る流れ（run.ts）・置き場の鍵と延ばす・書く時の印（kv.ts）・来た人の試しを元に戻す（trial.ts）・来た人の窓口（try.ts）と画面から呼ぶ形（tryClient.ts）。AI は呼ばない
src/app/api/freee/ freee の窓口（つなぐ・戻り先・つながっているか・外す・明細を入れる・登録・読み直す・来た人の試し try）。中身は src/lib/freee/server.ts（本番のサイトか・受ける形・Origin は src/lib/server/site.ts）
src/lib/home/      ホームの欄の開け閉め：最初の状態（PC／スマホ）と覚えた物の読み方（folds.ts。画面に依らない）・画面で使う形（useHomeFolds.ts）
src/lib/jobs/      ホームの「AI に頼める仕事」：これから来る物4行の流れ（run.ts。今の /api/ai/ の窓口をそのまま使う）・済みの印（ブラウザの中に残す形）
src/lib/brief/     朝の要点の「AI の一言」：材料と印（items.ts。名前は送らない・印を日時とお名前に置きかえる）・門・指示文・流れ・決まった返事（scriptBriefWriter）
src/lib/eval/      試験10問（/eval。左のタブには出さない）：問い（config と seed から作る。ふつうの予約3問）・判定（checks.ts。文と結果。AI は使わない）・流し方（同時に1回・1問ごとに eval.minIntervalSeconds 秒・eval.maxCallsPerRun 回まで・流せなかった物は数えない）・合言葉（EVAL_PASSCODE。窓口は src/app/api/eval/。AI は呼ばない）・サーバーの見張り（guard.ts。KV の印は SET NX＋期限・回数は INCR。/api/ai/ の窓口が試験の札の見出しを見て数える）・仮押さえの問いは「選んだ枠にちょうど1件・確定0件」の時だけ合格・「確定しました」と言わない、は確定したと伝える文だけ落とす（かぎかっこの中・「〜とお伝えできません」の打ち消しは数えない）・README に写す形は文の条件で落ちた所の前後も出す。今の /api/ai/ の窓口を使い、結果は画面の表だけ
connect/          本物の検索広告（Google 広告）の中で動かす見本のスクリプト（google-ads/secretairy-sync.js）。アプリの動きとビルドには入れない・本物のアカウントでは動かしていない。広告の部品を直に読むのは main だけ（テストは作り物の部品を差し込む）。サービスの名前（Google 広告）は、画面ではテスト用アカウントにつながっている時の札（config/ads.json の live.label）だけ。コード・仕様書・README には書いてよい
src/lib/ads/live/  広告のテスト用アカウントに本当に送る（サーバーの側だけ。仕様書 §1.7.8）：環境変数4つ（env.ts。鍵・管理アカウントの番号・広告アカウントの番号・オーナー用の合言葉）・通行証（token.ts。JWT を Node の crypto で・5分前まで使い回す）・REST（api.ts。書くのは mutate だけで、入口で毎回テスト用アカウントかを確かめる。developer-token は送らない）・窓口の中身（server.ts。用意・送る・読み直す・合言葉・1日の上限と間違いの数は KvStore・動いている印）・決まった理由（errors.ts）・画面との形（wire.ts）と画面から呼ぶ形（client.ts）・押した後の流れ（panel.ts。「用意」「送る」「試す」を始めたら古い一覧を消し、用意・送るは同じ run の中で1回だけ読み直す・遅れた読み直しの返事は epoch と頼みの番号で捨てる・「印がありますが〜」は最後の用意・送る・試すより後の一覧とだけ、最後に元の形に戻した時刻より後の印とだけ比べる）・画面に1つの流れと札（usePanel.ts。承認から試す・読み直す・オーナーの送るが同じ物を使う）・だれでも試す（直しU。窓口 try・受け取るのは種類と番号だけ・言葉は最初の表 trial.ts から・元の形に戻してから1件・planTry・上限は live.try で別に数え、同時に1回の印を取る前に確かめる（409 でも数は戻さない）・送り元は IPv4 は番地・IPv6 は /64 と /48 でまとめる（sourceBuckets）・数え方は src/lib/server/limits.ts の countCall（読み直す live.read も同じ）・この道では realAt を付けない・承認の知らせは notice.ts・LINE のボタンと戻す案からは呼ばない・自動で呼び直さない）。結果は直しR の受け取る結果と同じ形で、印は connectLoad.ts の1つの道。画面は src/app/ads/AdsLive.tsx（「くわしく」の中のオーナーの用意・送る）と src/app/ads/AdsLiveRead.tsx（広告の管理画面のすぐ下の札・読み直す・一覧）。テストは作り物の Google（__tests__/fakeGoogle.ts。公式の形でない送り方を断る）
src/app/api/ads/live/ 広告のテスト用アカウントの窓口（status・setup・send・read・try）。中身は src/lib/ads/live/server.ts。AI は呼ばない
src/lib/server/    窓口の共通の守り：本番のサイトか・受ける形・Origin（site.ts の siteCheck。freee と広告のテスト用アカウント）・合言葉の比べ方（passcode.ts の checkPasscode。試験と広告のテスト用アカウント）・送り元の束とハッシュ（source.ts の sourceIp・sourceBucket・sourceBuckets（IPv6 の /64 と /48）・sourceHash・sourceHashes。広告のだれでも試すと経理の来た人の試し）・来た人の呼び出しの数え方（limits.ts の countCall。同じ送り元 → /48 → 全体の1分・1時間・1日・設定の数の約束は callLimitsProblem で確かめる。広告のだれでも試す・読み直すと経理の来た人の試し）。2つ作らない
.claude/agents/   サブエージェント「意地悪なお客さん役」（mean-customer.md）：試験の問いの案を出す。材料は seed と config だけ
src/lib/menuEdits.ts メニューを直す（時間・値段・最終受付。ルールのタブの「メニュー」・画面は src/app/rules/MenuPanel.tsx。メニューごとに1行に畳む）・足す（単品・own-N・名前の確かめ menuNameProblem・色 menuColorChoices）・足したメニューを消す（使っている所 menuUses）：幅の確かめ・ブラウザに残す形・サーバーで受け取る確かめ（readMenus）・保存の前の一覧（menuConflicts。重なり・閉店越え・最終受付）ともう一度押す（saveStep）・保存と日誌（commitMenus）・メニューの設定の印（menusMark。直す前に始まった予約チャットの返事を入れない）。読むのは useMenus.ts → useBook の data.menus
src/lib/holidays.ts 休みの日（オーナーが予約のページで決める。ブラウザの中・seats と同じ扱い）：判定（calDay）にだけ効かせ、最初の状態の日付は baseShop・seedAnchor で数える（今ある予約の日付を動かさない）。サーバーは readHolidays で確かめる
src/lib/reminder.ts 「翌日へ」の前日のお知らせ（決まった形・AI なし・送らない）
src/lib/reset.ts   「最初に戻す」（予約・カルテ・広告・経理・LINE の預かりをまとめて戻す。書けたかを返す）
src/lib/book/store.ts 台帳をブラウザに書く所（updateBook。書けたかを返す）・今の「最初に戻す」の印（currentEpoch）
src/lib/book/nextDay.ts 「翌日へ」1回の全部（advanceDay）
src/lib/ai/busy.ts AI の窓口が混んでいる時（429）・理由の文が無い時の文と、画面から窓口を呼ぶ形（postAi・answerOf）
src/lib/brief/cache.ts 朝の要点の AI の一言の答えを材料ごとにブラウザに残す（同じ材料なら開き直しても AI を呼ばない）
```

- **ブラウザに書いた結果・「最初に戻す」・「翌日へ」は、決まった形を通す**（仕様書 §5.1・§1.6。後から足す所もこの形を使い、自分で作らない）：
  - ブラウザに書く所は `writeBrowser` の答え（`BrowserWrite`：`{ ok: true }` か `{ ok: false, why: "full" | "denied" }`）を返す。例外は投げない。台帳は `useBook` の `update`（中身は `book/store.ts` の `updateBook`）が同じ物を返す。成功の文と日誌は `ok` の時だけ出し、失敗の時は入力と案を残して `SAVE_FAILED_MESSAGE`（「ブラウザに保存できませんでした。入力はそのまま残しています。」）。もう一度押せば保存でき、成功の日誌は1回だけ（カルテの保存は `karte/save.ts`、メモを投げるは `todo/throw.ts`）。
  - 「最初に戻す」は `resetAll`（`{ written, failed, lineToken }` を返す。台帳を先に書き、書けなければ何も戻さない）。画面は `written` の時だけ日誌を書く。戻すたびに台帳の印 `epoch` が変わる。戻す前に始まった処理（AI の返事を待っている・あとで書く物）は、始めた時の印（`currentEpoch()`）を持ち、書く直前に `sameEpoch` で同じ時だけ書く（予約チャットは `ai/reserveStream.ts` の `holdInto`）。画面は `book.state.epoch` が変わったのを見て、流れている物を止める。
  - 「翌日へ」は `book/nextDay.ts` の `advanceDay` を通す（上限 `MAX_DAY_OFFSET`・書けなかった時は進めず、日誌と前日のお知らせも作らない。ボタンは `canNextDay` が false なら押せなくして `LAST_DEMO_DAY`）。「翌日へ」とそろえて待ち時間・期限を数える所は、本当の時計ではなく `calendar.ts` の `demoInstant`（いまは広告の「7日に1つ」）。「本当の今日」の文は `realDayNote`。
- AI の道具は `src/lib/ai/tools.ts` の5つだけ（空きを調べる・ルールを確かめる・前回を見る・仮押さえ・仮押さえを外す）。確定の道具は足さない。「仮押さえを外す」は、この会話で作った、まだ承認されていない仮押さえだけ（プログラムで確かめる）。テストでは Claude を呼ばず `src/lib/ai/script.ts` に置きかえる。
- 予約チャットで店の中の決まりをお客様に言わない（仕様書 §1.2.1）：伝えるかはルールごとにオーナーが決める（`Rule` の任意の欄 `tellCustomer`。欄が無い・前からのルール・`config/rules.seed.json` は伝えない。チェックは足すフォームと言葉で足す時の承認の所・最初は外れている）。伝えるときはルールの名前をそのまま理由に。伝えない理由で断ったら AI に文を作らせず中身も渡さず、プログラムが「その時間はお受けできません」（組み合わせは「この組み合わせではお受けできません」とその組み合わせにならない代わり）＋確かめ済みの候補で返す（`agent.ts`・`src/lib/rules/tellable.ts`）。定休日・営業時間・過ぎた時刻・メニューの最終受付は店の設定なので伝える（同じ時間に受ける人数は伝えない）。返事の門（`src/lib/ai/innerGate.ts`）は後ろの守りで、伝えないルールの文と「○分あける」の形と英語の作業の文（`workTextHit`。英字の単語が3つ続く・英字が20字以上。「AI」「LINE」・時刻は当たらない）だけ止める（ふつうの時間の言い方は止めない）。お客様に出す AI の文は、道具を呼ばずに終わった最後の回の文だけ（道具を呼んだ回の文は捨てる。空なら `fixedReply`）。オーナーに見せる所（AI の手順・LINE のオーナー側）には理由を書く。テストは `src/lib/ai/__tests__/tellable.test.ts`。
- 予約チャットでプログラムが決めること：週と日付の食い違いの聞き返し（`dates.ts`）・候補のボタン（返事の文に出た候補だけ）・「お店に確かめてご連絡します」の ToDo（`replies.ts`）。AI に任せない。
- ToDo の並べ方は `src/lib/todo/items.ts` の1か所（ToDo のタブ・ホームの「まずやる3つ」・朝の要点の「今日まで」「期限切れ」の数（`todoDueCounts`））。入口から足すときは鍵（`src/lib/todo/keys.ts`）を付け、同じ鍵がもうあれば足さない。最初の例（`seed/todo.json`）の鍵は「例:」で始め、本物の鍵と重ねない。メモを投げる AI は文だけ（テストでは `scriptTodoWriter`）。
- 同じ時間に受ける人数は1つの数だけ（`src/lib/capacity.ts`）。オーナーがルールのタブで変えた分はブラウザの中（`secretairy:capacity`）。数を使う所は画面の台帳（`useBook` の `shop`）を通し、`data.shop.seats` を直に読まない。サーバーの窓口には画面が `seats` を送る。
- 承認待ちの数は、承認BOXの行（`src/lib/approvals.ts` の `approvalQueue`。画面は `useApprovals`）から出す。ほかの所で数えない。
- 1回の来店で複数のメニューは `src/lib/combo.ts`（設定に無い組み合わせは id を「+」でつなぐ）を通す。
- カルテの AI は下書きまで。プログラムの言葉の門（`src/lib/karte/gate.ts`。言葉は `locked.ts` の `KARTE_GATE_WORDS`。減らさない）を通し、保存は人の「保存」ボタンだけ。お客様の名前は AI に送らない。テストでは `scriptKarteWriter` に置きかえる。
- 録音からメモを作る（仕様書 §1.5.1）：声はブラウザの外に出さない（文字にするのは Web Worker の Whisper）。送るのは文字だけで、名字は〔お客様〕に置きかえる。要点にも言葉の門（`gateLine`）を通し、メモに入れるのも保存も人のボタン。テストでは作った音・決まった文字起こし・`scriptNotesWriter` を使う（Whisper と Claude は呼ばない）。
- 広告の見直しの道具は `src/lib/ads/tools.ts` の止める・外すの2つ（この2つでは言葉を足せない。門の「言葉を足していない」はそのまま）と、そのあとの別の1回の「足す」（`add_keyword`）だけ。足すのは、売りのメニューの名前が入って予約につながった調べ言葉だけで、プログラムが決めた候補（`src/lib/ads/add.ts`）の番号から選ぶ。売り以外へは広げない。売りの言葉が入っているかの確かめは `src/lib/ads/featured.ts` の `featuredWordIn` の1か所（足す案・書き出し・`connect/` の見本のスクリプトの全部。スクリプトは本体を写し、テストで同じか確かめる）。案は門（`src/lib/ads/gate.ts`・`add.ts`）を通してから承認BOXへ。足すの行は `secretairy:ads` の `adds`（止める・外すの `proposals` とは別）で、LINE・AI のチームの会議・効いたかの判定・戻す案・毎週の報告・ToDo には入れない。「承認待ちは1つ」「7日に1つ」は1回の見直しの行をまとめて1回（`canPropose`）。窓口の中身は `src/lib/ads/serve.ts`（広告タブ・ホームの仕事・テストが同じ物を通す）。テストでは `src/lib/ads/script.ts` に置きかえる。
- 広告の効いたかの判定はプログラム（`src/lib/ads/verdict.ts`。後の数は `seed/ads.json` の `after`）。戻す案は承認BOXへ（戻すのは人の「承認」だけ）。毎週の見直しの報告は `src/lib/ads/weekly.ts`（数はプログラム）。AI の文は広告の言葉の門（`src/lib/ads/words.ts`）を通す。一言のまとめ（`/api/ai/ads/note`・Haiku）は数字なし・AI が使えない時は出さない。テストでは決まった文を返す物に置きかえる（`src/lib/ads/__tests__/results.test.ts`）。

- 広告の案の「AI のチーム」の会議（`src/lib/ads/team/`・窓口は `/api/ai/ads/team`・画面は `src/components/AdTeam.tsx`。仕様書 §1.7.4）：SecretAIry はオーナーの側近で、案をチームで話し合ってから出す。決めるのは今の承認BOXのボタンだけで、会議には確定・承認の道具を渡さない（会議は広告も承認BOXも変えない）。
  - 付けるのは、ふつうの広告の案の行（`AdApprovalRows`）だけ。戻す案・広告以外の案には付けない。ホームの「AI の仕事」と予約の「AI の手順」には出さない。
  - 数・日時・値段はリサーチャー（プログラム）だけが入れる。分身と野党は同じ材料を別々に読み（おたがいの答えは見せない）、補佐は門を通った2つだけを読む。Claude は1回の会議で3回まで（`config/ai.json` の `adsTeam.maxCalls`）。作り直しはしない。モデルは Sonnet（`adsTeam.model`）。指示は門に合う書き方（`prompt.ts` の `WRITING_RULES`：数字・日付・値段を書かず「予約がない」のように言葉で・1文60字くらい・分身1〜2文・野党と補佐は欄ごとに1文・「様子を見る」ではなく「次の見直しで確かめる」）。門をゆるめて通すのではなく、指示と出力の上限で直す。
  - 言葉の門は欄ごと（`team/gate.ts`。今の広告の門 `words.ts` は最初の1文しか見ないので使わない）。通った文だけを画面・日誌・補佐へ。鍵つきの2つはサーバーで指示の先頭に足しなおし、答えにも当てる。
  - 会議を始めた時の案の中身を印に残し、答えは案がまだ承認待ちで中身が同じ時だけ出す。1つの案に1回まで。オーナーが押したら日誌に「分身の予想：外す／オーナー：残した」（画面と LINE のボタンの両方）。
  - 分身に渡す前の判断は、対象・止める／外す・承認か見送りか・決めた日・その時の予約だけ（記録の理由は AI の理由なので渡さない）。最初の状態の判断は `seed/ads.json` の `past`。
  - AI につながらない時・決まった返事の案の時も、決まった返事（`team/script.ts`）で4つの声を出し「AI なし」と出す。テストは Claude を呼ばず、`scriptTeamWriter` か決まった答えを返す物に置きかえる（`src/lib/ads/__tests__/team.test.ts`）。
- 発信の下書きは `src/lib/posts/`（窓口は `/api/ai/posts`。Sonnet）。種類が違っても仕組みは1本で、変わるのは `config/posts.json` の指示文と材料だけ。Claude には日時と数字を書かせない（空き枠・お休みは画面が台帳と設定から入れる。ブログのリンクは印だけ）。言葉の門（`gate.ts`）に当たったら1回だけ作り直し、2回とも当たったら保存しない。保存はオーナーのボタンだけ（承認BOXは通さない）。送信・公開はしない。テストでは `scriptPostsModel` か決まった文を返す物に置きかえる。
- 発信の下書きの「AI のチーム」（`src/lib/posts/team/`・窓口は `/api/ai/posts/team`・画面は `src/components/PostTeam.tsx`。仕様書 §1.10.1）：今の下書きのカードの下に「チームに読んでもらう」（保存した下書き・ほかのタブには出さない。1つの下書きに1回・作り直したらまた押せる・`postsTeam.maxDraftChars` より長ければ切り捨てずに「長すぎるのでチームにかけられません」で呼ばない）。AI は下書きを書きかえない。直しを入れるのはオーナーの「入れる」ボタンだけ（下書きの番号・版・会議の番号を照合し、手で直したら残りは使えない）。
  - リサーチャーはプログラム（数・日時はここだけ）。分身の材料は店のルールとお店のメモだけ（保存した下書きは使わない）。補佐は確かめ済みの候補の番号だけを選び、文は候補の文をそのまま使う。Claude は1回の会議で3回まで・作り直しなし・道具なし・🔒 はどの指示も先頭。
  - 元の文は1回だけ出てくる1文まるごと。数字・日付・曜日・印・URL の入った文は候補にしない。置きかえた後の全文に作る時の門（`gatePost`）は掛けない（正しい日付まで当たる）。広告のチームと共有するのは役の名前・カードの見た目（`TeamVoice.tsx`）・Claude を呼ぶ薄い所（`ads/team/claude.ts`）まで。テストは Claude を呼ばず、`scriptPostTeamWriter` か決まった答えを返す物に置きかえる（`src/lib/posts/__tests__/team.test.ts`）。

- LINE（オーナー側）の窓口は `src/app/api/line/` に分け、画面の処理と混ぜない。画面が開いている間だけ動く（受け取るのは `src/components/LineBridge.tsx`）。
  - 届いた知らせは `LINE_CHANNEL_SECRET` で署名を確かめ、違う物は捨てる。合言葉でつないでいない LINE では何も動かさない。
  - LINE のボタンで確定してよいのは、サーバーが「つないだ人・その画面の行・1回だけの印」を確かめた press の知らせだけ。一言（文）や AI の答えからは確定しない。
  - 送る通数を減らす（返事で済む時は返事。1日の上限は `config/line.json`）。鍵・LINE の人の番号は画面・日誌・ログに出さない。
  - 一言の振り分けの道具は `src/lib/line/sort.ts` の3つ（仮押さえ・ToDo・カルテのメモ）だけ。テストでは `scriptSortModel` と置きかえた LINE・`memoryStore` を使う（Claude と LINE は呼ばない）。お客さん側の LINE はまだ。
- ホームの「AI に頼める仕事」（`src/lib/jobs/`）は、今の窓口（予約・広告・メモ）と今の変え方（仮押さえ・承認BOX・ToDo）をそのまま呼ぶだけ。確定は呼ばない。1回押した時に AI を呼ぶ回数は `config/ai.json` の `jobs.maxAiCallsPerPress` まで。テストでは決まった返事に置きかえる（`src/lib/jobs/__tests__/jobs.test.ts`）。
- 経理の freee（テスト事業所。仕様書 §1.8.1）：AI は呼ばない（科目も金額も AI は決めない）。つないでいる時の明細の一覧は freee から読んだ「まだ処理していない明細」（口座は「SecretAIry カード」「SecretAIry 口座」の2つだけ・期間は今日の90日前から statement.to と今日の遅い方まで・200件まで・読むのはタブを開いた時と「freee から読み直す」だけ・読めなければ理由を出し架空の明細に切り替えない）。一覧の行と仕分けは `src/lib/accounting/rows.ts`・`view.ts`（摘要に購入先の名前がちょうど1つの時だけその購入先のルール・入金は見せるだけ）。freee の明細の選びと状態は `t<wallet_txn の id>` で持ち、架空の明細の番号と混ぜない。登録するのは人の「登録」ボタンの分だけで、1件ずつ・書く直前に freee の明細を読んで照らし合わせる。窓口は本番のサイト（`VERCEL_ENV=production` と `secretairy.vercel.app`）だけ・書く物は POST と Origin の確かめ・cookie が無い呼び出しは受けない・事業所の番号は鍵の返事の番号と `FREEE_COMPANY_ID` だけ（ブラウザから来た番号は使わない）。freee 側を消して戻すボタン・売上を送ること・自動登録ルールとの同期は作らない（鍵を延ばすのは置き場の鍵だけ・来た人の試しの窓口の中だけ）。「結果が分からない」は送り直さない（「freee から読み直す」の後でだけ）。明細を入れる・登録・読み直す・「最初に戻す」は同じ排他（Web Locks。`run.ts` の `withFreeeLock`）の中だけ。明細を入れた結果が分からない時は待つ期限（`importHold`）を残す。サーバーは持ち時間（`serverBudgetSeconds`）で区切る。テストは fetch と Web Locks を置きかえる（`src/lib/freee/__tests__/freee.test.ts`。freee は呼ばない）。freee の名前を画面に出すのは、つながっている時の札・つなぐボタン・つながっていない画面の札だけ。
  - 来た人の試し（仕様書 §1.8.2。`src/lib/freee/try.ts`・窓口は `/api/freee/try`・画面は `src/app/accounting/TryPanel.tsx`）：オーナーの窓口（start・callback・import・register・check・disconnect）は今どおり cookie だけ（`guard()` を置き場の鍵で通さない）。来た人ができるのは読む・1件の登録・読み直すだけで、ブラウザから受け取るのは明細の番号と店用か私用かだけ。書けるのは、印から引いた見本（`trial.ts` の `seedItemOfMark`）と日付・金額・出金・口座・摘要がちょうど合う（`matchesSeed`）出金で未処理の物だけ（`useAllowed` も今どおり）。書く前に置き場に「書くかもしれない明細」、書いた後に取引の番号。最後に書いてから `freee.try.holdSeconds` をこえた後の最初の呼び出しで、窓口の頭で元に戻す（`restoreTrial`。置き場に残した取引だけを消す → 未処理に戻らなければ印のある見本の明細だけを消して作り直す → 全部が見本どおりの未処理かを確かめる）。取引の番号が分からない明細は消す・作り直すもせず「要復旧」で来た人の登録を止める（外すのは、オーナーが直してからもう一度つないだ時に読んで確かめてから）。書く時の印は1つ（`kv.ts` の `withWriteLock`。来た人の登録・元に戻す・オーナーの明細を入れる・登録。期限は持ち時間より長く、締め切りは印の期限より前）。鍵を延ばすのは同時に1回（`kvAccess`）・つないだ回の番号が進んでいたら（`genMovedPast`。大きい番号が読めた時だけ）延ばした鍵を書かない。回数の上限は `freee.try.register`／`read`（数え方は `server/limits.ts` の `countCall`。同じ送り元 → /48 → 全体の1分・1時間・1日の順でこえたら先は足さない・送り元は `server/source.ts` の束・元に戻すは別に数えて全体の上限では止めない・同じ送り元の上限をこえた呼び出しは元に戻す処理を動かさず書く時の印も取らない）・置き場が使えなければ 503。元に戻す一歩（取引を消す・明細を消す・作り直す）は送る前に記録に置き、1回目の 404・番号の違う明細・作り直しが見つからない・空の deal_ids は要復旧。一歩は「持ち時間（`canSend`）と `held()` を確かめる → 一歩を置く → 送る」の順で、送っていないと分かる止まり方では一歩を外す（残すのは送った後に返事が途切れた時だけ）・印を失った後は置き場に書かない。前の回の一歩が残っていて 404 を「もう無い」と受けた明細は `assumedGone` を置き、未処理に戻っていなければ要復旧（消す・作り直すをしない）。印を取った後につないだ回の番号を読み直し、進んでいたら書かない。延ばすのを断られた鍵（400・401 など続けても変わらない断り。429・409・423・5xx・通信切れは印を付けず次の回にやり直す。分け方は `api.ts` の `isTransientRefusal`）は `freee:kv:dead` に中身のハッシュを置き、freee を呼ばずに「つながっていない」（オーナーの画面にも `dead`）。番号の鍵の期限は進める時と鍵を書く時に付け直す。オーナーの登録は試しの記録にある明細を断る（`TRIAL_HELD_MESSAGE`）。「つなぎを外す」は先に印を取り（取れなければ 409・置き場が落ちたら 503 で cookie を残す）、元に戻してから置き場の鍵を消す（戻せなければ記録を残し、次につないだ時に戻す）。返事とログは決まった短い理由だけ。テストは `src/lib/freee/__tests__/try.test.ts`・`tryClient.test.ts`（作り物の freee と memoryStore）。
- 秘密の鍵（Claude API キー・LINE の秘密 `LINE_CHANNEL_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN`・オーナー用の合言葉 `LINE_OWNER_PASSCODE`（任意）・試験の合言葉 `EVAL_PASSCODE`（試験を流す時）・Redis の `KV_REST_API_URL`／`KV_REST_API_TOKEN`・freee の `FREEE_CLIENT_ID`／`FREEE_CLIENT_SECRET`／`FREEE_COMPANY_ID`／`FREEE_COOKIE_KEY`（Production だけ）・広告のテスト用アカウントの `GOOGLE_ADS_SERVICE_ACCOUNT_KEY`／`GOOGLE_ADS_LOGIN_CUSTOMER_ID`／`GOOGLE_ADS_CUSTOMER_ID`／`GOOGLE_ADS_OWNER_PASSCODE`（Production だけ・`NEXT_PUBLIC_` を付けない））は `.env.local`（Vercel では環境変数）に置く。`.env` で始まるファイルはコミットしない。
