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

// ---- ここから下は形だけ（中身は後日） ----

/** 広告の案。AI の案は「前 → 後」と理由1文 */
export type Ad = {
  id: string;
  /** どこに出すか（例：チラシ・地図アプリ・SNS） */
  channel: string;
  title: string;
  before?: string;
  after: string;
  reason: string;
  /** draft = 案 / approved = 人が確定した */
  status: "draft" | "approved";
  day: BusinessDay;
};

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
  { key: "channel", label: "どこに出すか" },
  { key: "title", label: "見出し" },
  { key: "before → after", label: "前 → 後" },
  { key: "reason", label: "理由（1文）" },
  { key: "status", label: "状態（案 / 確定）" },
  { key: "day", label: "何番目の営業日" },
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
