// LINE のつなぎ（オーナー側）の、サーバーの側の流れ。窓口（src/app/api/line/）から呼ぶ。
//
//  画面「LINE とつなぐ」──▶ 合言葉（期限つき）と、その画面だけが持つ印（token）
//  オーナーが LINE で合言葉を送る ──▶ その LINE の人とその画面がつながる（期限つき）
//  LINE の一言・ボタン ──▶ 署名を確かめる ──▶ つながった人で、画面が開いていれば預ける（短い間）──▶ 画面が受け取りに来る
//  画面が答えを出す ──▶ 返事（数えない）で返す。返事の期限が過ぎていたら送る（1日の上限まで）
//
// 置き場所（store.ts）に置くのは、つなぎと預かり物だけ（どれも期限つき）。お客様の記録・台帳は置かない。
// LINE の人の番号は置き場所の中だけ。画面・日誌・ログには出さない。
// 🔒 確定は人：承認のボタンは「合言葉でつないだ LINE の人」が押した物で、その画面に向けた物だけを通す。1つの行のボタンは1回だけ効く。

import { createHash, timingSafeEqual } from "node:crypto";
import { shopNow } from "../calendar";
import type { LineSettings } from "../settings";
import type { LineClient, LineMessage } from "./api";
import { approvalMessage, LINE_TEXT, textMessage } from "./messages";
import type { KvStore } from "./store";
import {
  parseScreenEvent,
  type ApprovalTarget,
  type LinkStartResponse,
  type OutMessage,
  type PollResponse,
  type ScreenEvent,
  type SendRequest,
  type SendResponse,
} from "./wire";

export type BridgeDeps = {
  store: KvStore;
  /** LINE の鍵が無いときは null（返事も送ることもしない） */
  line: LineClient | null;
  settings: LineSettings;
  timezone: string;
  now: () => Date;
  random: (bytes: number) => Buffer;
  /** オーナー用の合言葉（環境変数 LINE_OWNER_PASSCODE）。あれば「LINE とつなぐ」でこれを求める。無ければ求めない */
  ownerPasscode?: string | null;
};

/** 置き場所の名前。LINE の人の番号は名前に入れない（ハッシュにする） */
export const KEY = {
  code: (c: string) => `line:code:${c}`,
  link: (id: string) => `line:link:${id}`,
  user: (uh: string) => `line:user:${uh}`,
  alive: (id: string) => `line:alive:${id}`,
  inbox: (id: string) => `line:inbox:${id}`,
  reply: (id: string, ev: string) => `line:reply:${id}:${ev}`,
  ticket: (t: string) => `line:ticket:${t}`,
  once: (id: string, k: string) => `line:once:${id}:${k}`,
  seen: (ev: string) => `line:seen:${ev}`,
  push: (day: string) => `line:push:${day}`,
  tries: (uh: string) => `line:try:${uh}`,
  passTries: (ch: string) => `line:passtry:${ch}`,
};

/** つなぎの中身。th = 画面の印のハッシュ / u = LINE の人の番号（つながった後だけ） */
type LinkRecord = { th: string; u?: string; uh?: string; until?: string };
type Ticket = { linkId: string; approvalId: string; target: ApprovalTarget };

export const CODE_RE = /^\d{6}$/;
const POP_MAX = 20;
const ONCE_SECONDS = 2 * 24 * 3600;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 40);
const b64 = (b: Buffer) => b.toString("base64url");

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 全角の数字なども半角にして、前後の空白を取る */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").trim();
}

function newCode(d: BridgeDeps): string {
  return String(d.random(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** 画面の印を確かめる。印は「つなぎの id.秘密」。置き場所には秘密のハッシュだけを置く */
async function readToken(d: BridgeDeps, token: string): Promise<{ linkId: string; link: LinkRecord } | null> {
  const [linkId, secret, extra] = token.split(".");
  if (!linkId || !secret || extra !== undefined || !/^[\w-]{6,40}$/.test(linkId)) return null;
  const link = parseJson<LinkRecord>(await d.store.get(KEY.link(linkId)));
  if (!link || typeof link.th !== "string") return null;
  const a = Buffer.from(sha(secret));
  const b = Buffer.from(link.th);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { linkId, link };
}

/** 文どうしを、かかる時間で中身がわからない形で比べる */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha(a));
  const y = Buffer.from(sha(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export type StartLinkOptions = {
  /** 画面で入れたオーナー用の合言葉（LINE_OWNER_PASSCODE があるときだけ見る） */
  passcode?: string;
  /** 試した回数を数える相手（窓口が送り元から作る。置き場所にはハッシュだけ） */
  client?: string;
};

/**
 * 画面の「LINE とつなぐ」：合言葉と、その画面だけが持つ印を作る。前の印があれば、そのつなぎは切る。
 * オーナー用の合言葉（LINE_OWNER_PASSCODE）があるときは、それが合っている時だけ作る（10分に codeTries 回まで試せる）。
 */
export async function startLink(d: BridgeDeps, oldToken?: string, opts: StartLinkOptions = {}): Promise<LinkStartResponse> {
  const owner = d.ownerPasscode?.trim();
  if (owner) {
    const ch = sha(`pass:${opts.client ?? "?"}`);
    const tries = await d.store.incr(KEY.passTries(ch), 600);
    if (tries > d.settings.codeTries)
      return { ok: false, code: "passcode", message: "オーナー用の合言葉を何回もまちがえたので、10分ほど待ってからもう一度押してください" };
    if (!opts.passcode || !sameSecret(normalizeText(opts.passcode), owner))
      return { ok: false, code: "passcode", message: "オーナー用の合言葉がちがいます" };
    await d.store.del(KEY.passTries(ch));
  }
  if (oldToken) await unlink(d, oldToken);
  const linkId = b64(d.random(9));
  const secret = b64(d.random(24));
  const ex = d.settings.codeMinutes * 60;
  let code = "";
  for (let i = 0; i < 8 && !code; i++) {
    const c = newCode(d);
    if (await d.store.set(KEY.code(c), linkId, { ex, nx: true })) code = c;
  }
  if (!code) return { ok: false, code: "failed", message: "合言葉を作れませんでした。もう一度押してください" };
  await d.store.set(KEY.link(linkId), JSON.stringify({ th: sha(secret) } satisfies LinkRecord), { ex });
  return {
    ok: true,
    token: `${linkId}.${secret}`,
    code,
    codeExpiresAt: new Date(d.now().getTime() + ex * 1000).toISOString(),
  };
}

/** 画面が受け取りに来る。来たことを「開いている」の印にし、つながっていれば預かり物を渡す（渡した物は消える） */
export async function pollScreen(d: BridgeDeps, token: string): Promise<PollResponse> {
  const r = await readToken(d, token);
  if (!r) return { ok: false, code: "gone", message: "つながりがありません" };
  await d.store.set(KEY.alive(r.linkId), "1", { ex: d.settings.aliveSeconds });
  if (!r.link.u) return { ok: true, linked: false, events: [] };
  const raw = await d.store.lpop(KEY.inbox(r.linkId), POP_MAX);
  const events = raw.map((x) => parseScreenEvent(parseJson(x))).filter((e): e is ScreenEvent => !!e);
  return { ok: true, linked: true, until: r.link.until, events };
}

/** 画面の「つなぎを切る」 */
export async function unlink(d: BridgeDeps, token: string): Promise<void> {
  const r = await readToken(d, token);
  if (!r) return;
  await d.store.del(KEY.link(r.linkId));
  await d.store.del(KEY.alive(r.linkId));
  await d.store.del(KEY.inbox(r.linkId));
  if (r.link.uh && (await d.store.get(KEY.user(r.link.uh))) === r.linkId) await d.store.del(KEY.user(r.link.uh));
}

/**
 * 画面の「最初に戻す」：その画面に向けて預かっている LINE の知らせを消す（まだ画面が受け取っていない一言・ボタン）。
 * つなぎは切らない。印が違えば何もしない。
 */
export async function clearInbox(d: BridgeDeps, token: string): Promise<boolean> {
  const r = await readToken(d, token);
  if (!r) return false;
  await d.store.del(KEY.inbox(r.linkId));
  return true;
}

// ---- LINE からの知らせ（署名を確かめた後） ----

type LineEvent = {
  type?: unknown;
  replyToken?: unknown;
  webhookEventId?: unknown;
  source?: { type?: unknown; userId?: unknown };
  message?: { type?: unknown; text?: unknown };
  postback?: { data?: unknown };
};

/** 署名を確かめた後の中身を読む。ここに来る前に、署名の違う物は捨ててある（窓口 route.ts） */
export async function handleWebhook(d: BridgeDeps, body: unknown): Promise<void> {
  const events = body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : [];
  for (const e of events.slice(0, 20)) {
    if (e && typeof e === "object") await handleEvent(d, e as LineEvent);
  }
}

async function reply(d: BridgeDeps, replyToken: string | null, text: string): Promise<void> {
  if (d.line && replyToken) await d.line.reply(replyToken, [textMessage(text)]);
}

async function handleEvent(d: BridgeDeps, e: LineEvent): Promise<void> {
  // 1対1のトークだけ（グループ・ルームは何もしない）
  if (e.source?.type !== "user" || typeof e.source.userId !== "string" || !e.source.userId) return;
  // LINE が同じ知らせを送りなおしたときは、2回目を使わない
  if (typeof e.webhookEventId === "string" && !(await d.store.set(KEY.seen(e.webhookEventId), "1", { ex: 600, nx: true }))) return;
  const uid = e.source.userId;
  const uh = sha(uid);
  const replyToken = typeof e.replyToken === "string" ? e.replyToken : null;

  const linkId = await d.store.get(KEY.user(uh));
  const link = linkId ? parseJson<LinkRecord>(await d.store.get(KEY.link(linkId))) : null;
  const linked = !!(linkId && link && link.u === uid);
  const alive = linked && !!(await d.store.get(KEY.alive(linkId!)));

  if (e.type === "follow") {
    if (!linked) await reply(d, replyToken, LINE_TEXT.askCode);
    return;
  }

  if (e.type === "message") {
    if (e.message?.type !== "text" || typeof e.message.text !== "string") {
      await reply(d, replyToken, linked ? LINE_TEXT.textOnly : LINE_TEXT.askCode);
      return;
    }
    const text = normalizeText(e.message.text);
    if (CODE_RE.test(text)) return tryLink(d, uid, uh, text, replyToken);
    // つながっていない人の一言では何も動かさない
    if (!linked) return reply(d, replyToken, LINE_TEXT.askCode);
    if (!alive) return reply(d, replyToken, LINE_TEXT.screenClosed);
    if (!text) return;
    await enqueue(d, linkId!, { id: b64(d.random(9)), at: d.now().toISOString(), kind: "text", text: text.slice(0, d.settings.maxTextChars) }, replyToken);
    return;
  }

  if (e.type === "postback") {
    const data = new URLSearchParams(typeof e.postback?.data === "string" ? e.postback.data : "");
    const tk = data.get("tk") ?? "";
    const how = data.get("do");
    if (!/^[\w-]{8,40}$/.test(tk) || (how !== "approve" && how !== "skip")) return;
    // 🔒 合言葉でつないだ人のボタンだけ
    if (!linked) return reply(d, replyToken, LINE_TEXT.linkGone);
    // 画面が閉じているときは、ボタンを使わずに残しておく（開いてから押しなおせる）
    if (!alive) return reply(d, replyToken, LINE_TEXT.screenClosed);
    const t = parseJson<Ticket>(await d.store.get(KEY.ticket(tk)));
    if (!t) return reply(d, replyToken, LINE_TEXT.buttonUsed);
    if (t.linkId !== linkId) return reply(d, replyToken, LINE_TEXT.buttonNotYours);
    // 1つの行のボタンは1回だけ（「承認」と「見送り」で同じ印。読んだら消す）
    if (!(await d.store.getdel(KEY.ticket(tk)))) return reply(d, replyToken, LINE_TEXT.buttonUsed);
    await enqueue(
      d,
      linkId!,
      { id: b64(d.random(9)), at: d.now().toISOString(), kind: "press", approvalId: t.approvalId, target: t.target, how },
      replyToken,
    );
  }
}

async function tryLink(d: BridgeDeps, uid: string, uh: string, code: string, replyToken: string | null): Promise<void> {
  const tries = await d.store.incr(KEY.tries(uh), 600);
  if (tries > d.settings.codeTries) return reply(d, replyToken, LINE_TEXT.tooMany);
  const linkId = await d.store.getdel(KEY.code(code));
  const link = linkId ? parseJson<LinkRecord>(await d.store.get(KEY.link(linkId))) : null;
  if (!linkId || !link || link.u) return reply(d, replyToken, LINE_TEXT.wrongCode);
  // 同じ人が前に別の画面とつないでいたら、そちらは切る（1人の LINE は1つの画面と）
  const old = await d.store.get(KEY.user(uh));
  if (old && old !== linkId) {
    await d.store.del(KEY.link(old));
    await d.store.del(KEY.inbox(old));
  }
  const ex = d.settings.linkHours * 3600;
  const until = new Date(d.now().getTime() + ex * 1000).toISOString();
  await d.store.set(KEY.link(linkId), JSON.stringify({ th: link.th, u: uid, uh, until } satisfies LinkRecord), { ex });
  await d.store.set(KEY.user(uh), linkId, { ex });
  await d.store.del(KEY.tries(uh));
  await reply(d, replyToken, LINE_TEXT.linked(d.settings.linkHours));
}

async function enqueue(d: BridgeDeps, linkId: string, ev: ScreenEvent, replyToken: string | null): Promise<void> {
  if (replyToken) await d.store.set(KEY.reply(linkId, ev.id), replyToken, { ex: d.settings.replySeconds });
  await d.store.rpush(KEY.inbox(linkId), JSON.stringify(ev), d.settings.inboxSeconds);
}

// ---- 画面から LINE へ ----

async function toLineMessages(d: BridgeDeps, linkId: string, list: OutMessage[]): Promise<LineMessage[]> {
  const out: LineMessage[] = [];
  for (const m of list) {
    if (m.type === "text") out.push(textMessage(m.text));
    else {
      const ticket = b64(d.random(12));
      const t: Ticket = { linkId, approvalId: m.card.approvalId, target: m.card.target };
      await d.store.set(KEY.ticket(ticket), JSON.stringify(t), { ex: d.settings.linkHours * 3600 });
      out.push(approvalMessage(m.card, ticket));
    }
  }
  return out;
}

/**
 * 画面から LINE へ。返事で済むとき（replyTo の印がまだ使える）は返事（数えない）。
 * そうでなければ送る（数える）。送るのは1日 dailyPushLimit 通まで（店の時間帯の日付で数える）。
 */
export async function sendFromScreen(d: BridgeDeps, req: SendRequest): Promise<SendResponse> {
  const r = await readToken(d, req.token);
  if (!r) return { ok: false, code: "gone", message: "つながりがありません" };
  if (!r.link.u) return { ok: false, code: "not-linked", message: "まだ LINE とつながっていません" };
  if (!d.line) return { ok: false, code: "no-line", message: "LINE の鍵がありません" };
  // 同じ承認待ちの行のボタンは1回だけ届ける（2つの窓・返事と知らせが重なっても）。文はそのまま送る
  let list = req.messages;
  if (req.once && !(await d.store.set(KEY.once(r.linkId, req.once), "1", { ex: ONCE_SECONDS, nx: true })))
    list = list.filter((m) => m.type !== "approval");
  if (list.length === 0) return { ok: true, via: "skipped" };

  const messages = await toLineMessages(d, r.linkId, list);
  if (req.replyTo) {
    const rt = await d.store.getdel(KEY.reply(r.linkId, req.replyTo));
    if (rt) {
      const res = await d.line.reply(rt, messages);
      if (res.ok) return { ok: true, via: "reply" };
    }
  }
  const day = shopNow({ timezone: d.timezone }, d.now()).date;
  const n = await d.store.incr(KEY.push(day), ONCE_SECONDS);
  if (n > d.settings.dailyPushLimit)
    return { ok: false, code: "limit", message: `今日の LINE の送る上限（${d.settings.dailyPushLimit}通）に来ました` };
  const res = await d.line.push(r.link.u, messages);
  if (res.ok) return { ok: true, via: "push" };
  if (res.status === 429) return { ok: false, code: "limit", message: "LINE の今月の送る上限に来ました" };
  return { ok: false, code: "failed", message: "LINE に送れませんでした" };
}

/** テスト用：1日に送った数 */
export async function pushedToday(d: BridgeDeps): Promise<number> {
  return Number((await d.store.get(KEY.push(shopNow({ timezone: d.timezone }, d.now()).date))) ?? 0);
}
