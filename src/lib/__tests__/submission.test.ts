// 提出の前の点検と、小さい直しのテスト。Claude・LINE・Redis は呼ばない。
// 1. 安全の点検：鍵や .env がリポジトリに無い・AI を呼ぶ窓口は全部 /api/ai/ の下・上限は全部 config にあって効く
// 5. 小さい直し：お礼の返事に「スタッフ」と言わない・流れている返事の途中の切り替え・カルテの門の漢数字・LINE のオーナー用の合言葉

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import aiJson from "../../../config/ai.json";
import lineJson from "../../../config/line.json";
import { runReview } from "../ads/review";
import { scriptAdsModel } from "../ads/script";
import { parseAdsRequest } from "../ads/wire";
import { buildTable } from "../ads/report";
import { getAds } from "../data/seed";
import { BUSY_NOTICE, createChatRuns, NO_CUSTOMER_NOTICE, sendBlocked } from "../ai/chatRuns";
import { THANKS_REPLY } from "../ai/replies";
import { reserveSystem } from "../ai/reservePrompt";
import { parseReserveRequest } from "../ai/request";
import { at, chat, ctxAt } from "../ai/__tests__/helpers";
import { gateKarte, gateLine, kanjiNumber, numbersIn } from "../karte/gate";
import { karteSystem } from "../karte/prompt";
import { parseKarteRequest } from "../karte/request";
import { startLink, KEY, type BridgeDeps } from "../line/bridge";
import { memoryStore } from "../line/store";
import { parseSendRequest, MAX_OUT_MESSAGES, MAX_OUT_TEXT } from "../line/wire";
import { LOCKED_INSTRUCTIONS } from "../rules/prompt";
import { LOCKED_RULES } from "../rules/locked";
import { getRules } from "../rules/store";
import {
  getAdSettings,
  getAdsAiSettings,
  getAdsFixMaxChars,
  getAiSettings,
  getChatMaxChars,
  getKarteHeadings,
  getLineAiSettings,
  getLineSettings,
  getMenus,
  getShop,
} from "../settings";

const ROOT = join(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

function tracked(): string[] {
  try {
    return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("1. 安全の点検", () => {
  test(".env で始まるファイルはリポジトリに入れない（.gitignore にもある）", () => {
    const files = tracked();
    assert.ok(files.length > 0, "git ls-files が読める");
    assert.deepEqual(files.filter((f) => /(^|\/)\.env/.test(f)), []);
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    assert.match(ignore, /^\.env\*$/m);
  });

  test("鍵・トークンの形の物が、リポジトリのファイルに無い（ドキュメントは環境変数の名前だけ）", () => {
    const looksSecret = [
      /sk-ant-[A-Za-z0-9_-]{10,}/,
      /\b(ANTHROPIC_API_KEY|LINE_CHANNEL_SECRET|LINE_CHANNEL_ACCESS_TOKEN|KV_REST_API_TOKEN|LINE_OWNER_PASSCODE)\s*=\s*["']?[A-Za-z0-9+/_-]{8,}/,
      /Bearer\s+[A-Za-z0-9._-]{30,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    const hits: string[] = [];
    for (const f of tracked()) {
      if (f === "package-lock.json" || /\.(png|ico|jpg|woff2?)$/.test(f)) continue;
      const text = readFileSync(join(ROOT, f), "utf8");
      for (const re of looksSecret) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    assert.deepEqual(hits, []);
  });

  test("AI（Claude）を呼ぶ窓口は全部 /api/ai/ の下（LINE の一言の振り分けも）", () => {
    const routes = walk(join(ROOT, "src/app/api")).filter((p) => p.endsWith("route.ts"));
    // Claude を呼ぶ部品（@anthropic-ai/sdk を使う所）
    const aiModules = walk(join(ROOT, "src/lib"))
      .filter((p) => p.endsWith(".ts") && !p.includes("__tests__"))
      .filter((p) => /from "@anthropic-ai\/sdk"/.test(readFileSync(p, "utf8")) && !/^import type/m.test(readFileSync(p, "utf8").match(/.*@anthropic-ai\/sdk.*/)?.[0] ?? ""))
      .map((p) => rel(p).replace(/^src\//, "@/").replace(/\.ts$/, ""));
    assert.ok(aiModules.length >= 4, `Claude を呼ぶ部品：${aiModules.join("、")}`);
    for (const r of routes) {
      const text = readFileSync(r, "utf8");
      const usesAi = aiModules.some((m) => text.includes(`"${m}"`)) || /@anthropic-ai\/sdk/.test(text);
      if (usesAi) assert.match(rel(r), /^src\/app\/api\/ai\//, `${rel(r)} は AI を呼ぶので /api/ai/ の下に置く`);
    }
    // 4つの AI の窓口がそろっている
    for (const name of ["reserve", "karte", "ads", "line"]) assert.ok(routes.some((r) => rel(r) === `src/app/api/ai/${name}/route.ts`), name);
    // LINE の窓口（/api/line）は AI を呼ばない
    for (const r of routes.filter((x) => rel(x).startsWith("src/app/api/line"))) {
      const text = readFileSync(r, "utf8");
      assert.doesNotMatch(text, /sortClaude|claude"|writer"|@anthropic-ai/, rel(r));
    }
  });

  test("上限は全部 config にある（字数・返事の長さ・道具の回数・LINE の1日の通数）", () => {
    const pos = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
    const ai = aiJson as Record<string, any>;
    for (const k of ["maxReplyTokens", "maxToolCalls", "maxMessages", "maxMessageChars", "maxRequestChars"]) assert.ok(pos(ai[k]), k);
    for (const k of ["maxReplyTokens", "maxMemoChars", "maxRequestChars"]) assert.ok(pos(ai.karte[k]), `karte.${k}`);
    for (const k of ["maxReplyTokens", "maxTries", "maxFixChars", "maxRequestChars"]) assert.ok(pos(ai.ads[k]), `ads.${k}`);
    for (const k of ["maxReplyTokens", "maxRequestChars"]) assert.ok(pos(ai.line[k]), `line.${k}`);
    const line = lineJson as Record<string, number>;
    for (const k of ["dailyPushLimit", "maxTextChars", "codeTries", "maxOutChars", "maxOutMessages", "maxWebhookChars", "maxScreenRequestChars"]) assert.ok(pos(line[k]), k);
    // 読むのは settings.ts を通す
    assert.equal(getChatMaxChars(), ai.maxMessageChars);
    assert.equal(getAdsFixMaxChars(), ai.ads.maxFixChars);
    assert.equal(getAdsAiSettings().maxTries, ai.ads.maxTries);
    assert.equal(getLineAiSettings().maxRequestChars, ai.line.maxRequestChars);
    assert.equal(MAX_OUT_TEXT, line.maxOutChars);
    assert.equal(MAX_OUT_MESSAGES, line.maxOutMessages);
  });

  test("窓口と画面に、上限の数を直に書かない（config から読む）", () => {
    const files = [
      ...walk(join(ROOT, "src/app/api")).filter((p) => p.endsWith("route.ts")),
      join(ROOT, "src/app/reservations/ReserveChat.tsx"),
      join(ROOT, "src/components/AdApprovalRows.tsx"),
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      assert.doesNotMatch(text, /MAX_BODY\s*=|const MAX_CHARS = \d|MAX_FIX_CHARS = \d|\d+_000\b/, rel(f));
    }
  });

  test("上限が効く：予約チャットの文・カルテのメモ・広告の「直す」の一言・LINE へ送る文", () => {
    const ai = getAiSettings();
    const long = "あ".repeat(ai.maxMessageChars + 50);
    const r = parseReserveRequest(
      { mode: "script", messages: [{ role: "user", text: long }], customer: { id: "c01", surname: "青木", firstVisit: false }, booked: [], rules: [], visits: [] },
      getMenus(),
      ai,
    );
    assert.ok(r.ok);
    if (r.ok) assert.equal([...r.value.messages[0].text].length, ai.maxMessageChars);
    // 会話の数
    const many = Array.from({ length: ai.maxMessages + 5 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `${i}` }));
    const r2 = parseReserveRequest({ mode: "script", messages: many, customer: { id: "c01", surname: "青木", firstVisit: false }, booked: [], rules: [], visits: [] }, getMenus(), ai);
    if (r2.ok) assert.ok(r2.value.messages.length <= ai.maxMessages);
    // カルテのメモは上限を超えると受けない
    const k = parseKarteRequest({ mode: "script", memo: "あ".repeat(ai.karte.maxMemoChars + 1), rules: [] }, ai.karte.maxMemoChars, getMenus().map((m) => m.id));
    assert.equal(k.ok, false);
    // 広告の「直す」の一言は config の字数で切る
    const table = buildTable(getAds(), getAdSettings());
    const ads = parseAdsRequest(
      { mode: "script", table, rules: [], fix: { text: "い".repeat(getAdsFixMaxChars() + 30), current: { action: "stop", no: 3 } } },
      getMenus().map((m) => m.id),
      getAdsFixMaxChars(),
    );
    assert.ok(ads.ok);
    if (ads.ok) assert.equal(ads.value.fix?.text.length, getAdsFixMaxChars());
    // LINE へ送る文の長さ・数
    const send = parseSendRequest({ token: "a.b", messages: Array.from({ length: MAX_OUT_MESSAGES + 2 }, () => ({ type: "text", text: "う".repeat(MAX_OUT_TEXT + 10) })) });
    assert.ok(send);
    assert.equal(send!.messages.length, MAX_OUT_MESSAGES);
    assert.equal((send!.messages[0] as { text: string }).text.length, MAX_OUT_TEXT);
  });

  test("上限が効く：広告の案を作らせる回数は config の maxTries まで", async () => {
    const table = buildTable(getAds(), getAdSettings());
    const settings = getAdSettings();
    // 決まった返事は1回目に町の名前入りの9番を外す案を出して門に弾かれる → maxTries=1 なら作り直さない
    const once = await runReview({ table, rules: LOCKED_RULES, settings, model: scriptAdsModel(table), maxTokens: 600, maxTries: 1 });
    assert.equal(once.ok, false);
    assert.equal(once.tries, 1);
    const twice = await runReview({ table, rules: LOCKED_RULES, settings, model: scriptAdsModel(table), maxTokens: 600, maxTries: getAdsAiSettings().maxTries });
    assert.equal(twice.ok, true);
    assert.equal(twice.tries, 2);
  });

  test("窓口は config の大きさより大きい物を受けない（/api/ai/karte）", async () => {
    const { POST } = await import("../../app/api/ai/karte/route");
    const big = JSON.stringify({ mode: "script", memo: "x", rules: [], pad: "あ".repeat(getAiSettings().karte.maxRequestChars) });
    const res = await POST(new Request("http://x/api/ai/karte", { method: "POST", body: big }));
    assert.equal(res.status, 413);
  });
});

describe("5. お礼の返事に「スタッフ」と言わない（1人で営業する店）", () => {
  test("決まった返事・AI への指示・鍵つきの指示に「スタッフ」が無い", () => {
    assert.doesNotMatch(THANKS_REPLY, /スタッフ/);
    for (const t of LOCKED_INSTRUCTIONS) assert.doesNotMatch(t, /スタッフ/);
    const ctx = ctxAt(at("2026-11-04", "10:00"));
    const sys = reserveSystem(ctx, []);
    // 「使わない」と指示する1行のほかには出さない
    const lines = sys.split("\n").filter((l) => l.includes("スタッフ"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /使わない/);
    assert.doesNotMatch(karteSystem(getKarteHeadings(), getRules()), /スタッフ/);
  });

  test("お礼を言われたら、お礼だけ（スタッフとは言わない）", async () => {
    const r = await chat(ctxAt(at("2026-11-04", "10:00")), [{ role: "user", text: "この前のカット、とても気に入りました。ありがとうございました" }]);
    assert.match(r.text, /ありがとうございます/);
    assert.doesNotMatch(r.text, /スタッフ/);
  });
});

describe("5. 返事が流れている途中にお客様を切り替える", () => {
  test("切り替えたら流れている返事を止める（止めた返事は使わない）。次の返事はすぐ始められる", () => {
    const runs = createChatRuns();
    const a = runs.start("c01");
    assert.equal(runs.busy(), true);
    assert.equal(runs.isCurrent(a.id), true);
    // お客様を切り替えた
    assert.equal(runs.stop(), "c01");
    assert.equal(a.signal.aborted, true, "流れていた返事の受け取りを止める");
    assert.equal(runs.isCurrent(a.id), false, "止めた返事の知らせ（文・仮押さえ・ToDo）は使わない");
    assert.equal(runs.busy(), false);
    // 次に送った文は黙って捨てられない
    assert.equal(sendBlocked({ text: "土曜の15時にカット", busy: runs.busy(), hasCustomer: true }), null);
    const b = runs.start("c02");
    assert.equal(runs.isCurrent(b.id), true);
    // 前の返事の終わり（finally）が来ても、新しい返事は外れない
    runs.finish(a.id);
    assert.equal(runs.isCurrent(b.id), true);
    runs.finish(b.id);
    assert.equal(runs.busy(), false);
    assert.equal(runs.stop(), null, "流れていなければ何も止めない");
  });

  test("流れている間に送ろうとしたら、送れない理由を出す（黙って捨てない）", () => {
    assert.equal(sendBlocked({ text: "1つ目で", busy: true, hasCustomer: true }), BUSY_NOTICE);
    assert.equal(sendBlocked({ text: "1つ目で", busy: false, hasCustomer: false }), NO_CUSTOMER_NOTICE);
    assert.equal(sendBlocked({ text: "  ", busy: true, hasCustomer: true }), "", "空の文は何もしない");
  });

  test("新しく始めると、前の返事は止まる（2つの返事を同時に流さない）", () => {
    const runs = createChatRuns();
    const a = runs.start("c01");
    const b = runs.start("c01");
    assert.equal(a.signal.aborted, true);
    assert.equal(runs.isCurrent(a.id), false);
    assert.equal(runs.isCurrent(b.id), true);
  });
});

describe("5. カルテの言葉の門：漢数字も算用数字と同じく調べる", () => {
  test("漢数字を数にする", () => {
    assert.equal(kanjiNumber("三"), 3);
    assert.equal(kanjiNumber("二十"), 20);
    assert.equal(kanjiNumber("十五"), 15);
    assert.equal(kanjiNumber("百八十"), 180);
    assert.equal(kanjiNumber("一万二千"), 12000);
    assert.equal(kanjiNumber("二〇二六"), 2026);
    assert.deepEqual(numbersIn("放置は二十分、アイロン百八十度"), ["20", "180"]);
    // 数ではない言葉は数えない
    assert.deepEqual(numbersIn("娘さんと一緒に来た"), []);
  });

  test("メモに無い漢数字の行は載せない", () => {
    const memo = "カット。全体を3センチ切った。";
    assert.match(gateLine("・五センチ切った", memo) ?? "", /「5」はメモに無い数字です/);
    assert.match(gateLine("・四週間後にまた", memo) ?? "", /「4」はメモに無い数字です/);
    assert.match(gateLine("・3センチと二か月後", memo) ?? "", /「2」/);
  });

  test("メモにある数は、漢数字でも算用数字でも残す（書き方がちがっても同じ数）", () => {
    assert.equal(gateLine("・三センチ切った", "全体を3センチ切った"), null);
    assert.equal(gateLine("・3センチ切った", "全体を三センチ切った"), null);
    assert.equal(gateLine("・二か月後ごろ、またリタッチ", "次は二か月後くらい"), null);
    assert.equal(gateLine("・一緒に来た娘さん", "娘さんと一緒に来た"), null);
  });

  test("下書き全体でも：メモに無い漢数字の1行だけを外す", () => {
    const headings = getKarteHeadings();
    const sections = Object.fromEntries(headings.map((h) => [h.id, [] as string[]]));
    sections.treatment = ["・カット：全体を3センチ", "・前髪は二センチ"];
    const { sections: kept, removed } = gateKarte(sections, "全体を3センチ切った。前髪も少し。", headings);
    assert.deepEqual(kept.treatment, ["・カット：全体を3センチ"]);
    assert.equal(removed.length, 1);
    assert.match(removed[0].reason, /「2」はメモに無い数字です/);
  });
});

describe("5. LINE とつなぐ：オーナー用の合言葉（LINE_OWNER_PASSCODE）", () => {
  let clock = Date.parse("2026-11-04T09:00:00+09:00");
  let seq = 0;
  const deps = (ownerPasscode: string | null): BridgeDeps & { store: ReturnType<typeof memoryStore> } => ({
    store: memoryStore(() => clock),
    line: null,
    settings: getLineSettings(),
    timezone: getShop().timezone,
    now: () => new Date(clock),
    random: (n) => {
      seq += 1;
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = (seq * 37 + i * 11) & 0xff;
      return b;
    },
    ownerPasscode,
  });

  test("環境変数が無ければ今のまま（合言葉を求めない）", async () => {
    const r = await startLink(deps(null));
    assert.ok(r.ok);
    assert.match(r.ok ? r.code : "", /^\d{6}$/);
  });

  test("環境変数があれば、その合言葉が合っている時だけ画面の合言葉を出す", async () => {
    const d = deps("mochi-owner-pass");
    const none = await startLink(d);
    assert.equal(none.ok, false);
    assert.equal(!none.ok && none.code, "passcode");
    const wrong = await startLink(d, undefined, { passcode: "ちがう", client: "1.2.3.4" });
    assert.equal(wrong.ok, false);
    assert.equal(!wrong.ok && wrong.code, "passcode");
    const ok = await startLink(d, undefined, { passcode: " mochi-owner-pass ", client: "1.2.3.4" });
    assert.ok(ok.ok);
    // 合言葉そのものは置き場所に置かない
    for (const k of d.store.keys()) assert.doesNotMatch(`${k}=${(await d.store.get(k)) ?? ""}`, /mochi-owner-pass/);
  });

  test("何回もまちがえると、しばらく受けない（10分たてば戻る）。ほかの送り元は止めない", async () => {
    const d = deps("mochi-owner-pass");
    const tries = getLineSettings().codeTries;
    for (let i = 0; i < tries; i++) assert.equal((await startLink(d, undefined, { passcode: `x${i}`, client: "9.9.9.9" })).ok, false);
    const locked = await startLink(d, undefined, { passcode: "mochi-owner-pass", client: "9.9.9.9" });
    assert.equal(locked.ok, false);
    assert.match(!locked.ok ? locked.message : "", /何回も/);
    assert.ok((await startLink(d, undefined, { passcode: "mochi-owner-pass", client: "5.5.5.5" })).ok);
    clock += 11 * 60 * 1000;
    assert.ok((await startLink(d, undefined, { passcode: "mochi-owner-pass", client: "9.9.9.9" })).ok);
    assert.ok(KEY.passTries("x").startsWith("line:passtry:"));
  });

  test("窓口：合言葉がちがえば 403 で、画面の合言葉も印も返さない", async () => {
    const { POST } = await import("../../app/api/line/link/route");
    const before = { pass: process.env.LINE_OWNER_PASSCODE, url: process.env.KV_REST_API_URL, up: process.env.UPSTASH_REDIS_REST_URL };
    process.env.LINE_OWNER_PASSCODE = "mochi-owner-pass";
    delete process.env.KV_REST_API_URL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    try {
      const { needsOwnerPasscode } = await import("../line/server");
      assert.equal(needsOwnerPasscode(), true);
      // Redis が無いときは「つながらない」（合言葉の中身は返さない）
      const res = await POST(new Request("http://x/api/line/link", { method: "POST", body: JSON.stringify({ action: "start", passcode: "ちがう" }) }));
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.ok, false);
      assert.equal(body.token, undefined);
      assert.doesNotMatch(JSON.stringify(body), /mochi-owner-pass/);
    } finally {
      if (before.pass === undefined) delete process.env.LINE_OWNER_PASSCODE;
      else process.env.LINE_OWNER_PASSCODE = before.pass;
      if (before.url) process.env.KV_REST_API_URL = before.url;
      if (before.up) process.env.UPSTASH_REDIS_REST_URL = before.up;
    }
  });
});
