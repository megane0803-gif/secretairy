// 来た人の呼び出しの数え方（サーバーの側）。広告のだれでも試す・広告の読み直す（src/lib/ads/live/server.ts）と、
// 経理の来た人の試し（src/lib/freee/try.ts）が、どれもここを通す（2つ作らない）。
//   - 数えるのは置き場（Upstash）で、先に足してから比べる（同時に来ても数えもれが無い）
//   - 順は、同じ送り元（1日 → 1時間 → 1分）→ 広い束（IPv6 の /48。1日 → 1時間）→ サイト全体（1分 → 1時間 → 1日）。
//     こえたらそこで止め、先の数は足さない（少ない送り元が送り続けても、全体の数はその送り元の上限までしか増えない）
//   - サイト全体の1日の数は、1時間ごとにも割り振る（site.hour）。1日の数を site.hour × 24 以上にしておくと、1日の数には届かず、
//     使い切られても止まるのはその時の終わりまで（長くて1時間）
//   - 送り元は日ごとの塩と合わせたハッシュ（src/lib/server/source.ts の sourceHashes）だけを鍵に入れる（生の IP は入れない）

/** 1つの窓口の上限（config/ に置く。コードに数を書かない） */
export type CallLimits = {
  /** 同じ送り元（IPv4 は1つの番地・IPv6 は /64） */
  source: { day: number; hour: number; minute: number };
  /** 同じ広い束（IPv6 の /48。同じ家や会社の人が困らないよう、source より大きい数） */
  wide: { day: number; hour: number };
  /** サイト全体（1時間の数は1日の数の割り振り） */
  site: { minute: number; hour: number; day: number };
};

/** どこで止まったか（ok はどこにも届いていない） */
export type CallCount = "ok" | "source-day" | "wide-day" | "source-soon" | "site-minute" | "site-hour" | "site-day";

export type CallCountCtx = {
  /** 置き場の incr（期限は足すのと同じ1回で付く。src/lib/line/store.ts）。置き場の失敗は呼ぶ側の形で投げる */
  incr: (key: string, ex: number) => Promise<number>;
  /** 窓口ごとの鍵の頭（例 "ads:live:try"） */
  prefix: string;
  /** 店の日付（YYYY-MM-DD） */
  date: string;
  /** 店の時（"00"〜"23"） */
  hour: string;
  /** いまの分（1970年からの分の数） */
  minute: number;
  /** 送り元の束のハッシュ（sourceHashes） */
  sender: { narrow: string; wide: string | null };
};

const DAY_EX = 2 * 86_400;
const HOUR_EX = 2 * 3_600;
const MINUTE_EX = 120;

/** 数の鍵（テストで見る用にも出す） */
export function callKeys(c: Pick<CallCountCtx, "prefix" | "date" | "hour" | "minute" | "sender">) {
  const h = `${c.date}T${c.hour}`;
  return {
    sourceDay: `${c.prefix}:src:${c.date}:${c.sender.narrow}`,
    sourceHour: `${c.prefix}:src:${h}:${c.sender.narrow}`,
    sourceMinute: `${c.prefix}:src:m${c.minute}:${c.sender.narrow}`,
    wideDay: c.sender.wide ? `${c.prefix}:wide:${c.date}:${c.sender.wide}` : null,
    wideHour: c.sender.wide ? `${c.prefix}:wide:${h}:${c.sender.wide}` : null,
    siteMinute: `${c.prefix}:min:${c.minute}`,
    siteHour: `${c.prefix}:hour:${h}`,
    siteDay: `${c.prefix}:day:${c.date}`,
  };
}

/** 1回の呼び出しを数える（先に足してから比べる・こえたらそこで止めて先は足さない） */
export async function countCall(c: CallCountCtx, lim: CallLimits): Promise<CallCount> {
  const k = callKeys(c);
  const steps: [string | null, number, number, CallCount][] = [
    [k.sourceDay, DAY_EX, lim.source.day, "source-day"],
    [k.sourceHour, HOUR_EX, lim.source.hour, "source-soon"],
    [k.sourceMinute, MINUTE_EX, lim.source.minute, "source-soon"],
    [k.wideDay, DAY_EX, lim.wide.day, "wide-day"],
    [k.wideHour, HOUR_EX, lim.wide.hour, "source-soon"],
    [k.siteMinute, MINUTE_EX, lim.site.minute, "site-minute"],
    [k.siteHour, HOUR_EX, lim.site.hour, "site-hour"],
    [k.siteDay, DAY_EX, lim.site.day, "site-day"],
  ];
  for (const [key, ex, max, hit] of steps) {
    if (key === null) continue;
    if ((await c.incr(key, ex)) > max) return hit;
  }
  return "ok";
}

const clocks = new Map<string, { date: Intl.DateTimeFormat; hour: Intl.DateTimeFormat }>();

/** 店の日付と時（Intl。夏時間のある所でも、その時の店の時計の日付と時） */
export function shopClock(timeZone: string, nowMs: number): { date: string; hour: string; minute: number } {
  let f = clocks.get(timeZone);
  if (!f) {
    f = { date: new Intl.DateTimeFormat("en-CA", { timeZone }), hour: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }) };
    clocks.set(timeZone, f);
  }
  const d = new Date(nowMs);
  return { date: f.date.format(d), hour: f.hour.format(d).padStart(2, "0"), minute: Math.floor(nowMs / 60_000) };
}

/**
 * 上限の数の約束（config の確かめ。テストで全部の窓口に当てる）：
 * - 1日の数は1時間の割り振りの24倍以上（1日の数に届かない＝使い切られても止まるのは長くて1時間）
 * - IPv4 の番地10個（同じ送り元の1日 × 10）と IPv6 の /48 1つ（広い束の1日）では、1日の全体に届かない
 * - 1つの送り元は全体の1時間の3分の1まで・/48 1つでは全体の1時間を使い切れない（1つの束が1時間ずつ散らして送っても、ほかの人を止めない）
 * - 細かい単位ほど小さい（送り元 ≦ 広い束・1分 ≦ 1時間 ≦ 1日）
 */
export function callLimitsProblem(l: CallLimits): string | null {
  const pos = (n: number) => Number.isInteger(n) && n > 0;
  const all = [l.source.day, l.source.hour, l.source.minute, l.wide.day, l.wide.hour, l.site.minute, l.site.hour, l.site.day];
  if (!all.every(pos)) return "数は1以上の整数";
  if (l.site.day < l.site.hour * 24) return "1日の数が1時間の割り振りの24倍より小さい";
  if (l.source.day * 10 >= l.site.day) return "同じ送り元の1日の10倍が、全体の1日に届く";
  if (l.wide.day >= l.site.day) return "広い束の1日が、全体の1日に届く";
  if (l.source.day > l.wide.day || l.source.hour > l.wide.hour) return "送り元の数が広い束より大きい";
  if (l.source.hour * 3 > l.site.hour) return "1つの送り元で、全体の1時間の3分の1より多く使える";
  if (l.wide.hour >= l.site.hour) return "広い束1つで、全体の1時間を使い切れる";
  if (l.source.minute > l.source.hour || l.source.hour > l.source.day || l.wide.hour > l.wide.day) return "送り元の細かい単位が大きい";
  if (l.site.minute > l.site.hour || l.site.hour > l.site.day) return "全体の細かい単位が大きい";
  return null;
}
