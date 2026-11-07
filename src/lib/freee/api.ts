// freee 会計の API を呼ぶ所（サーバーの側だけ）。形は公式の API の定義（github.com/freee/freee-api-schema の
// v2020_06_15/open-api-3/api-schema.json）で確かめた物だけを使う。テストでは fetch を置きかえる（本物の freee は呼ばない）。
//
// 返事の分け方：
// - つながらない・待ちきれない（送った後かもしれない） → FreeeNoAnswer（書く窓口では「結果が分からない」）
// - 401 → FreeeExpired（鍵が切れた。もう一度つなぐ）
// - 500 台 → 書く窓口では「結果が分からない」（freee の中で済んだかもしれない）
// - ほかの 400 台 → FreeeRejected（freee が受けなかった。書いていない）

import type { FreeeSettings } from "../settings";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class FreeeNoAnswer extends Error {}
export class FreeeExpired extends Error {}
export class FreeeRejected extends Error {
  constructor(
    public status: number,
    public messages: string[],
  ) {
    super(`freee が受けませんでした（${status}）`);
  }
}
export class FreeeServerError extends Error {
  constructor(public status: number) {
    super(`freee の返事が途切れました（${status}）`);
  }
}
/** 返事の形が定義と違う */
export class FreeeBadShape extends Error {}
/** サーバーの持ち時間が残っていないので、送らずに止めた（freee には何も送っていない） */
export class FreeeOutOfTime extends Error {}

export type WalletableType = "bank_account" | "credit_card" | "wallet";

export type Walletable = { id: number; name: string; type: WalletableType };

/** 口座明細（wallet_txn）。status：1 消込待ち・2 消込済み・3 無視・4 消込中・6 対象外 */
export type WalletTxn = {
  id: number;
  company_id: number;
  date: string;
  amount: number;
  due_amount: number;
  entry_side: "income" | "expense";
  walletable_type: WalletableType;
  walletable_id: number;
  description: string;
  status: number;
};

export type AccountItem = { id: number; name: string; available: boolean };
export type Tax = { code: number; name: string; name_ja: string; available: boolean };

export type TokenAnswer = { accessToken: string; expiresIn: number; companyId: number | null };

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const isStr = (x: unknown): x is string => typeof x === "string";

function messagesOf(body: unknown): string[] {
  const out: string[] = [];
  const errors = (body as { errors?: unknown })?.errors;
  if (Array.isArray(errors))
    for (const e of errors) {
      const m = (e as { messages?: unknown })?.messages;
      if (Array.isArray(m)) for (const x of m) if (isStr(x)) out.push(x.slice(0, 200));
    }
  return out.slice(0, 5);
}

/**
 * deadline：この時刻（ms）までに返事を待ち終えられない呼び出しは、送らずに FreeeOutOfTime で止める
 * （1件ずつの待つ時間 timeoutSeconds を足して、持ち時間を超えるなら送らない）。
 */
export function freeeClient(p: { fetch: FetchLike; settings: FreeeSettings; accessToken: string; now?: () => number; deadline?: number | null }) {
  const { settings, accessToken } = p;
  const now = p.now ?? (() => Date.now());
  const call = async (method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<unknown> => {
    if (p.deadline != null && now() + settings.timeoutSeconds * 1000 > p.deadline) throw new FreeeOutOfTime("持ち時間が残っていないので送りませんでした");
    const url = new URL(path, settings.apiBase);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await p.fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
      });
    } catch {
      throw new FreeeNoAnswer("freee から返事がありません");
    }
    let body: unknown = null;
    let parsed = true;
    try {
      body = await res.json();
    } catch {
      parsed = false;
    }
    if (res.status === 401) throw new FreeeExpired("鍵が切れました");
    if (res.status >= 500) throw new FreeeServerError(res.status);
    if (res.status >= 400) throw new FreeeRejected(res.status, messagesOf(body));
    if (!parsed) throw new FreeeNoAnswer("freee の返事を読めませんでした");
    return body;
  };

  return {
    /** 口座一覧（GET /api/1/walletables） */
    async walletables(companyId: number): Promise<Walletable[]> {
      const b = (await call("GET", "/api/1/walletables", { query: { company_id: companyId } })) as { walletables?: unknown };
      if (!Array.isArray(b?.walletables)) throw new FreeeBadShape("口座一覧の形が違います");
      return b.walletables
        .filter((w): w is Walletable => isInt(w?.id) && isStr(w?.name) && (w.type === "bank_account" || w.type === "credit_card" || w.type === "wallet"))
        .map((w) => ({ id: w.id, name: w.name, type: w.type }));
    },

    /**
     * 口座明細を全部（GET /api/1/wallet_txns。limit は100まで・offset でめくる）。
     * range：取引日で絞る（start_date／end_date）。同じ番号（id）で中身も同じ物は1つにする（ページの重なり）。
     * 同じ番号で中身が違う物（読んでいる間に freee の側で変わった など）は両方残す（照らし合わせで「候補2件」として止める）。
     * 1ページが limit より少なければ終わり。maxPages をこえたら止める（読み切れない時は進まない）。
     * stopAfterOpen：まだ処理していない明細（未処理で登録待ちの金額が0より大きい）がこの件数をこえたら、そこで読むのをやめる（一覧の上限）。
     * （読んでいる間に freee の側で明細が足された・消された時の読み落としまでは防げない）
     */
    async walletTxns(
      companyId: number,
      walletable: { type: WalletableType; id: number },
      range?: { from: string; to: string },
      opts: { stopAfterOpen?: number } = {},
    ): Promise<WalletTxn[]> {
      const out = new Map<number, WalletTxn>();
      const extra: WalletTxn[] = [];
      const same = (a: WalletTxn, b: WalletTxn) => JSON.stringify(a) === JSON.stringify(b);
      const all = () => [...out.values(), ...extra];
      for (let page = 0; page < settings.maxPages; page++) {
        const b = (await call("GET", "/api/1/wallet_txns", {
          query: {
            company_id: companyId,
            walletable_type: walletable.type,
            walletable_id: walletable.id,
            ...(range ? { start_date: range.from, end_date: range.to } : {}),
            limit: settings.pageLimit,
            offset: page * settings.pageLimit,
          },
        })) as { wallet_txns?: unknown };
        if (!Array.isArray(b?.wallet_txns)) throw new FreeeBadShape("口座明細の形が違います");
        for (const t of b.wallet_txns) {
          const x = toTxn(t);
          if (!x) throw new FreeeBadShape("口座明細の形が違います");
          const had = out.get(x.id);
          if (!had) out.set(x.id, x);
          else if (!same(had, x) && !extra.some((e) => same(e, x))) extra.push(x);
        }
        if (b.wallet_txns.length < settings.pageLimit) return all();
        if (opts.stopAfterOpen != null && all().filter(isOpen).length > opts.stopAfterOpen) return all();
      }
      throw new FreeeBadShape(`口座明細が${settings.maxPages}ページより多く、読み切れません`);
    },

    /** 口座明細を1件入れる（POST /api/1/wallet_txns。返事は 201 の wallet_txn） */
    async createWalletTxn(params: {
      company_id: number;
      walletable_type: WalletableType;
      walletable_id: number;
      entry_side: "income" | "expense";
      amount: number;
      date: string;
      description: string;
    }): Promise<WalletTxn> {
      const b = (await call("POST", "/api/1/wallet_txns", { body: params })) as { wallet_txn?: unknown };
      const x = toTxn(b?.wallet_txn);
      if (!x) throw new FreeeNoAnswer("明細を入れた返事の形が違います");
      return x;
    },

    /** 勘定科目一覧（GET /api/1/account_items） */
    async accountItems(companyId: number): Promise<AccountItem[]> {
      const b = (await call("GET", "/api/1/account_items", { query: { company_id: companyId } })) as { account_items?: unknown };
      if (!Array.isArray(b?.account_items)) throw new FreeeBadShape("勘定科目の形が違います");
      return b.account_items
        .filter((a): a is AccountItem => isInt(a?.id) && isStr(a?.name))
        .map((a) => ({ id: a.id, name: a.name, available: a.available === true }));
    },

    /** 事業所の税区分一覧（GET /api/1/taxes/companies/{company_id}） */
    async taxes(companyId: number): Promise<Tax[]> {
      const b = (await call("GET", `/api/1/taxes/companies/${companyId}`)) as { taxes?: unknown };
      if (!Array.isArray(b?.taxes)) throw new FreeeBadShape("税区分の形が違います");
      return b.taxes
        .filter((t): t is Tax => isInt(t?.code) && isStr(t?.name_ja))
        .map((t) => ({ code: t.code, name: isStr(t.name) ? t.name : "", name_ja: t.name_ja, available: t.available === true }));
    },

    /**
     * 店用：明細から取引を登録する（POST /api/1/wallet_txns/{id}/create_deal）。
     * 返事は deal_ids（配列）。形が違えば「結果が分からない」。
     */
    async createDeal(txnId: number, body: { company_id: number; deal_lines: { amount: number; account_item_id: number; tax_code: number }[] }): Promise<number[]> {
      const b = (await call("POST", `/api/1/wallet_txns/${txnId}/create_deal`, { body })) as { deal_ids?: unknown };
      if (!Array.isArray(b?.deal_ids) || !b.deal_ids.every(isInt)) throw new FreeeNoAnswer("取引を登録した返事の形が違います");
      return b.deal_ids;
    },

    /**
     * 私用：明細をプライベート取引として登録する（POST /api/1/wallet_txns/{id}/create_private_deal）。
     * 返事は deal_id（1つ）。形が違えば「結果が分からない」。
     */
    async createPrivateDeal(txnId: number, companyId: number): Promise<number> {
      const b = (await call("POST", `/api/1/wallet_txns/${txnId}/create_private_deal`, { body: { company_id: companyId } })) as { deal_id?: unknown };
      if (!isInt(b?.deal_id)) throw new FreeeNoAnswer("プライベート取引を登録した返事の形が違います");
      return b.deal_id;
    },
  };
}

export type FreeeClient = ReturnType<typeof freeeClient>;

/** まだ処理していない明細か（未処理 status 1 で、登録待ちの金額が0より大きい） */
export function isOpen(t: WalletTxn): boolean {
  return t.status === 1 && t.due_amount > 0;
}

function toTxn(t: unknown): WalletTxn | null {
  const x = t as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return null;
  if (!isInt(x.id) || !isInt(x.company_id) || !isStr(x.date) || !isInt(x.amount) || !isInt(x.due_amount) || !isInt(x.walletable_id) || !isInt(x.status)) return null;
  if (x.entry_side !== "income" && x.entry_side !== "expense") return null;
  if (x.walletable_type !== "bank_account" && x.walletable_type !== "credit_card" && x.walletable_type !== "wallet") return null;
  return {
    id: x.id,
    company_id: x.company_id,
    date: x.date,
    amount: x.amount,
    due_amount: x.due_amount,
    entry_side: x.entry_side,
    walletable_type: x.walletable_type,
    walletable_id: x.walletable_id,
    description: isStr(x.description) ? x.description : "",
    status: x.status,
  };
}

/**
 * 許可のコードを鍵に換える（POST {tokenUrl}。form の形で grant_type=authorization_code）。
 * 送る物の形は freee 公式の freee-mcp（github.com/freee/freee-mcp の src/auth/oauth.ts）と同じ。
 * 返事の company_id は、許可で選んだ事業所の番号。無ければ null（その時は鍵を捨てて止める）。
 * refresh_token は読まない（持たない・自動の更新はしない）。
 */
export async function exchangeCode(p: {
  fetch: FetchLike;
  settings: FreeeSettings;
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenAnswer> {
  let res: Response;
  try {
    res = await p.fetch(p.settings.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: p.clientId,
        client_secret: p.clientSecret,
        code: p.code,
        redirect_uri: p.redirectUri,
        code_verifier: p.codeVerifier,
      }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(p.settings.timeoutSeconds * 1000),
    });
  } catch {
    throw new FreeeNoAnswer("freee から返事がありません");
  }
  if (!res.ok) throw new FreeeRejected(res.status, []);
  let b: Record<string, unknown>;
  try {
    b = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new FreeeBadShape("鍵の返事を読めませんでした");
  }
  if (!isStr(b?.access_token) || !b.access_token || !isInt(b.expires_in) || b.expires_in <= 0) throw new FreeeBadShape("鍵の返事の形が違います");
  const cid = b.company_id;
  const companyId = isInt(cid) && cid > 0 ? cid : isStr(cid) && /^[1-9]\d{0,18}$/.test(cid) ? Number(cid) : null;
  return { accessToken: b.access_token, expiresIn: b.expires_in, companyId };
}
