// LINE の一言の、AI を呼ぶ側の流れ（窓口は /api/ai/line）。画面から一言と台帳・ルールを受け取り、答えを返すだけ。
// 受け取った物はどこにも残さない（docs/SPEC.md §5.1）。LINE には何も送らない（送るのは画面 → /api/line/send）。
//
//  一言（名前は〔お客様〕に置きかえ済み）──▶ 振り分け（AI か決まった返事）
//    ToDo・カルテのメモ ──▶ 「どれに振り分けたか」だけ返す（足すのは画面）
//    予約 ──▶ 予約チャットと同じ道具（check_rules → place_hold）とプログラムの判定 ──▶ 仮押さえまで（🔒 確定はしない）

import { contextFor, parseReserveRequest } from "../ai/request";
import { candidateLabel } from "../ai/slots";
import { runTool } from "../ai/tools";
import type { BookedRow, HoldOffer, Step } from "../ai/wire";
import type { Rule } from "../rules/types";
import type { AiSettings, Menu, ShopSettings } from "../settings";
import { runSort, type SortModel } from "./sort";

export type LineAskMode = "ai" | "script";

export type LineAskRequest = {
  mode: LineAskMode;
  /** オーナーの一言（お客様の名字は〔お客様〕に置きかえ済み） */
  text: string;
  /** 一言の名字から画面のプログラムが決めたお客様（予約のときに使う。AI には渡さない） */
  customer: { id: string; surname: string; firstVisit: boolean } | null;
  booked: BookedRow[];
  rules: Rule[];
  dayOffset: number;
};

export type LineAskResponse =
  | { ok: true; via: LineAskMode; kind: "todo" | "karte" | "unknown" }
  | { ok: true; via: LineAskMode; kind: "hold"; hold: HoldOffer; label: string; steps: Step[] }
  | { ok: true; via: LineAskMode; kind: "hold-no"; reason: string; alternatives: string[]; label: string; steps: Step[] }
  | { ok: true; via: LineAskMode; kind: "hold-missing"; missing: string[] }
  | { ok: false; code: "no-ai" | "bad-request"; message: string };

export const LINE_HOLD_REASON = "オーナーが LINE で頼みました（空きとルールはプログラムで確かめ済み）";

export function parseLineAskRequest(
  body: unknown,
  menus: Menu[],
  ai: Pick<AiSettings, "maxMessages" | "maxMessageChars">,
  maxChars: number,
): { ok: true; value: LineAskRequest } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "形がおかしいです" };
  const b = body as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text.trim().slice(0, maxChars) : "";
  if (!text) return { ok: false, reason: "一言がありません" };
  const cu = b.customer && typeof b.customer === "object" ? (b.customer as Record<string, unknown>) : null;
  const customer =
    cu && typeof cu.id === "string" && typeof cu.surname === "string"
      ? { id: cu.id.slice(0, 40), surname: cu.surname.slice(0, 20), firstVisit: cu.firstVisit === true }
      : null;
  // 台帳・ルール・「翌日へ」は予約チャットと同じ確かめ方で読む（ルールは鍵つきを先頭に足しなおす）
  const r = parseReserveRequest(
    {
      mode: "script",
      messages: [{ role: "user", text }],
      candidates: [],
      customer: customer ?? { id: "", surname: "", firstVisit: false },
      booked: b.booked,
      rules: b.rules,
      visits: [],
      dayOffset: b.dayOffset,
    },
    menus,
    { ...ai, maxMessageChars: maxChars },
  );
  if (!r.ok) return r;
  const mode: LineAskMode = b.mode === "script" ? "script" : "ai";
  return { ok: true, value: { mode, text, customer, booked: r.value.booked, rules: r.value.rules, dayOffset: r.value.dayOffset } };
}

export async function runLineAsk(opts: {
  req: LineAskRequest;
  shop: ShopSettings;
  menus: Menu[];
  model: SortModel;
  maxTokens: number;
  now?: Date;
}): Promise<LineAskResponse> {
  const { req, shop, menus, model } = opts;
  const ctx = contextFor(
    {
      mode: req.mode,
      messages: [],
      candidates: [],
      customer: req.customer ?? { id: "", surname: "", firstVisit: false },
      booked: req.booked,
      rules: req.rules,
      visits: [],
      dayOffset: req.dayOffset,
      holds: [],
    },
    shop,
    menus,
    opts.now,
  );
  const sorted = await runSort(model, { shop, menus, rules: req.rules, today: ctx.today, now: ctx.now }, req.text, opts.maxTokens);
  const via = req.mode;
  if (sorted.kind !== "hold") return { ok: true, via, kind: sorted.kind };

  const missing = [
    ...(req.customer ? [] : ["お客様の名字"]),
    ...(sorted.menuId ? [] : ["メニュー"]),
    ...(sorted.date ? [] : ["日にち"]),
    ...(sorted.start ? [] : ["時刻"]),
  ];
  if (missing.length) return { ok: true, via, kind: "hold-missing", missing };

  // 予約チャットと同じ道具・同じ判定を通す（AI が決めた日時でも、プログラムが受けられると言った物だけ）
  const input = { menu_id: sorted.menuId, date: sorted.date, start: sorted.start };
  const c = { menuId: sorted.menuId, date: sorted.date, start: sorted.start };
  const label = candidateLabel(ctx, c);
  const checked = runTool(ctx, "check_rules", input);
  const steps: Step[] = [...checked.steps];
  const out = JSON.parse(checked.content) as { ok?: boolean; reason?: string; error?: string; candidates?: { label: string }[] };
  if (!out.ok) {
    return {
      ok: true,
      via,
      kind: "hold-no",
      reason: out.reason ?? out.error ?? "受けられません",
      alternatives: (out.candidates ?? []).map((x) => x.label),
      label,
      steps,
    };
  }
  // オーナーが一言で選んだ日時なので、それを「出した候補」として仮押さえの道具に渡す
  const held = runTool({ ...ctx, shown: checked.candidates ?? [] }, "place_hold", input);
  steps.push(...held.steps);
  if (!held.hold) {
    const o = JSON.parse(held.content) as { reason?: string; error?: string; candidates?: { label: string }[] };
    return { ok: true, via, kind: "hold-no", reason: o.reason ?? o.error ?? "受けられません", alternatives: (o.candidates ?? []).map((x) => x.label), label, steps };
  }
  return { ok: true, via, kind: "hold", hold: { ...held.hold, reason: LINE_HOLD_REASON }, label, steps };
}
