// 予約チャットのテストの道具。Claude は呼ばず、決まった返事（script.ts）に置きかえる。

import { shopToday } from "../../calendar";
import { getCustomers, getSeedKartes } from "../../data/seed";
import { resolveSeedKartes, toVisits, type SavedKarte, allKartes } from "../../karte/record";
import { loadBook } from "../../reservations";
import { getRules } from "../../rules/store";
import { getAiSettings, getMenus, getShop } from "../../settings";
import { runReserve } from "../agent";
import type { ReplyModel } from "../model";
import { contextFor } from "../request";
import { scriptModel } from "../script";
import type { ToolContext } from "../tools";
import type { BookedRow, Candidate, ChatTurn, ReserveEvent } from "../wire";

export const shop = getShop();
export const menus = getMenus();
export const customers = getCustomers();
export const ai = getAiSettings();

/** 店の時間帯（東京）で「YYYY-MM-DD HH:MM に開いた」とき */
export function at(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+09:00`);
}

/** その時刻に初めて開いたブラウザの台帳（起点 = 今日） */
export function bookedAt(now: Date): BookedRow[] {
  return loadAt(now).all.map((r) => ({
    id: r.id,
    customerId: r.customer.id,
    menuId: r.menu.id,
    date: r.date,
    start: r.start,
    status: r.status,
    newCustomer: r.customer.firstVisit,
  }));
}

function loadAt(now: Date) {
  const { today } = shopToday(shop, now);
  return loadBook(shop, menus, today);
}

/** その時刻に初めて開いたブラウザのカルテ（最初の状態の前回までのカルテ＋保存した物）の日付とメニュー */
export function visitsAt(now: Date, saved: SavedKarte[] = []) {
  return toVisits(allKartes(resolveSeedKartes(getSeedKartes(), loadAt(now).all), saved));
}

export function ctxAt(now: Date, over: Partial<ToolContext> = {}, customerId = "c04", saved: SavedKarte[] = []): ToolContext {
  const c = customers.find((x) => x.id === customerId)!;
  let n = 0;
  return {
    ...contextFor(
      {
        mode: "script",
        messages: [],
        candidates: [],
        customer: { id: c.id, surname: c.surname, firstVisit: c.firstVisit },
        booked: bookedAt(now),
        rules: getRules(),
        visits: visitsAt(now, saved),
        dayOffset: 0,
      },
      shop,
      menus,
      now,
      () => `h-test-${++n}`,
    ),
    ...over,
  };
}

export async function chat(ctx: ToolContext, history: ChatTurn[], model: ReplyModel = scriptModel(ctx)) {
  const events: ReserveEvent[] = [];
  await runReserve({ ctx, history, model, limits: ai, emit: (e) => events.push(e) });
  const text = events.flatMap((e) => (e.t === "text" ? [e.d] : [])).join("");
  const steps = events.flatMap((e) => (e.t === "step" ? [e.step] : []));
  const holds = events.flatMap((e) => (e.t === "hold" ? [e.hold] : []));
  const cands = events.filter((e): e is Extract<ReserveEvent, { t: "candidates" }> => e.t === "candidates").pop()?.list;
  return { events, text, steps, holds, candidates: cands ?? null };
}

/** 2回のやりとり：1回目の返事の候補を、2回目の「1つ目で」に渡す */
export async function twoTurns(ctx: ToolContext, first: string, second = "1つ目で") {
  const a = await chat(ctx, [{ role: "user", text: first }]);
  const shown: Candidate[] = a.candidates ?? [];
  const b = await chat({ ...ctx, shown }, [
    { role: "user", text: first },
    { role: "assistant", text: a.text },
    { role: "user", text: second },
  ]);
  return { a, b, shown };
}
