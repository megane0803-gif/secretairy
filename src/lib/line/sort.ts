// LINE の一言の振り分け。AI が「予約の仮押さえ」「ToDo」「カルテのメモ」のどれかを1つ選ぶ（道具を1つだけ呼ぶ）。
// 道具は3つだけで、どれも「どれに振り分けたか」を返すだけ。呼んでも何も変わらない。🔒 確定の道具は無い。
// 予約は、ここで読み取ったメニュー・日・時刻を、予約チャットと同じ道具（ai/tools.ts）とプログラムの判定に通す（ask.ts）。
// お客様の名前は AI に送らない（画面で〔お客様〕に置きかえ、だれかは画面のプログラムが名字で決める）。
// テストでは Claude を呼ばず、決まった返事（scriptSortModel）に置きかえる。

import { readRequest } from "../ai/script";
import { comboIdOf } from "../combo";
import type { CalDay } from "../calendar";
import { menuDataLines } from "../ai/menuData";
import { instructionsFor } from "../rules/prompt";
import type { Rule } from "../rules/types";
import type { Menu, ShopSettings } from "../settings";

export type SortToolName = "hold_request" | "add_todo" | "karte_memo";

export type SortToolDef = {
  name: SortToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: "string"; description: string }>;
    required: string[];
    additionalProperties: false;
  };
};

/** 画面の言葉での振り分け先 */
export const SORT_LABEL: Record<SortToolName, string> = {
  hold_request: "予約の仮押さえ",
  add_todo: "ToDo",
  karte_memo: "カルテのメモ",
};

export const SORT_TOOLS: SortToolDef[] = [
  {
    name: "hold_request",
    description:
      "予約の仮押さえを頼まれたとき。メニュー・日・時刻を読み取って返す。確定ではない。受けられるかはプログラムが判定する。わからない所は空の文字にする（自分で決めない）。",
    input_schema: {
      type: "object",
      properties: {
        menu_id: { type: "string", description: "メニューの id（指示のメニュー一覧の id）。2つ以上なら id を + でつなぐ（例 cut+headspa）。わからなければ空" },
        date: { type: "string", description: "日付 YYYY-MM-DD（今日の日付は指示にある）。わからなければ空" },
        start: { type: "string", description: "始まる時刻 HH:MM（24時間）。わからなければ空" },
      },
      required: ["menu_id", "date", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "add_todo",
    description: "やること（発注・連絡・買い物・確かめること など）。ToDo の題はオーナーの言葉のまま、プログラムが入れる。",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "karte_memo",
    description: "お客様の施術・様子・会話のメモ（カルテに書く物）。メモはオーナーの言葉のまま、プログラムが入れる。良い悪いの判断はしない。",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

export type SortPick = { name: string; input: unknown } | null;

export interface SortModel {
  /** 道具を1つだけ選ぶ。選べなかった（断られた・途中で切れた）ときは null */
  pick(req: { system: string; text: string; maxTokens: number }): Promise<SortPick>;
}

/** 振り分けた結果。hold は読み取ったメニュー・日・時刻（空なら読み取れなかった） */
export type Sorted =
  | { kind: "hold"; menuId: string; date: string; start: string }
  | { kind: "todo" }
  | { kind: "karte" }
  | { kind: "unknown" };

export const CUSTOMER_MARK = "〔お客様〕";

/**
 * お客様の名字を〔お客様〕に置きかえる（AI に名前を送らないため）。だれかは名字で画面のプログラムが決める。
 * 長い名字から見る（「上野」と「上」のように重なっても長い方を先に）。
 */
export function maskNames<C extends { surname: string }>(text: string, customers: C[]): { masked: string; found: C[] } {
  let masked = text;
  const found: C[] = [];
  for (const c of [...customers].filter((c) => c.surname).sort((a, b) => b.surname.length - a.surname.length)) {
    if (!masked.includes(c.surname)) continue;
    found.push(c);
    masked = masked.split(c.surname).join(CUSTOMER_MARK);
  }
  return { masked, found };
}

export type SortContext = {
  shop: ShopSettings;
  menus: Menu[];
  rules: Rule[];
  today: CalDay;
  now: { date: string; time: string };
};

export function sortSystem(ctx: SortContext): string {
  const close = Object.values(ctx.shop.hours).find((h) => h)?.close ?? "20:00";
  return [
    instructionsFor(ctx.rules, { tab: "home", menuIds: [] }, (id) => ctx.menus.find((m) => m.id === id)?.name ?? id),
    "",
    `# この仕事：美容室「${ctx.shop.name}」のオーナーが LINE で送った一言を、3つのどれかに振り分ける`,
    "- 道具を1つだけ呼ぶ：hold_request（予約の仮押さえ）・add_todo（やること）・karte_memo（カルテのメモ）。",
    "- 予約は仮押さえまで。確定はしない（確定はオーナーがボタンで押す）。受けられるかはプログラムが判定する。",
    "- hold_request のメニュー・日・時刻は、一言に書いてある物だけ。書いていない所は空の文字にする（自分で決めない）。",
    `- お客様の名前は ${CUSTOMER_MARK} に置きかえてある。名前を当てようとしない。`,
    "- 頭皮・肌・体調などの話は karte_memo に振り分けるだけ。良い悪いを判断しない。",
    "",
    "# いまの様子",
    `- 今日：${ctx.today.date}（${ctx.today.label}）。いまの時刻：${ctx.now.time}（店の時間帯）。「明日」は今日の次の日。`,
    // メニューの名前（オーナーが足した物も）は、お店のデータとして渡す（menuData.ts）
    ...menuDataLines(ctx.menus, close),
  ].join("\n");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** AI の選んだ道具を、そのまま信じずに読む */
export function readPick(pick: SortPick, menus: Menu[]): Sorted {
  if (!pick) return { kind: "unknown" };
  if (pick.name === "add_todo") return { kind: "todo" };
  if (pick.name === "karte_memo") return { kind: "karte" };
  if (pick.name !== "hold_request") return { kind: "unknown" };
  const r = (pick.input && typeof pick.input === "object" ? pick.input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
  // 知らないメニューは使わない（2つ以上は + でつないだ id。組み合わせの決め方は予約チャットと同じ combo.ts）
  const menuId = s("menu_id") ? (comboIdOf(menus, [s("menu_id")]) ?? "") : "";
  const date = DATE_RE.test(s("date")) ? s("date") : "";
  const start = TIME_RE.test(s("start")) ? s("start") : "";
  return { kind: "hold", menuId, date, start };
}

export async function runSort(model: SortModel, ctx: SortContext, text: string, maxTokens: number): Promise<Sorted> {
  const pick = await model.pick({ system: sortSystem(ctx), text, maxTokens });
  return readPick(pick, ctx.menus);
}

/**
 * 決まった返事（AI なし）。テストと、AI につながらないときに使う。決まった形の言葉だけ読む。
 * 「仮押さえ」「予約」、またはメニューと時刻がある → 予約。「カルテ」「メモ」→ カルテのメモ。ほかは ToDo。
 */
export function scriptSortModel(ctx: Pick<SortContext, "menus" | "today">): SortModel {
  return {
    async pick({ text }) {
      const r = readRequest(ctx, text);
      const menuId = r.menuIds.length ? (comboIdOf(ctx.menus, r.menuIds) ?? "") : "";
      if (/仮押さえ|予約/.test(text) || (menuId && r.start))
        return { name: "hold_request", input: { menu_id: menuId, date: r.date ?? "", start: r.start ?? "" } };
      if (/カルテ|メモ/.test(text)) return { name: "karte_memo", input: {} };
      return { name: "add_todo", input: {} };
    },
  };
}
