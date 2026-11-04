// LINE のつなぎ（オーナー側）のテスト。Claude と LINE は呼ばない（決まった返事・置きかえた LINE・このプロセスの中の置き場所）。
// 署名が違うと捨てる・合言葉でつながる・つながっていない人は動かない・画面が閉じていると動かない・
// 承認のボタンが1回だけ効く・一言の振り分け・返事で済むときは返事・1日の上限。

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { emptyBook, pendingApprovals, withHold, type BookState } from "../../book/state";
import { EMPTY_ADS } from "../../ads/state";
import { addDays, calDay, shopToday } from "../../calendar";
import { findSlots } from "../../ai/slots";
import { getRules } from "../../rules/store";
import { getAdSettings, getAiSettings, getLineSettings, type LineSettings } from "../../settings";
import { at, bookedAt, ctxAt, customers, menus, shop } from "../../ai/__tests__/helpers";
import type { LineClient, LineMessage } from "../api";
import { applyAsk, applyPress, karteTargetFor, reservationCard } from "../apply";
import { LINE_HOLD_REASON, parseLineAskRequest, runLineAsk, type LineAskRequest } from "../ask";
import { handleWebhook, KEY, pollScreen, pushedToday, sendFromScreen, startLink, unlink, type BridgeDeps } from "../bridge";
import { LINE_TEXT } from "../messages";
import { morningText } from "../morning";
import { lineSignature, verifyLineSignature } from "../signature";
import { CUSTOMER_MARK, maskNames, readPick, scriptSortModel } from "../sort";
import { memoryStore } from "../store";
import { parseSendRequest, type ScreenEvent } from "../wire";

const SECRET = "test-channel-secret";
const OWNER = "U-owner-0001";
const OTHER = "U-other-0002";

type Sent = { kind: "reply" | "push"; to: string; messages: LineMessage[] };

function fakeLine(sent: Sent[], ok = true): LineClient {
  return {
    reply: async (to, messages) => {
      sent.push({ kind: "reply", to, messages });
      return { ok, status: ok ? 200 : 400 };
    },
    push: async (to, messages) => {
      sent.push({ kind: "push", to, messages });
      return { ok, status: ok ? 200 : 500 };
    },
  };
}

let clock = Date.parse("2026-11-04T09:00:00+09:00");
let seq = 0;
let sent: Sent[] = [];
let d: BridgeDeps & { store: ReturnType<typeof memoryStore> };

function deps(over: Partial<LineSettings> = {}): typeof d {
  return {
    store: memoryStore(() => clock),
    line: fakeLine(sent),
    settings: { ...getLineSettings(), ...over },
    timezone: shop.timezone,
    now: () => new Date(clock),
    // 決まった並びの「でたらめ」（テストで同じ答えになるように）
    random: (n) => {
      seq += 1;
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = (seq * 31 + i * 7) & 0xff;
      return b;
    },
  };
}

const textEvent = (userId: string, text: string, replyToken = `rt-${++seq}`) => ({
  type: "message",
  replyToken,
  webhookEventId: `we-${++seq}`,
  source: { type: "user", userId },
  message: { type: "text", text },
});
const postbackEvent = (userId: string, data: string, replyToken = `rt-${++seq}`) => ({
  type: "postback",
  replyToken,
  webhookEventId: `we-${++seq}`,
  source: { type: "user", userId },
  postback: { data },
});
const hook = (...events: unknown[]) => handleWebhook(d, { destination: "x", events });
const replyText = (s: Sent) => String((s.messages[0] as { text?: string }).text ?? "");

/** 画面が「LINE とつなぐ」を押し、オーナーが合言葉を送り、画面が受け取りに来た状態 */
async function linked(): Promise<string> {
  const s = await startLink(d);
  assert.ok(s.ok);
  await hook(textEvent(OWNER, s.code));
  const p = await pollScreen(d, s.token);
  assert.ok(p.ok && p.linked);
  return s.token;
}

/** 承認待ちのカードを LINE に届けて、ボタンの postback の data を取り出す */
async function sendCard(token: string, approvalId: string): Promise<{ approve: string; skip: string }> {
  const res = await sendFromScreen(d, {
    token,
    messages: [{ type: "approval", card: { approvalId, target: "reservation", what: "青木（架空）様 カット", when: "11/5（木）15:00–16:00", why: "理由", check: "✓" } }],
  });
  assert.ok(res.ok);
  const flex = sent[sent.length - 1].messages[0] as { contents: { footer: { contents: { action: { data: string } }[] } } };
  const [a, s] = flex.contents.footer.contents.map((b) => b.action.data);
  return { approve: a, skip: s };
}

beforeEach(() => {
  clock = Date.parse("2026-11-04T09:00:00+09:00");
  seq = 0;
  sent = [];
  d = deps();
});

describe("署名：LINE_CHANNEL_SECRET で確かめ、違う物は捨てる", () => {
  test("正しい署名だけ通る", () => {
    const body = JSON.stringify({ events: [] });
    assert.equal(verifyLineSignature(body, lineSignature(body, SECRET), SECRET), true);
    assert.equal(verifyLineSignature(body, lineSignature(body, "ちがう秘密"), SECRET), false);
    assert.equal(verifyLineSignature(body + " ", lineSignature(body, SECRET), SECRET), false);
    assert.equal(verifyLineSignature(body, null, SECRET), false);
    assert.equal(verifyLineSignature(body, lineSignature(body, SECRET), undefined), false);
  });

  test("窓口は署名の違う知らせを捨てる（置き場所にも触らない）", async () => {
    const { POST } = await import("../../../app/api/line/route");
    const before = { secret: process.env.LINE_CHANNEL_SECRET, url: process.env.KV_REST_API_URL };
    process.env.LINE_CHANNEL_SECRET = SECRET;
    delete process.env.KV_REST_API_URL;
    try {
      const body = JSON.stringify({ events: [textEvent(OWNER, "123456")] });
      const bad = await POST(new Request("http://x/api/line", { method: "POST", body, headers: { "x-line-signature": lineSignature(body, "にせ") } }));
      assert.equal(bad.status, 401);
      const none = await POST(new Request("http://x/api/line", { method: "POST", body }));
      assert.equal(none.status, 401);
      // 署名が正しければ先へ進む（ここでは Redis が無いので「つながらない」）
      const good = await POST(new Request("http://x/api/line", { method: "POST", body, headers: { "x-line-signature": lineSignature(body, SECRET) } }));
      assert.equal(good.status, 503);
    } finally {
      process.env.LINE_CHANNEL_SECRET = before.secret;
      if (before.url) process.env.KV_REST_API_URL = before.url;
    }
  });
});

describe("合言葉でつなぐ", () => {
  test("画面の合言葉を LINE で送ると、その人とその画面がつながる（期限つき）", async () => {
    const s = await startLink(d);
    assert.ok(s.ok);
    assert.match(s.code, /^\d{6}$/);
    assert.deepEqual(await pollScreen(d, s.token), { ok: true, linked: false, events: [] });
    // 全角で送っても読める
    const wide = s.code.replace(/\d/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    await hook(textEvent(OWNER, ` ${wide} `));
    assert.equal(replyText(sent[0]), LINE_TEXT.linked(d.settings.linkHours));
    const p = await pollScreen(d, s.token);
    assert.ok(p.ok && p.linked);
    assert.equal(p.until, new Date(clock + d.settings.linkHours * 3600_000).toISOString());
    // 期限が過ぎたら切れる
    clock += d.settings.linkHours * 3600_000 + 1000;
    const late = await pollScreen(d, s.token);
    assert.equal(late.ok, false);
  });

  test("合言葉は1回だけ・期限つき。違う合言葉ではつながらない", async () => {
    const s = await startLink(d);
    assert.ok(s.ok);
    await hook(textEvent(OTHER, "000000" === s.code ? "111111" : "000000"));
    assert.equal(replyText(sent[0]), LINE_TEXT.wrongCode);
    await hook(textEvent(OWNER, s.code));
    await hook(textEvent(OTHER, s.code));
    assert.equal(replyText(sent[2]), LINE_TEXT.wrongCode);

    const s2 = await startLink(d);
    assert.ok(s2.ok);
    clock += d.settings.codeMinutes * 60_000 + 1000;
    await hook(textEvent(OTHER, s2.code));
    assert.equal(replyText(sent[3]), LINE_TEXT.wrongCode);
  });

  test("合言葉を何回も試すと、しばらく受けない", async () => {
    for (let i = 0; i < d.settings.codeTries; i++) await hook(textEvent(OTHER, "999999"));
    const s = await startLink(d);
    assert.ok(s.ok);
    await hook(textEvent(OTHER, s.code));
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.tooMany);
  });

  test("つなぎを切ると、その画面は受け取れない", async () => {
    const token = await linked();
    await unlink(d, token);
    assert.equal((await pollScreen(d, token)).ok, false);
    await hook(textEvent(OWNER, "シャンプー発注"));
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.askCode);
  });

  test("画面に渡す物に、LINE の人の番号・返事の印は入らない", async () => {
    const token = await linked();
    await hook(textEvent(OWNER, "シャンプー発注", "rt-secret-reply"));
    const p = await pollScreen(d, token);
    const shown = JSON.stringify(p);
    assert.ok(!shown.includes(OWNER));
    assert.ok(!shown.includes("rt-secret-reply"));
    // 置き場所の名前にも番号は入れない
    assert.ok(d.store.keys().every((k) => !k.includes(OWNER)));
  });
});

describe("つながっていない人・画面が閉じている時は動かない", () => {
  test("つながっていない人の一言は預けず、「合言葉を送ってください」とだけ返す", async () => {
    const token = await linked();
    await hook(textEvent(OTHER, "明日15時に青木さんカットで仮押さえ"));
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.askCode);
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    assert.equal(p.events.length, 0);
  });

  test("つながっていない人のボタンは効かない", async () => {
    const token = await linked();
    const { approve } = await sendCard(token, "ap-h1");
    await hook(postbackEvent(OTHER, approve));
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.linkGone);
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    assert.equal(p.events.length, 0);
  });

  test("画面が閉じている（受け取りに来ない）と「画面を開いている間だけ動きます」と返す", async () => {
    const token = await linked();
    clock += (d.settings.aliveSeconds + 1) * 1000;
    await hook(textEvent(OWNER, "シャンプー発注"));
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.screenClosed);
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    assert.equal(p.events.length, 0);
  });

  test("グループからの知らせ・送りなおしは使わない", async () => {
    const token = await linked();
    await hook({ ...textEvent(OWNER, "シャンプー発注"), source: { type: "group", groupId: "G1", userId: OWNER } });
    const ev = textEvent(OWNER, "シャンプー発注");
    await hook(ev, ev);
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    assert.equal(p.events.length, 1);
  });
});

describe("承認のボタン：つないだオーナーだけ・1つの行で1回だけ", () => {
  test("「承認」は1回だけ。もう一度押しても、「見送り」を押しても効かない", async () => {
    const token = await linked();
    const { approve, skip } = await sendCard(token, "ap-h1");
    await hook(postbackEvent(OWNER, approve));
    await hook(postbackEvent(OWNER, approve));
    await hook(postbackEvent(OWNER, skip));
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    assert.equal(p.events.length, 1);
    assert.deepEqual(
      { kind: p.events[0].kind, ...(p.events[0].kind === "press" ? { id: p.events[0].approvalId, how: p.events[0].how } : {}) },
      { kind: "press", id: "ap-h1", how: "approve" },
    );
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.buttonUsed);
  });

  test("画面が閉じている時のボタンは使わずに残す（開いてから押せる）", async () => {
    const token = await linked();
    const { approve } = await sendCard(token, "ap-h1");
    clock += (d.settings.aliveSeconds + 1) * 1000;
    await hook(postbackEvent(OWNER, approve));
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.screenClosed);
    await pollScreen(d, token);
    await hook(postbackEvent(OWNER, approve));
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    assert.equal(p.events.length, 1);
  });

  test("別の画面とつないだ人は、この画面の行のボタンを押せない", async () => {
    const token = await linked();
    const { approve } = await sendCard(token, "ap-h1");
    // もう1人が別の画面とつなぐ
    const s2 = await startLink(d);
    assert.ok(s2.ok);
    await hook(textEvent(OTHER, s2.code));
    await pollScreen(d, s2.token);
    await hook(postbackEvent(OTHER, approve));
    assert.equal(replyText(sent[sent.length - 1]), LINE_TEXT.buttonNotYours);
    // 持ち主はまだ押せる
    await hook(postbackEvent(OWNER, approve));
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    assert.equal(p.events.length, 1);
  });

  test("画面の側でも、同じ行は1回だけ確定する（承認の箱のボタンと同じ変え方）", () => {
    const now = at("2026-11-04", "09:00");
    const nowIso = now.toISOString();
    const ctx = ctxAt(now);
    const slot = findSlots(ctx, "cut", { date: addDays(ctx.today.date, 1) }).slots[0];
    let book: BookState = withHold(emptyBook(ctx.today.date), {
      id: "h1",
      customerId: "c01",
      ...slot,
      heldAt: nowIso,
      expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
      reason: "テスト",
    });
    const actx = { shop, menus, customers, nowIso, today: ctx.today.date, adSettings: getAdSettings() };
    const ev: ScreenEvent = { id: "e1", at: nowIso, kind: "press", approvalId: "ap-h1", target: "reservation", how: "approve" };
    const first = applyPress(ev, book, EMPTY_ADS, actx);
    assert.equal(first.book.chat[0].status, "confirmed");
    assert.match(first.journal[0].text, /^承認（LINE のボタン）：/);
    book = first.book;
    const again = applyPress({ ...ev, id: "e2" }, book, EMPTY_ADS, actx);
    assert.equal(again.book, book);
    assert.equal(again.journal.length, 0);
    const skip = applyPress({ ...ev, id: "e3", how: "skip" }, book, EMPTY_ADS, actx);
    assert.equal(skip.book.chat[0].status, "confirmed");
  });
});

describe("返事で済むときは返事（数えない）。送るのは1日の上限まで", () => {
  test("一言への答えは返事で返す（送った数は増えない）", async () => {
    const token = await linked();
    await hook(textEvent(OWNER, "シャンプー発注", "rt-a"));
    const p = await pollScreen(d, token);
    assert.ok(p.ok);
    const res = await sendFromScreen(d, { token, replyTo: p.events[0].id, messages: [{ type: "text", text: "ToDo に足しました" }] });
    assert.deepEqual(res, { ok: true, via: "reply" });
    assert.equal(sent[sent.length - 1].kind, "reply");
    assert.equal(sent[sent.length - 1].to, "rt-a");
    assert.equal(await pushedToday(d), 0);
    // 返事の印は1回だけ。2回目は送る（数える）方
    const again = await sendFromScreen(d, { token, replyTo: p.events[0].id, messages: [{ type: "text", text: "もう一度" }] });
    assert.deepEqual(again, { ok: true, via: "push" });
    assert.equal(await pushedToday(d), 1);
  });

  test("1日に送るのは config の上限まで", async () => {
    d = deps({ dailyPushLimit: 2 });
    const token = await linked();
    const send = () => sendFromScreen(d, { token, messages: [{ type: "text", text: "朝の要点" }] });
    assert.deepEqual(await send(), { ok: true, via: "push" });
    assert.deepEqual(await send(), { ok: true, via: "push" });
    const third = await send();
    assert.equal(third.ok, false);
    assert.equal(!third.ok && third.code, "limit");
    assert.equal(sent.filter((s) => s.kind === "push").length, 2);
  });

  test("同じ承認待ちの行のボタンは1回だけ届ける（文は送る）", async () => {
    const token = await linked();
    const card = { approvalId: "ap-h9", target: "reservation" as const, what: "何を", when: "いつ", why: "理由", check: "✓" };
    assert.deepEqual(await sendFromScreen(d, { token, messages: [{ type: "approval", card }], once: "ap-h9" }), { ok: true, via: "push" });
    assert.deepEqual(await sendFromScreen(d, { token, messages: [{ type: "approval", card }], once: "ap-h9" }), { ok: true, via: "skipped" });
    const both = await sendFromScreen(d, { token, messages: [{ type: "text", text: "文" }, { type: "approval", card }], once: "ap-h9" });
    assert.deepEqual(both, { ok: true, via: "push" });
    assert.equal(sent[sent.length - 1].messages.length, 1);
  });

  test("画面から送る形がおかしい物は受けない", () => {
    assert.equal(parseSendRequest({ token: "a.b", messages: [] }), null);
    assert.equal(parseSendRequest({ token: "a.b", messages: [{ type: "flex", contents: {} }] }), null);
    assert.ok(parseSendRequest({ token: "a.b", messages: [{ type: "text", text: "x" }] }));
  });
});

describe("一言の振り分け（決まった返事で。Claude と LINE は呼ばない）", () => {
  const now = at("2026-11-04", "09:00");
  const today = shopToday(shop, now).today;
  const model = scriptSortModel({ menus, today });
  const ai = getAiSettings();

  function ask(text: string, over: Partial<LineAskRequest> = {}) {
    const { masked, found } = maskNames(text, customers);
    const parsed = parseLineAskRequest(
      {
        mode: "script",
        text: masked,
        customer: found.length === 1 ? found[0] : null,
        booked: bookedAt(now),
        rules: getRules().filter((r) => !r.locked),
        dayOffset: 0,
        ...over,
      },
      menus,
      ai,
      getLineSettings().maxTextChars,
    );
    assert.ok(parsed.ok);
    return { found, masked, run: runLineAsk({ req: parsed.value, shop, menus, model, maxTokens: 300, now }) };
  }

  test("お客様の名字は AI に送らない（〔お客様〕に置きかえる）", () => {
    const { masked, found } = maskNames("明日15時に青木さんカットで仮押さえ", customers);
    assert.equal(masked, `明日15時に${CUSTOMER_MARK}さんカットで仮押さえ`);
    assert.deepEqual(found.map((c) => c.id), ["c01"]);
  });

  test("「シャンプー発注」→ ToDo（題はオーナーの言葉のまま）", async () => {
    const { run } = ask("シャンプー発注");
    const res = await run;
    assert.deepEqual(res, { ok: true, via: "script", kind: "todo" });
    const ev: ScreenEvent = { id: "e1", at: now.toISOString(), kind: "text", text: "シャンプー発注" };
    const out = applyAsk(ev, res as Extract<typeof res, { ok: true }>, emptyBook(today.date), EMPTY_ADS, {
      shop,
      menus,
      customers,
      nowIso: now.toISOString(),
      today: today.date,
      adSettings: getAdSettings(),
      found: [],
      karte: null,
      memoMax: 1500,
    });
    assert.deepEqual(out.book.todos.map((t) => [t.id, t.title]), [["td-line-e1", "シャンプー発注"]]);
    assert.equal(out.reply, "ToDo に足しました：シャンプー発注");
  });

  test("「明日15時に青木さんカットで仮押さえ」→ 予約チャットと同じ道具と判定を通って仮押さえまで（確定しない）", async () => {
    const tomorrow = addDays(today.date, 1);
    assert.equal(calDay(shop, tomorrow).open, true);
    const { run, found } = ask("明日15時に青木さんカットで仮押さえ");
    const res = await run;
    assert.ok(res.ok && res.kind === "hold", JSON.stringify(res));
    assert.deepEqual([res.hold.customerId, res.hold.menuId, res.hold.date, res.hold.start], ["c01", "cut", tomorrow, "15:00"]);
    assert.equal(res.hold.reason, LINE_HOLD_REASON);
    assert.ok(res.steps.some((s) => s.text.startsWith("ルールを確かめる：")));
    const ev: ScreenEvent = { id: "e1", at: now.toISOString(), kind: "text", text: "明日15時に青木さんカットで仮押さえ" };
    const out = applyAsk(ev, res, emptyBook(today.date), EMPTY_ADS, {
      shop,
      menus,
      customers,
      nowIso: now.toISOString(),
      today: today.date,
      adSettings: getAdSettings(),
      found,
      karte: null,
      memoMax: 1500,
    });
    // 仮押さえで承認の箱に1行。確定はしていない
    assert.equal(out.book.chat[0].status, "hold");
    assert.equal(pendingApprovals(out.book, now.toISOString()).length, 1);
    assert.match(out.reply, /^仮押さえしました：青木（架空）様/);
    assert.equal(out.card?.approvalId, `ap-${res.hold.id}`);
  });

  test("ルールで受けられない日時は仮押さえせず、理由と代わりを1行で返す", async () => {
    // 例のルール「予約は来店の3時間前まで」：いま 9:00 なので、今日の 11:00 は受けられない
    const res = await ask("今日11時に石田さんカットで仮押さえ").run;
    assert.ok(res.ok && res.kind === "hold-no", JSON.stringify(res));
    assert.match(res.reason, /3時間前/);
    assert.ok(res.steps.some((s) => s.kind === "reject"));
  });

  test("だれか・いつかがわからなければ仮押さえしない", async () => {
    const res = await ask("明日15時にカットで仮押さえ").run;
    assert.deepEqual(res, { ok: true, via: "script", kind: "hold-missing", missing: ["お客様の名字"] });
    const res2 = await ask("青木さんカットで仮押さえ").run;
    assert.ok(res2.ok && res2.kind === "hold-missing");
    assert.deepEqual(res2.missing, ["日にち", "時刻"]);
  });

  test("「青木さん カルテ：…」→ カルテのメモ（今日の確定の予約の方だけ。言葉はそのまま）", async () => {
    const book = bookedAt(now);
    const todayRes = book.filter((b) => b.date === today.date && b.status === "confirmed");
    const c = customers.find((x) => x.id === todayRes[0].customerId)!;
    const text = `${c.surname}さん カルテのメモ：頭皮が赤かった`;
    const { run, found } = ask(text);
    const res = await run;
    assert.deepEqual(res, { ok: true, via: "script", kind: "karte" });
    const karte = karteTargetFor(found, todayRes.map((b) => ({ customerId: b.customerId, date: b.date, status: b.status })), emptyBook(today.date));
    const ev: ScreenEvent = { id: "e1", at: now.toISOString(), kind: "text", text };
    const out = applyAsk(ev, res as Extract<typeof res, { ok: true }>, emptyBook(today.date), EMPTY_ADS, {
      shop,
      menus,
      customers,
      nowIso: now.toISOString(),
      today: today.date,
      adSettings: getAdSettings(),
      found,
      karte,
      memoMax: 1500,
    });
    assert.deepEqual(out.memo, { customerId: c.id, date: today.date, text });
    // 健康の判断はしない（返事に「大丈夫」などを入れない）
    assert.doesNotMatch(out.reply, /大丈夫|やめた方/);
  });

  test("AI の答えはそのまま信じない（知らない道具・おかしな日付は使わない）", () => {
    assert.deepEqual(readPick({ name: "confirm_booking", input: {} }, menus), { kind: "unknown" });
    assert.deepEqual(readPick({ name: "hold_request", input: { menu_id: "nope", date: "明日", start: "3pm" } }, menus), {
      kind: "hold",
      menuId: "",
      date: "",
      start: "",
    });
    assert.deepEqual(readPick(null, menus), { kind: "unknown" });
    // 2つ以上のメニューは + でつなぐ（予約チャットと同じ決め方。設定の組み合わせにはまとめる）
    assert.deepEqual(readPick({ name: "hold_request", input: { menu_id: "cut+headspa", date: "2026-11-05", start: "15:00" } }, menus), {
      kind: "hold",
      menuId: "cut+headspa",
      date: "2026-11-05",
      start: "15:00",
    });
    assert.equal((readPick({ name: "hold_request", input: { menu_id: "cut+color", date: "", start: "" } }, menus) as { menuId: string }).menuId, "cut_color");
  });
});

describe("朝の要点の文（プログラムが作る）", () => {
  test("今日の予約・前回の次回提案・空き枠を並べる", () => {
    const text = morningText({
      shopName: "omochi",
      todayLabel: "11/4（水）",
      items: [
        { start: "10:00", end: "11:00", surname: "青木", menu: "カット", hold: false, next: ["前髪を短く"] },
        { start: "13:00", end: "14:30", surname: "石田", menu: "カラー", hold: true, next: null },
      ],
      open: true,
      free: { ranges: [{ start: "15:00", end: "17:00", free: 2 }], seatSlots: 8 },
      slotMinutes: 30,
    });
    assert.match(text, /今日の予約 2件/);
    assert.match(text, /青木（架空）様 カット\n　前回の次回提案：前髪を短く/);
    assert.match(text, /石田（架空）様 カラー（仮押さえ）\n　前回の記録なし/);
    assert.match(text, /15:00–17:00 空き2席/);
  });
});

describe("承認待ちを LINE に届ける形", () => {
  test("何を・いつ・理由と、プログラムの確認", () => {
    const now = at("2026-11-04", "09:00");
    const ctx = ctxAt(now);
    const slot = findSlots(ctx, "cut", { date: addDays(ctx.today.date, 1) }).slots[0];
    const book = withHold(emptyBook(ctx.today.date), {
      id: "h1",
      customerId: "c01",
      ...slot,
      heldAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
      reason: "お客様が選びました",
    });
    const row = pendingApprovals(book, now.toISOString())[0];
    const card = reservationCard(row, { shop, menus, customers }, true);
    assert.equal(card.what, "青木（架空）様 カット");
    assert.match(card.when, /^\d+\/\d+（.） \d{2}:\d{2}–\d{2}:\d{2}$/);
    assert.equal(card.why, "お客様が選びました");
    assert.match(card.check, /^✓/);
    assert.ok(KEY.ticket("x").startsWith("line:"));
  });
});
