/**
 * SecretAIry → Google 広告：広告の中で動かす見本のスクリプト（docs/SPEC.md §1.7.7）
 *
 * ★ 本物の Google 広告のアカウントでは動かしていません。作り物の広告の部品で動かしたテストだけです
 *   （src/lib/ads/__tests__/connect.test.ts）。
 * ★ 今の作品は、承認の箱の中身を見ている人のブラウザの中だけに残すので、このスクリプトが取りに来る窓口はまだありません
 *   （README の「本物の検索広告につなぐ道」）。窓口の場所と合言葉は空の置き場だけです。
 *
 * 使い方（本当に使う時）：Google 広告の管理画面の「ツール → 一括操作 → スクリプト」に貼る → 1回だけ許可する →
 * まず「プレビュー」で試す（プレビューの時は、結果を作品に送り返しません）→ 動かす間隔を決める（1時間ごとなど）。
 *
 * 流れ：渡す中身の JSON を読む（作品の窓口から合言葉つき）→ 止める・外す・足すを行う → 変えた後に読み直して
 * 本当に変わったか確かめる → 結果の JSON を作る（プレビューでなければ作品に送り返す）。
 * 守り：承認済みの案だけ／キャンペーンの名前が渡した中身と下の設定の1つに合う時だけ／足すのは売りの言葉が入った物だけ／
 * 見つからない・2つ以上ある時は何もせず「できなかった（理由）」／1回に行う数に上限（maxOps）。
 *
 * このファイルはアプリの動きとビルドには入れません（アプリからは読み込みません）。
 */

var CONFIG = {
  // 作品のサーバーの窓口（渡す中身を GET・結果を POST）。まだ無いので空
  endpoint: "",
  // 窓口の合言葉。まだ無いので空（ここに書くのは本当に使う時だけ。作品のリポジトリには入れない）
  passcode: "",
  // 店の広告（キャンペーン）の名前と、足す先の広告グループの名前（作品の config/ads.json の connect と同じ作り物の名前）
  campaign: "もちの木 検索",
  adGroup: "売りのメニュー",
  // 売りの言葉（作品の config/ads.json の featuredMenus のメニューの名前）
  featuredWords: ["縮毛矯正", "ヘッドスパ"],
  // 1回に行う数の上限
  maxOps: 10,
  // 言葉の長さの上限（字）
  maxTextChars: 40,
};

var SYNC_FORMAT = "secretairy-ads-sync";
var RESULT_FORMAT = "secretairy-ads-result";
var SYNC_VERSION = 1;

/** 入口。広告の部品（AdsApp・UrlFetchApp・Logger）を直に読むのはここだけ */
function main() {
  var out = runSync({
    ads: AdsApp,
    http: UrlFetchApp,
    log: function (s) {
      Logger.log(s);
    },
    config: CONFIG,
  });
  Logger.log(out.note);
  if (out.result) Logger.log(JSON.stringify(out.result));
}

/** 売りの言葉が入っているか（空白を除いて比べる）。本体は src/lib/ads/featured.ts の featuredWordIn と1字も違わない（テストで確かめる） */
function featuredWordIn(text, words) {
  // <same>
  const plain = String(text == null ? "" : text).replace(/\s+/g, "");
  for (const w of words) {
    const word = String(w == null ? "" : w).replace(/\s+/g, "");
    if (word !== "" && plain.includes(word)) return w;
  }
  return null;
  // </same>
}

/**
 * 中身。deps = { ads（広告の部品）, http（外の窓口の部品）, log, config, now? }
 * 返す物 = { ok, note, preview, sent, result? }
 */
function runSync(deps) {
  var cfg = deps.config;
  var log = deps.log || function () {};
  var nowIso = deps.now ? deps.now() : new Date().toISOString();
  if (!cfg.endpoint || !cfg.passcode) return { ok: false, note: "窓口の場所と合言葉が空なので、何もしませんでした", preview: false, sent: false };

  var preview = deps.ads.getExecutionInfo().isPreview() === true;
  var headers = { Authorization: "Bearer " + cfg.passcode };

  // 1. 渡す中身を読む
  var got = deps.http.fetch(cfg.endpoint, { method: "get", headers: headers, muteHttpExceptions: true });
  if (got.getResponseCode() !== 200) return { ok: false, note: "渡す中身を読めませんでした（" + got.getResponseCode() + "）", preview: preview, sent: false };
  var payload;
  try {
    payload = JSON.parse(got.getContentText());
  } catch (e) {
    return { ok: false, note: "渡す中身が JSON として読めませんでした", preview: preview, sent: false };
  }
  if (!payload || payload.format !== SYNC_FORMAT || payload.version !== SYNC_VERSION || !Array.isArray(payload.items) || typeof payload.campaign !== "string")
    return { ok: false, note: "渡す中身の形が違うので、何もしませんでした", preview: preview, sent: false };

  // 2. キャンペーンの名前が、渡した中身と設定の1つに合う時だけ
  if (payload.campaign !== cfg.campaign) return { ok: false, note: "キャンペーンの名前が設定と違うので、何もしませんでした", preview: preview, sent: false };
  var campaigns = collect(deps.ads.campaigns().get(), function (c) {
    return c.getName() === cfg.campaign;
  });
  if (campaigns.length !== 1)
    return { ok: false, note: campaigns.length === 0 ? "キャンペーンが見つからないので、何もしませんでした" : "同じ名前のキャンペーンが2つ以上あるので、何もしませんでした", preview: preview, sent: false };
  var campaign = campaigns[0];

  // 3. 1件ずつ
  var results = [];
  var ops = 0;
  for (var i = 0; i < payload.items.length; i++) {
    var item = payload.items[i] || {};
    var base = { id: String(item.id || ""), kind: String(item.kind || ""), text: String(item.text || "") };
    // 番号か種類の形が違う案は、結果にも入れない（作品の読み込みは結果の全部の形を確かめるので）。何もせず書き残すだけ
    if (typeof item.id !== "string" || !item.id || (item.kind !== "stop" && item.kind !== "exclude" && item.kind !== "add")) {
      log("形の違う案を飛ばした（何もしていません）");
      continue;
    }
    var why = itemProblem(item, payload, cfg);
    if (why) {
      results.push(failed(base, why));
      continue;
    }
    if (ops >= cfg.maxOps) {
      results.push(failed(base, "1回に行う数の上限（" + cfg.maxOps + "）をこえたので、次の回に"));
      continue;
    }
    ops += 1;
    var r;
    try {
      r = item.kind === "stop" ? stopKeyword(campaign, item.text, preview) : item.kind === "exclude" ? excludeTerm(campaign, item.text, preview) : addKeyword(campaign, cfg.adGroup, item.text, preview);
    } catch (e) {
      r = { ok: false, reason: "うまくいきませんでした（" + String(e && e.message ? e.message : e).slice(0, 60) + "）" };
    }
    // プレビューの時は、変えずに確かめただけ（読み直しで変わらないので、反映したとは言わない）
    if (r.ok && preview) r = { ok: false, reason: "試し（プレビュー）なので、反映していません" };
    results.push(r.ok ? { id: base.id, kind: base.kind, text: base.text, status: "done" } : failed(base, r.reason));
    log((r.ok ? "反映した：" : "できなかった：") + base.kind + "「" + base.text + "」" + (r.ok ? "" : "（" + r.reason + "）"));
  }

  var result = { format: RESULT_FORMAT, version: SYNC_VERSION, campaign: cfg.campaign, createdAt: nowIso, results: results };

  // 4. 試し（プレビュー）の時は送り返さない
  if (preview) return { ok: true, note: "試し（プレビュー）なので、結果は送り返していません", preview: true, sent: false, result: result };
  var sent = deps.http.fetch(cfg.endpoint, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(result),
    headers: headers,
    muteHttpExceptions: true,
  });
  var ok = sent.getResponseCode() === 200;
  return { ok: ok, note: ok ? "結果を送り返しました" : "結果を送り返せませんでした（" + sent.getResponseCode() + "）", preview: false, sent: ok, result: result };
}

/** 案を行ってよいか（だめなら理由） */
function itemProblem(item, payload, cfg) {
  if (typeof item.id !== "string" || !item.id) return "案の番号がありません";
  if (item.kind !== "stop" && item.kind !== "exclude" && item.kind !== "add") return "種類が違います";
  if (typeof item.approvedAt !== "string" || isNaN(Date.parse(item.approvedAt))) return "承認済みの案ではありません";
  var t = item.text;
  if (typeof t !== "string" || !t.trim() || t.length > cfg.maxTextChars || /["\[\]\n\r]/.test(t)) return "言葉の形が違います";
  if (item.kind === "exclude" && item.match !== "exact") return "外すのは完全一致だけです";
  if (item.kind === "add") {
    if (item.match !== "phrase") return "足すのはフレーズ一致だけです";
    if (payload.adGroup !== cfg.adGroup) return "広告グループの名前が設定と違います";
    if (!featuredWordIn(t, cfg.featuredWords)) return "売りの言葉が入っていないので足しません";
  }
  return null;
}

function failed(base, reason) {
  return { id: base.id, kind: base.kind, text: base.text, status: "failed", reason: reason };
}

/** 選んだ物を全部たどって、合う物だけ集める（get() の hasNext・next） */
function collect(iterator, pred) {
  var out = [];
  while (iterator.hasNext()) {
    var x = iterator.next();
    if (pred(x)) out.push(x);
  }
  return out;
}

/** 合い方の印（[完全一致]・"フレーズ一致"）を外した言葉 */
function bare(text) {
  var t = String(text);
  if (/^\[.*\]$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
  return t;
}

/** 止める：決めたキャンペーンの中で、言葉の文字がちょうど1つ合う物だけ */
function stopKeyword(campaign, text, preview) {
  var find = function () {
    return collect(campaign.keywords().get(), function (k) {
      return bare(k.getText()) === text;
    });
  };
  var hits = find();
  if (hits.length !== 1) return { ok: false, reason: hits.length === 0 ? "言葉が見つかりません" : "同じ言葉が2つ以上あります" };
  hits[0].pause();
  if (preview) return { ok: true };
  var again = find();
  if (again.length !== 1 || !again[0].isPaused()) return { ok: false, reason: "読み直しても止まっていませんでした" };
  return { ok: true };
}

/** 外す：決めたキャンペーンに、完全一致の除外の言葉として */
function excludeTerm(campaign, text, preview) {
  var exact = "[" + text + "]";
  var find = function () {
    return collect(campaign.negativeKeywords().get(), function (n) {
      return n.getText() === exact;
    });
  };
  if (find().length > 0) return { ok: true };
  campaign.createNegativeKeyword(exact);
  if (preview) return { ok: true };
  if (find().length !== 1) return { ok: false, reason: "読み直しても外せていませんでした" };
  return { ok: true };
}

/** 足す：決めた広告グループ（名前がちょうど1つ）に、フレーズ一致で */
function addKeyword(campaign, adGroupName, text, preview) {
  var groups = collect(campaign.adGroups().get(), function (g) {
    return g.getName() === adGroupName;
  });
  if (groups.length !== 1) return { ok: false, reason: groups.length === 0 ? "広告グループが見つかりません" : "同じ名前の広告グループが2つ以上あります" };
  var group = groups[0];
  var phrase = '"' + text + '"';
  var find = function () {
    return collect(group.keywords().get(), function (k) {
      return k.getText() === phrase;
    });
  };
  if (find().length > 0) return { ok: true };
  var op = group.newKeywordBuilder().withText(phrase).build();
  if (!op.isSuccessful()) return { ok: false, reason: "足せませんでした（" + String(op.getErrors()).slice(0, 60) + "）" };
  if (preview) return { ok: true };
  if (find().length !== 1) return { ok: false, reason: "読み直しても足せていませんでした" };
  return { ok: true };
}
