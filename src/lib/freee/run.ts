// freee（テスト事業所）の押した後の流れ（ブラウザの側）。AI は使わない。
// 画面とテストが同じ物を使う（テストでは post と locks を置きかえる。本物の freee もサーバーも呼ばない）。
//
// - 取り合いを止める鍵：「freee に明細を入れる」・登録（前の読み直しから登録が終わるまで）・「freee から読み直す」・「最初に戻す」は、
//   同じ排他（Web Locks の navigator.locks。同じブラウザのほかのタブとも）の中だけで動く。取れなければ始めない（待たない）
// - 送り始めたら、明細と店用／私用の選びを固定する（state.ts の uses）。1件ずつ順に送る
// - 「結果が分からない」は送り直さない（「freee から読み直す」で照らし合わせた後でだけ、もう一度送れる）
// - 明細を入れた結果が分からない時は、待つ期限（importHold）を記録に残す。期限が過ぎても、読み直して照らし合わせてから、まだ無い物だけ入れる
// - つなぎが切れた・結果が分からない時は、そこで止める（残りは「まだ」のまま。会計（架空）には切り替えない）

import type { CardUse } from "../data/types";
import {
  importHeld,
  isSending,
  stateOf,
  toSend,
  withChecked,
  withImportHold,
  withItem,
  withRunEnd,
  withRunStart,
  withSending,
  withStaleRecovered,
  type FreeeRecord,
  type FreeeRun,
} from "./state";

/** サーバーの窓口を呼ぶ。つながらない時は投げる。body は JSON で読めなければ null */
export type Post = (path: string, body?: unknown) => Promise<{ status: number; body: unknown | null }>;

/** Web Locks（navigator.locks）の使う所だけ。ifAvailable：取れなければ待たずに null で呼ぶ */
export type LockLike = {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown | null) => Promise<T>): Promise<T>;
};

export const FREEE_LOCK = "secretairy-freee";
export const BUSY_REASON = "ほかのタブか画面で freee とやりとりしています。終わってから押してください";

export type RunDeps = {
  read: () => FreeeRecord;
  write: (r: FreeeRecord) => void;
  post: Post;
  now: () => Date;
  staleSeconds: number;
  /** 同じブラウザのタブどうしの排他。null（使えないブラウザ）の時は、このタブの中だけで止める */
  locks: LockLike | null;
  /** 明細を入れた結果が分からない時に待つ秒数 */
  importWaitSeconds: number;
  /** 明細を入れる1回の押しで、窓口を続けて呼ぶ回数の上限 */
  maxImportCalls: number;
};

export type Fail = { ok: false; reason: string };

const messageOf = (b: unknown, fallback: string) => {
  const m = (b as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m.slice(0, 300) : fallback;
};

// Web Locks が使えない時だけの、このタブの中の印
let fallbackHeld = false;

/** 排他の中で動かす。取れなければ待たずに断る */
export async function withFreeeLock<T>(locks: LockLike | null, fn: () => Promise<T>): Promise<T | Fail> {
  if (locks) return locks.request(FREEE_LOCK, { ifAvailable: true }, async (lock) => (lock ? fn() : { ok: false as const, reason: BUSY_REASON }));
  if (fallbackHeld) return { ok: false, reason: BUSY_REASON };
  fallbackHeld = true;
  try {
    return await fn();
  } finally {
    fallbackHeld = false;
  }
}

/** 排他を持っている時：ほかに送っている人はいないので、残っている「送っている」は止まった物（結果が分からない） */
function recoverHeld(deps: RunDeps): FreeeRecord {
  const r = deps.read();
  const nowIso = deps.now().toISOString();
  // Web Locks で排他を持っている → 印が新しくても、送っている人はいない。使えない時は時間で決める
  const nowMs = deps.locks ? Number.POSITIVE_INFINITY : deps.now().getTime();
  const out = withStaleRecovered(r, nowMs, deps.staleSeconds, nowIso);
  if (out !== r) deps.write(out);
  return out;
}

/** 開いた時・印が古くなった時：排他が空いていれば、止まった「送っている」を「結果が分からない」にする */
export async function recoverIfIdle(deps: RunDeps): Promise<void> {
  await withFreeeLock(deps.locks, async () => {
    recoverHeld(deps);
    return null;
  });
}

function fresh(deps: RunDeps): FreeeRecord {
  return deps.read();
}

export type RunOutcome = { ok: true; run: FreeeRun; stoppedBy: string | null };

/**
 * 選び終わった明細を、1件ずつ順に freee に登録する（排他の中から呼ぶ）。
 * uses：いまの店用／私用（もう固定してあれば、固定した方を使う）。nos：送ってよい明細の番号（明細の順）。
 */
export async function runRegister(deps: RunDeps, p: { uses: Record<string, CardUse>; nos: number[] }): Promise<RunOutcome | Fail> {
  let r = fresh(deps);
  if (!deps.locks && isSending(r, deps.now().getTime(), deps.staleSeconds)) return { ok: false, reason: BUSY_REASON };
  if (p.nos.some((no) => !p.uses[String(no)] && !r.uses?.[String(no)])) return { ok: false, reason: "選び終わっていません" };
  r = withRunStart(r, p.uses, deps.now().toISOString());
  deps.write(r);
  const uses = r.uses!;
  const run: FreeeRun = { at: deps.now().toISOString(), registered: 0, already: 0, failed: 0, unknown: 0, dealIds: [] };
  let stoppedBy: string | null = null;

  for (const no of toSend(r, p.nos)) {
    deps.write(withSending(fresh(deps), no, deps.now().toISOString()));
    const use = uses[String(no)];
    let res: { status: number; body: unknown | null } | null = null;
    try {
      res = await deps.post("/api/freee/register", { no, use });
    } catch {
      res = null;
    }
    const nowIso = deps.now().toISOString();
    const b = (res?.body ?? null) as { ok?: unknown; result?: unknown; dealIds?: unknown; reason?: unknown; code?: unknown } | null;
    let next = fresh(deps);
    if (res && res.status === 200 && b?.ok === true && b.result === "registered" && Array.isArray(b.dealIds)) {
      const dealIds = b.dealIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n));
      next = withItem(next, no, { state: "registered", dealIds }, nowIso);
      run.registered++;
      run.dealIds.push(...dealIds);
    } else if (res && res.status === 200 && b?.ok === true && b.result === "already") {
      next = withItem(next, no, { state: "already" }, nowIso);
      run.already++;
    } else if (res && res.status === 200 && b?.ok === true && (b.result === "check" || b.result === "failed")) {
      const reason = typeof b.reason === "string" ? b.reason : "";
      next = withItem(next, no, { state: "failed", reason: b.result === "check" ? `確かめが要る：${reason}` : reason }, nowIso);
      run.failed++;
    } else if (res && res.status < 500 && res.status !== 200 && b !== null) {
      // 窓口が受けなかった（つなぎが切れた・本番のサイトではない など）。freee には書いていない
      const reason = messageOf(b, "うまくいきませんでした");
      next = withItem(next, no, { state: "failed", reason }, nowIso);
      run.failed++;
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 503) stoppedBy = reason;
    } else {
      // つながらない・500 台・返事が読めない・「結果が分からない」：送ったかもしれないので、送り直さない
      const reason =
        b?.ok === true && b.result === "unknown" && typeof b.reason === "string"
          ? b.reason
          : "送った後に返事が途切れました。送り直さずに、freee から読み直して照らし合わせてください";
      next = withItem(next, no, { state: "unknown", reason }, nowIso);
      run.unknown++;
      stoppedBy = reason;
    }
    deps.write({ ...next, sendingAt: nowIso });
    if (stoppedBy) break;
  }
  deps.write(withRunEnd(fresh(deps), run));
  return { ok: true, run, stoppedBy };
}

export type CheckKind = "ready" | "done" | "check" | "missing";
export type CheckOutcome = { ok: true; answers: { no: number; kind: CheckKind; reason?: string }[]; setup: unknown };

/**
 * freee から読み直して照らし合わせる（書かない。排他の中から呼ぶ）。
 * 読み直しを始めた時刻より新しい記録（その間に登録した など）は上書きしない。
 */
export async function runCheck(deps: RunDeps, nos: number[]): Promise<CheckOutcome | Fail> {
  const startedAt = deps.now().getTime();
  let res;
  try {
    res = await deps.post("/api/freee/check", { nos });
  } catch {
    return { ok: false, reason: "サーバーにつながりませんでした" };
  }
  const b = res.body as { ok?: unknown; items?: unknown; setup?: unknown } | null;
  if (res.status !== 200 || b?.ok !== true || !Array.isArray(b.items)) return { ok: false, reason: messageOf(b, "読み直せませんでした") };
  const answers = (b.items as { no?: unknown; kind?: unknown; reason?: unknown }[])
    .filter((a) => typeof a.no === "number" && nos.includes(a.no) && (a.kind === "ready" || a.kind === "done" || a.kind === "check" || a.kind === "missing"))
    .map((a) => ({ no: a.no as number, kind: a.kind as CheckKind, reason: typeof a.reason === "string" ? a.reason : undefined }));
  deps.write(withChecked(fresh(deps), answers, deps.now().toISOString(), startedAt));
  return { ok: true, answers, setup: b.setup ?? null };
}

export type PressRegisterOutcome = RunOutcome & { skipped: { check: number; missing: number } };

/**
 * 「freee（テスト事業所）に登録」1回の押し：排他の中で、止まった「送っている」を直し → 読み直して照らし合わせ → 1件ずつ登録。
 * 「結果が分からない」の明細は読み直しに入れず、送らない（「freee から読み直す」を押した後でだけ送れる）。
 * この押しの読み直しで「確かめが要る」「明細が無い」になった明細も送らない（件数だけ返す）。
 */
export async function pressRegister(deps: RunDeps, p: { uses: Record<string, CardUse>; nos: number[] }): Promise<PressRegisterOutcome | Fail> {
  return withFreeeLock(deps.locks, async () => {
    const first = recoverHeld(deps);
    const checkNos = p.nos.filter((no) => {
      const s = stateOf(first, no);
      return s !== "unknown" && s !== "sending" && s !== "registered" && s !== "already";
    });
    const skipped = { check: 0, missing: 0 };
    let sendNos = checkNos;
    if (checkNos.length) {
      deps.write({ ...fresh(deps), sendingAt: deps.now().toISOString() });
      const c = await runCheck(deps, checkNos);
      if (!c.ok) {
        deps.write({ ...fresh(deps), sendingAt: null });
        return c;
      }
      const stop = new Set<number>();
      for (const a of c.answers) {
        if (a.kind === "check") skipped.check++;
        if (a.kind === "missing") skipped.missing++;
        if (a.kind === "check" || a.kind === "missing" || a.kind === "done") stop.add(a.no);
      }
      sendNos = checkNos.filter((no) => !stop.has(no));
    }
    const out = await runRegister(deps, { uses: p.uses, nos: sendNos });
    if (!out.ok) {
      deps.write({ ...fresh(deps), sendingAt: null });
      return out;
    }
    return { ...out, skipped };
  });
}

/** 「freee から読み直す」：排他の中で、止まった「送っている」を直してから、読み直して照らし合わせる（書かない） */
export async function pressCheck(deps: RunDeps, nos: number[]): Promise<CheckOutcome | Fail> {
  return withFreeeLock(deps.locks, async () => {
    recoverHeld(deps);
    deps.write({ ...fresh(deps), sendingAt: deps.now().toISOString() });
    try {
      return await runCheck(deps, nos);
    } finally {
      deps.write({ ...fresh(deps), sendingAt: null });
    }
  });
}

export type ImportOutcome = {
  ok: true;
  created: number;
  existed: number;
  check: number;
  done: boolean;
  /** 止めた理由（結果が分からない・freee が受けなかった・呼ぶ回数の上限） */
  stopped: string | null;
  /** 結果が分からない時の、待つ期限 */
  holdUntil: string | null;
};

/**
 * 「freee に明細を入れる」1回の押し：排他の中で、窓口を続けて呼ぶ（サーバーは持ち時間で区切って、そこまでの結果を返す）。
 * つながらない・500 台（504 も）・読めない返事・200 でも中が「結果が分からない」の時は、待つ期限を記録に残して止める。
 * 期限の前は呼ばない。期限が過ぎた後も「書き終わった」とは見なさず、サーバーが読み直して照らし合わせ、まだ無い物だけ入れる。
 */
export async function pressImport(deps: RunDeps): Promise<ImportOutcome | Fail> {
  return withFreeeLock(deps.locks, async () => {
    const r = recoverHeld(deps);
    if (importHeld(r, deps.now().getTime()))
      return { ok: false, reason: `前に入れた結果が分からないので、${r.importHold!.until} まで待ってください（その後、freee から読み直して、まだ無い物だけ入れます）` };
    const out: ImportOutcome = { ok: true, created: 0, existed: 0, check: 0, done: false, stopped: null, holdUntil: null };
    let createdBefore = 0;
    const hold = (reason: string) => {
      const nowMs = deps.now().getTime();
      const next = withImportHold(fresh(deps), nowMs, deps.importWaitSeconds, reason);
      deps.write(next);
      out.stopped = reason;
      out.holdUntil = next.importHold!.until;
    };
    try {
      for (let call = 0; call < deps.maxImportCalls; call++) {
        deps.write({ ...fresh(deps), sendingAt: deps.now().toISOString() });
        let res: { status: number; body: unknown | null } | null = null;
        try {
          res = await deps.post("/api/freee/import");
        } catch {
          res = null;
        }
        const b = (res?.body ?? null) as {
          ok?: unknown;
          created?: unknown;
          existed?: unknown;
          check?: unknown;
          done?: unknown;
          stopped?: { kind?: unknown; reason?: unknown } | null;
        } | null;
        if (!res || res.status >= 500 || b === null) {
          hold("明細を入れた返事が途切れました（結果が分かりません）");
          return out;
        }
        if (res.status !== 200 || b.ok !== true) {
          out.stopped = messageOf(b, "うまくいきませんでした");
          return out;
        }
        const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0);
        out.created += n(b.created);
        // もうあった：この呼び出しで見つけた物から、前の呼び出しで入れた物を引く
        out.existed = Math.max(0, n(b.existed) - createdBefore);
        out.check = n(b.check);
        createdBefore += n(b.created);
        const kind = b.stopped?.kind;
        const reason = typeof b.stopped?.reason === "string" ? b.stopped.reason : "";
        if (kind === "unknown" || (b.stopped && kind !== "time" && kind !== "failed")) {
          hold(reason || "明細を入れた結果が分かりません");
          return out;
        }
        if (kind === "failed") {
          out.stopped = reason || "freee が受けませんでした";
          return out;
        }
        if (kind === "time") continue; // サーバーが持ち時間で区切った。続きを呼ぶ
        if (b.done === true) {
          out.done = true;
          deps.write({ ...fresh(deps), importHold: null });
          return out;
        }
        hold("明細を入れた返事の形が違います（結果が分かりません）");
        return out;
      }
      out.stopped = "呼ぶ回数の上限に来たので止めました。もう一度押すと、続きを入れます";
      return out;
    } finally {
      deps.write({ ...fresh(deps), sendingAt: null });
    }
  });
}
