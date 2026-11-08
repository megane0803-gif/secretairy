// 直しY 1：承認BOXの広告の行の知らせ（テスト用アカウントへ送った結果：送っています → 反映した／いまは送れませんでした（理由））は、
// 次の操作まで出し続ける。ホームの承認BOXで最後の行を承認して0件になっても（広告の行の部品が外れても、知らせは承認BOXが持つ）、
// 広告のタブで止める・外すの行が残ったまま足す案（や戻す案）の最後を承認しても出す。文は今のまま（approvedNotice）。
// 広告の部品はブラウザの中の置き場所を読むので、画面と同じ形（承認BOXの行・承認・知らせを持つ物・試す流れ）で確かめ、
// 部品のつなぎはソースで確かめる。知らせの1行（AdDoneLine）と、渡した知らせを出す広告の行の部品は描いて確かめる。
// 窓口は呼ばない（試すは作り物で、返事を止めておける）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdApprovalRows, AdDoneLine } from "../../../components/AdApprovalRows";
import { approvalQueue, approvalsFor } from "../../approvals";
import { emptyBook } from "../../book/state";
import { getAds } from "../../data/seed";
import { getSeedRules } from "../../rules/store";
import { getAdSettings, getMenus, getShop } from "../../settings";
import { featuredWords } from "../featured";
import { adDoneText, approvedNotice, beginTry, type AdDone, type AdDoneSet, type Approved, type TryRoute } from "../live/notice";
import { livePanel } from "../live/panel";
import type { LiveFail, LiveTryResponse, TryKind } from "../live/wire";
import { buildTable } from "../report";
import { approveAd, approveAdd, EMPTY_ADS, pendingAd, pendingAdds, tableOf, withProposal, withReview } from "../state";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const settings = getAdSettings();
const report = getAds();
const table = buildTable(report, settings);
const shop = getShop();
const words = featuredWords(settings, getMenus());
const NOW = "2026-11-07T01:00:00.000Z";
const TODAY = "2026-11-07";

/** React の useState と同じ形の、知らせを持つ物（ホームは承認BOX・広告のタブは広告の行の箱が持つ。useAdDone） */
function holder() {
  let done: AdDone | null = null;
  const set: AdDoneSet = (next) => {
    done = typeof next === "function" ? next(done) : next;
  };
  return { set, get: () => done };
}

/** 画面に1つの流れ（usePanel.ts の sharedPanel と同じ livePanel）。試すの返事は止めておき、release で返す */
function heldTry(epoch: () => string | undefined = () => "e1") {
  let release!: (r: LiveTryResponse | LiveFail) => void;
  const hold = new Promise<LiveTryResponse | LiveFail>((r) => (release = r));
  const unused = async () => ({ ok: false as const, code: "x", message: "使わない" });
  const panel = livePanel({
    setup: unused,
    send: unused,
    read: unused,
    try: () => hold,
    epoch,
    payload: () => {
      throw new Error("使わない");
    },
    mark: () => ({ ok: false, note: "使わない" }),
    journal: () => {},
    onChange: () => {},
  });
  // usePanel.ts の tryAfterApprove と同じ（テスト用アカウントにつないでいる時）
  const tryOne = async (it: { kind: TryKind; no: number; text: string }): Promise<TryRoute> => ((await panel.tryOne(it)) ? "started" : "not-run");
  const done = (a: Pick<Approved, "kind" | "no" | "text">): LiveTryResponse => ({ ok: true, line: { kind: a.kind, no: a.no, text: a.text, outcome: "done" }, list: null });
  return { panel, tryOne, release, done };
}

/** 承認BOXの行の数（ホームは全部） */
const count = (book: ReturnType<typeof emptyBook>, ads: Parameters<typeof approvalQueue>[1]) => approvalsFor(approvalQueue(book, ads, NOW), "all").count;

describe("直しY 1：広告の承認の知らせは、次の操作まで出し続ける", () => {
  test("ホームで広告の最後の1行を承認 → 承認待ちが0件になっても、知らせが出る（送っています → 反映した）", async () => {
    const row = table.keywords[0];
    const ads0 = withProposal(EMPTY_ADS, { action: "stop", no: row.no, text: row.text, reason: "予約につながっていません。" }, table, { id: "ad1", checks: [], nowIso: NOW, mode: "script" }, settings);
    const book0 = emptyBook(TODAY);
    assert.equal(count(book0, ads0), 1, "広告の行が最後の1行");
    // 承認（画面と同じ approveAd）→ 0件。承認BOXは「承認待ちはありません」の形になり、広告の行の部品（AdApprovalRows）は外れる
    const out = approveAd(ads0, book0, "ad1", { nowIso: NOW, today: TODAY, shop, settings });
    assert.equal(count(out.book, out.ads), 0);

    // 知らせを持つのは承認BOX（部品が外れても残る）。承認した後に1回だけ試す
    const box = holder();
    const live = heldTry();
    const going = beginTry({ kind: "stop", no: row.no, text: row.text, todo: true }, box.set, live.tryOne);
    assert.equal(
      adDoneText(box.get()!, live.panel.view().tried, "home"),
      `✓ ${row.no}番「${row.text}」を止めました（広告の管理画面に反映）。ToDo に「効いたか見る」を足しました。テスト用の広告アカウントを元の形に戻してから、この1件を送っています…`,
    );
    live.release(live.done({ kind: "stop", no: row.no, text: row.text }));
    await going;
    assert.equal(
      adDoneText(box.get()!, live.panel.view().tried, "home"),
      `✓ ${row.no}番「${row.text}」を止めました。テスト用の広告アカウントを元の形に戻してから送り、読み直して止まったのを確かめました（広告は出ず、お金は動きません）。ToDo に「効いたか見る」を足しました。一覧は広告のタブで見られます。`,
    );

    // 画面：知らせを持つのは承認BOX。0件の時は「承認待ちはありません」の下に同じ1行（AdDoneLine）を出す
    const box_ = read("src/components/ApprovalBox.tsx");
    assert.match(box_, /const \[adDone, setAdDone\] = useAdDone\(book\.state\.epoch\);/);
    const empty = box_.slice(box_.indexOf("if (queue.count === 0)"), box_.indexOf("// 確定しない時"));
    assert.match(empty, /<Checked>承認待ちはありません<\/Checked>/);
    assert.match(empty, /\{only !== "reservations" && adDone && <AdDoneLine done=\{adDone\} where="home" inList=\{false\} \/>\}/);
    assert.match(box_, /\{only !== "reservations" && <AdApprovalRows seedRules=\{data\.seedRules\} done=\{adDone\} onDone=\{setAdDone\} \/>\}/);
    // 広告の行の部品は、渡された知らせを使う（自分の中に持たない）
    const rows = read("src/components/AdApprovalRows.tsx");
    assert.match(rows, /const \[done, setDone\]: \[AdDone \| null, AdDoneSet\] = onDone \? \[heldDone \?\? null, onDone\] : own;/);
  });

  test("広告のタブで、止める行を残したまま足す案の最後の1つを承認 → 知らせが出る（送っています → 反映した）", async () => {
    const s0 = withReview(
      EMPTY_ADS,
      {
        proposal: { id: "ad-1", action: "stop", no: 3, text: "美容院 安い", reason: "予約につながっていません。", checks: [] },
        adds: [{ id: "ad-1-add1", no: 11, reason: "売りの言葉です。", checks: [] }],
      },
      table,
      { nowIso: NOW, mode: "script" },
      settings,
    );
    const add = pendingAdds(s0)[0];
    assert.ok(pendingAd(s0) && add);
    const out = approveAdd(s0, add.id, { nowIso: NOW, table: tableOf(report, settings, s0), words, settings });
    assert.ok(out.ok);
    assert.ok(pendingAd(out.ads), "止める行は残る");
    assert.equal(pendingAdds(out.ads).length, 0, "足す案は0件");

    const tab = holder();
    const live = heldTry();
    const going = beginTry({ kind: "add", no: add.no, text: add.text, todo: false }, tab.set, live.tryOne);
    assert.equal(
      adDoneText(tab.get()!, live.panel.view().tried, "ads"),
      `✓ ${add.no}番「${add.text}」を広告を出す言葉に足しました（広告の管理画面に反映）。テスト用の広告アカウントを元の形に戻してから、この1件を送っています…`,
    );
    live.release(live.done({ kind: "add", no: add.no, text: add.text }));
    await going;
    assert.equal(
      adDoneText(tab.get()!, live.panel.view().tried, "ads"),
      `✓ ${add.no}番「${add.text}」を広告を出す言葉に足しました。テスト用の広告アカウントを元の形に戻してから送り、読み直して足されたのを確かめました（広告は出ず、お金は動きません）。`,
    );

    // 画面：広告のタブの箱は、行が残っていても0件でも知らせを出す（前は「止める・外すの行が無い時か、足す案が残っている時」だけ）
    const rows = read("src/components/AdApprovalRows.tsx");
    const tabPart = rows.slice(rows.indexOf("{row || revert || adds.length ? ("));
    assert.match(tabPart, /\{done && <AdDoneLine done=\{done\} where="ads" inList=\{false\} \/>\}/);
    assert.doesNotMatch(rows, /done && \(!row|adds\.length > 0\) &&/);
    // 戻す案の知らせ（決まった文）も同じ1行で出す
    assert.match(tabPart, /<AdRevertRow onDone=\{setDone\} \/>/);
    assert.equal(adDoneText("✓ 検索広告で 3番を また出すことにしました", null, "ads"), "✓ 検索広告で 3番を また出すことにしました");
  });

  test("いまは送れなかった時も、知らせ（理由つき）を次の操作まで出す", async () => {
    const box = holder();
    const live = heldTry();
    const a: Approved = { kind: "exclude", no: 10, text: "美容院 安い 学生", todo: true };
    const going = beginTry(a, box.set, live.tryOne);
    live.release({ ok: true, line: { kind: "exclude", no: 10, text: "美容院 安い 学生", outcome: "failed", reason: "広告の側で受けられませんでした" }, list: null });
    await going;
    assert.equal(
      adDoneText(box.get()!, live.panel.view().tried, "home"),
      "10番「美容院 安い 学生」：広告の管理画面には反映しました。テスト用の広告アカウントへは、いまは送れませんでした（広告の側で受けられませんでした）。ToDo に「効いたか見る」を足しました。一覧は広告のタブで見られます。",
    );
  });

  test("次の操作の知らせに変わったら、遅れて届いた試すの返事で上書きしない（次の知らせを、その次の操作まで出す）", async () => {
    const box = holder();
    const live = heldTry();
    const a: Approved = { kind: "add", no: 11, text: "縮毛矯正 くせ毛 ひどい", todo: false };
    const going = beginTry(a, box.set, live.tryOne);
    box.set("見送りました：3番を止める案を閉じました");
    live.release(live.done(a));
    await going;
    assert.equal(box.get(), "見送りました：3番を止める案を閉じました");
  });

  test("「最初に戻す」で消えた知らせは、遅れて届いた返事で戻らない（台帳の印が変わったら useAdDone が消す）", async () => {
    const box = holder();
    const live = heldTry();
    const a: Approved = { kind: "stop", no: 3, text: "美容院 安い", todo: true };
    const going = beginTry(a, box.set, live.tryOne);
    box.set(null);
    live.release(live.done(a));
    await going;
    assert.equal(box.get(), null);
    const rows = read("src/components/AdApprovalRows.tsx");
    assert.match(rows, /if \(seen !== \(epoch \?\? ""\)\) \{\n\s+setSeen\(epoch \?\? ""\);\n\s+setDone\(null\);/);
    assert.match(rows, /const own = useAdDone\(bookState\.state\.epoch\);/);
  });

  test("文は今のまま：承認した1件は approvedNotice、決まった文はそのまま", () => {
    const a: Approved = { kind: "stop", no: 7, text: "髪型 流行り", todo: true, route: "off" };
    for (const where of ["ads", "home"] as const) assert.equal(adDoneText(a, null, where), approvedNotice(a, null, where));
    assert.equal(adDoneText("見送りました：7番を止める案を閉じました", null, "home"), "見送りました：7番を止める案を閉じました");
  });
});

describe("直しY 1：知らせの1行の部品（描いて確かめる）", () => {
  const a: Approved = { kind: "stop", no: 7, text: "髪型 流行り", todo: true };

  test("一覧が無い時は p・一覧の中は li。どちらも role=status で、文は approvedNotice と同じ", () => {
    const sending = approvedNotice(a, null, "home");
    assert.equal(renderToStaticMarkup(createElement(AdDoneLine, { done: a, where: "home", inList: false })), `<p class="hint" role="status">${sending}</p>`);
    assert.equal(renderToStaticMarkup(createElement(AdDoneLine, { done: "見送りました", where: "ads", inList: true })), '<li class="hint" role="status">見送りました</li>');
  });

  test("ホームの広告の行の部品は、承認BOXから渡された知らせを出す（自分の行が無くても）", () => {
    const html = renderToStaticMarkup(createElement(AdApprovalRows, { seedRules: getSeedRules(), done: a, onDone: () => {} }));
    assert.equal(html, `<li class="hint" role="status">${approvedNotice(a, null, "home")}</li>`);
    // 知らせが無ければ何も出さない
    assert.equal(renderToStaticMarkup(createElement(AdApprovalRows, { seedRules: getSeedRules(), done: null, onDone: () => {} })), "");
  });
});
