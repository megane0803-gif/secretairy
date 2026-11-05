import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultFoldOpen, deviceOfWidth, foldOpen, HOME_FOLD_IDS, parseFolds, withFold } from "../folds";

describe("ホームの欄の開け閉め：最初の状態", () => {
  it("PC は今日のお客様・今日の注意・空いている時間・これまでの動きが開き、AI に頼める仕事・LINE とつなぐは閉じる", () => {
    const open = HOME_FOLD_IDS.filter((id) => defaultFoldOpen(id, "pc"));
    assert.deepEqual(open, ["customers", "notes", "free", "journal"]);
  });

  it("スマホは今日のお客様だけ開く", () => {
    const open = HOME_FOLD_IDS.filter((id) => defaultFoldOpen(id, "phone"));
    assert.deepEqual(open, ["customers"]);
  });

  it("1024px から PC、それより狭いとスマホ", () => {
    assert.equal(deviceOfWidth(1280), "pc");
    assert.equal(deviceOfWidth(1024), "pc");
    assert.equal(deviceOfWidth(1023), "phone");
    assert.equal(deviceOfWidth(390), "phone");
  });

  it("覚えた物が無ければ最初の状態", () => {
    assert.equal(foldOpen("jobs", "pc", parseFolds(null)), false);
    assert.equal(foldOpen("journal", "pc", parseFolds(null)), true);
    assert.equal(foldOpen("journal", "phone", parseFolds(null)), false);
  });
});

describe("ホームの欄の開け閉め：覚えた物の読み方", () => {
  it("覚えた物が最初の状態より先（PC でもスマホでも）", () => {
    const saved = parseFolds(JSON.stringify({ jobs: true, customers: false }));
    assert.equal(foldOpen("jobs", "pc", saved), true);
    assert.equal(foldOpen("jobs", "phone", saved), true);
    assert.equal(foldOpen("customers", "pc", saved), false);
    assert.equal(foldOpen("customers", "phone", saved), false);
    // 覚えていない欄は最初の状態
    assert.equal(foldOpen("free", "pc", saved), true);
    assert.equal(foldOpen("free", "phone", saved), false);
  });

  it("壊れている時は最初の状態に戻る", () => {
    for (const raw of ["{", "null", "[]", '"open"', "3", ""]) {
      const saved = parseFolds(raw);
      assert.deepEqual(saved, {}, raw);
      assert.equal(foldOpen("customers", "pc", saved), true);
      assert.equal(foldOpen("line", "pc", saved), false);
    }
  });

  it("知らない欄・true/false でない値は読まない（その欄だけ最初の状態）", () => {
    const saved = parseFolds(JSON.stringify({ line: "yes", approvals: false, notes: 1, free: false }));
    assert.deepEqual(saved, { free: false });
    assert.equal(foldOpen("line", "pc", saved), false);
    assert.equal(foldOpen("notes", "pc", saved), true);
    assert.equal(foldOpen("free", "pc", saved), false);
  });

  it("1つの欄を覚えても、ほかの欄の覚えた物はそのまま。壊れていた物は捨てて書く", () => {
    const a = withFold(JSON.stringify({ jobs: true }), "line", true);
    assert.deepEqual(parseFolds(a), { jobs: true, line: true });
    const b = withFold(a, "jobs", false);
    assert.deepEqual(parseFolds(b), { jobs: false, line: true });
    assert.deepEqual(parseFolds(withFold("{壊れた", "notes", false)), { notes: false });
  });
});
