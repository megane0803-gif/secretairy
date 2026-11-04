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

// ---- 経理（売上・通販の明細） ----

/** 店用 / 私用 */
export type CardUse = "shop" | "private";

/** 売上の1日分（定休日は持たない）。売上は支払い方法の合計（プログラムが足す） */
export type SalesDay = {
  /** YYYY-MM-DD */
  date: string;
  /** 来店（人） */
  visits: number;
  /** 支払い方法ごとの金額（円）。キーは methods の id */
  pay: Record<string, number>;
};

/** 架空の1か月の売上 */
export type SalesMonth = {
  /** YYYY-MM */
  month: string;
  methods: { id: string; name: string }[];
  days: SalesDay[];
};

/** 購入先（架空） */
export type Merchant = { id: string; name: string };

/** 自動のルール：この購入先は店用（私用） */
export type MerchantRule = { merchantId: string; use: CardUse };

/** 前の月までに仕分けた数（購入先ごと） */
export type MerchantHistory = { merchantId: string; shop: number; private: number };

/** 通販の明細の1行。来るのは日付・購入先・金額だけ（品名は無い） */
export type CardItem = {
  /** 番号（1から） */
  no: number;
  /** YYYY-MM-DD */
  date: string;
  merchantId: string;
  /** 円 */
  amount: number;
};

export type CardStatement = { from: string; to: string; items: CardItem[] };

/** 経理の最初の状態（seed/accounting.json） */
export type AccountingSeed = {
  sales: SalesMonth;
  merchants: Merchant[];
  /** 前の月までの自動のルール */
  rules: MerchantRule[];
  history: MerchantHistory[];
  /** 会計（架空）がカード会社から取り込んだ、未処理の通販の明細 */
  statement: CardStatement;
  /** 登録の後の「次の明細（試し）」 */
  trial: CardStatement;
};

// ---- ここから下は形だけ（中身は後日） ----

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

export const CARD_FIELDS: FieldNote[] = [
  { key: "statement.items[].no", label: "番号" },
  { key: "statement.items[].date", label: "日付（YYYY-MM-DD。品名は来ない）" },
  { key: "statement.items[].merchantId", label: "購入先（merchants の id）" },
  { key: "statement.items[].amount", label: "金額（円）" },
  { key: "rules[]", label: "前の月までの自動のルール（購入先ごとに店用か私用）" },
  { key: "history[]", label: "前の月までに仕分けた数（購入先ごとの店用・私用）" },
  { key: "sales.days[]", label: "売上の1日分（日付・来店・支払い方法ごとの金額。定休日は持たない）" },
];

export const TODO_FIELDS: FieldNote[] = [
  { key: "title", label: "やること" },
  { key: "due", label: "いつまで（何番目の営業日）" },
  { key: "done", label: "済んだか" },
];
