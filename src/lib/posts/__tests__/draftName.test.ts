// 発信の下書きの呼び名：種類の名前が「下書き」で終わる時は「の下書き」を足さない（「ブログの下書きの下書き」にしない）。
// 画面の「後：」と日誌の文の両方がこの1つの関数を使う。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { getPostsSettings } from "../../settings";
import { draftName } from "../draftName";

const ROOT = join(__dirname, "../../../..");

describe("「下書き」を重ねない", () => {
  test("「ブログの下書き」→「ブログの下書き」・「お客様への配信」→「お客様への配信の下書き」", () => {
    assert.equal(draftName("ブログの下書き"), "ブログの下書き");
    assert.equal(draftName("お客様への配信"), "お客様への配信の下書き");
    assert.equal(draftName("SNS の投稿文"), "SNS の投稿文の下書き");
  });

  test("設定のどの種類でも「下書きの下書き」にならない（種類の名前そのものは変えない）", () => {
    for (const k of getPostsSettings().kinds) {
      assert.doesNotMatch(draftName(k.label), /下書きの下書き/, k.label);
      assert.ok(draftName(k.label).startsWith(k.label));
      assert.ok(draftName(k.label).endsWith("下書き"));
    }
  });

  test("画面と日誌の文は「${kind.label}の下書き」を直に書かず draftName を通す", () => {
    for (const f of ["src/app/posts/PostsForm.tsx", "src/app/posts/PostsBoard.tsx", "src/lib/posts/write.ts", "src/components/PostTeam.tsx"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(text, /label( \?\? "")?\}の下書き/, f);
    }
  });
});
