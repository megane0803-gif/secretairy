// LINE のつなぎの、画面とサーバー（/api/line/link・/api/line/poll・/api/line/send）のあいだの形。
// 画面に渡すのは「何が来たか」だけ。LINE の人の番号・返事の印（replyToken）・鍵は画面に渡さない。

/** 画面が受け取る LINE の知らせ。text = オーナーの一言 / press = 承認の箱のボタン（合言葉でつないだ LINE から押した物だけ） */
export type ScreenEvent =
  | { id: string; at: string; kind: "text"; text: string }
  | { id: string; at: string; kind: "press"; approvalId: string; target: ApprovalTarget; how: "approve" | "skip" };

/** 承認の箱のどの行か（予約の仮押さえ / 広告の案） */
export type ApprovalTarget = "reservation" | "ad";

/** LINE に届ける承認待ちの1行（何を・いつ・理由）。ボタンの印（1回だけ効く）はサーバーが付ける */
export type ApprovalCard = {
  approvalId: string;
  target: ApprovalTarget;
  what: string;
  when: string;
  why: string;
  /** プログラムの確認（✓ / ✗ の1文） */
  check: string;
};

export type OutMessage = { type: "text"; text: string } | { type: "approval"; card: ApprovalCard };

export type LinkStartResponse =
  | { ok: true; token: string; code: string; codeExpiresAt: string }
  | { ok: false; code: LineProblem; message: string };

export type PollResponse =
  | { ok: true; linked: boolean; until?: string; events: ScreenEvent[] }
  | { ok: false; code: LineProblem; message: string };

export type SendRequest = {
  token: string;
  /** LINE の知らせ（ScreenEvent の id）への返事なら、その id。返事は数えられない */
  replyTo?: string;
  messages: OutMessage[];
  /** 承認待ちの行のボタンを2回届けないための印（行の id）。サーバーで1回だけ通す（2回目はボタンを外し、文だけ送る） */
  once?: string;
};

export type SendResponse =
  | { ok: true; via: "reply" | "push" | "skipped" }
  | { ok: false; code: LineProblem; message: string };

/** gone = つなぎが無い（期限切れ・切った） / limit = 1日の上限 / no-store = Redis が無い / no-line = LINE の鍵が無い */
export type LineProblem = "gone" | "not-linked" | "limit" | "no-store" | "no-line" | "failed" | "bad-request";

export const MAX_OUT_TEXT = 1000;
export const MAX_OUT_MESSAGES = 3;
const MAX_FIELD = 120;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : null);

export function parseScreenEvent(x: unknown): ScreenEvent | null {
  if (!isObj(x) || typeof x.id !== "string" || typeof x.at !== "string") return null;
  if (x.kind === "text" && typeof x.text === "string") return { id: x.id, at: x.at, kind: "text", text: x.text.slice(0, 500) };
  if (
    x.kind === "press" &&
    typeof x.approvalId === "string" &&
    (x.target === "reservation" || x.target === "ad") &&
    (x.how === "approve" || x.how === "skip")
  )
    return { id: x.id, at: x.at, kind: "press", approvalId: x.approvalId, target: x.target, how: x.how };
  return null;
}

function parseCard(x: unknown): ApprovalCard | null {
  if (!isObj(x)) return null;
  const approvalId = str(x.approvalId, 80);
  const what = str(x.what, MAX_FIELD);
  const when = str(x.when, MAX_FIELD);
  const why = str(x.why, MAX_FIELD);
  const check = str(x.check, MAX_FIELD);
  if (!approvalId || !what || !when || why === null || check === null) return null;
  if (x.target !== "reservation" && x.target !== "ad") return null;
  return { approvalId, target: x.target, what, when, why, check };
}

export function parseSendRequest(x: unknown): SendRequest | null {
  if (!isObj(x) || typeof x.token !== "string" || !Array.isArray(x.messages)) return null;
  const messages: OutMessage[] = [];
  for (const m of x.messages.slice(0, MAX_OUT_MESSAGES)) {
    if (!isObj(m)) return null;
    if (m.type === "text" && typeof m.text === "string" && m.text.trim()) messages.push({ type: "text", text: m.text.slice(0, MAX_OUT_TEXT) });
    else if (m.type === "approval") {
      const card = parseCard(m.card);
      if (!card) return null;
      messages.push({ type: "approval", card });
    } else return null;
  }
  if (messages.length === 0) return null;
  return {
    token: x.token.slice(0, 200),
    messages,
    ...(typeof x.replyTo === "string" ? { replyTo: x.replyTo.slice(0, 80) } : {}),
    ...(typeof x.once === "string" ? { once: x.once.slice(0, 80) } : {}),
  };
}
