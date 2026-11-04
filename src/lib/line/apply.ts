// LINE から来た物を、画面（ブラウザ）の側で台帳・ToDo・カルテのメモ・承認の箱に入れる所。形と変え方だけ（どこにも書かない）。
// 書くのは LineBridge.tsx。ここは同じ入力なら同じ答え（テストで確かめる）。
//
// 🔒 確定は人：applyPress を呼んでよいのは、合言葉でつないだ LINE のボタン（サーバーが署名・つなぎ・1回だけの印を
// 確かめて画面に渡した press の知らせ）のときだけ。承認の箱の画面のボタンと同じ変え方（withApproved など）を使う。
// LINE の一言（text）からは確定しない。AI が振り分けた予約も仮押さえまで。

import { approveAd, pendingAd, withAdSkipped, type AdProposal, type AdsState } from "../ads/state";
import { proposalLabel } from "../ads/gate";
import { candidateLabel, judgeSlot, type SlotContext } from "../ai/slots";
import { parseHoldOffer } from "../ai/wire";
import { pendingApprovals, withApproved, withHold, withReleased, withTodo, type BookState, type PendingRow } from "../book/state";
import { savedOn } from "../karte/record";
import type { JournalWho } from "../journal";
import type { Customer } from "../data/types";
import type { AdSettings, Menu, ShopSettings } from "../settings";
import type { LineAskResponse } from "./ask";
import type { ApprovalCard, ScreenEvent } from "./wire";

type Journal = { who: JournalWho; text: string }[];

export type ApplyContext = {
  shop: ShopSettings;
  menus: Menu[];
  customers: Customer[];
  nowIso: string;
  /** 「翌日へ」も入れた今日（YYYY-MM-DD） */
  today: string;
  adSettings: Pick<AdSettings, "checkAfterDays" | "channel">;
};

export type ApplyOutcome = {
  book: BookState;
  ads: AdsState;
  journal: Journal;
  /** LINE に返す1行 */
  reply: string;
  /** 返事にいっしょに付ける承認待ちの行（予約の仮押さえをしたとき） */
  card?: ApprovalCard;
};

const who = (customers: Customer[], id: string) => `${customers.find((c) => c.id === id)?.surname ?? "お客"}（架空）様`;

/** 承認待ちの予約の行を、LINE に届ける形（何を・いつ・理由）にする */
export function reservationCard(row: PendingRow, ctx: Pick<ApplyContext, "shop" | "menus" | "customers">, check?: boolean): ApprovalCard {
  const r = row.reservation;
  const menu = ctx.menus.find((m) => m.id === r.menuId)?.name ?? r.menuId;
  return {
    approvalId: row.approval.id,
    target: "reservation",
    what: `${who(ctx.customers, r.customerId)} ${menu}`,
    when: candidateLabel(ctx, r).replace(` ${menu}`, ""),
    why: row.approval.reason,
    check:
      check === undefined
        ? "承認＝確定して台帳に入ります。見送り＝仮押さえを外します"
        : check
          ? "✓ いまの台帳とルールでも受けられます"
          : "✗ いまの台帳・ルールでは受けられません。画面で確かめてください",
  };
}

/** 承認待ちの広告の案を、LINE に届ける形にする */
export function adCard(p: AdProposal, channel: string): ApprovalCard {
  return {
    approvalId: p.id,
    target: "ad",
    what: `${channel}：${proposalLabel(p)}`,
    when: "承認すると、すぐ変わります",
    why: p.reason,
    check: p.checks.every((c) => c.ok !== false) ? "✓ プログラムの確認を通りました" : "✗ プログラムの確認で止まった所があります",
  };
}

/** いまの台帳とルールで、その仮押さえを受けられるか（承認の箱と同じ確かめ方。自分の仮押さえは数えない） */
export function stillOk(ctx: SlotContext, row: PendingRow): boolean {
  const r = row.reservation;
  return judgeSlot({ ...ctx, booked: ctx.booked.filter((b) => b.id !== r.id) }, r).ok;
}

/**
 * 🔒 LINE の「承認」「見送り」ボタン。承認の箱の画面のボタンと同じ変え方を使う（人が押した扱い）。
 * もう決まった行（画面で押した・期限が切れた・前に LINE で押した）には何もしない。
 */
export function applyPress(ev: Extract<ScreenEvent, { kind: "press" }>, book: BookState, ads: AdsState, ctx: ApplyContext): ApplyOutcome {
  const same = { book, ads, journal: [] as Journal };
  if (ev.target === "reservation") {
    const row = pendingApprovals(book, ctx.nowIso).find((x) => x.approval.id === ev.approvalId);
    if (!row) return { ...same, reply: "この行はもう決まっています（画面で押したか、期限が切れました）。" };
    const r = row.reservation;
    const surname = ctx.customers.find((c) => c.id === r.customerId)?.surname ?? "お客";
    const what = `${surname}（架空）様 ${candidateLabel(ctx, r)}`;
    if (ev.how === "approve")
      return {
        book: withApproved(book, row.approval.id, ctx.nowIso),
        ads,
        journal: [{ who: "オーナー", text: `承認（LINE のボタン）：${what} を確定し、台帳に入れた` }],
        reply: `✓ 確定しました：${what}`,
      };
    return {
      book: withReleased(book, row.approval.id, "skipped", surname, ctx.nowIso),
      ads,
      journal: [
        {
          who: "オーナー",
          text: `見送り（LINE のボタン）：${what} の仮押さえを外し、ToDo に「${surname}（架空）様に別の日時を案内」を足した（お客様の了解なしに時間は変えない）`,
        },
      ],
      reply: `見送りました：仮押さえを外し、ToDo に「${surname}（架空）様に別の日時を案内」を足しました`,
    };
  }
  const p = pendingAd(ads);
  if (!p || p.id !== ev.approvalId) return { ...same, reply: "この広告の案はもう決まっています（画面で押しました）。" };
  if (ev.how === "approve") {
    const out = approveAd(ads, book, p.id, { nowIso: ctx.nowIso, today: ctx.today, shop: ctx.shop, settings: ctx.adSettings });
    return {
      book: out.book,
      ads: out.ads,
      journal: out.journal.map((j) => ({ ...j, text: j.text.replace(/^承認：/, "承認（LINE のボタン）：") })),
      reply: `✓ ${ctx.adSettings.channel}で ${proposalLabel(p).replace(/を(止める|外す)$/, "")}を${p.action === "stop" ? "止めました" : "外しました"}`,
    };
  }
  return {
    book,
    ads: withAdSkipped(ads, p.id, ctx.nowIso),
    journal: [{ who: "オーナー", text: `見送り（LINE のボタン）：広告の案「${proposalLabel(p)}」を閉じた（広告は変えていない）` }],
    reply: `見送りました：広告の案「${proposalLabel(p)}」を閉じました`,
  };
}

export type KarteTarget = { customerId: string; surname: string; date: string; saved: boolean } | null;

/** LINE の一言の答え（/api/ai/line）を、台帳・ToDo・カルテのメモに入れる。予約は仮押さえまで */
export function applyAsk(
  ev: Extract<ScreenEvent, { kind: "text" }>,
  res: Extract<LineAskResponse, { ok: true }>,
  book: BookState,
  ads: AdsState,
  ctx: ApplyContext & { found: Customer[]; karte: KarteTarget; memoMax: number },
): ApplyOutcome & { memo?: { customerId: string; date: string; text: string } } {
  const by = res.via === "ai" ? ("AI" as const) : ("プログラム" as const);
  const tag = res.via === "script" ? "（決まった返事で）" : "";
  const sortLine = (to: string) => ({ who: by, text: `LINE の一言を「${to}」に振り分けた${tag}：「${ev.text}」` });
  const same = { book, ads };
  switch (res.kind) {
    case "todo": {
      const title = ev.text.slice(0, 80);
      return {
        book: withTodo(book, { id: `td-line-${ev.id}`, title, createdAt: ctx.nowIso, done: false }),
        ads,
        journal: [sortLine("ToDo"), { who: "LINE", text: `ToDo に足した：${title}` }],
        reply: `ToDo に足しました：${title}`,
      };
    }
    case "karte": {
      const k = ctx.karte;
      if (ctx.found.length !== 1)
        return { ...same, journal: [sortLine("カルテのメモ")], reply: "どのお客様のメモか、名字を1人だけ入れて送ってください。" };
      if (!k) return { ...same, journal: [sortLine("カルテのメモ")], reply: `今日の予約（確定）に${ctx.found[0].surname}（架空）様がいないので、メモに入れませんでした。` };
      if (k.saved) return { ...same, journal: [sortLine("カルテのメモ")], reply: `${k.surname}（架空）様の今日のカルテはもう保存してあります。` };
      return {
        ...same,
        journal: [sortLine("カルテのメモ"), { who: "LINE", text: `カルテのメモに入れた：${k.surname}（架空）様（今日）。カルテにする・保存は画面で` }],
        reply: `カルテのメモに入れました：${k.surname}（架空）様（今日）。カルテにするのは画面のカルテのタブで（保存は人が押します）`,
        memo: { customerId: k.customerId, date: k.date, text: ev.text.slice(0, ctx.memoMax) },
      };
    }
    case "hold-missing":
      return {
        ...same,
        journal: [sortLine("予約の仮押さえ"), { who: "プログラム", text: `仮押さえしなかった：${res.missing.join("・")}がわからない` }],
        reply: `仮押さえしませんでした。${res.missing.join("・")}を入れて送ってください（例：明日15時に青木さんカットで仮押さえ）`,
      };
    case "hold-no": {
      const alt = res.alternatives.length ? `代わり：${res.alternatives.join("・")}` : "代わりは見つかりませんでした";
      return {
        ...same,
        journal: [
          sortLine("予約の仮押さえ"),
          ...res.steps.map((s) => ({ who: s.kind === "tool" ? ("AI" as const) : ("プログラム" as const), text: `LINE の予約：${s.text}` })),
        ],
        reply: `✗ ${res.label} は受けられません。${res.reason}${alt}`.slice(0, 300),
      };
    }
    case "hold": {
      const h = parseHoldOffer(res.hold);
      const c = ctx.found[0];
      if (!h || !c || h.customerId !== c.id) return { ...same, journal: [sortLine("予約の仮押さえ")], reply: "仮押さえできませんでした。もう一度送ってください。" };
      const next = withHold(book, h);
      const row = pendingApprovals(next, ctx.nowIso).find((x) => x.reservation.id === h.id);
      const label = `${c.surname}（架空）様 ${candidateLabel(ctx, h)}`;
      return {
        book: next,
        ads,
        journal: [
          sortLine("予約の仮押さえ"),
          ...res.steps
            .filter((s) => s.kind !== "hold")
            .map((s) => ({ who: s.kind === "tool" ? ("AI" as const) : ("プログラム" as const), text: `LINE の予約：${s.text}` })),
          { who: "AI", text: `仮押さえした（LINE から）：${label}（承認の箱へ）` },
        ],
        reply: `仮押さえしました：${label}（確定はまだ。下のボタンか画面の承認の箱で）`,
        ...(row ? { card: reservationCard(row, ctx, true) } : {}),
      };
    }
    case "unknown":
      return { ...same, journal: [sortLine("どれでもない")], reply: "うまく振り分けられませんでした。「シャンプー発注」「明日15時に青木さんカットで仮押さえ」のように送ってください。" };
  }
}

/** 一言の名字から、カルテのメモを入れる先（今日の確定の予約）を決める */
export function karteTargetFor(
  found: Customer[],
  todays: { customerId: string; date: string; status: "confirmed" | "hold" }[],
  book: Pick<BookState, "kartes">,
): KarteTarget {
  if (found.length !== 1) return null;
  const c = found[0];
  const r = todays.find((x) => x.customerId === c.id && x.status === "confirmed");
  if (!r) return null;
  return { customerId: c.id, surname: c.surname, date: r.date, saved: !!savedOn(book.kartes, c.id, r.date) };
}
