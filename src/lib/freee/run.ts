// freee（テスト事業所）の押した後の流れ（ブラウザの側）。AI は使わない。
// 画面とテストが同じ物を使う（テストでは post と locks を置きかえる。本物の freee もサーバーも呼ばない）。
//
// - 取り合いを止める鍵：「freee に明細を入れる」・登録（前の読み直しから登録が終わるまで）・「freee から読み直す」・「最初に戻す」は、
//   同じ排他（Web Locks の navigator.locks。同じブラウザのほかのタブとも）の中だけで動く。取れなければ始めない（待たない）
// - 送り始めたら、明細と店用／私用の選びを固定する（state.ts の uses）。1件ずつ順に送る
// - 「結果が分からない」は送り直さない（「freee から読み直す」で照らし合わせた後でだけ、もう一度送れる）
// - 明細を入れた結果が分からない時は、待つ期限（importHold）を記録に残す。期限が過ぎても、読み直して照らし合わせてから、まだ無い物だけ入れる
// - つなぎが切れた・結果が分からない時は、そこで止める（残りは「まだ」のまま。画面の中の会計には切り替えない）

import { txnKey, type ListedTxn } from "../accounting/rows";
import { isRealDate } from "../calendar";
import type { CardUse, StatementAccount } from "../data/types";
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
  /** 「freee から読み直す」で読んだ一覧を、画面の一覧に入れる（ブラウザには書かない。画面のメモリの中だけ） */
  onList?: (list: FreeeList) => void;
};

/** freee から読んだ、まだ処理していない明細の一覧（画面のメモリの中だけに持つ。ブラウザには書かない） */
export type FreeeList = {
  range: { from: string; to: string };
  rows: ListedTxn[];
  /** 多いので、新しい方から上限の件数だけ */
  capped: boolean;
  /** 銀行の口座が無い時の1行 */
  bank: string | null;
  at: string;
};

/** 登録で送る1件（freee から読んだ明細。サーバーが freee から読み直して、全部合う時だけ登録する） */
export type RegisterTarget = { key: string; id: number; account: StatementAccount; date: string; amount: number };

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
 * uses：いまの店用／私用（もう固定してある明細は、固定した方を使う）。targets：送ってよい明細（一覧の順）。
 */
export async function runRegister(deps: RunDeps, p: { uses: Record<string, CardUse>; targets: RegisterTarget[] }): Promise<RunOutcome | Fail> {
  let r = fresh(deps);
  if (!deps.locks && isSending(r, deps.now().getTime(), deps.staleSeconds)) return { ok: false, reason: BUSY_REASON };
  if (p.targets.some((t) => !p.uses[t.key] && !r.uses?.[t.key])) return { ok: false, reason: "選び終わっていません" };
  const startUses: Record<string, CardUse> = {};
  for (const t of p.targets) if (p.uses[t.key]) startUses[t.key] = p.uses[t.key];
  r = withRunStart(r, startUses, deps.now().toISOString());
  deps.write(r);
  const uses = r.uses!;
  const run: FreeeRun = { at: deps.now().toISOString(), registered: 0, already: 0, failed: 0, unknown: 0, dealIds: [] };
  let stoppedBy: string | null = null;
  const send = new Set(toSend(r, p.targets.map((t) => t.key)));

  for (const t of p.targets) {
    if (!send.has(t.key)) continue;
    const key = t.key;
    deps.write(withSending(fresh(deps), key, deps.now().toISOString()));
    const use = uses[key];
    let res: { status: number; body: unknown | null } | null = null;
    try {
      res = await deps.post("/api/freee/register", { id: t.id, use, account: t.account, date: t.date, amount: t.amount });
    } catch {
      res = null;
    }
    const nowIso = deps.now().toISOString();
    const b = (res?.body ?? null) as { ok?: unknown; result?: unknown; dealIds?: unknown; reason?: unknown; code?: unknown } | null;
    let next = fresh(deps);
    if (res && res.status === 200 && b?.ok === true && b.result === "registered" && Array.isArray(b.dealIds)) {
      const dealIds = b.dealIds.filter((n): n is number => typeof n === "number" && Number.isInteger(n));
      next = withItem(next, key, { state: "registered", dealIds }, nowIso);
      run.registered++;
      run.dealIds.push(...dealIds);
    } else if (res && res.status === 200 && b?.ok === true && b.result === "already") {
      next = withItem(next, key, { state: "already" }, nowIso);
      run.already++;
    } else if (res && res.status === 200 && b?.ok === true && (b.result === "check" || b.result === "failed")) {
      const reason = typeof b.reason === "string" ? b.reason : "";
      next = withItem(next, key, { state: "failed", reason: b.result === "check" ? `確かめが要る：${reason}` : reason }, nowIso);
      run.failed++;
    } else if (res && res.status < 500 && res.status !== 200 && b !== null) {
      // 窓口が受けなかった（つなぎが切れた・本番のサイトではない など）。freee には書いていない
      const reason = messageOf(b, "うまくいきませんでした");
      next = withItem(next, key, { state: "failed", reason }, nowIso);
      run.failed++;
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 503) stoppedBy = reason;
    } else {
      // つながらない・500 台・返事が読めない・「結果が分からない」：送ったかもしれないので、送り直さない
      const reason =
        b?.ok === true && b.result === "unknown" && typeof b.reason === "string"
          ? b.reason
          : "送った後に返事が途切れました。送り直さずに、freee から読み直して照らし合わせてください";
      next = withItem(next, key, { state: "unknown", reason }, nowIso);
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
export type CheckOutcome = { ok: true; answers: { key: string; kind: CheckKind; reason?: string }[]; setup: unknown; list: FreeeList };

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** サーバーの一覧の答えを読む（形のおかしい行は落とす） */
export function readList(b: unknown, nowIso: string): FreeeList | null {
  const x = b as { range?: { from?: unknown; to?: unknown }; rows?: unknown; capped?: unknown; bank?: unknown } | null;
  if (!x || !Array.isArray(x.rows) || typeof x.range?.from !== "string" || typeof x.range?.to !== "string") return null;
  const rows: ListedTxn[] = [];
  for (const r of x.rows as Record<string, unknown>[]) {
    if (!r || !isInt(r.id) || (r.account !== "card" && r.account !== "bank") || (r.side !== "income" && r.side !== "expense")) continue;
    if (!isRealDate(r.date) || !isInt(r.amount)) continue;
    rows.push({ id: r.id, account: r.account, side: r.side, date: r.date, amount: r.amount, description: typeof r.description === "string" ? r.description.slice(0, 200) : "" });
  }
  return { range: { from: x.range.from, to: x.range.to }, rows, capped: x.capped === true, bank: typeof x.bank === "string" ? x.bank.slice(0, 200) : null, at: nowIso };
}

/**
 * freee から読み直して照らし合わせる（書かない。排他の中から呼ぶ）。
 * keys：照らし合わせる明細（"t<id>"）。読み直しを始めた時刻より新しい記録（その間に登録した など）は上書きしない。
 */
export async function runCheck(deps: RunDeps, keys: string[]): Promise<CheckOutcome | Fail> {
  const startedAt = deps.now().getTime();
  const ids = keys.map((k) => Number(k.slice(1))).filter(isInt);
  let res;
  try {
    res = await deps.post("/api/freee/check", { ids });
  } catch {
    return { ok: false, reason: "サーバーにつながりませんでした" };
  }
  const b = res.body as { ok?: unknown; items?: unknown; setup?: unknown } | null;
  const list = res.status === 200 && b?.ok === true ? readList(b, deps.now().toISOString()) : null;
  if (!list || !Array.isArray(b?.items)) return { ok: false, reason: messageOf(b, "読み直せませんでした") };
  const answers = (b.items as { id?: unknown; kind?: unknown; reason?: unknown }[])
    .filter((a) => isInt(a.id) && ids.includes(a.id) && (a.kind === "ready" || a.kind === "done" || a.kind === "check" || a.kind === "missing"))
    .map((a) => ({ key: txnKey(a.id as number), kind: a.kind as CheckKind, reason: typeof a.reason === "string" ? a.reason : undefined }));
  deps.write(withChecked(fresh(deps), answers, deps.now().toISOString(), startedAt));
  return { ok: true, answers, setup: b.setup ?? null, list };
}

export type PressRegisterOutcome = RunOutcome & { skipped: { check: number; missing: number } };

/**
 * 「freee（テスト事業所）に登録」1回の押し：排他の中で、止まった「送っている」を直し → 読み直して照らし合わせ → 1件ずつ登録。
 * 「結果が分からない」の明細は読み直しに入れず、送らない（「freee から読み直す」を押した後でだけ送れる）。
 * この押しの読み直しで「確かめが要る」「明細が無い」になった明細も送らない（件数だけ返す）。
 * この押しの読み直しは照らし合わせだけで、画面の一覧は入れかえない（一覧を読むのは、開いた時と「freee から読み直す」だけ）。
 */
export async function pressRegister(deps: RunDeps, p: { uses: Record<string, CardUse>; targets: RegisterTarget[] }): Promise<PressRegisterOutcome | Fail> {
  return withFreeeLock(deps.locks, async () => {
    const first = recoverHeld(deps);
    const checkTargets = p.targets.filter((t) => {
      const s = stateOf(first, t.key);
      return s !== "unknown" && s !== "sending" && s !== "registered" && s !== "already";
    });
    const skipped = { check: 0, missing: 0 };
    let sendTargets = checkTargets;
    if (checkTargets.length) {
      deps.write({ ...fresh(deps), sendingAt: deps.now().toISOString() });
      const c = await runCheck(deps, checkTargets.map((t) => t.key));
      if (!c.ok) {
        deps.write({ ...fresh(deps), sendingAt: null });
        return c;
      }
      const stop = new Set<string>();
      for (const a of c.answers) {
        if (a.kind === "check") skipped.check++;
        if (a.kind === "missing") skipped.missing++;
        if (a.kind === "check" || a.kind === "missing" || a.kind === "done") stop.add(a.key);
      }
      sendTargets = checkTargets.filter((t) => !stop.has(t.key));
    }
    const out = await runRegister(deps, { uses: p.uses, targets: sendTargets });
    if (!out.ok) {
      deps.write({ ...fresh(deps), sendingAt: null });
      return out;
    }
    return { ...out, skipped };
  });
}

/**
 * 「freee から読み直す」（経理のタブを開いた時も）：排他の中で、止まった「送っている」を直してから、
 * freee から読み直して一覧を入れかえ、記録にある明細を照らし合わせる（書かない）。
 */
export async function pressCheck(deps: RunDeps, keys: string[]): Promise<CheckOutcome | Fail> {
  return withFreeeLock(deps.locks, async () => {
    recoverHeld(deps);
    deps.write({ ...fresh(deps), sendingAt: deps.now().toISOString() });
    try {
      const c = await runCheck(deps, keys);
      if (c.ok) deps.onList?.(c.list);
      return c;
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
  /** 銀行の口座が無いので銀行の分を入れなかった時の1行 */
  bank: string | null;
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
    const out: ImportOutcome = { ok: true, created: 0, existed: 0, check: 0, done: false, stopped: null, holdUntil: null, bank: null };
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
          bank?: unknown;
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
        if (typeof b.bank === "string" && b.bank) out.bank = b.bank.slice(0, 200);
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
