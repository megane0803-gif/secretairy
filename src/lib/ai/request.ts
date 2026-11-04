// 画面から来た相談を確かめて、道具が使う形（ToolContext）にする。
// 台帳とルールは画面から毎回送られてくる。サーバーでは残さない。
// ルールは鍵つきを先頭に足しなおし、オーナーのルールは validate.ts で同じように確かめる（送られた物で鍵つきは緩まない）。

import { shopNow, shopToday } from "../calendar";
import { LOCKED_RULES } from "../rules/locked";
import type { Rule } from "../rules/types";
import { validateOwnerRule } from "../rules/validate";
import type { AiSettings, Menu, ShopSettings } from "../settings";
import { MAX_CANDIDATES } from "./slots";
import type { ToolContext } from "./tools";
import type { BookedRow, Candidate, ChatTurn, ReserveRequest } from "./wire";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_BOOKED = 2000;
const MAX_RULES = 200;

type Parsed = { ok: true; value: ReserveRequest } | { ok: false; reason: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

export function parseReserveRequest(body: unknown, menus: Menu[], ai: Pick<AiSettings, "maxMessages" | "maxMessageChars">): Parsed {
  if (!isObj(body)) return { ok: false, reason: "形がおかしいです" };
  const mode = body.mode === "script" ? "script" : "ai";

  if (!Array.isArray(body.messages) || body.messages.length === 0) return { ok: false, reason: "会話がありません" };
  // 長い会話は新しい方だけ使う
  const messages: ChatTurn[] = body.messages
    .slice(-ai.maxMessages)
    .filter((m): m is Record<string, unknown> => isObj(m) && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .map((m) => ({ role: m.role as ChatTurn["role"], text: (m.text as string).slice(0, m.role === "user" ? ai.maxMessageChars : 1200) }));
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !last.text.trim()) return { ok: false, reason: "お客様の文がありません" };

  const menuIds = new Set(menus.map((m) => m.id));
  const candidates: Candidate[] = (Array.isArray(body.candidates) ? body.candidates : [])
    .filter(
      (c): c is Record<string, unknown> =>
        isObj(c) && typeof c.menuId === "string" && menuIds.has(c.menuId) && typeof c.date === "string" && DATE.test(c.date) && typeof c.start === "string" && TIME.test(c.start),
    )
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ menuId: c.menuId as string, date: c.date as string, start: c.start as string }));

  const cu = body.customer;
  if (!isObj(cu) || typeof cu.id !== "string" || typeof cu.surname !== "string") return { ok: false, reason: "お客様がわかりません" };
  const customer = { id: cu.id.slice(0, 40), surname: cu.surname.slice(0, 20), firstVisit: cu.firstVisit === true };

  if (!Array.isArray(body.booked) || body.booked.length > MAX_BOOKED) return { ok: false, reason: "台帳の形がおかしいです" };
  const booked: BookedRow[] = body.booked
    .filter(
      (b): b is Record<string, unknown> =>
        isObj(b) &&
        typeof b.id === "string" &&
        typeof b.customerId === "string" &&
        typeof b.menuId === "string" &&
        menuIds.has(b.menuId) &&
        typeof b.date === "string" &&
        DATE.test(b.date) &&
        typeof b.start === "string" &&
        TIME.test(b.start) &&
        (b.status === "confirmed" || b.status === "hold"),
    )
    .map((b) => ({
      id: b.id as string,
      customerId: b.customerId as string,
      menuId: b.menuId as string,
      date: b.date as string,
      start: b.start as string,
      status: b.status as BookedRow["status"],
      newCustomer: b.newCustomer === true,
    }));

  if (!Array.isArray(body.rules) || body.rules.length > MAX_RULES) return { ok: false, reason: "ルールの形がおかしいです" };
  const locked = new Set(LOCKED_RULES.map((r) => r.id));
  const own: Rule[] = [];
  for (const r of body.rules) {
    if (isObj(r) && typeof r.id === "string" && locked.has(r.id)) continue; // 鍵つきは送られた物を使わない
    const v = validateOwnerRule(r, [...menuIds]);
    if (v.ok) own.push(v.value);
  }

  return { ok: true, value: { mode, messages, candidates, customer, booked, rules: [...LOCKED_RULES, ...own] } };
}

/** 道具が使う形にする。いまの時刻はサーバーの時計（店の時間帯）で決める */
export function contextFor(
  req: ReserveRequest,
  shop: ShopSettings,
  menus: Menu[],
  now: Date = new Date(),
  newId: () => string = () => `h-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
): ToolContext {
  return {
    shop,
    menus,
    rules: req.rules,
    booked: req.booked,
    customer: req.customer,
    now: shopNow(shop, now),
    today: shopToday(shop, now).today,
    shown: req.candidates,
    nowIso: now.toISOString(),
    held: false,
    newId,
  };
}
