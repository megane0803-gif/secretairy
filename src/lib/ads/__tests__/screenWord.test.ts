// 画面の言葉「承認BOX」を、広告の門で英字として止めない。
// 言い換えで AI への指示に「承認BOX」が入ったので、AI がこの言葉を書いても、広告の言葉の門（words.ts の gateAdSentence）と
// 会議の門（team/gate.ts の gateTeamText）は通す。外すのは字の形をそろえた後（NFKC）の「承認BOX」だけで、ほかの英字は今どおり止める。
// 予約チャットの門（ai/innerGate.ts）は短い英字を止めないので変えない（止まらないことだけ確かめる）。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { innerWordsHit, workTextHit } from "../../ai/innerGate";
import { getSeedRules } from "../../rules/store";
import { getAdSettings, getAdsTeamAiSettings } from "../../settings";
import { gateTeamText } from "../team/gate";
import { gateAdSentence, latinWritten } from "../words";

const settings = getAdSettings();
const team = getAdsTeamAiSettings();
const opts = { maxSentences: 1, maxChars: team.maxLineChars, gateWords: settings.gateWords, material: "" };
const LATIN = "英字（会社やサービスの名前）は書きません";

const pass = ["承認BOXで決めてもらいます。", "承認BOXに回します。", "承認ＢＯＸに入れました。"];
const stop = ["BOXで決めてもらいます。", "boxに入れました。", "承認boxに回します。", "検索はGoogleで見ます。", "承認BOXとLINEに回します。"];

describe("画面の言葉「承認BOX」は広告の門で英字として数えない", () => {
  test("「承認BOX」（全角も）は、言葉の門と会議の門の両方を通る", () => {
    for (const t of pass) {
      assert.equal(latinWritten(t), false, t);
      const a = gateAdSentence(t, settings.gateWords);
      assert.equal(a.ok, true, `言葉の門：${t}${a.ok ? "" : ` ${a.problems.join("／")}`}`);
      const b = gateTeamText(t, opts);
      assert.equal(b.ok, true, `会議の門：${t}${b.ok ? "" : ` ${b.problems.join("／")}`}`);
    }
  });

  test("「BOX」だけ・「box」・ほかの英字（会社やサービスの名前）は、今どおり止まる", () => {
    for (const t of stop) {
      assert.equal(latinWritten(t), true, t);
      const a = gateAdSentence(t, settings.gateWords);
      assert.ok(!a.ok && a.problems.includes(LATIN), `言葉の門：${t}`);
      const b = gateTeamText(t, opts);
      assert.ok(!b.ok && b.problems.includes(LATIN), `会議の門：${t}`);
    }
  });

  test("予約チャットの門は「承認BOX」を含む返事を止めない（変えない）", () => {
    const rules = getSeedRules();
    for (const t of [...pass, "仮押さえしました。お店の承認BOXで確かめてからご連絡します。"]) {
      assert.equal(workTextHit(t), null, t);
      assert.equal(innerWordsHit(t, rules), null, t);
    }
  });
});
