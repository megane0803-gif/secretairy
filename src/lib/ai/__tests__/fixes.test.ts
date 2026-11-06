// 公開 URL で本物の Claude を使って見つかった読み違いと不具合（2〜8）のテスト。
// Claude は呼ばない。決まった返事（script.ts）か、Claude の言い方をまねた決まった返事（下の claudeLike）で試す。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelTurn, ReplyModel } from "../model";
import { reserveSystem } from "../reservePrompt";
import { candidateLabel, judgeSlot, menuOf } from "../slots";
import { runTool } from "../tools";
import { emptyBook, pendingApprovals, withChatTodo, withGuestReleased, withHold, withApproved } from "../../book/state";
import { toMinutes } from "../../calendar";
import type { Rule } from "../../rules/types";
import { at, chat, conversation, ctxAt, shop } from "./helpers";

const now = at("2026-11-04", "10:00"); // 水曜

/**
 * Claude の言い方をまねた決まった返事。道具の呼び方（呼ぶ順）と、最後の文を決めて渡す。
 * 最後の文は、それまでの道具の答え（label）から作る。
 */
function claudeLike(calls: { name: string; input: Record<string, unknown> }[], finalText: (labels: string[]) => string): ReplyModel {
  let i = 0;
  const labels: string[] = [];
  return {
    async turn(req, onText): Promise<ModelTurn> {
      const last = req.messages[req.messages.length - 1];
      if (last && Array.isArray(last.content))
        for (const b of last.content)
          if (b.type === "tool_result" && typeof b.content === "string") {
            const d = JSON.parse(b.content) as { candidates?: { label: string }[] };
            for (const c of d.candidates ?? []) labels.push(c.label);
          }
      if (i < calls.length) {
        const c = calls[i++];
        const id = `cl-${i}`;
        return { assistant: [{ type: "tool_use", id, name: c.name, input: c.input }], toolCalls: [{ id, name: c.name, input: c.input }], stop: "tool" };
      }
      const text = finalText(labels);
      onText(text);
      return { assistant: [{ type: "text", text }], toolCalls: [], stop: "end" };
    },
  };
}

describe("2. 候補のボタンは、出した候補の数だけ", () => {
  test("道具を2回呼んで1つずつ出しても、ボタンは2つ（前は最後の道具の1つだけだった）", async () => {
    const model = claudeLike(
      [
        { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06", after: "15:00" } },
        { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-07", after: "15:00" } },
      ],
      (l) => `1つ目：${l[0]}、2つ目：${l[2]} が空いています。`,
    );
    const r = await chat(ctxAt(now), [{ role: "user", text: "金曜か土曜の15時ごろにカット" }], model);
    assert.equal(r.candidates?.length, 2);
    assert.deepEqual(
      r.candidates!.map((c) => c.date),
      ["2026-11-06", "2026-11-07"],
    );
  });

  test("文に出さなかった候補にはボタンを出さない（道具が2つ返しても、文が1つなら1つ）", async () => {
    const model = claudeLike([{ name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } }], (l) => `${l[1]} はいかがでしょう。`);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.equal(r.candidates?.length, 1);
    // 同じ時間に受ける人数は1人（config/shop.json）。11/6 10:30–12:30 のパーマの後で、1時間より離した2つ目
    assert.equal(candidateLabel(ctxAt(now), r.candidates![0]), "11/6（金） 14:00–15:00 カット");
  });

  test("日付を「6日（金）の15時」と言い換えても、番号を付けて出していればボタンが出る", async () => {
    const model = claudeLike([{ name: "check_rules", input: { menu_ids: ["cut"], date: "2026-11-06", start: "15:00" } }], () => "1つ目：6日（金）の15時からカット でお取りできます。");
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6の15時にカット" }], model);
    assert.equal(r.candidates?.length, 1);
  });

  test("決まった返事：2日の希望で2つ出したら、ボタンも2つ", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6か11/7の13時からカットをお願いします" }]);
    assert.equal(r.candidates?.length, 2);
    for (const c of r.candidates!) assert.ok(r.text.includes(candidateLabel(ctxAt(now), c)));
  });
});

describe("3. 取りやめた後・仮押さえの後は、候補のボタンを消す", () => {
  test("仮押さえができた返事では、候補は空（ボタンを消す）", async () => {
    const { turns } = await conversation(ctxAt(now), ["11/6の15時にカット", "1つ目で"]);
    assert.equal(turns[0].candidates?.length, 1);
    assert.equal(turns[1].holds.length, 1);
    assert.deepEqual(turns[1].candidates, []);
  });

  test("候補を出した後にお客様が取りやめたら、候補は空", async () => {
    const { turns } = await conversation(ctxAt(now), ["11/6にカット", "やっぱりやめます"]);
    assert.equal(turns[0].candidates?.length, 2);
    assert.deepEqual(turns[1].candidates, []);
    assert.equal(turns[1].holds.length, 0);
  });

  test("Claude が道具を呼ばずに文だけで取りやめを受けても、候補は空", async () => {
    const ctx = ctxAt(now);
    const first = await chat(ctx, [{ role: "user", text: "11/6にカット" }]);
    const model = claudeLike([], () => "かしこまりました。またご連絡ください。");
    const r = await chat({ ...ctx, shown: first.candidates! }, [{ role: "user", text: "11/6にカット" }, { role: "assistant", text: first.text }, { role: "user", text: "やめておきます" }], model);
    assert.deepEqual(r.candidates, []);
  });
});

describe("4. 週と日付が食い違う言い方は、決めずに聞き返す", () => {
  const refuse: ReplyModel = {
    async turn() {
      throw new Error("返事を作る物は呼ばない（プログラムが聞き返す）");
    },
  };

  test("「来週の20日」：20日は来週に無い → どちらのことか聞き返す。道具も仮押さえも無し", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "来週の20日の15時にカットをお願いします" }], refuse);
    assert.match(r.text, /どちら/);
    assert.match(r.text, /11\/20（金）/);
    assert.match(r.text, /11\/13（金）/);
    assert.equal(r.holds.length, 0);
    assert.deepEqual(r.candidates, []);
    assert.ok(r.steps.every((s) => s.kind === "ask"));
  });

  test("「11/6（木）」：11/6 は金曜 → どちらのことか聞き返す", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6（木）の15時にカット" }], refuse);
    assert.match(r.text, /11\/6は金曜日/);
    assert.match(r.text, /11\/5（木）/);
  });

  test("食い違わなければ聞き返さない（「来週の13日」「再来週の20日」）", async () => {
    for (const text of ["来週の13日の15時にカット", "再来週の20日の15時にカット"]) {
      const r = await chat(ctxAt(now), [{ role: "user", text }]);
      assert.ok(!r.steps.some((s) => s.kind === "ask"), text);
      assert.equal(r.candidates?.length, 1, text);
    }
  });

  test("指示にも暦（今週・来週・再来週）と「食い違うときは聞き返す」が入る", () => {
    const sys = reserveSystem(ctxAt(now), []);
    assert.match(sys, /来週 11\/9（月）〜11\/15（日）/);
    assert.match(sys, /食い違うとき/);
  });
});

describe("5. 仮押さえの後の「ずらしたい」「やめたい」", () => {
  test("ずらしたい → 前の仮押さえを外してから、新しい候補を出す（同じ枠は出さない）", async () => {
    const { turns } = await conversation(ctxAt(now), ["11/6の15時にカット", "1つ目で", "やっぱり日にちをずらしたいです", "1つ目で"]);
    const first = turns[1].holds[0];
    const shift = turns[2];
    assert.ok(shift.events.some((e) => e.t === "release" && e.holdId === first.id), "前の仮押さえを外す");
    assert.ok(shift.steps.some((s) => s.kind === "release"));
    assert.ok(shift.candidates && shift.candidates.length >= 1, "出し直す");
    assert.ok(!shift.candidates!.some((c) => c.date === first.date && c.start === first.start), "外した枠は出さない");
    assert.equal(turns[3].holds.length, 1, "選び直して仮押さえ");
  });

  test("やめたい → 外すだけ（候補は出さない）", async () => {
    const { turns } = await conversation(ctxAt(now), ["11/6の15時にカット", "1つ目で", "やっぱりやめたいです"]);
    assert.ok(turns[2].events.some((e) => e.t === "release"));
    assert.deepEqual(turns[2].candidates, []);
    assert.match(turns[2].text, /外しました/);
  });

  const row = (id: string, status: "hold" | "confirmed", customerId = "c04") => ({
    id, customerId, menuId: "cut", date: "2026-11-06", start: "15:00", status, newCustomer: false,
  });

  test("外せるのは、この会話で作った仮押さえだけ（ほかの会話・ほかの方の物は外さない）", () => {
    const ctx = ctxAt(now);
    const notMine = runTool({ ...ctx, booked: [...ctx.booked, row("h-x", "hold")], convHolds: [] }, "release_hold", { hold_id: "h-x" });
    assert.equal(notMine.release, undefined);
    assert.equal(notMine.isError, true);
    const other = runTool({ ...ctx, booked: [...ctx.booked, row("h-y", "hold", "c01")], convHolds: ["h-y"] }, "release_hold", { hold_id: "h-y" });
    assert.equal(other.release, undefined);
  });

  test("もう承認された予約は外さない（承認待ちの仮押さえだけ）", () => {
    const ctx = ctxAt(now);
    const out = runTool({ ...ctx, booked: [...ctx.booked, row("h-z", "confirmed")], convHolds: ["h-z"] }, "release_hold", { hold_id: "h-z" });
    assert.equal(out.release, undefined);
    assert.ok(out.steps.some((s) => s.text.includes("承認された")));
    const ok = runTool({ ...ctx, booked: [...ctx.booked, row("h-w", "hold")], convHolds: ["h-w"] }, "release_hold", { hold_id: "h-w" });
    assert.equal(ok.release, "h-w");
  });

  test("ブラウザの側でも確かめる：承認待ちの仮押さえは外れ、承認済み・ほかの方の物は変わらない", () => {
    const hold = { id: "h1", customerId: "c04", menuId: "cut", date: "2026-11-06", start: "15:00", heldAt: "2026-11-04T01:00:00.000Z", expiresAt: "2026-11-05T01:00:00.000Z", reason: "候補から" };
    const nowIso = "2026-11-04T02:00:00.000Z";
    const s0 = withHold(emptyBook("2026-11-04"), hold);
    const released = withGuestReleased(s0, "h1", "c04", nowIso);
    assert.equal(released.chat.length, 0);
    assert.equal(pendingApprovals(released, nowIso).length, 0);
    assert.equal(released.approvals[0].state, "withdrawn");
    assert.equal(released.todos.length, 0, "お客様が自分で取り下げたので ToDo は足さない");
    assert.equal(withGuestReleased(s0, "h1", "c01", nowIso), s0, "ほかの方の物は変えない");
    const approved = withApproved(s0, s0.approvals[0].id, nowIso);
    assert.equal(withGuestReleased(approved, "h1", "c04", nowIso), approved, "承認済みは変えない");
  });
});

describe("6. 1回の来店で複数のメニュー", () => {
  const ctx = ctxAt(now);

  test("カットとヘッドスパ：所要時間を足して1つの枠（90分）。候補どうしは重ならない", async () => {
    const r = await chat(ctx, [{ role: "user", text: "カットとヘッドスパを11/6にお願いします" }]);
    assert.ok(r.candidates && r.candidates.length >= 1);
    for (const c of r.candidates!) {
      assert.equal(c.menuId, "cut+headspa");
      assert.equal(menuOf(ctx, c.menuId)?.minutes, 90);
      assert.equal(judgeSlot(ctx, c).ok, true);
    }
    const [a, b] = r.candidates!;
    if (b && a.date === b.date) assert.ok(toMinutes(b.start) - toMinutes(a.start) >= 90, "同じ時刻に重なる候補は出さない");
  });

  test("設定にある組み合わせ（カットとカラー）は、そのメニュー（カット＋カラー）を使う", async () => {
    const r = await chat(ctx, [{ role: "user", text: "カットとカラーを11/7に" }]);
    assert.ok(r.candidates!.every((c) => c.menuId === "cut_color"));
  });

  test("最終受付を守る：縮毛矯正を含む組み合わせは、閉店に間に合っても 16:00 より後に始めない", async () => {
    // 縮毛矯正＋ヘッドスパは210分。16:30 からなら 20:00 に終わるが、縮毛矯正の最終受付（16:00）を過ぎる
    const r = await chat(ctx, [{ role: "user", text: "縮毛矯正とヘッドスパを11/7の16:30に" }]);
    assert.equal(r.holds.length, 0);
    assert.match(r.text, /最終受付を過ぎるので、お受けできません（縮毛矯正の最終受付（16:00）を過ぎています）。/);
    assert.ok(r.candidates!.length >= 1);
    for (const c of r.candidates!) assert.ok(c.start <= "16:00", c.start);
  });

  test("「いっしょに受けない組み合わせ」のルール：受けられない組み合わせは理由を1文で（候補は出さない）", async () => {
    const own: Rule = { id: "own-nt", level: "menu", menuId: "straight", label: "縮毛矯正とパーマは同じ日に受けない", check: { kind: "notTogether", with: "perm" }, tellCustomer: true };
    const c2 = { ...ctx, rules: [...ctx.rules, own] };
    const r = await chat(c2, [{ role: "user", text: "縮毛矯正とパーマを11/7にお願いします" }]);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.holds.length, 0);
    assert.equal(r.text, "「縮毛矯正とパーマは同じ日に受けない」のため、この組み合わせではお受けできません。", "お客様に伝えるルールは、ルールの名前を理由に1文で");
    assert.ok(r.steps.some((s) => s.kind === "reject"));
  });

  test("「11月の金曜」：当てはまる日を全部見て、日ごとに1つずつ", async () => {
    const r = await chat(ctx, [{ role: "user", text: "11月の金曜にカットをお願いします" }]);
    const look = r.steps.find((s) => s.text.startsWith("空きを調べる"))!.text;
    for (const d of ["11/6（金）", "11/13（金）", "11/20（金）", "11/27（金）"]) assert.ok(look.includes(d), d);
    assert.equal(r.candidates?.length, 2);
    assert.notEqual(r.candidates![0].date, r.candidates![1].date);
  });
});

describe("7. 希望の日が複数：日ごとに1つずつ。近すぎる時刻を並べない。中の決まりは言わない", () => {
  const ctx = ctxAt(now);

  test("2日の希望 → 日ごとに1つずつ", async () => {
    const r = await chat(ctx, [{ role: "user", text: "11/6か11/7の13時からカットをお願いします" }]);
    assert.deepEqual(
      r.candidates!.map((c) => c.date),
      ["2026-11-06", "2026-11-07"],
    );
  });

  test("同じ日に2つ出すときは、1時間以内の2つを並べない", async () => {
    for (const text of ["11/6にカット", "11/6にヘッドスパ", "11/6にカラー"]) {
      const r = await chat(ctx, [{ role: "user", text }]);
      const [a, b] = r.candidates!;
      assert.ok(a && b && a.date === b.date, text);
      assert.ok(toMinutes(b.start) - toMinutes(a.start) > 60, `${text}：${a.start} と ${b.start}`);
    }
  });

  test("「候補は2つまでなので」のような中の決まりは、お客様に言わない（指示にも書く）", async () => {
    const r = await chat(ctx, [{ role: "user", text: "11/6か11/7か11/8の13時からカット" }]);
    assert.doesNotMatch(r.text, /2つまで|候補は/);
    assert.match(reserveSystem(ctx, []), /候補の数の決まり（「候補は2つまで」など）や道具のことは、お客様に言わない/);
  });
});

describe("8. 予約ではない話への返し方", () => {
  test("「今日やってますか？」→ 店の設定から、やっているかだけ（メニューは聞かない）", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "今日やってますか？" }]);
    assert.equal(r.text, "今日（11/4（水））は 10:00〜20:00 で営業しています。");
    assert.doesNotMatch(r.text, /メニュー/);
    assert.equal(r.steps.length, 0);
  });

  test("定休日（火曜）に聞かれたら、お休みと次の営業日", async () => {
    const r = await chat(ctxAt(at("2026-11-10", "11:00")), [{ role: "user", text: "今日って営業してますか" }]);
    assert.match(r.text, /今日（11\/10（火））はお休み（定休日）です。次は 11\/11（水） 10:00〜20:00/);
    assert.equal(shop.hours.tue, null);
  });

  test("お礼・感想には、お礼だけ（予約は勧めない）", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "この前のカット、とても気に入りました。ありがとうございました" }]);
    assert.match(r.text, /ありがとうございます/);
    assert.doesNotMatch(r.text, /予約|ご来店|お待ちして|メニュー/);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.steps.length, 0);
  });

  test("忘れ物の問い合わせ → 「お店に確かめてご連絡します」と、プログラムが ToDo「○○様：用件の1行」を足す", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "昨日お店に青い傘を忘れたかもしれません。ありますか？" }]);
    assert.match(r.text, /お店に確かめてご連絡します/);
    const todo = r.events.find((e) => e.t === "todo");
    assert.ok(todo && todo.t === "todo");
    assert.equal(todo.todo.title, "江口様：昨日お店に青い傘を忘れたかもしれません");
    assert.ok(r.steps.some((s) => s.kind === "todo"));
    // ブラウザの側：ToDo に入り、日誌の1行ができる
    const out = withChatTodo(emptyBook("2026-11-04"), todo.todo, "江口", "2026-11-04T01:00:00.000Z");
    assert.equal(out.state.todos.length, 1);
    assert.equal(out.state.todos[0].title, todo.todo.title);
    assert.match(out.journal!, /^ToDo に足した/);
    assert.equal(withChatTodo(out.state, todo.todo, "江口", "2026-11-04T01:00:00.000Z").journal, null, "同じ物は2回足さない");
    assert.equal(withChatTodo(emptyBook("2026-11-04"), { id: "x", title: "ほかの文" }, "江口", "2026-11-04T01:00:00.000Z").journal, null, "形の違う題は受け取らない");
  });

  test("Claude が自分の言葉で「お店に確認してご連絡します」と言った時も、ToDo を足す", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "駐車場はありますか" }], claudeLike([], () => "駐車場のことは、お店に確認してご連絡しますね。"));
    assert.ok(r.events.some((e) => e.t === "todo" && e.todo.title === "江口様：駐車場はありますか"));
  });

  test("仮押さえの「お店から確定のご連絡をします」では ToDo を足さない", async () => {
    const { turns } = await conversation(ctxAt(now), ["11/6の15時にカット", "1つ目で"]);
    assert.ok(!turns[1].events.some((e) => e.t === "todo"));
  });
});

describe("自動レビューの指摘（4つ）", () => {
  test("メニューだけ変えた時：同じ日時でも、ボタンは新しいメニュー（ヘッドスパ）を選ぶ", async () => {
    const { turns } = await conversation(ctxAt(now), ["11/6の15時にカット", "ヘッドスパに変えたいです。11/6の15時で", "1つ目で"]);
    assert.equal(turns[0].candidates?.[0].menuId, "cut");
    assert.match(turns[1].text, /ヘッドスパ/);
    assert.deepEqual(turns[1].candidates?.map((c) => c.menuId), ["headspa"], "ボタンも新しいメニュー");
    assert.equal(turns[2].holds.length, 1);
    assert.equal(turns[2].holds[0].menuId, "headspa", "仮押さえも新しいメニュー");
  });

  test("shownCandidates：前の返事と同じ日時なら、この相談の候補を使う", async () => {
    const { shownCandidates } = await import("../replies");
    const prev = [{ menuId: "cut", date: "2026-11-06", start: "15:00" }];
    const cur = [{ menuId: "headspa", date: "2026-11-06", start: "15:00" }];
    const text = "1つ目：11/6（金） 15:00–15:30 ヘッドスパ でお取りできます。";
    assert.deepEqual(shownCandidates(text, cur, cur, false, prev), cur);
    assert.deepEqual(shownCandidates("11/6（金） 15:00 のカットはいかがでしょう。", [], null, false, prev), prev, "この相談で出していなければ前の物");
  });

  test("「11/6か11/7（土）」：（土）は 11/7 の曜日。聞き返さずに2日とも探す", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6か11/7（土）にカットをお願いします" }]);
    assert.ok(!r.steps.some((s) => s.kind === "ask"), r.text);
    assert.deepEqual(
      r.candidates!.map((c) => c.date),
      ["2026-11-06", "2026-11-07"],
    );
  });

  test("「11/6（土）か11/7」：（土）は 11/6 の曜日で食い違うので、聞き返す", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6（土）か11/7にカット" }]);
    assert.ok(r.steps.some((s) => s.kind === "ask"));
    assert.match(r.text, /11\/6は金曜日/);
  });

  test("時刻だけでずらす（「18時にずらしたい」）：前の仮押さえを外し、同じ日の18:00 で確かめる", async () => {
    const { turns } = await conversation(ctxAt(now), ["11/6の15時にカット", "1つ目で", "18時にずらしたいです"]);
    const shift = turns[2];
    assert.ok(shift.events.some((e) => e.t === "release"), "前の仮押さえを外す");
    assert.ok(shift.steps.some((s) => s.text.startsWith("ルールを確かめる：11/6（金） 18:00")), shift.steps.map((s) => s.text).join("\n"));
    assert.deepEqual(shift.candidates, [{ menuId: "cut", date: "2026-11-06", start: "18:00" }]);
  });

  test("決まった返事で試し直す時も、この会話の仮押さえを引きつぐ（「やめたい」で外れる）", async () => {
    const { carryOver } = await import("../carry");
    const cur = { candidates: [{ menuId: "cut", date: "2026-11-06", start: "15:00" }], holds: ["h-1"] };
    assert.deepEqual(carryOver(false, cur), cur, "やり直し（同じ会話）は引きつぐ");
    assert.deepEqual(carryOver(true, cur), { candidates: [], holds: [] }, "新しい会話だけ空にする");
    // 引きついだ仮押さえがあれば、決まった返事の「やめたい」で外れる
    const { turns, ctx } = await conversation(ctxAt(now), ["11/6の15時にカット", "1つ目で"]);
    const hold = turns[1].holds[0];
    const retried = carryOver(false, { candidates: ctx.shown, holds: ctx.convHolds });
    const r = await chat({ ...ctx, shown: retried.candidates, convHolds: retried.holds }, [{ role: "user", text: "やっぱりやめたいです" }]);
    assert.ok(r.events.some((e) => e.t === "release" && e.holdId === hold.id));
  });

  test("画面のやり直し（trySample）は新しい会話にしない：fresh を付けるのは別の方に切りかえる時だけ", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../app/reservations/ReserveChat.tsx", import.meta.url), "utf8");
    assert.match(src, /carryOver\(over\?\.fresh === true/);
    assert.equal((src.match(/fresh: true/g) ?? []).length, 1, "fresh: true は例文で別の方に切りかえる所だけ");
    assert.doesNotMatch(src, /holds: over\?\.msgs \? \[\]/);
  });
});
