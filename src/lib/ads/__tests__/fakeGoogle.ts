// テスト用の作り物の Google 広告（REST）と通行証の窓口。本物の Google は呼ばない。
// 公式の資料の形でない送り方を断る（自分で作った形にだけ合う作り物にしない）：
//   - 見出し：Authorization: Bearer <この作り物が出した通行証>・login-customer-id（管理アカウントの番号）。developer-token は付けると断る
//   - 通行証：grant_type=jwt-bearer の JWT を、作り物の鍵の公開鍵で確かめる（範囲・行き先・期限も）
//   - 検索：GAQL は「SELECT 欄 FROM 種類 WHERE 欄 演算子 値 AND …」。知らない欄・知らない種類は断る。文字は ' で囲み \ と ' を逃がす
//   - 変える：mutateOperations の各行は1つの操作だけ。update は updateMask が "status" だけ（中身も resourceName と status だけ）。
//     仮の番号（負の数）は種類をまたいでも同じ数を使えない（DUPLICATE_TEMP_IDS）。キャンペーンは status・入札・EU の政治広告の欄を必ず書く
//     （作り物は、書かない送り方を断る）。言葉は80文字・10語まで。validateOnly は何も変えない。partialFailure の時は行ごとに受ける
//   - JSON では false の値は省く（customer.testAccount など）

import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

type Status = "ENABLED" | "PAUSED" | "REMOVED";
type Match = "EXACT" | "PHRASE" | "BROAD";

export type FakeCustomer = { id: string; testAccount: boolean; manager: boolean };
export type FakeBudget = { id: number; name: string; status: Status };
export type FakeCampaign = { id: number; name: string; status: Status; budget: string; channel: string };
export type FakeGroup = { id: number; campaignId: number; name: string; status: Status };
export type FakeCriterion = { groupId: number; id: number; text: string; match: Match; status: Status };
export type FakeNegative = { campaignId: number; id: number; text: string; match: Match; status: Status };

export type FakeHooks = {
  /** 送った後、変えてから返事を落とす（通信が切れた形） */
  dropAfterMutate?: boolean;
  /** 送る前（何も変えずに）通信が切れた形 */
  dropBeforeMutate?: boolean;
  /** 止めるの update を受けたと言うが、変えない */
  ignoreStatusUpdate?: boolean;
  /** この言葉の操作は受けない（validateOnly でも本当でも） */
  rejectText?: string;
  /** この言葉の操作は validateOnly では通るが、本当に送ると受けない */
  rejectTextOnSend?: string;
  /** どの呼び出しにも CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION を返す */
  notApproved?: boolean;
  /** 読む（search）時に通信が切れる（n 回目から） */
  dropSearchFrom?: number;
};

export type FakeGoogle = {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  customers: FakeCustomer[];
  budgets: FakeBudget[];
  campaigns: FakeCampaign[];
  groups: FakeGroup[];
  criteria: FakeCriterion[];
  negatives: FakeNegative[];
  hooks: FakeHooks;
  /** 届いた呼び出し（URL・見出し・中身。テストで見る） */
  calls: { url: string; headers: Record<string, string>; body: string }[];
  tokenCalls: number;
  mutateCalls: { validateOnly: boolean; partialFailure: boolean; ops: Record<string, unknown>[] }[];
  searchCount: number;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = /^https:\/\/googleads\.googleapis\.com\/v26\/customers\/(\d{10})\/googleAds:(search|mutate)$/;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const googleError = (status: number, statusText: string, errorCode: Record<string, string>) =>
  reply(
    {
      error: {
        code: status,
        // 本物の返事のように、文の中に番号やメールが混ざる（窓口がそのまま出さないことを確かめる）
        message: "Request contains an invalid argument. customer 9000000002 robot" + "@fake.invalid",
        status: statusText,
        details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode, message: "secret detail 9000000001" }], requestId: "fake-request" }],
      },
    },
    status,
  );

const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function fakeGoogle(p: { publicKeyPem: string; email: string; managerId: string; customerId: string; now: () => number }): FakeGoogle {
  const pub: KeyObject = createPublicKey(p.publicKeyPem);
  const tokens = new Map<string, number>();
  let seq = 1000;
  const g: FakeGoogle = {
    customers: [
      { id: p.managerId, testAccount: true, manager: true },
      { id: p.customerId, testAccount: true, manager: false },
    ],
    budgets: [],
    campaigns: [],
    groups: [],
    criteria: [],
    negatives: [],
    hooks: {},
    calls: [],
    tokenCalls: 0,
    mutateCalls: [],
    searchCount: 0,
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const body = typeof init.body === "string" ? init.body : "";
      g.calls.push({ url: input, headers, body });
      if (input === TOKEN_URL) return tokenEndpoint(body);
      const m = input.match(API);
      if (!m || init.method !== "POST") return reply({ error: { code: 404, status: "NOT_FOUND" } }, 404);
      if (g.hooks.notApproved) return googleError(403, "PERMISSION_DENIED", { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" });
      if ("developer-token" in headers) return googleError(400, "INVALID_ARGUMENT", { headerError: "INVALID_DEVELOPER_TOKEN" });
      const auth = headers.authorization ?? "";
      const t = auth.startsWith("Bearer ") ? tokens.get(auth.slice(7)) : undefined;
      if (t === undefined || t <= p.now()) return googleError(401, "UNAUTHENTICATED", { authenticationError: "OAUTH_TOKEN_INVALID" });
      if (headers["login-customer-id"] !== p.managerId) return googleError(403, "PERMISSION_DENIED", { authorizationError: "USER_PERMISSION_DENIED" });
      const cid = m[1];
      if (!g.customers.some((c) => c.id === cid)) return googleError(403, "PERMISSION_DENIED", { authorizationError: "USER_PERMISSION_DENIED" });
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(body);
      } catch {
        return googleError(400, "INVALID_ARGUMENT", { requestError: "INVALID_INPUT" });
      }
      return m[2] === "search" ? searchEndpoint(cid, j) : mutateEndpoint(cid, j);
    },
  };

  function tokenEndpoint(body: string): Response {
    g.tokenCalls += 1;
    const q = new URLSearchParams(body);
    if (q.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return reply({ error: "unsupported_grant_type" }, 400);
    const parts = (q.get("assertion") ?? "").split(".");
    if (parts.length !== 3) return reply({ error: "invalid_grant" }, 400);
    const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).end().verify(pub, b64urlDecode(parts[2]));
    if (!ok) return reply({ error: "invalid_grant" }, 400);
    const h = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    const c = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
    const nowS = Math.floor(p.now() / 1000);
    if (h.alg !== "RS256" || c.iss !== p.email || c.aud !== TOKEN_URL || c.scope !== "https://www.googleapis.com/auth/adwords") return reply({ error: "invalid_grant" }, 400);
    if (!(c.iat <= nowS + 60 && c.exp > nowS && c.exp - c.iat <= 3600)) return reply({ error: "invalid_grant" }, 400);
    const token = `fake-access-${g.tokenCalls}`;
    tokens.set(token, p.now() + 3600_000);
    return reply({ access_token: token, expires_in: 3599, token_type: "Bearer" });
  }

  // ---- 検索 ----

  type Flat = Record<string, string | number | boolean>;
  const rn = (cid: string, kind: string, id: string | number) => `customers/${cid}/${kind}/${id}`;

  function rowsOf(cid: string, from: string): Flat[] | null {
    switch (from) {
      case "customer": {
        const c = g.customers.find((x) => x.id === cid)!;
        return [{ "customer.resource_name": rn(cid, "customers", cid).replace(`/customers/${cid}`, ""), "customer.id": c.id, "customer.test_account": c.testAccount, "customer.manager": c.manager }];
      }
      case "campaign":
        return g.campaigns.map((c) => ({ "campaign.resource_name": rn(cid, "campaigns", c.id), "campaign.id": c.id, "campaign.name": c.name, "campaign.status": c.status }));
      case "campaign_budget":
        return g.budgets.map((b) => ({ "campaign_budget.resource_name": rn(cid, "campaignBudgets", b.id), "campaign_budget.name": b.name, "campaign_budget.status": b.status }));
      case "ad_group":
        return g.groups.map((a) => ({
          "ad_group.resource_name": rn(cid, "adGroups", a.id),
          "ad_group.name": a.name,
          "ad_group.status": a.status,
          "ad_group.campaign": rn(cid, "campaigns", a.campaignId),
          "campaign.id": a.campaignId,
        }));
      case "ad_group_criterion":
        return g.criteria.map((k) => {
          const a = g.groups.find((x) => x.id === k.groupId)!;
          return {
            "ad_group_criterion.resource_name": rn(cid, "adGroupCriteria", `${k.groupId}~${k.id}`),
            "ad_group_criterion.status": k.status,
            "ad_group_criterion.type": "KEYWORD",
            "ad_group_criterion.negative": false,
            "ad_group_criterion.keyword.text": k.text,
            "ad_group_criterion.keyword.match_type": k.match,
            "ad_group.resource_name": rn(cid, "adGroups", a.id),
            "ad_group.name": a.name,
            "ad_group.status": a.status,
            "ad_group.campaign": rn(cid, "campaigns", a.campaignId),
          };
        });
      case "campaign_criterion":
        return g.negatives.map((n) => ({
          "campaign_criterion.resource_name": rn(cid, "campaignCriteria", `${n.campaignId}~${n.id}`),
          "campaign_criterion.campaign": rn(cid, "campaigns", n.campaignId),
          "campaign_criterion.type": "KEYWORD",
          "campaign_criterion.negative": true,
          "campaign_criterion.status": n.status,
          "campaign_criterion.keyword.text": n.text,
          "campaign_criterion.keyword.match_type": n.match,
        }));
      default:
        return null;
    }
  }

  /** GAQL の値：'…'（中の \ と ' は \ で逃がした物）・TRUE/FALSE・数・列挙 */
  function readValue(s: string, at: number): { v: string | number | boolean; next: number } | null {
    if (s[at] === "'") {
      let out = "";
      for (let i = at + 1; i < s.length; i++) {
        if (s[i] === "\\") {
          const n = s[i + 1];
          if (n !== "\\" && n !== "'") return null;
          out += n;
          i++;
        } else if (s[i] === "'") return { v: out, next: i + 1 };
        else out += s[i];
      }
      return null;
    }
    const m = s.slice(at).match(/^([A-Z_]+|\d+)/);
    if (!m) return null;
    const w = m[1];
    return { v: w === "TRUE" ? true : w === "FALSE" ? false : /^\d+$/.test(w) ? Number(w) : w, next: at + w.length };
  }

  function parseQuery(q: string): { fields: string[]; from: string; conds: { f: string; op: string; v: string | number | boolean }[]; limit?: number } | null {
    const m = q.match(/^SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.+?))?(?: LIMIT (\d+))?$/);
    if (!m) return null;
    const fields = m[1].split(", ");
    const conds: { f: string; op: string; v: string | number | boolean }[] = [];
    if (m[3]) {
      let s = m[3];
      let at = 0;
      while (true) {
        const fm = s.slice(at).match(/^([a-z_.]+) (=|!=) /);
        if (!fm) return null;
        at += fm[0].length;
        const v = readValue(s, at);
        if (!v) return null;
        conds.push({ f: fm[1], op: fm[2], v: v.v });
        at = v.next;
        if (at === s.length) break;
        if (s.slice(at, at + 5) !== " AND ") return null;
        at += 5;
      }
      s = "";
    }
    return { fields, from: m[2], conds, ...(m[4] ? { limit: Number(m[4]) } : {}) };
  }

  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

  function searchEndpoint(cid: string, j: Record<string, unknown>): Response {
    g.searchCount += 1;
    if (g.hooks.dropSearchFrom !== undefined && g.searchCount >= g.hooks.dropSearchFrom) throw new TypeError("fetch failed");
    const keys = Object.keys(j);
    if (typeof j.query !== "string" || keys.some((k) => k !== "query" && k !== "pageToken")) return googleError(400, "INVALID_ARGUMENT", { requestError: "UNKNOWN" });
    const q = parseQuery(j.query);
    if (!q) return googleError(400, "INVALID_ARGUMENT", { queryError: "UNEXPECTED_INPUT" });
    const rows = rowsOf(cid, q.from);
    if (!rows) return googleError(400, "INVALID_ARGUMENT", { queryError: "INVALID_RESOURCE_NAME" });
    const known = new Set(Object.keys(rows[0] ?? rowsOf(cid, q.from)![0] ?? {}));
    const all = (rows.length ? rows : []).length ? rows : [];
    // 知らない欄は断る（行が無い時も、種類ごとの欄の名前で確かめる）
    const sample = sampleFields(q.from);
    for (const f of [...q.fields, ...q.conds.map((c) => c.f)]) if (!sample.has(f) && !known.has(f)) return googleError(400, "INVALID_ARGUMENT", { queryError: "UNRECOGNIZED_FIELD" });
    let out = all.filter((r) => q.conds.every((c) => (c.op === "=" ? r[c.f] === c.v : r[c.f] !== c.v)));
    if (q.limit) out = out.slice(0, q.limit);
    const results = out.map((r) => {
      const o: Record<string, unknown> = {};
      for (const f of q.fields) {
        const v = r[f];
        if (v === false) continue; // JSON では false を省く
        const path = f.split(".").map(camel);
        let cur = o;
        for (let i = 0; i < path.length - 1; i++) cur = (cur[path[i]] ??= {}) as Record<string, unknown>;
        cur[path[path.length - 1]] = typeof v === "number" && f.endsWith(".id") ? String(v) : v;
      }
      return o;
    });
    // 本物と同じく、合う行が無い時は results を省く
    return reply({ ...(results.length ? { results } : {}), fieldMask: q.fields.map(camel).join(","), requestId: "fake" });
  }

  function sampleFields(from: string): Set<string> {
    const base: Record<string, string[]> = {
      customer: ["customer.resource_name", "customer.id", "customer.test_account", "customer.manager"],
      campaign: ["campaign.resource_name", "campaign.id", "campaign.name", "campaign.status"],
      campaign_budget: ["campaign_budget.resource_name", "campaign_budget.name", "campaign_budget.status"],
      ad_group: ["ad_group.resource_name", "ad_group.name", "ad_group.status", "ad_group.campaign", "campaign.id"],
      ad_group_criterion: [
        "ad_group_criterion.resource_name",
        "ad_group_criterion.status",
        "ad_group_criterion.type",
        "ad_group_criterion.negative",
        "ad_group_criterion.keyword.text",
        "ad_group_criterion.keyword.match_type",
        "ad_group.resource_name",
        "ad_group.name",
        "ad_group.status",
        "ad_group.campaign",
      ],
      campaign_criterion: [
        "campaign_criterion.resource_name",
        "campaign_criterion.campaign",
        "campaign_criterion.type",
        "campaign_criterion.negative",
        "campaign_criterion.status",
        "campaign_criterion.keyword.text",
        "campaign_criterion.keyword.match_type",
      ],
    };
    return new Set(base[from] ?? []);
  }

  // ---- 変える ----

  type OpError = { index: number; code: Record<string, string> };

  function mutateEndpoint(cid: string, j: Record<string, unknown>): Response {
    const keys = Object.keys(j);
    if (!Array.isArray(j.mutateOperations) || keys.some((k) => !["mutateOperations", "partialFailure", "validateOnly", "responseContentType"].includes(k)))
      return googleError(400, "INVALID_ARGUMENT", { requestError: "UNKNOWN" });
    const ops = j.mutateOperations as Record<string, unknown>[];
    const validateOnly = j.validateOnly === true;
    const partialFailure = j.partialFailure === true;
    g.mutateCalls.push({ validateOnly, partialFailure, ops });
    if (!validateOnly && g.hooks.dropBeforeMutate) throw new TypeError("fetch failed");
    const cust = g.customers.find((c) => c.id === cid)!;
    if (cust.manager) return googleError(400, "INVALID_ARGUMENT", { requestError: "CANNOT_MUTATE_MANAGER" });
    // 仮の番号：種類をまたいでも同じ数は使えない
    const temps: string[] = [];
    for (const op of ops) {
      const inner = Object.values(op)[0] as Record<string, unknown> | undefined;
      const rnv = inner && typeof inner === "object" ? (inner.create as Record<string, unknown> | undefined)?.resourceName : undefined;
      const tm = typeof rnv === "string" ? rnv.match(/\/(-\d+)$/) : null;
      if (tm) temps.push(tm[1]);
    }
    if (new Set(temps).size !== temps.length) return googleError(400, "INVALID_ARGUMENT", { newResourceCreationError: "DUPLICATE_TEMP_IDS" });

    // 写しの上で順に行い、全部できたら（または partialFailure なら行ごとに）本物に写す
    const snap = JSON.parse(JSON.stringify({ budgets: g.budgets, campaigns: g.campaigns, groups: g.groups, criteria: g.criteria, negatives: g.negatives }));
    const work = { ...snap } as typeof snap;
    const tempMap = new Map<string, string>();
    const errors: OpError[] = [];
    const responses: Record<string, unknown>[] = [];
    ops.forEach((op, index) => {
      const r = applyOne(cid, op, work, tempMap, !validateOnly);
      if ("error" in r) {
        errors.push({ index, code: r.error });
        responses.push({});
      } else responses.push(r.response);
    });
    if (errors.length && !partialFailure)
      return googleError(400, "INVALID_ARGUMENT", errors[0].code);
    if (!validateOnly) {
      g.budgets = work.budgets;
      g.campaigns = work.campaigns;
      g.groups = work.groups;
      g.criteria = work.criteria;
      g.negatives = work.negatives;
      if (g.hooks.dropAfterMutate) throw new TypeError("fetch failed");
    }
    const body: Record<string, unknown> = { mutateOperationResponses: validateOnly ? [] : responses };
    if (errors.length)
      body.partialFailureError = {
        code: 3,
        message: "Multiple errors in 'details'. customer 9000000002",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
            errors: errors.map((e) => ({ errorCode: e.code, message: "detail", location: { fieldPathElements: [{ fieldName: "mutate_operations", index: e.index }] } })),
          },
        ],
      };
    return reply(body);
  }

  type Work = { budgets: FakeBudget[]; campaigns: FakeCampaign[]; groups: FakeGroup[]; criteria: FakeCriterion[]; negatives: FakeNegative[] };

  function ref(cid: string, v: unknown, kind: string, tempMap: Map<string, string>): number | null {
    if (typeof v !== "string") return null;
    const real = tempMap.get(v) ?? v;
    const m = real.match(new RegExp(`^customers/${cid}/${kind}/(\\d+)$`));
    return m ? Number(m[1]) : null;
  }

  const ENUM_STATUS = ["ENABLED", "PAUSED"];
  const keywordBad = (k: unknown, matches: string[]): Record<string, string> | null => {
    if (!k || typeof k !== "object") return { fieldError: "REQUIRED" };
    const { text, matchType, ...rest } = k as Record<string, unknown>;
    if (Object.keys(rest).length) return { fieldError: "UNKNOWN" };
    if (typeof text !== "string" || !text.trim()) return { fieldError: "REQUIRED" };
    if ([...text].length > 80) return { stringLengthError: "TOO_LONG" };
    if (text.trim().split(/\s+/).length > 10) return { criterionError: "KEYWORD_HAS_TOO_MANY_WORDS" };
    if (!matches.includes(String(matchType))) return { fieldError: "INVALID_VALUE" };
    return null;
  };

  function applyOne(cid: string, op: Record<string, unknown>, w: Work, tempMap: Map<string, string>, real: boolean): { response: Record<string, unknown> } | { error: Record<string, string> } {
    const kinds = Object.keys(op);
    if (kinds.length !== 1) return { error: { mutateError: "INVALID_OPERATION" } };
    const kind = kinds[0];
    const o = op[kind] as Record<string, unknown>;
    if (!o || typeof o !== "object") return { error: { mutateError: "INVALID_OPERATION" } };
    const action = Object.keys(o).filter((k) => k !== "updateMask");
    if (action.length !== 1 || !["create", "update", "remove"].includes(action[0])) return { error: { mutateError: "INVALID_OPERATION" } };
    const c = o[action[0]] as Record<string, unknown>;
    const text = (x: unknown) => (x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "") : "");
    const kwText = text(c?.keyword);
    if (g.hooks.rejectText && kwText === g.hooks.rejectText) return { error: { policyViolationError: "POLICY_ERROR" } };
    if (real && g.hooks.rejectTextOnSend && kwText === g.hooks.rejectTextOnSend) return { error: { policyViolationError: "POLICY_ERROR" } };
    const newId = () => ++seq;
    const temp = (rnv: unknown, k: string): string | null | "bad" => {
      if (rnv === undefined) return null;
      if (typeof rnv !== "string") return "bad";
      const m = rnv.match(new RegExp(`^customers/${cid}/${k}/(-\\d+)$`));
      return m ? rnv : "bad";
    };
    const done = (key: string, r: string) => ({ response: { [key]: { resourceName: r } } });

    if (kind === "campaignBudgetOperation" && action[0] === "create") {
      const t = temp(c.resourceName, "campaignBudgets");
      if (t === "bad") return { error: { resourceNameError: "MALFORMED" } };
      if (typeof c.name !== "string" || typeof c.amountMicros !== "string" || !/^\d+$/.test(c.amountMicros) || c.deliveryMethod !== "STANDARD" || c.explicitlyShared !== false)
        return { error: { fieldError: "REQUIRED" } };
      if (w.budgets.some((b) => b.name === c.name && b.status !== "REMOVED")) return { error: { campaignBudgetError: "DUPLICATE_NAME" } };
      const id = newId();
      w.budgets.push({ id, name: c.name, status: "ENABLED" });
      const r = `customers/${cid}/campaignBudgets/${id}`;
      if (t) tempMap.set(t, r);
      return done("campaignBudgetResult", r);
    }
    if (kind === "campaignOperation" && action[0] === "create") {
      const t = temp(c.resourceName, "campaigns");
      if (t === "bad") return { error: { resourceNameError: "MALFORMED" } };
      const ns = c.networkSettings as Record<string, unknown> | undefined;
      // 作り物は、status・入札・EU の政治広告の欄・ネットワークの欄を書かない送り方を断る
      if (typeof c.name !== "string" || c.advertisingChannelType !== "SEARCH" || !ENUM_STATUS.includes(String(c.status))) return { error: { fieldError: "REQUIRED" } };
      if (!c.manualCpc || typeof c.manualCpc !== "object") return { error: { biddingError: "BIDDING_STRATEGY_REQUIRED" } };
      if (c.containsEuPoliticalAdvertising !== "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING") return { error: { fieldError: "REQUIRED" } };
      if (!ns || ns.targetGoogleSearch !== true || ns.targetSearchNetwork !== false || ns.targetContentNetwork !== false) return { error: { fieldError: "REQUIRED" } };
      const b = ref(cid, c.campaignBudget, "campaignBudgets", tempMap);
      if (b === null || !w.budgets.some((x) => x.id === b)) return { error: { resourceNameError: "MALFORMED" } };
      if (w.campaigns.some((x) => x.name === c.name && x.status !== "REMOVED")) return { error: { campaignError: "DUPLICATE_CAMPAIGN_NAME" } };
      const id = newId();
      w.campaigns.push({ id, name: c.name, status: c.status as Status, budget: String(b), channel: "SEARCH" });
      const r = `customers/${cid}/campaigns/${id}`;
      if (t) tempMap.set(t, r);
      return done("campaignResult", r);
    }
    if (kind === "adGroupOperation" && action[0] === "create") {
      const t = temp(c.resourceName, "adGroups");
      if (t === "bad") return { error: { resourceNameError: "MALFORMED" } };
      if (typeof c.name !== "string" || c.type !== "SEARCH_STANDARD" || !ENUM_STATUS.includes(String(c.status))) return { error: { fieldError: "REQUIRED" } };
      const cp = ref(cid, c.campaign, "campaigns", tempMap);
      if (cp === null || !w.campaigns.some((x) => x.id === cp)) return { error: { resourceNameError: "MALFORMED" } };
      if (w.groups.some((x) => x.campaignId === cp && x.name === c.name && x.status !== "REMOVED")) return { error: { adGroupError: "DUPLICATE_ADGROUP_NAME" } };
      const id = newId();
      w.groups.push({ id, campaignId: cp, name: c.name, status: c.status as Status });
      const r = `customers/${cid}/adGroups/${id}`;
      if (t) tempMap.set(t, r);
      return done("adGroupResult", r);
    }
    if (kind === "adGroupCriterionOperation" && action[0] === "create") {
      if (c.resourceName !== undefined) return { error: { resourceNameError: "MALFORMED" } };
      const bad = keywordBad(c.keyword, ["EXACT", "PHRASE", "BROAD"]);
      if (bad) return { error: bad };
      if (!ENUM_STATUS.includes(String(c.status))) return { error: { fieldError: "REQUIRED" } };
      const ag = ref(cid, c.adGroup, "adGroups", tempMap);
      if (ag === null || !w.groups.some((x) => x.id === ag)) return { error: { resourceNameError: "MALFORMED" } };
      const k = c.keyword as { text: string; matchType: Match };
      if (w.criteria.some((x) => x.groupId === ag && x.text === k.text && x.match === k.matchType && x.status !== "REMOVED")) return { error: { criterionError: "DUPLICATE_KEYWORD" } };
      const id = newId();
      w.criteria.push({ groupId: ag, id, text: k.text, match: k.matchType, status: c.status as Status });
      return done("adGroupCriterionResult", `customers/${cid}/adGroupCriteria/${ag}~${id}`);
    }
    if (kind === "adGroupCriterionOperation" && action[0] === "update") {
      // update は updateMask が "status" だけ・中身は resourceName と status だけ
      if (o.updateMask !== "status") return { error: { fieldMaskError: "FIELD_MASK_MISSING" } };
      const keysOf = Object.keys(c).sort().join(",");
      if (keysOf !== "resourceName,status") return { error: { fieldMaskError: "FIELD_NOT_FOUND" } };
      if (!ENUM_STATUS.includes(String(c.status))) return { error: { fieldError: "INVALID_VALUE" } };
      const m = String(c.resourceName).match(new RegExp(`^customers/${cid}/adGroupCriteria/(\\d+)~(\\d+)$`));
      const k = m ? w.criteria.find((x) => x.groupId === Number(m[1]) && x.id === Number(m[2])) : undefined;
      if (!k || k.status === "REMOVED") return { error: { mutateError: "RESOURCE_NOT_FOUND" } };
      if (!g.hooks.ignoreStatusUpdate) k.status = c.status as Status;
      return done("adGroupCriterionResult", String(c.resourceName));
    }
    if (kind === "campaignCriterionOperation" && action[0] === "create") {
      if (c.negative !== true) return { error: { fieldError: "REQUIRED" } };
      const bad = keywordBad(c.keyword, ["EXACT", "PHRASE", "BROAD"]);
      if (bad) return { error: bad };
      const cp = ref(cid, c.campaign, "campaigns", tempMap);
      if (cp === null || !w.campaigns.some((x) => x.id === cp)) return { error: { resourceNameError: "MALFORMED" } };
      const k = c.keyword as { text: string; matchType: Match };
      if (w.negatives.some((x) => x.campaignId === cp && x.text === k.text && x.match === k.matchType)) return { error: { criterionError: "DUPLICATE_KEYWORD" } };
      const id = newId();
      w.negatives.push({ campaignId: cp, id, text: k.text, match: k.matchType, status: "ENABLED" });
      return done("campaignCriterionResult", `customers/${cid}/campaignCriteria/${cp}~${id}`);
    }
    // 広告文（adGroupAdOperation）など、ほかの操作はこの作品からは送らない
    return { error: { mutateError: "UNSUPPORTED_IN_FAKE" } };
  }

  return g;
}
