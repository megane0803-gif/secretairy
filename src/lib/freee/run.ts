// 「freee（テスト事業所）に登録」の流れ（ブラウザの側）。1件ずつ順に送る。AI は使わない。
// 画面とテストが同じ物を使う（テストでは post を置きかえる。本物の freee もサーバーも呼ばない）。
//
// - 送り始めたら、明細と店用／私用の選びを固定する（state.ts の uses）
// - 送っている間は印（sendingAt）を付けなおす。ほかの画面で送っている時は始めない
// - 「結果が分からない」は送り直さない（読み直す＝runCheck の後でだけ、もう一度送れる）
// - つなぎが切れた・結果が分からない時は、そこで止める（残りは「まだ」のまま。会計（架空）には切り替えない）

import type { CardUse } from "../data/types";
import {
  isSending,
  toSend,
  withChecked,
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

export type RunDeps = {
  read: () => FreeeRecord;
  write: (r: FreeeRecord) => void;
  post: Post;
  now: () => Date;
  staleSeconds: number;
};

export type RunOutcome = { ok: true; run: FreeeRun; stoppedBy: string | null } | { ok: false; reason: string };

const messageOf = (b: unknown, fallback: string) => {
  const m = (b as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m.slice(0, 300) : fallback;
};

function fresh(deps: RunDeps): FreeeRecord {
  const now = deps.now();
  return withStaleRecovered(deps.read(), now.getTime(), deps.staleSeconds, now.toISOString());
}

/**
 * 選び終わった明細を、1件ずつ順に freee に登録する。
 * uses：いまの店用／私用（もう固定してあれば、固定した方を使う）。nos：明細の番号（明細の順）。
 */
export async function runRegister(deps: RunDeps, p: { uses: Record<string, CardUse>; nos: number[] }): Promise<RunOutcome> {
  let r = fresh(deps);
  if (isSending(r, deps.now().getTime(), deps.staleSeconds)) return { ok: false, reason: "ほかの画面で送っています。終わるまで待ってください" };
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

/** freee から読み直して照らし合わせる（書かない）。送っている間はしない */
export async function runCheck(deps: RunDeps, nos: number[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = fresh(deps);
  if (isSending(r, deps.now().getTime(), deps.staleSeconds)) return { ok: false, reason: "送っている間は読み直しません" };
  if (r !== deps.read()) deps.write(r);
  let res;
  try {
    res = await deps.post("/api/freee/check", { nos });
  } catch {
    return { ok: false, reason: "サーバーにつながりませんでした" };
  }
  const b = res.body as { ok?: unknown; items?: unknown } | null;
  if (res.status !== 200 || b?.ok !== true || !Array.isArray(b.items)) return { ok: false, reason: messageOf(b, "読み直せませんでした") };
  const answers = (b.items as { no?: unknown; kind?: unknown; reason?: unknown }[])
    .filter((a) => typeof a.no === "number" && nos.includes(a.no) && (a.kind === "ready" || a.kind === "done" || a.kind === "check" || a.kind === "missing"))
    .map((a) => ({ no: a.no as number, kind: a.kind as "ready" | "done" | "check" | "missing", reason: typeof a.reason === "string" ? a.reason : undefined }));
  deps.write(withChecked(fresh(deps), answers, deps.now().toISOString()));
  return { ok: true };
}
