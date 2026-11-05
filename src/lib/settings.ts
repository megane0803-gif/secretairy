// 店ごとに変わる物（メニュー・営業時間・最終受付・カルテの見出し・タブの表示）は
// ここを通して読む。今は config/*.json をそのまま読むだけ。
// あとで設定の画面を足すときは、この関数の中身だけを差しかえる。

import shop from "@config/shop.json";
import menus from "@config/menus.json";
import karte from "@config/karte.json";
import tabs from "@config/tabs.json";
import ai from "@config/ai.json";
import ads from "@config/ads.json";
import accounting from "@config/accounting.json";
import line from "@config/line.json";
import recording from "@config/recording.json";
import todo from "@config/todo.json";
import posts from "@config/posts.json";
import jobs from "@config/jobs.json";
import reminder from "@config/reminder.json";
import { TAB_IDS, TABS, type TabDef, type TabId } from "./tabs";

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Hours = { open: string; close: string } | null;

export type ShopSettings = {
  name: string;
  timezone: string;
  /**
   * 同じ時間に受ける人数（前は「席の数」）。予約チャット・台帳・予約サイト・朝の要点・発信の空き枠・AI の仕事が、みなこの1つの数を使う。
   * 最初の状態はここ。オーナーがルールのタブで変えた分はブラウザの中（capacity.ts の withSeats で重ねる）
   */
  seats: number;
  /** ルールのタブで選べる「同じ時間に受ける人数」の幅 */
  seatsRange?: { min: number; max: number };
  slotMinutes: number;
  holdExpiresHours: number;
  hours: Record<DayKey, Hours>;
  closedDates: string[];
};

export type Menu = {
  id: string;
  name: string;
  minutes: number;
  price: number;
  /** 最終受付（この時刻までに始める）。無ければ「閉店 − 所要時間」まで */
  lastStart?: string;
  /** 組み合わせのメニュー（例：カット＋カラー）に入っているメニュー。メニューごとのルールはここにも効く */
  includes?: string[];
  /**
   * 予約の台帳の帯の色の名前（globals.css の --menu-<名前>。src/lib/book/menuColor.ts の MENU_COLORS のどれか）。
   * 見た目だけに使う（AI に送る中身・料金の答えには入れない）。無い・知らない名前のメニューは灰色。
   */
  color?: string;
};

/** AI を呼ぶときの設定（モデル名・1回の返事の長さ・1回の相談で道具を呼ぶ回数の上限など） */
export type AiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 1回の相談で道具を呼ぶ回数の上限 */
  maxToolCalls: number;
  /** 送ってよい会話の数 */
  maxMessages: number;
  /** お客様の1回の文の長さ（字） */
  maxMessageChars: number;
  /** 予約チャットの窓口（/api/ai/reserve）が受け取る大きさの上限（字） */
  maxRequestChars: number;
  /** カルテ自動作成（Haiku） */
  karte: KarteAiSettings;
};

export type KarteAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 施術メモの長さの上限（字） */
  maxMemoChars: number;
  /** 窓口（/api/ai/karte）が受け取る大きさの上限（字） */
  maxRequestChars: number;
  /** 録音から作ったメモ（要点をまとめた物）の長さの上限（字）。この流れの時だけ広げる */
  maxRecordingMemoChars: number;
};

export function getAiSettings(): AiSettings {
  const a = ai as AiSettings;
  // モデル名は環境変数で差しかえられる（鍵と同じく .env.local）
  return {
    ...a,
    model: process.env.ANTHROPIC_MODEL || a.model,
    karte: { ...a.karte, model: process.env.ANTHROPIC_KARTE_MODEL || a.karte.model },
  };
}

/** 施術メモの長さの上限（字）。画面でも使う（鍵や環境変数は読まない） */
export function getMemoMaxChars(): number {
  return (ai as AiSettings).karte.maxMemoChars;
}

/** 予約チャットのお客様の1回の文の長さの上限（字）。画面でも使う（鍵や環境変数は読まない） */
export function getChatMaxChars(): number {
  return (ai as AiSettings).maxMessageChars;
}

export type KarteHeading = {
  id: string;
  label: string;
  note?: string;
  /**
   * next = 次回提案（保存のとき ToDo「次回話すこと」に1行目を足す・朝の要点に出す）。
   * request = お客様のご希望（次の来店の希望は、ここと次回提案の両方に入れる。karte/tidy.ts）
   */
  role?: "next" | "request";
  /** 決まった返事（AI なし）で、メモの文をこの見出しに分ける手がかりの言葉 */
  hints?: string[];
};

export function getShop(): ShopSettings {
  return shop as ShopSettings;
}

export function getMenus(): Menu[] {
  return menus as Menu[];
}

export function getKarteHeadings(): KarteHeading[] {
  return (karte as { headings: KarteHeading[] }).headings;
}

export type TabSwitches = Record<TabId, boolean>;

/** 表示スイッチの最初の状態（config/tabs.json）。画面で変えた分はブラウザの中で重ねる */
export function getTabSwitches(): TabSwitches {
  const raw = tabs as Partial<Record<TabId, { visible: boolean }>>;
  return Object.fromEntries(TAB_IDS.map((id) => [id, raw[id]?.visible !== false])) as TabSwitches;
}

/** スイッチが入っているか。必須のタブはスイッチが切れていても出す */
export function isTabShown(id: TabId, switches: TabSwitches): boolean {
  return TABS[id].required || switches[id] !== false;
}

/** 表示スイッチが入っているタブ */
export function getVisibleTabs(switches: TabSwitches = getTabSwitches()): TabDef[] {
  return TAB_IDS.filter((id) => isTabShown(id, switches)).map((id) => TABS[id]);
}

/** 広告のタブの設定（config/ads.json） */
export type AdSettings = {
  /** どこに出している広告か（画面の札） */
  channel: string;
  /** 売りのメニュー（その言葉に「売り」の印を出す） */
  featuredMenus: string[];
  /** 架空の町の名前。この名前が入った言葉は「外す」案にしない */
  towns: string[];
  /** 承認してから何日後に「効いたか見る」の ToDo の期限にするか */
  checkAfterDays: number;
  /** 案は何日に1つまでか */
  oncePerDays: number;
  /**
   * 効いたかの判定（プログラム。src/lib/ads/verdict.ts）。
   * minWordClicks = 止めた言葉の、前の週の押された回数がこれより少なければ「まだ分からない」
   * minBookings = 前と後の予約を足してこれより少なければ「まだ分からない」
   */
  judge: { minWordClicks: number; minBookings: number };
  /** 毎週の見直しの報告。maxKeptWords = 「止めなかった言葉」に出す数 / listCount = 前の週の報告を残す数 */
  report: { maxKeptWords: number; listCount: number };
  /** 広告の言葉の門：AI の文（案の理由・一言のまとめ）に入れない言葉（だれかを責める言い方・言い切り） */
  gateWords: string[];
};

export function getAdSettings(): AdSettings {
  return ads as AdSettings;
}

/** 広告の見直しで AI を呼ぶときの上限（config/ai.json の ads） */
export type AdsAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 案を作らせる回数の上限（1回目＋作り直し。直すときは1回だけ） */
  maxTries: number;
  /** 「直す」のオーナーの一言の長さの上限（字）。画面でも使う */
  maxFixChars: number;
  /** 窓口（/api/ai/ads）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

/** 「直す」の一言の長さの上限（字）。画面でも使う（鍵や環境変数は読まない） */
export function getAdsFixMaxChars(): number {
  return (ai as { ads: { maxFixChars: number } }).ads.maxFixChars;
}

/** 広告の判定と報告の「一言のまとめ」で AI（Haiku）を呼ぶときの上限（config/ai.json の adsNote） */
export type AdsNoteAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 1文の長さの上限（字） */
  maxNoteChars: number;
  /** 窓口（/api/ai/ads/note）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getAdsNoteAiSettings(): AdsNoteAiSettings {
  return (ai as { adsNote: AdsNoteAiSettings }).adsNote;
}

export function getAdsAiSettings(): AdsAiSettings {
  const a = (ai as { ads: Omit<AdsAiSettings, "model"> }).ads;
  return { model: getAiSettings().model, ...a };
}

/** 経理のタブの設定（config/accounting.json）。札は「会計（架空）」。実在の会計サービスの名前（freee）は、freee（テスト事業所）のつなぎの札（freee.label・freee.unconnectedNote）にだけ書く（docs/SPEC.md §1.8） */
export type AccountingSettings = {
  /** 明細を取り込み、登録する先（画面の札。例「会計（架空）」）。オーナーのブラウザで freee（テスト事業所）につながっている時は freee の札（freee.label） */
  service: string;
  /** 明細の出どころ（例「カード会社（架空）」） */
  cardSource: string;
  /** freee（テスト事業所）とのつなぎ（オーナーのブラウザだけ。鍵・秘密は環境変数。docs/SPEC.md §1.8.1） */
  freee: FreeeSettings;
};

export type FreeeSettings = {
  /** つながっている時の札 */
  label: string;
  /** つながっていない画面の札 */
  unconnectedNote: string;
  /** 本番のサイト（ここから来た呼び出しだけ受ける） */
  siteOrigin: string;
  /** 許可の戻り先の道（freee のアプリに入れた物と同じ） */
  callbackPath: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  /** 使うカードの口座の名前（プログラムでは作らない。ちょうど1つの時だけ使う） */
  cardName: string;
  /** 店用の科目の名前（freee から名前で引く） */
  accountItemName: string;
  /** 店用の税区分の名前（freee の画面の名前 name_ja） */
  taxName: string;
  /** 摘要の印の頭（「SecretAIry:<データの版>:<明細の番号>」） */
  markPrefix: string;
  /** 許可の行き来の合図（state）の期限（分） */
  stateMinutes: number;
  /** アクセスの鍵を持たせる長さの上限（秒。6時間） */
  maxTokenSeconds: number;
  /** 明細を読む時の1ページの件数（freee の上限は100） */
  pageLimit: number;
  /** めくるページの上限 */
  maxPages: number;
  /** freee の返事を待つ秒数 */
  timeoutSeconds: number;
  /** 窓口が受け取る大きさ（字） */
  maxRequestChars: number;
  /** 「送っている」の印が、この秒数より古ければ止まった物とみなす */
  sendingStaleSeconds: number;
  /** サーバーの1回の呼び出しで使ってよい秒数（窓口の時間の上限より短く。返事の時間を残して、次の書き込みを止める） */
  serverBudgetSeconds: number;
  /** 「freee に明細を入れる」の結果が分からない時に待つ秒数（この間は入れない） */
  importUnknownWaitSeconds: number;
  /** 「freee に明細を入れる」1回の押しで、画面が窓口を続けて呼ぶ回数の上限 */
  maxImportCalls: number;
};

export function getFreeeSettings(): FreeeSettings {
  return getAccountingSettings().freee;
}

export function getAccountingSettings(): AccountingSettings {
  return accounting as AccountingSettings;
}

/** LINE のつなぎ（オーナー側）の設定（config/line.json）。鍵・秘密はここに書かない（環境変数） */
export type LineSettings = {
  /** 画面に出す合言葉の期限（分） */
  codeMinutes: number;
  /** 合言葉でつないだ後、つながっている時間（時間） */
  linkHours: number;
  /** 画面が LINE の知らせを受け取りに行く間（秒） */
  pollSeconds: number;
  /** 画面が最後に受け取りに来てから「開いている」とみなす長さ（秒） */
  aliveSeconds: number;
  /** LINE の知らせを預けておく長さ（秒）。画面が受け取りに来なければ消える */
  inboxSeconds: number;
  /** LINE の返事（無料）に使える長さ（秒）。過ぎたら送る（数える）方になる */
  replySeconds: number;
  /** 1日に送る（返事ではない）通数の上限。無料は月200通 */
  dailyPushLimit: number;
  /** LINE の一言の長さ（字） */
  maxTextChars: number;
  /** つながっていない人が合言葉を試せる回数（10分ごと） */
  codeTries: number;
  /** 画面から LINE へ送る1通の文の長さ（字） */
  maxOutChars: number;
  /** 画面から LINE へ1回に送る通の数 */
  maxOutMessages: number;
  /** LINE の Webhook（/api/line）が受け取る大きさの上限（字） */
  maxWebhookChars: number;
  /** 画面からの LINE の窓口（つなぐ・受け取り・送る）が受け取る大きさの上限（字） */
  maxScreenRequestChars: number;
};

export function getLineSettings(): LineSettings {
  return line as LineSettings;
}

/** LINE の一言の振り分けで AI を呼ぶときの設定（config/ai.json の line。モデル名は ANTHROPIC_LINE_MODEL でも差しかえられる） */
export type LineAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 窓口（/api/ai/line）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getLineAiSettings(): LineAiSettings {
  const a = (ai as { line: LineAiSettings }).line;
  return {
    model: process.env.ANTHROPIC_LINE_MODEL || a.model,
    maxReplyTokens: a.maxReplyTokens,
    maxRequestChars: a.maxRequestChars,
  };
}

/** 録音からメモを作る（カルテのタブ。config/recording.json）。声はブラウザの外に出さない */
export type WhisperModel = {
  /** Hugging Face のモデルの名前 */
  id: string;
  label: string;
  device: "webgpu" | "wasm";
  dtype: Record<string, string>;
  /** 初回に読み込む大きさのめやす（MB） */
  approxMB: number;
};

export type SilenceSettings = {
  /** 音の大きさを見る1こまの長さ（ミリ秒） */
  frameMs: number;
  /** これより小さい音は黙っている所 */
  minLevel: number;
  /** まわりのいちばん小さい音の何倍より大きければ声とみなすか（ずっと同じ大きさの音＝音だけの所は飛ばす） */
  modulationRatio: number;
  /** 「まわり」の幅（秒） */
  windowSeconds: number;
  /** 声の前後に足す長さ（秒） */
  padSeconds: number;
  /** これより短い声は捨てる（秒） */
  minSpeechSeconds: number;
  /** これより短いすき間は声どうしをつなぐ（秒） */
  mergeGapSeconds: number;
};

export type RecordingSettings = {
  /** 機能を出すか（最初の状態。画面のスイッチで変えた分はブラウザの中だけ） */
  visible: boolean;
  /** 受けるファイルの拡張子 */
  accept: string[];
  /** 受けるファイルの大きさの上限（バイト） */
  maxBytes: number;
  /** 受ける録音の長さの上限（秒） */
  maxSeconds: number;
  /** 1つの区切りの長さ（秒） */
  chunkSeconds: number;
  /** 文字にするときの音の細かさ（Hz） */
  sampleRate: number;
  /** Whisper に渡す言葉 */
  language: string;
  silence: SilenceSettings;
  recorder: {
    /** 画面の録音を区切ってしまう長さ（秒） */
    segmentSeconds: number;
    /** これより小さい音が続けば「音が入っていません」 */
    quietLevel: number;
    /** 何秒続けば知らせるか */
    quietWarnSeconds: number;
  };
  folder: {
    /** 録音フォルダを見に行く間（秒） */
    pollSeconds: number;
  };
  models: { webgpu: WhisperModel; wasm: WhisperModel };
};

export function getRecordingSettings(): RecordingSettings {
  return recording as RecordingSettings;
}

/** 録音の要点づくりで AI を呼ぶときの設定（config/ai.json の recording。モデル名は ANTHROPIC_KARTE_MODEL でも差しかえられる） */
export type RecordingAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 1つの区切りの文字の長さの上限（字）。超えた分は送らない */
  maxTextChars: number;
  /** 1つの区切りの要点の数の上限 */
  maxNotes: number;
  /** 要点1行の長さの上限（字） */
  maxNoteChars: number;
  /** 窓口（/api/ai/recording）が受け取る大きさの上限（字） */
  maxRequestChars: number;
  /** 区切りごとに AI を呼ぶ間（秒。/api/ai/ の1分10回に収める） */
  minIntervalSeconds: number;
};

export function getRecordingAiSettings(): RecordingAiSettings {
  const a = (ai as { recording: RecordingAiSettings }).recording;
  return { ...a, model: process.env.ANTHROPIC_KARTE_MODEL || a.model };
}

/** 録音から作ったメモの長さの上限（字）。画面でも使う（鍵や環境変数は読まない） */
export function getRecordingMemoMaxChars(): number {
  return (ai as AiSettings).karte.maxRecordingMemoChars;
}

/** ToDo のメモを短いタスクの文に直すときの設定（config/ai.json の todo。モデル名は ANTHROPIC_TODO_MODEL でも差しかえられる） */
export type TodoAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 投げるメモの長さの上限（字）。画面の入力欄も同じ数 */
  maxMemoChars: number;
  /** タスクの文の長さの上限（字）。超えたらプログラムがメモから作る */
  maxTitleChars: number;
  /** 窓口（/api/ai/todo）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getTodoAiSettings(): TodoAiSettings {
  const a = (ai as { todo: TodoAiSettings }).todo;
  return { ...a, model: process.env.ANTHROPIC_TODO_MODEL || a.model };
}

/** ToDo の画面の設定（config/todo.json）：「済にしました　戻す」を出す秒数・ホームの「今やる」の数 */
export type TodoSettings = {
  undoSeconds: number;
  topCount: number;
};

export function getTodoSettings(): TodoSettings {
  return todo as TodoSettings;
}

/** 画面で使う ToDo の上限（鍵や環境変数は読まない） */
export function getTodoLimits(): { maxMemoChars: number; maxTitleChars: number } & TodoSettings {
  const a = (ai as { todo: TodoAiSettings }).todo;
  return { maxMemoChars: a.maxMemoChars, maxTitleChars: a.maxTitleChars, ...getTodoSettings() };
}

/** 発信のタブ：下書きの種類（config/posts.json の kinds）。種類が違っても仕組みは1本で、変わるのは指示文と材料だけ */
export type PostKindId = string;

/** 下書きにプログラムが入れる物（openings = 空き枠の日時・closed = お休みの日付・blogLink = ブログのリンクの印） */
export type PostInsert = "openings" | "closed" | "blogLink";

export type PostMaterialField = { id: string; label: string; placeholder: string };

export type PostKind = {
  id: PostKindId;
  /** 画面の名前（「LINE」の字は入れない） */
  label: string;
  /** その種類だけの指示文（AI への指示に入れる） */
  instruction: string;
  /** 長さの目安（字） */
  targetChars: number;
  /** 形の目安（例「5段落くらい」「見出し4つくらい」「タグ4つくらい」） */
  shape: string;
  /** 材料の入力欄（1つ目は必ず入れる） */
  materials: PostMaterialField[];
  /** 下書きに無ければプログラムが足す物 */
  insert: PostInsert[];
};

export type PostsSettings = {
  kinds: PostKind[];
  /** 言葉の門で当てる言葉（全角は半角にそろえて調べる） */
  gateWords: string[];
  /** 空き枠を探す日数（今日から） */
  openingDays: number;
  /** 空き枠を入れる日の数の上限 */
  maxOpeningDays: number;
  /** お休みを探す日数（今日から） */
  closedDays: number;
  /** お休みを入れる日の数の上限 */
  maxClosedDays: number;
  /** 保存しておける下書きの数（種類ごと） */
  maxSavedPerKind: number;
  /** 長さの目安（targetChars）から、どれだけ長くてよいか（0.2 = 2割まで）。超えたら1回だけ短く作り直す（posts/write.ts） */
  lengthSlack?: number;
  /** 材料に書いた時期の言葉と、その日の幅（月-日）。空き枠・お休みをその時期の日から出す（posts/facts.ts の periodOf） */
  periods?: { words: string[]; from: string; to: string }[];
};

export function getPostsSettings(): PostsSettings {
  return posts as PostsSettings;
}

/** 発信の下書きで AI を呼ぶときの上限（config/ai.json の posts。モデルは予約チャットと同じ Sonnet） */
export type PostsAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 下書きを作らせる回数の上限（1回目＋作り直し） */
  maxTries: number;
  /** 材料の1つの欄の長さの上限（字）。画面でも使う */
  maxMaterialChars: number;
  /** 窓口（/api/ai/posts）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getPostsAiSettings(): PostsAiSettings {
  const a = (ai as { posts: Omit<PostsAiSettings, "model"> }).posts;
  return { model: getAiSettings().model, ...a };
}

/** 材料の1つの欄の長さの上限（字）。画面でも使う（鍵や環境変数は読まない） */
export function getPostsMaterialMaxChars(): number {
  return (ai as { posts: { maxMaterialChars: number } }).posts.maxMaterialChars;
}

/**
 * ホームの「AI の仕事」：欄を出すか（最初の状態。画面で切りかえた分はブラウザの中だけ）と、
 * 1回押した時に AI の窓口（/api/ai/）を呼ぶ回数の上限（config/ai.json の jobs.maxAiCallsPerPress）。
 */
export type JobsSettings = {
  visible: boolean;
  maxAiCallsPerPress: number;
};

export function getJobsSettings(): JobsSettings {
  const a = (ai as { jobs: { maxAiCallsPerPress: number } }).jobs;
  return { visible: (jobs as { visible: boolean }).visible !== false, maxAiCallsPerPress: a.maxAiCallsPerPress };
}

/**
 * ホームの「翌日へ」で見せる前日のお知らせ（デモ。本当には送らない）。文は決まった形で、AI は使わない。
 * {time}・{menu}・{shop} はプログラムが台帳と店の設定から入れる（config/reminder.json）。
 */
export type ReminderSettings = {
  template: string;
  /** 画面に小さく出す1文（「デモ：実際には送信されません」） */
  demoNote: string;
};

export function getReminderSettings(): ReminderSettings {
  return reminder as ReminderSettings;
}

/**
 * 朝の要点の「AI の一言」（気をつける点を数個まで。config/ai.json の brief。モデル名は ANTHROPIC_BRIEF_MODEL でも差しかえられる）。
 * Claude が書くのは文だけで、日時・数字・名前はプログラムが印（【予約1】など）から入れる。
 */
export type BriefAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 出す一言の数の上限 */
  maxNotes: number;
  /** 一言1つの長さの上限（字。印も数える） */
  maxNoteChars: number;
  /** 送る材料（今日の予約・承認待ち・ToDo）の数の上限 */
  maxItems: number;
  /** 材料1つの文の長さの上限（字） */
  maxItemChars: number;
  /** 窓口（/api/ai/brief）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getBriefAiSettings(): BriefAiSettings {
  const a = (ai as { brief: BriefAiSettings }).brief;
  return { ...a, model: process.env.ANTHROPIC_BRIEF_MODEL || a.model };
}

/** 画面で使う「AI の一言」の上限（鍵や環境変数は読まない） */
export function getBriefLimits(): Omit<BriefAiSettings, "model"> {
  const { model: _model, ...rest } = (ai as { brief: BriefAiSettings }).brief;
  void _model;
  return rest;
}

/** カルテの案を人が直すときの上限（config/karte.json の edit）：見出し1つの行の数・1行の字数 */
export type KarteEditSettings = { maxLines: number; maxLineChars: number };

export function getKarteEditSettings(): KarteEditSettings {
  return (karte as { edit: KarteEditSettings }).edit;
}

/**
 * 試験10問（/eval。docs/SPEC.md §1.13）の上限（config/ai.json の eval）。
 * minIntervalSeconds = 前の問いの答えが来てから次を流すまであける秒数（/api/ai/ は Vercel の Firewall で1分10回まで）
 * maxCallsPerRun = 1回の試験で AI の窓口を呼ぶ回数の上限（サーバーでも数える） / maxPasscodeChars = 合言葉の窓口が受け取る長さの上限
 * lockSeconds = サーバーの「流している印」の期限（窓口を呼ぶたびに付けなおす。止めた時は消し、途中で落ちた時はこの秒数で消える）
 */
export type EvalSettings = { minIntervalSeconds: number; maxCallsPerRun: number; maxPasscodeChars: number; lockSeconds: number };

export function getEvalSettings(): EvalSettings {
  const e = (ai as { eval: EvalSettings }).eval;
  return { minIntervalSeconds: e.minIntervalSeconds, maxCallsPerRun: e.maxCallsPerRun, maxPasscodeChars: e.maxPasscodeChars, lockSeconds: e.lockSeconds };
}

/**
 * ルールを言葉で書いて足すときの設定（config/ai.json の ruleWords。モデル名は ANTHROPIC_RULES_MODEL でも差しかえられる）。
 * AI（Haiku）は足す欄を文から埋めるだけ。保存は人の「足す」ボタン（docs/SPEC.md §4.3.2）
 */
export type RuleWordsAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 書く文の長さの上限（字）。画面の入力欄も同じ数 */
  maxTextChars: number;
  /** 窓口（/api/ai/rules）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getRuleWordsAiSettings(): RuleWordsAiSettings {
  const a = (ai as { ruleWords: RuleWordsAiSettings }).ruleWords;
  return { ...a, model: process.env.ANTHROPIC_RULES_MODEL || a.model };
}

/** 画面で使う、言葉で書く文の長さの上限（字。鍵や環境変数は読まない） */
export function getRuleWordsMaxChars(): number {
  return (ai as { ruleWords: RuleWordsAiSettings }).ruleWords.maxTextChars;
}

/**
 * 広告の案の「AI のチーム」の会議（config/ai.json の adsTeam。docs/SPEC.md §1.7.4）。
 * Claude を呼ぶのは1回の会議で maxCalls（3。分身・野党・補佐）まで。作り直しはしない。
 */
export type AdsTeamAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン。役ごと） */
  maxReplyTokens: number;
  /** 1回の会議で Claude を呼ぶ回数の上限 */
  maxCalls: number;
  /** 分身の文（1〜2文）の長さの上限（字） */
  maxTwinChars: number;
  /** 野党の「危ない所」「代わりの選び方」・補佐の3行の、1つの長さの上限（字） */
  maxLineChars: number;
  /** 分身に渡す前のオーナーの判断の数の上限（新しい方から） */
  maxHistory: number;
  /** 窓口（/api/ai/ads/team）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getAdsTeamAiSettings(): AdsTeamAiSettings {
  return (ai as { adsTeam: AdsTeamAiSettings }).adsTeam;
}

/** 画面でも使う会議の上限（鍵や環境変数は読まない） */
export function getAdsTeamLimits(): Omit<AdsTeamAiSettings, "model"> {
  const { model: _model, ...rest } = (ai as { adsTeam: AdsTeamAiSettings }).adsTeam;
  void _model;
  return rest;
}

/**
 * 発信の下書きの「AI のチーム」の会議（config/ai.json の postsTeam。docs/SPEC.md §1.10.1）。
 * Claude を呼ぶのは1回の会議で maxCalls（3。分身・野党・補佐）まで。作り直しはしない。モデルは広告のチームと同じ値。
 */
export type PostsTeamAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン。役ごと） */
  maxReplyTokens: number;
  /** 1回の会議で Claude を呼ぶ回数の上限 */
  maxCalls: number;
  /** 分身の直しの数の上限 */
  maxTwinEdits: number;
  /** 補佐が選ぶ直しの数の上限 */
  maxPicks: number;
  /** 直した文・理由の1文の長さの上限（字） */
  maxLineChars: number;
  /** チームに送る下書きの長さの上限（字）。超えたら切り捨てずに「長すぎるのでチームにかけられません」 */
  maxDraftChars: number;
  /** 窓口（/api/ai/posts/team）が受け取る大きさの上限（字） */
  maxRequestChars: number;
};

export function getPostsTeamAiSettings(): PostsTeamAiSettings {
  return (ai as { postsTeam: PostsTeamAiSettings }).postsTeam;
}

/** 画面でも使う会議の上限（鍵や環境変数は読まない） */
export function getPostsTeamLimits(): Omit<PostsTeamAiSettings, "model"> {
  const { model: _model, ...rest } = (ai as { postsTeam: PostsTeamAiSettings }).postsTeam;
  void _model;
  return rest;
}
