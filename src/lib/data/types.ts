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
  /** 名字のよみ（ひらがな）。カルテのお客様一覧で50音の行に分ける */
  kana?: string;
  /** 架空のお客様の印（データの印。画面では名前ごとに「架空」の札を出さない。架空であることは入力欄の近くの注意の1行と README で伝える） */
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
  /**
   * 効いたかの判定に使う「後の数」（架空）。その言葉を止めた（外した）あとの週ごとの、広告を出す言葉みんなの数（古い順）。
   * 判定日（承認の checkAfterDays 日後）に、前の同じ週の数（weeks の最後の週から）と比べる（src/lib/ads/verdict.ts）。
   */
  after?: AdAfter[];
  /**
   * 前のオーナーの判断（架空。この表の前の見直しで決めた案）。AI のチームの「分身」が読む（src/lib/ads/team/）。
   * 持つのは対象・止める／外す・承認か見送りか・決めた日（何番目の営業日。負の数は過去）・その時の4週の予約の数だけ。理由は持たない。
   */
  past?: AdPastDecision[];
};

/** 前のオーナーの判断1つ（架空の最初の状態） */
export type AdPastDecision = {
  id: string;
  text: string;
  action: "stop" | "exclude";
  decision: "approved" | "skipped";
  /** 決めた日（起点の日から数えた営業日。負の数 = 過去） */
  day: BusinessDay;
  /** その時の4週の予約の数 */
  bookings: number;
};

/** 止めた（外した）言葉の番号と、その後の週ごとの数（架空） */
export type AdAfter = { no: number; weeks: AdWeek[] };

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

/** version：データの版（freee（テスト事業所）の明細の摘要の印「SecretAIry:<版>:<番号>」に使う。今回の明細だけが持つ） */
export type CardStatement = { version?: string; from: string; to: string; items: CardItem[] };

/** 経理の最初の状態（seed/accounting.json） */
export type AccountingSeed = {
  sales: SalesMonth;
  merchants: Merchant[];
  /** 前の月までの自動のルール */
  rules: MerchantRule[];
  history: MerchantHistory[];
  /** 会計がカード会社から取り込んだ、未処理の通販の明細 */
  statement: CardStatement;
  /** 登録の後の「次の明細（試し）」 */
  trial: CardStatement;
};

/** 発信の「お店のメモ」（架空）。下書きの中身は、このメモと材料にある事だけ */
export type PostMemo = { id: string; title: string; text: string };

/**
 * やること（最初の状態。seed/todo.json）。期限は「何番目の営業日」（0 = 今日・負の数は過ぎた日）。
 * source はどの入口から入った物のつもりか（src/lib/todo/keys.ts の TodoSource）。key は同じ物を2回足さない鍵。
 */
export type Todo = {
  id: string;
  title: string;
  /** いつまで（無ければ決めていない） */
  due?: BusinessDay;
  done: boolean;
  source?: "memo" | "karte" | "ad" | "reserve" | "line" | "chat";
  key?: string;
  /** 投げたメモの元の文（source が memo の物） */
  memo?: string;
  /** 投げたメモで選んだ種類（source が memo の物だけ。customer / supply / shop / office。無ければ その他） */
  category?: "customer" | "supply" | "shop" | "office";
};

// ---- ここから下は形だけ（中身は後日） ----

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
  { key: "title", label: "やること（1行の文）" },
  { key: "due", label: "いつまで（何番目の営業日。無ければ期限なし）" },
  { key: "done", label: "済んだか" },
  { key: "source", label: "どこから入ったか（メモ・カルテ・広告・予約・LINE・チャット）" },
  { key: "key", label: "同じ物を2回足さない鍵（メモ:番号・カルテ:番号・語句:番号・予約:お客様＠日時 など。最初の例は「例:」で始める）" },
  { key: "memo", label: "投げたメモの元の文（プログラムがそのまましまう）" },
  { key: "category", label: "投げたメモで選んだ種類（お客様・仕入れと材料・お店のこと・お金と事務。無ければ その他。ほかの入口は出どころで箱が決まる）" },
];

/**
 * ホームの「AI の仕事」で、これから来る物（最初の状態。seed/jobs.json）。1行ずつ上から順に並べる。
 * reserve = 予約の相談（架空のお客様の文。日は「何番目の営業日」と時刻で持ち、文は画面がその日の言い方で作る）
 * card = 新しい明細（経理の「次の明細（試し）」の架空の明細）/ ads = 広告の見直し / memo = メモ1件（ToDo へ）
 * site = 予約サイトから予約が入る（空いている枠に1件。AI なし。お客様と枠はプログラムが選ぶ。src/lib/book/site.ts）
 */
export type JobSeed =
  | { id: "reserve"; customerId: string; menuId: string; day: BusinessDay; start: string }
  | { id: "card" }
  | { id: "ads" }
  | { id: "memo"; text: string }
  | { id: "site" };
