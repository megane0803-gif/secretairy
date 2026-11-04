// 予約チャットで AI に渡す道具は4つだけ：空きを調べる・ルールを確かめる・前回を見る・仮押さえ。
// 🔒 確定の道具は作らない（確定は人のボタンだけ。src/lib/rules/locked.ts）。
// どの道具も、答えはプログラム（slots.ts → judge.ts）が出す。仮押さえも、ここでもう一度判定してから出す。

import { calDay } from "../calendar";
import { scopeTag } from "../rules/describe";
import type { Step, Candidate, HoldOffer, Visit } from "./wire";
import {
  alternativesFor,
  candidateLabel,
  findSlots,
  judgeSlot,
  menuName,
  menuOf,
  plainReason,
  previousVisit,
  refusalSentence,
  sameSlot,
  type SlotContext,
  type SlotSearch,
} from "./slots";

export type ToolName = "find_openings" | "check_rules" | "previous_visit" | "place_hold";

/** 画面の言葉での道具の名前 */
export const TOOL_LABEL: Record<ToolName, string> = {
  find_openings: "空きを調べる",
  check_rules: "ルールを確かめる",
  previous_visit: "前回を見る",
  place_hold: "仮押さえ",
};

export type ToolDef = {
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: "string"; description: string }>;
    required: string[];
    additionalProperties: false;
  };
};

const DATE = { type: "string" as const, description: "日付 YYYY-MM-DD（今日の日付は指示に書いてあります）" };
const TIME = { type: "string" as const, description: "始まる時刻 HH:MM（24時間）" };
const MENU = { type: "string" as const, description: "メニューの id（指示のメニュー一覧の id）" };

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "find_openings",
    description:
      "空きを調べる。そのメニューで受けられる枠（店の設定とルールをプログラムが確かめ済み）を、指定の日時から先へ2つまで返す。日時が無ければ今から先を探す。",
    input_schema: {
      type: "object",
      properties: { menu_id: MENU, date: DATE, after: { type: "string", description: "この時刻（HH:MM）以降を探す" } },
      required: ["menu_id"],
      additionalProperties: false,
    },
  },
  {
    name: "check_rules",
    description:
      "ルールを確かめる。お客様が言った日時・メニューを受けられるかを、プログラムが店の設定とルールで判定する。受けられないときは理由1文と、代わりの枠2つまでを返す。",
    input_schema: {
      type: "object",
      properties: { menu_id: MENU, date: DATE, start: TIME },
      required: ["menu_id", "date", "start"],
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
      "仮押さえ。お客様が、直前に出した候補から選んだときだけ使う（例：「1つ目で」）。確定ではない。プログラムがもう一度判定し、受けられれば仮押さえして承認の箱に入れる。",
    input_schema: {
      type: "object",
      properties: { menu_id: MENU, date: DATE, start: TIME },
      required: ["menu_id", "date", "start"],
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
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 道具に来た入力を確かめる（AI の出した物なので、そのまま信じない） */
function readInput(
  ctx: ToolContext,
  name: ToolName,
  raw: unknown,
): { ok: true; menuId?: string; date?: string; start?: string; after?: string } | { ok: false; reason: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : undefined);
  const menuId = str("menu_id");
  const date = str("date");
  const start = str("start");
  const after = str("after");
  if (name === "previous_visit") return { ok: true };
  if (!menuId || !menuOf(ctx, menuId)) return { ok: false, reason: "menu_id がメニュー一覧にありません" };
  if (date !== undefined && !DATE_RE.test(date)) return { ok: false, reason: "date は YYYY-MM-DD で入れてください" };
  if (start !== undefined && !TIME_RE.test(start)) return { ok: false, reason: "start は HH:MM で入れてください" };
  if (after !== undefined && after !== "" && !TIME_RE.test(after)) return { ok: false, reason: "after は HH:MM で入れてください" };
  if ((name === "check_rules" || name === "place_hold") && (!date || !start))
    return { ok: false, reason: "date と start が要ります" };
  return { ok: true, menuId, date, start, after: after || undefined };
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
      const who = `${ctx.customer.surname}（架空）様`;
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
      const from = { date: input.date ?? ctx.now.date, time: input.after ?? (input.date ? undefined : ctx.now.time) };
      const search = findSlots(ctx, menuId, from);
      const fromLabel = `${calDay(ctx.shop, from.date < ctx.today.date ? ctx.today.date : from.date).label}${from.time ? ` ${from.time}` : ""}`;
      const found = search.slots.map((c) => candidateLabel(ctx, c)).join("・");
      return {
        content: json({
          menu: menuName(ctx, menuId),
          candidates: listed(ctx, search.slots),
          note: search.slots.length ? "番号の順にお客様へ出す" : "空きが見つかりませんでした",
        }),
        steps: [
          { kind: "tool", text: `${label}：${menuName(ctx, menuId)}を ${fromLabel} から → ${found || "見つかりませんでした"}` },
          ...excludedSteps(search),
        ],
        candidates: search.slots,
      };
    }

    case "check_rules": {
      const c = { menuId: input.menuId!, date: input.date!, start: input.start! };
      const v = judgeSlot(ctx, c);
      const what = candidateLabel(ctx, c);
      if (v.ok)
        return {
          content: json({ ok: true, candidates: listed(ctx, [c]), note: "受けられます。この候補をお客様に出し、選んでもらう" }),
          steps: [{ kind: "tool", text: `${label}：${what} → ✓ 受けられます` }],
          candidates: [c],
        };
      const alt = alternativesFor(ctx, c);
      const fails: Step[] = [
        ...v.base.filter((b) => !b.ok).map((b) => ({ kind: "reject" as const, text: `店の設定で外した：${b.label}（${plainReason(b.reason)}）` })),
        ...v.results
          .filter((r) => !r.ok)
          .map((r) => ({
            kind: "reject" as const,
            text: `ルールで外した：[${scopeTag(r.rule, (id) => menuName(ctx, id))}] ${r.rule.label}（${plainReason(r.reason)}）`,
          })),
      ];
      return {
        content: json({ ok: false, reason: refusalSentence(ctx, v), candidates: listed(ctx, alt.slots) }),
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
        const alt = alternativesFor(ctx, c);
        return {
          content: json({ ok: false, reason: refusalSentence(ctx, v), candidates: listed(ctx, alt.slots) }),
          steps: [
            { kind: "reject", text: `${label}：もう一度確かめたら受けられませんでした（${what}。${refusalSentence(ctx, v)}）` },
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
          note: "仮押さえです。確定ではありません。お客様には「仮でお取りしました。お店から確定のご連絡をします」と伝える",
        }),
        steps: [{ kind: "hold", text: `${label}：${what}（承認の箱へ。期限は${hours}時間）` }],
        hold,
      };
    }
  }
}
