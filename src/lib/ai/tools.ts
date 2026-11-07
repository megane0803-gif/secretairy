// 予約チャットで AI に渡す道具は5つだけ：空きを調べる・ルールを確かめる・前回を見る・仮押さえ・仮押さえを外す。
// 🔒 確定の道具は作らない（確定は人のボタンだけ。src/lib/rules/locked.ts）。
// どの道具も、答えはプログラム（slots.ts → judge.ts）が出す。仮押さえも、ここでもう一度判定してから出す。
// 仮押さえを外せるのは、この会話で作った、まだ承認されていない仮押さえだけ（プログラムで確かめる）。

import { calDay, isRealDate } from "../calendar";
import { comboIdOf } from "../combo";
import { scopeTag } from "../rules/describe";
import type { Step, Candidate, HoldOffer, Visit } from "./wire";
import {
  alternativesFor,
  candidateLabel,
  comboRefusal,
  daysInMonth,
  findOnDays,
  findSlots,
  judgeSlot,
  MAX_CANDIDATES,
  menuName,
  menuOf,
  noSlotOf,
  plainReason,
  previousVisit,
  ownerRefusal,
  refusalOf,
  sameSlot,
  type SlotContext,
  type SlotSearch,
  type WeekdayKey,
} from "./slots";

export type ToolName = "find_openings" | "check_rules" | "previous_visit" | "place_hold" | "release_hold";

/** 画面の言葉での道具の名前 */
export const TOOL_LABEL: Record<ToolName, string> = {
  find_openings: "空きを調べる",
  check_rules: "ルールを確かめる",
  previous_visit: "前回を見る",
  place_hold: "仮押さえ",
  release_hold: "仮押さえを外す",
};

type Prop = { type: "string"; description: string } | { type: "array"; items: { type: "string" }; description: string };

export type ToolDef = {
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, Prop>;
    required: string[];
    additionalProperties: false;
  };
};

const DATE = { type: "string" as const, description: "日付 YYYY-MM-DD（今日の日付と暦は指示に書いてあります）" };
const TIME = { type: "string" as const, description: "始まる時刻 HH:MM（24時間）" };
const MENUS = {
  type: "array" as const,
  items: { type: "string" as const },
  description: "1回の来店のメニューの id を全部（指示のメニュー一覧の id）。複数なら所要時間はプログラムが足す",
};
const MENU = { type: "string" as const, description: "メニューの id（1つだけのとき。複数なら menu_ids）" };

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "find_openings",
    description:
      "空きを調べる。そのメニューで受けられる枠（店の設定とルールをプログラムが確かめ済み）を返す。" +
      "希望の日がいくつかあるときは dates に全部入れる（日ごとに1つずつ返る）。「11月の金曜」のような幅のある言い方は month と weekday（当てはまる日を全部見る）。" +
      "日が1つなら date。日時が無ければ今から先を探す。同じ日に近すぎる時刻は返さない。",
    input_schema: {
      type: "object",
      properties: {
        menu_ids: MENUS,
        menu_id: MENU,
        date: DATE,
        dates: { type: "array", items: { type: "string" }, description: "希望の日が複数のとき、その日を全部（YYYY-MM-DD）" },
        month: { type: "string", description: "幅のある言い方の月 YYYY-MM（weekday といっしょに）" },
        weekday: { type: "string", description: "曜日 mon / tue / wed / thu / fri / sat / sun（month といっしょに）" },
        after: { type: "string", description: "この時刻（HH:MM）以降を探す" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "check_rules",
    description:
      "ルールを確かめる。お客様が言った日時・メニューを受けられるかを、プログラムが店の設定とルールで判定する。受けられないときは理由1文と、代わりの枠を返す。",
    input_schema: {
      type: "object",
      properties: { menu_ids: MENUS, menu_id: MENU, date: DATE, start: TIME },
      required: ["date", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "previous_visit",
    description: "前回を見る。いま話しているお客様の、保存したカルテ（前回の来店）の日とメニューを返す。カルテが無ければ「前回の記録なし」。",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "place_hold",
    description:
      "仮押さえ。お客様が、直前に出した候補から選んだときだけ使う（例：「1つ目で」）。確定ではない。プログラムがもう一度判定し、受けられれば仮押さえして承認BOXに入れる。",
    input_schema: {
      type: "object",
      properties: { menu_ids: MENUS, menu_id: MENU, date: DATE, start: TIME },
      required: ["date", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "release_hold",
    description:
      "仮押さえを外す。この会話で仮押さえした後に、お客様が文字で「ずらしたい」「やめたい」と言ったときだけ使う。外せるのは、この会話で作った、まだ承認されていない仮押さえだけ（指示の「この会話の仮押さえ」の id）。",
    input_schema: {
      type: "object",
      properties: { hold_id: { type: "string", description: "外す仮押さえの id" } },
      required: ["hold_id"],
      additionalProperties: false,
    },
  },
];

export type ToolContext = SlotContext & {
  /** そのお客様のカルテの日付とメニュー（「前回を見る」に使う） */
  visits: Visit[];
  /** 直前の返事でお客様に出した候補。仮押さえはこの中から選ばれた物だけ */
  shown: Candidate[];
  /** いまの時刻（ISO） */
  nowIso: string;
  /** この相談でもう仮押さえしたか（1回の相談で1つまで） */
  held: boolean;
  /** この会話で作った仮押さえの id（外せるのはこの中の、まだ承認待ちの物だけ） */
  convHolds: string[];
  /** この相談で外した仮押さえの枠（「ずらしたい」なので、同じ枠はもう出さない） */
  released: Candidate[];
  newId: () => string;
};

export type ToolOutcome = {
  /** AI に返す中身（JSON の文字） */
  content: string;
  isError?: boolean;
  steps: Step[];
  /** お客様に出す候補（この道具の答えに入っていた物） */
  candidates?: Candidate[];
  hold?: HoldOffer;
  /** 外した仮押さえの id */
  release?: string;
  /**
   * お客様に伝えない理由（間をあける・同じ時間に受ける人数 など。rules/tellable.ts）で断った。
   * このときは AI に返事の文を作らせず、プログラムが「その時間はお受けできません」＋この道具の候補で返す（agent.ts）
   */
  hidden?: boolean;
  /** hidden のときのお客様への1文（無ければ「その時間はお受けできません」） */
  hiddenReason?: string;
  /** 組み合わせそのものを受けられない（日を変えても同じ） */
  combo?: boolean;
  /** オーナーに見せる理由（店の中の決まりも書く。LINE のオーナー側だけが使う。AI に返す content には入れない） */
  ownerReason?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const WEEKDAYS: WeekdayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_DATES = 31;

type Input = {
  menuId?: string;
  date?: string;
  dates?: string[];
  month?: string;
  weekday?: WeekdayKey;
  start?: string;
  after?: string;
  holdId?: string;
};

/** 道具に来た入力を確かめる（AI の出した物なので、そのまま信じない） */
function readInput(ctx: ToolContext, name: ToolName, raw: unknown): ({ ok: true } & Input) | { ok: false; reason: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : undefined);
  const strs = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()) : undefined);
  if (name === "previous_visit") return { ok: true };
  if (name === "release_hold") {
    const holdId = str("hold_id");
    return holdId ? { ok: true, holdId } : { ok: false, reason: "hold_id が要ります" };
  }
  const ids = strs("menu_ids")?.filter(Boolean) ?? [];
  const one = str("menu_id");
  const list = ids.length ? ids : one ? [one] : [];
  const menuId = list.length ? comboIdOf(ctx.menus, list) : null;
  if (!menuId || !menuOf(ctx, menuId)) return { ok: false, reason: "menu_ids がメニュー一覧にありません" };
  const date = str("date");
  const start = str("start");
  const after = str("after");
  const dates = strs("dates");
  const month = str("month");
  const weekday = str("weekday");
  if (date !== undefined && !DATE_RE.test(date)) return { ok: false, reason: "date は YYYY-MM-DD で入れてください" };
  if (dates && (dates.length > MAX_DATES || dates.some((d) => !DATE_RE.test(d)))) return { ok: false, reason: "dates は YYYY-MM-DD の並びで入れてください" };
  // 形が合っていても暦に無い日（11/32・2/29・4/31 など）は断る（暦の計算で次の月に回す前の文字のまま確かめる）
  if (date !== undefined && !isRealDate(date)) return { ok: false, reason: "date は暦にある日付（YYYY-MM-DD）で入れてください" };
  if (dates && dates.some((d) => !isRealDate(d))) return { ok: false, reason: "dates は暦にある日付（YYYY-MM-DD）の並びで入れてください" };
  if (month !== undefined && month !== "" && !MONTH_RE.test(month)) return { ok: false, reason: "month は YYYY-MM で入れてください" };
  if (weekday !== undefined && weekday !== "" && !WEEKDAYS.includes(weekday as WeekdayKey))
    return { ok: false, reason: "weekday は mon〜sun で入れてください" };
  if (start !== undefined && !TIME_RE.test(start)) return { ok: false, reason: "start は HH:MM で入れてください" };
  if (after !== undefined && after !== "" && !TIME_RE.test(after)) return { ok: false, reason: "after は HH:MM で入れてください" };
  if ((name === "check_rules" || name === "place_hold") && (!date || !start)) return { ok: false, reason: "date と start が要ります" };
  return {
    ok: true,
    menuId,
    date,
    start,
    after: after || undefined,
    dates: dates?.length ? dates : undefined,
    month: month || undefined,
    weekday: (weekday || undefined) as WeekdayKey | undefined,
  };
}

/** 外した枠の行（どのルール・どの店の設定で外したか） */
function excludedSteps(search: SlotSearch): Step[] {
  return search.excluded
    .filter((e) => e.ex.key !== "base:open-day")
    .map((e) => ({
      kind: "reject" as const,
      text:
        e.ex.kind === "rule"
          ? `ルールで外した：${e.ex.label}（${e.count}枠。${plainReason(e.ex.reason)}）`
          : e.ex.key === "base:seats"
            ? `埋まっていて外した：${e.count}枠`
            : `店の設定で外した：${e.ex.label}（${e.count}枠。${plainReason(e.ex.reason)}）`,
    }));
}

function listed(ctx: ToolContext, list: Candidate[]) {
  return list.map((c, i) => ({ no: i + 1, label: candidateLabel(ctx, c), menu_id: c.menuId, date: c.date, start: c.start }));
}

function json(x: unknown): string {
  return JSON.stringify(x);
}

/** 組み合わせで断ったときのオーナー向けの理由（「お客様に伝える」のチェックがあっても無くても同じ文） */
export function comboOwnerReason(ruleLabel: string): string {
  return `「${ruleLabel}」という決まりがあるので、この組み合わせではお受けできません。`;
}

/**
 * 組み合わせそのものを受けられないとき（「いっしょに受けない組み合わせ」）の答え。
 * 伝えるルール（オーナーが「お客様に伝える」にした）なら、ルールの名前を理由に返す（AI が伝える）。
 * 伝えないルールなら、AI に中身を渡さず（hidden）、その組み合わせにならない代わり（2つのどちらかを外したメニュー）の枠をプログラムが探す。
 */
function comboRefused(ctx: ToolContext, label: string, menuId: string, from: { date: string; time?: string; near?: string }): ToolOutcome | null {
  const why = comboRefusal(ctx, menuId);
  if (!why) return null;
  const steps: Step[] = [
    { kind: "tool", text: `${label}：${menuName(ctx, menuId)} → ✗ この組み合わせは受けられません` },
    { kind: "reject", text: `ルールで外した：${why.rule.label}${why.tell ? "（お客様に伝える）" : ""}` },
  ];
  if (why.tell)
    return { content: json({ ok: false, reason: why.text, combo: true, candidates: [] }), combo: true, ownerReason: comboOwnerReason(why.rule.label), steps, candidates: [] };
  const alt: Candidate[] = [];
  for (const id of why.without) {
    const found = findSlots(ctx, id, from, 1, ctx.released).slots[0];
    if (found && alt.length < MAX_CANDIDATES) alt.push(found);
  }
  steps.push({
    kind: "tool",
    text: `その組み合わせにならない代わりを調べる：${why.without.map((id) => menuName(ctx, id)).join("・") || "なし"} → ${alt.map((c) => candidateLabel(ctx, c)).join("・") || "見つかりませんでした"}`,
  });
  return {
    content: json({ ok: false, reason: why.text, combo: true, candidates: listed(ctx, alt) }),
    combo: true,
    hidden: true,
    hiddenReason: why.text,
    ownerReason: comboOwnerReason(why.rule.label),
    steps,
    candidates: alt,
  };
}

export function runTool(ctx: ToolContext, name: string, raw: unknown): ToolOutcome {
  if (!(name in TOOL_LABEL)) {
    // 🔒 確定の道具は無い。ほかの名前も受け付けない
    return {
      content: json({ ok: false, error: `「${name}」という道具はありません。確定は人がボタンで行います。` }),
      isError: true,
      steps: [{ kind: "reject", text: `使えない道具を呼ぼうとしたので止めた：${name}` }],
    };
  }
  const tool = name as ToolName;
  const label = TOOL_LABEL[tool];
  const input = readInput(ctx, tool, raw);
  if (!input.ok) {
    return {
      content: json({ ok: false, error: input.reason }),
      isError: true,
      steps: [{ kind: "tool", text: `${label}：入力がおかしいので調べませんでした（${input.reason}）` }],
    };
  }

  switch (tool) {
    case "previous_visit": {
      const prev = previousVisit(ctx);
      const who = `${ctx.customer.surname}様`;
      if (!prev)
        return {
          content: json({ found: false, note: "前回の記録なし" }),
          steps: [{ kind: "tool", text: `${label}：${who} → 前回の記録なし（カルテがありません）` }],
        };
      const day = calDay(ctx.shop, prev.date);
      const name = menuName(ctx, prev.menuId);
      const minutes = menuOf(ctx, prev.menuId)?.minutes;
      return {
        content: json({
          found: true,
          date: prev.date,
          label: day.label,
          menu_id: prev.menuId,
          menu_name: name,
          minutes,
          note: "保存したカルテのメニュー。このメニューで find_openings を呼ぶ",
        }),
        steps: [{ kind: "tool", text: `${label}：${who} → ${day.label} ${name}（${minutes ?? "?"}分。保存したカルテから）` }],
      };
    }

    case "find_openings": {
      const menuId = input.menuId!;
      const refused = comboRefused(ctx, label, menuId, {
        date: input.date ?? input.dates?.[0] ?? (input.month ? `${input.month}-01` : ctx.now.date),
        time: input.after ?? (input.date ? undefined : ctx.now.time),
      });
      if (refused) return refused;
      // 日が複数（dates）・幅のある言い方（month と weekday）は、当てはまる日を全部見て、日ごとに1つずつ
      const days = input.dates ?? (input.month ? daysInMonth(ctx, input.month, input.weekday) : null);
      let search: SlotSearch;
      let fromLabel: string;
      if (days) {
        const r = findOnDays(ctx, menuId, days, input.after, undefined, ctx.released);
        search = r;
        fromLabel = r.looked.length ? `${r.looked.map((d) => calDay(ctx.shop, d).label).join("・")}（日ごとに1つ）` : "当てはまる日なし";
      } else {
        // 日と時刻（after）を言われたら、次の日からもその時刻に近い所から出す（今から先を探すときは開店から）
        const from = {
          date: input.date ?? ctx.now.date,
          time: input.after ?? (input.date ? undefined : ctx.now.time),
          near: input.date ? input.after : undefined,
        };
        search = findSlots(ctx, menuId, from, undefined, ctx.released);
        fromLabel = `${calDay(ctx.shop, from.date < ctx.today.date ? ctx.today.date : from.date).label}${from.time ? ` ${from.time}` : ""} から`;
      }
      const found = search.slots.map((c) => candidateLabel(ctx, c)).join("・");
      const none = search.slots.length ? null : noSlotOf(search);
      return {
        content: json({
          menu: menuName(ctx, menuId),
          minutes: menuOf(ctx, menuId)?.minutes,
          candidates: listed(ctx, search.slots),
          ...(none ? { reason: none.text, note: "空きが見つかりませんでした" } : { note: "番号の順にお客様へ出す" }),
        }),
        ...(none && !none.tell ? { hidden: true } : {}),
        steps: [
          { kind: "tool", text: `${label}：${menuName(ctx, menuId)}を ${fromLabel} → ${found || "見つかりませんでした"}` },
          ...excludedSteps(search),
        ],
        candidates: search.slots,
      };
    }

    case "check_rules": {
      const c = { menuId: input.menuId!, date: input.date!, start: input.start! };
      const refused = comboRefused(ctx, label, c.menuId, { date: c.date, time: c.start, near: c.start });
      if (refused) return refused;
      const v = judgeSlot(ctx, c);
      const what = candidateLabel(ctx, c);
      if (v.ok)
        return {
          content: json({ ok: true, candidates: listed(ctx, [c]), note: "受けられます。この候補をお客様に出し、選んでもらう" }),
          steps: [{ kind: "tool", text: `${label}：${what} → ✓ 受けられます` }],
          candidates: [c],
        };
      const alt = alternativesFor(ctx, c, ctx.released);
      const fails: Step[] = [
        ...v.base.filter((b) => !b.ok).map((b) => ({ kind: "reject" as const, text: `店の設定で外した：${b.label}（${plainReason(b.reason)}）` })),
        ...v.results
          .filter((r) => !r.ok)
          .map((r) => ({
            kind: "reject" as const,
            text: `ルールで外した：[${scopeTag(r.rule, (id) => menuName(ctx, id))}] ${r.rule.label}（${plainReason(r.reason)}）`,
          })),
      ];
      const why = refusalOf(ctx, v);
      return {
        content: json({ ok: false, reason: why.text, candidates: listed(ctx, alt.slots) }),
        ...(why.tell ? {} : { hidden: true }),
        ownerReason: ownerRefusal(ctx, v),
        steps: [
          { kind: "tool", text: `${label}：${what} → ✗ 受けられません` },
          ...fails,
          {
            kind: "tool",
            text: `代わりを調べる：→ ${alt.slots.map((s) => candidateLabel(ctx, s)).join("・") || "見つかりませんでした"}`,
          },
        ],
        candidates: alt.slots,
      };
    }

    case "place_hold": {
      const c = { menuId: input.menuId!, date: input.date!, start: input.start! };
      const what = candidateLabel(ctx, c);
      if (ctx.held)
        return {
          content: json({ ok: false, error: "1回の相談で仮押さえは1つまでです" }),
          isError: true,
          steps: [{ kind: "reject", text: `${label}：1回の相談で2つ目は押さえない（${what}）` }],
        };
      // お客様が選んだ候補（直前に出した物）だけ。AI が自分で決めた日時は押さえない
      if (!ctx.shown.some((s) => sameSlot(s, c)))
        return {
          content: json({
            ok: false,
            error: "お客様に出した候補ではありません。先に候補を出して、お客様に選んでもらってください。",
          }),
          isError: true,
          steps: [{ kind: "reject", text: `${label}：お客様が選んだ候補ではないので押さえない（${what}）` }],
        };
      // サーバーでもう一度プログラムで判定する（画面から来た台帳とルールで）
      const v = judgeSlot(ctx, c);
      if (!v.ok) {
        const alt = alternativesFor(ctx, c, ctx.released);
        const why = refusalOf(ctx, v);
        return {
          content: json({ ok: false, reason: why.text, candidates: listed(ctx, alt.slots) }),
          ...(why.tell ? {} : { hidden: true }),
          ownerReason: ownerRefusal(ctx, v),
          steps: [
            { kind: "reject", text: `${label}：もう一度確かめたら受けられませんでした（${what}。${ownerRefusal(ctx, v)}）` },
          ],
          candidates: alt.slots,
        };
      }
      const hours = ctx.shop.holdExpiresHours;
      const hold: HoldOffer = {
        id: ctx.newId(),
        customerId: ctx.customer.id,
        menuId: c.menuId,
        date: c.date,
        start: c.start,
        heldAt: ctx.nowIso,
        expiresAt: new Date(Date.parse(ctx.nowIso) + hours * 3_600_000).toISOString(),
        reason: "お客様が予約チャットの候補から選びました（空きとルールはプログラムで確かめ済み）",
      };
      return {
        content: json({
          ok: true,
          held: candidateLabel(ctx, c),
          hold_id: hold.id,
          note: "仮押さえです。確定ではありません。お客様には「仮でお取りしました。お店から確定のご連絡をします」と伝える",
        }),
        steps: [{ kind: "hold", text: `${label}：${what}（承認BOXへ。期限は${hours}時間）` }],
        hold,
      };
    }

    case "release_hold": {
      const id = input.holdId!;
      const row = ctx.booked.find((b) => b.id === id && b.customerId === ctx.customer.id);
      // この会話で作った仮押さえか（プログラムで確かめる。AI の言う id をそのまま信じない）
      if (!ctx.convHolds.includes(id) || !row)
        return {
          content: json({ ok: false, error: "この会話で作った仮押さえではないので、外せません。お店に確かめてご連絡しますと伝える" }),
          isError: true,
          steps: [{ kind: "reject", text: `${label}：この会話で作った仮押さえではないので外さない（${id}）` }],
        };
      const what = candidateLabel(ctx, row);
      if (row.status !== "hold")
        return {
          content: json({ ok: false, error: "もう承認された予約なので、ここでは外せません。お店に確かめてご連絡しますと伝える" }),
          isError: true,
          steps: [{ kind: "reject", text: `${label}：もう承認された予約なので外さない（${what}）` }],
        };
      return {
        content: json({
          ok: true,
          released: what,
          menu_id: row.menuId,
          date: row.date,
          start: row.start,
          note: "仮押さえを外しました。ずらしたいなら、新しい候補を出す（同じ枠はもう出さない）。やめたいなら、外したことだけ伝える",
        }),
        steps: [{ kind: "release", text: `${label}：${what}（お客様の頼み。この会話の仮押さえで、まだ承認待ち）` }],
        release: id,
      };
    }
  }
}
