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
import { TAB_IDS, TABS, type TabDef, type TabId } from "./tabs";

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Hours = { open: string; close: string } | null;

export type ShopSettings = {
  name: string;
  timezone: string;
  seats: number;
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
  /** next = 次回提案（保存のとき ToDo「次回話すこと」に1行目を足す・朝の要点に出す） */
  role?: "next";
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

export function getAdsAiSettings(): AdsAiSettings {
  const a = (ai as { ads: Omit<AdsAiSettings, "model"> }).ads;
  return { model: getAiSettings().model, ...a };
}

/** 経理のタブの設定（config/accounting.json）。実在の会計サービスの名前は書かない */
export type AccountingSettings = {
  /** 明細を取り込み、登録する先（画面の札。例「会計（架空）」） */
  service: string;
  /** 明細の出どころ（例「カード会社（架空）」） */
  cardSource: string;
};

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
