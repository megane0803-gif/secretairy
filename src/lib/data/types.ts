// 架空のデータの形。最初の状態は seed/*.json に置き、src/lib/data/seed.ts から読む。
// 画面で触った後の変化はブラウザの中だけに残す（docs/SPEC.md §5.1）。
//
// 日付は「今日から何番目の営業日か」で持つ（0 = 今日。負の数は過去の営業日）。
// こうしておくと、いつ開いても「今日から2週間分」の形になり、定休日にも置かれない。

/** 何番目の営業日（0 = 今日） */
export type BusinessDay = number;

export type Customer = {
  id: string;
  /** 名字だけ */
  surname: string;
  /** 架空のお客様。画面では必ず「架空」の札を出す */
  fictional: true;
  /** まだ一度も来ていない（初めての方） */
  firstVisit: boolean;
};

/** confirmed = 確定 / hold = 仮押さえ */
export type ReservationStatus = "confirmed" | "hold";

export type SeedReservation = {
  id: string;
  customerId: string;
  menuId: string;
  day: BusinessDay;
  /** 始まる時刻 HH:MM */
  start: string;
  status: ReservationStatus;
};

/**
 * 前回までのカルテ（最初の状態）。日付・メニュー・お客様は、その予約（前回の来店）から取る。
 * こうしておくと、カルテの日付とメニューがいつも予約の「前回」とそろう。
 */
export type SeedKarte = {
  id: string;
  /** どの予約（前回の来店）のカルテか */
  reservationId: string;
  /** 見出しの id（config/karte.json）ごとの短い行 */
  sections: Record<string, string[]>;
};

/**
 * カルテの「例文を入れる」。今日のお客様1人に1つ、話し言葉の施術メモ。
 * scripted は「決まった返事（AI なし）」でカルテにしたときの下書き（テストと同じ物）。
 * AI の書きすぎ（メモに無い言葉・数字）をわざと1行まぜてある例があり、言葉の門で外れることを見せる。
 */
export type KarteExample = {
  customerId: string;
  memo: string;
  scripted: string;
};

/** 1週分の数（どれもプログラムが表から出す。AI は数を作らない） */
export type AdWeek = {
  /** 押された回数 */
  clicks: number;
  /** かかったお金（円） */
  cost: number;
  /** 予約の数 */
  bookings: number;
};

/**
 * 広告の1行。番号（no）は「広告を出す言葉」と「お客さんが調べた言葉」を通して1つずつ違う。
 * weeks は古い順に4週分（4週前・3週前・2週前・先週）。
 */
export type AdRow = {
  no: number;
  text: string;
  weeks: AdWeek[];
};

/** 広告を出す言葉（止められる）。売りのメニューの言葉は menuId を持つ（config/ads.json の featuredMenus） */
export type AdKeyword = AdRow & { menuId?: string };

/** 架空の広告の4週分（seed/ads.json） */
export type AdReport = {
  /** 広告を出す言葉（8つ。止められる） */
  keywords: AdKeyword[];
  /** お客さんが調べた言葉（多い順に8つ。外せる） */
  searchTerms: AdRow[];
};

// ---- ここから下は形だけ（中身は後日） ----

/** お金の出入り */
export type MoneyEntry = {
  id: string;
  day: BusinessDay;
  /** income = 入ったお金 / expense = 使ったお金 */
  kind: "income" | "expense";
  /** 何のお金か（例：カット売上・シャンプー仕入れ） */
  label: string;
  /** 円 */
  amount: number;
  /** 予約から来た売上なら、その予約 */
  reservationId?: string;
};

/** やること */
export type Todo = {
  id: string;
  title: string;
  /** いつまで（無ければ決めていない） */
  due?: BusinessDay;
  done: boolean;
};

/** 画面の「くわしく」で見せる、形の説明 */
export type FieldNote = { key: string; label: string };

export const AD_FIELDS: FieldNote[] = [
  { key: "no", label: "番号（「N番を止める」「N番を外す」の N）" },
  { key: "text", label: "言葉" },
  { key: "menuId", label: "売りのメニュー（広告を出す言葉だけ。あれば「売り」の印）" },
  { key: "weeks[].clicks", label: "押された回数（週ごと）" },
  { key: "weeks[].cost", label: "かかったお金（円・週ごと）" },
  { key: "weeks[].bookings", label: "予約の数（週ごと）" },
];

export const MONEY_FIELDS: FieldNote[] = [
  { key: "day", label: "何番目の営業日（負の数は過去）" },
  { key: "kind", label: "入ったお金 / 使ったお金" },
  { key: "label", label: "何のお金か" },
  { key: "amount", label: "金額（円）" },
  { key: "reservationId", label: "どの予約の売上か（あれば）" },
];

export const TODO_FIELDS: FieldNote[] = [
  { key: "title", label: "やること" },
  { key: "due", label: "いつまで（何番目の営業日）" },
  { key: "done", label: "済んだか" },
];
