// ホームの数字のカード・AI の仕事の結果から、同じページの欄へ飛ぶ先（直しB の1）。
// 飛ぶ先の id が本当にホームの画面にあるか、畳める欄なら開いてから飛ぶか、をファイルの中身で確かめる。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JOB_APPROVAL_RESULT, jobDoneLink } from "../../jobs/state";
import { HOME_FOLD_IDS } from "../folds";
import { HOME_JUMPS } from "../jump";

const root = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const summary = read("src/app/home/HomeSummary.tsx");
const page = read("src/app/home/page.tsx");
const jobs = read("src/app/home/AiJobs.tsx");
const link = read("src/components/JumpLink.tsx");

describe("ホーム：数字のカードの飛ぶ先", () => {
  it("今日の予約 → 今日のお客様（畳める欄なので開いてから）。承認待ち → 承認の箱", () => {
    assert.deepEqual(HOME_JUMPS.customers, { target: "customers", fold: "customers", label: "今日のお客様" });
    assert.equal(HOME_JUMPS.approvals.target, "approvals");
    assert.equal(HOME_JUMPS.approvals.fold, undefined, "承認の箱は畳まない");
    for (const j of Object.values(HOME_JUMPS)) if (j.fold) assert.ok(HOME_FOLD_IDS.includes(j.fold));
  });

  it("飛ぶ先の id がホームの画面にある", () => {
    assert.match(summary, /id="customers"\s+anchor="customers"/, "今日のお客様の欄に id");
    assert.match(page, /<Panel title="承認の箱" id="approvals"/, "承認の箱に id");
  });

  it("4枚のカードがそれぞれの先へリンクになっている", () => {
    assert.match(summary, /<JumpLink to="customers"[^>]*>\s*<BigNumber label="今日の予約"/);
    assert.match(summary, /<JumpLink to="approvals"[^>]*>\s*<BigNumber label="承認待ち"/);
    assert.match(summary, /<Link href=\{TABS\.todo\.path\}[^>]*>\s*<BigNumber label="ToDo 今日まで" value=\{due\.dueToday\}/);
    assert.match(summary, /<Link href=\{TABS\.todo\.path\}[^>]*>\s*<BigNumber label="ToDo 期限切れ" value=\{due\.overdue\}/);
  });

  it("畳める欄は開いてから動かす（openHomeFold の後に scrollIntoView）", () => {
    const open = link.indexOf("openHomeFold(j.fold)");
    const scroll = link.indexOf("scrollIntoView");
    assert.ok(open > 0 && scroll > open);
    assert.match(link, /href=\{`#\$\{HOME_JUMPS\[to\]\.target\}`\}/, "JavaScript が無くても飛べる形");
  });
});

describe("ホーム：AI の仕事の結果のリンク", () => {
  it("「承認待ち1件」は同じページの承認の箱へ（予約・広告のタブへは行かない）", () => {
    assert.deepEqual(jobDoneLink({ result: JOB_APPROVAL_RESULT, tab: "reservations" }), { kind: "approvals" });
    assert.deepEqual(jobDoneLink({ result: JOB_APPROVAL_RESULT, tab: "ads" }), { kind: "approvals" });
  });

  it("ほかの結果は今までどおり結果が届いたタブへ", () => {
    assert.deepEqual(jobDoneLink({ result: "ToDo に1件", tab: "todo" }), { kind: "tab", tab: "todo" });
    assert.deepEqual(jobDoneLink({ result: "自動 3件・迷う物 1件", tab: "accounting" }), { kind: "tab", tab: "accounting" });
  });

  it("画面は jobDoneLink を通し、承認の箱へは JumpLink で飛ぶ", () => {
    assert.match(jobs, /jobDoneLink\(done\)/);
    assert.match(jobs, /<JumpLink to="approvals"/);
  });
});
