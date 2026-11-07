/**
 * SecretAIry → Google 広告：広告の中で動かす見本のスクリプト（docs/SPEC.md §1.7.7）
 *
 * ★ 本物の Google 広告のアカウントでは動かしていません。作り物の広告の部品で動かしたテストだけです
 *   （src/lib/ads/__tests__/connect.test.ts）。
 * ★ 今の作品は、承認BOXの中身を見ている人のブラウザの中だけに残すので、このスクリプトが取りに来る窓口はまだありません
 *   （README の「本物の検索広告につなぐ道」）。窓口の場所・合言葉・アカウントの番号は空の置き場だけです。
 * ★ 最初は書き込みません（CONFIG.write = false）。窓口と合言葉を入れただけでは、止める・外す・足すは行わず、
 *   行うはずだった物を「試し」として書き残すだけです。
 *
 * 使い方（本当に使う時）：Google 広告の管理画面の「ツール → 一括操作 → スクリプト」に貼る → 1回だけ許可する →
 * まず「プレビュー」で試す（プレビューの時は、結果を作品に送り返しません）→ 動かす間隔を決める（1時間ごとなど）→
 * 中身を確かめてから CONFIG.write を true にする。
 *
 * 流れ：アカウントの番号を確かめる → 渡す中身の JSON を読む（作品の窓口から合言葉つき）→ 止める・外す・足すを行う →
 * 変えた後に読み直して本当に変わったか確かめる → 結果の JSON を作る（書き込んだ時だけ作品に送り返す）。
 * 守り：書き込む設定の時だけ変える／実行しているアカウントの番号が設定の1つに合う時だけ／承認済みの案だけ／
 * キャンペーンの名前が渡した中身と設定の1つに合う時だけ／足すのは売りの言葉が入った物だけ／町の名前の入った言葉は外さない／
 * 見つからない・2つ以上ある時は何もせず「できなかった（理由）」／1回に行う数に上限（maxOps）。
 * 1回の実行は30分で打ち切られ、それまでの変更は残ります。2回動いても重ならないように、外す・足すは「もうある」なら何もしません
 * （止めるは、止まっている言葉をもう一度止めても同じ）。
 *
 * 書き方は公式の資料（developers.google.com/google-ads/scripts）に合わせています：条件は GAQL の形
 * （列の名前と列挙の値は大文字小文字を区別・文字は ' で囲み、中の \ と ' は \ で逃がす）。
 *
 * このファイルはアプリの動きとビルドには入れません（アプリからは読み込みません）。
 */

var CONFIG = {
  // 書き込むかどうか。false の間は止める・外す・足すを行わず、行うはずだった物を「試し」として書き残すだけ
  write: false,
  // このスクリプトを動かすアカウントの番号（例の形 123-456-7890）。空か違う番号なら何もしない。まだ無いので空
  customerId: "",
  // 作品のサーバーの窓口（渡す中身を GET・結果を POST）。まだ無いので空
  endpoint: "",
  // 窓口の合言葉。まだ無いので空（ここに書くのは本当に使う時だけ。作品のリポジトリには入れない）
  passcode: "",
  // 店の広告（キャンペーン）の名前と、足す先の広告グループの名前（作品の config/ads.json の connect と同じ作り物の名前）
  campaign: "もちの木 検索",
  adGroup: "売りのメニュー",
  // 売りの言葉（作品の config/ads.json の featuredMenus のメニューの名前）
  featuredWords: ["縮毛矯正", "ヘッドスパ"],
  // 町の名前（作品の config/ads.json の towns）。この名前が入った言葉は外さない
  towns: ["もちの木町", "白玉台", "きなこ坂", "あんこ橋", "みたらし川"],
  // 1回に行う数の上限
  maxOps: 10,
  // 言葉の長さの上限（字）
  maxTextChars: 40,
};

var SYNC_FORMAT = "secretairy-ads-sync";
var RESULT_FORMAT = "secretairy-ads-result";
var SYNC_VERSION = 1;
var LIVE = "ENABLED, PAUSED";

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

/** 町の名前が入っているか（空白を除いて比べる。作品の report.ts の townIn と同じ決まり） */
function townIn(text, towns) {
  var plain = String(text).replace(/\s+/g, "");
  for (var i = 0; i < towns.length; i++) {
    var t = String(towns[i]).replace(/\s+/g, "");
    if (t && plain.indexOf(t) >= 0) return towns[i];
  }
  return null;
}

/** GAQL の文字：' で囲み、中の \ と ' を \ で逃がす */
function q(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** アカウントの番号を比べる形（数字だけ） */
function digits(s) {
  return String(s == null ? "" : s).replace(/[^0-9]/g, "");
}

/**
 * 中身。deps = { ads（広告の部品）, http（外の窓口の部品）, log, config, now? }
 * 返す物 = { ok, note, preview, write, sent, result? }
 */
function runSync(deps) {
  var cfg = deps.config;
  var log = deps.log || function () {};
  var nowIso = deps.now ? deps.now() : new Date().toISOString();
  var none = function (note) {
    return { ok: false, note: note, preview: false, write: cfg.write === true, sent: false };
  };

  // 0. 実行しているアカウントの番号が、設定の1つに合う時だけ（置き場が空なら何もしない）
  if (!digits(cfg.customerId)) return none("アカウントの番号の置き場が空なので、何もしませんでした");
  if (digits(deps.ads.currentAccount().getCustomerId()) !== digits(cfg.customerId)) return none("動いているアカウントの番号が設定と違うので、何もしませんでした");
  if (!cfg.endpoint || !cfg.passcode) return none("窓口の場所と合言葉が空なので、何もしませんでした");

  var preview = deps.ads.getExecutionInfo().isPreview() === true;
  var write = cfg.write === true;
  // 試し：書き込まない設定（変える操作は呼ばない）か、プレビュー（変える操作は呼ぶが何も変わらない。読み直さない）
  var trial = !write ? "試し（書き込まない設定なので、行っていません）" : preview ? "試し（プレビュー）なので、反映していません" : null;
  var headers = { Authorization: "Bearer " + cfg.passcode };

  // 1. 渡す中身を読む
  var got = deps.http.fetch(cfg.endpoint, { method: "GET", headers: headers, muteHttpExceptions: true });
  if (got.getResponseCode() !== 200) return none("渡す中身を読めませんでした（" + got.getResponseCode() + "）");
  var payload;
  try {
    payload = JSON.parse(got.getContentText());
  } catch (e) {
    return none("渡す中身が JSON として読めませんでした");
  }
  if (!payload || payload.format !== SYNC_FORMAT || payload.version !== SYNC_VERSION || !Array.isArray(payload.items) || typeof payload.campaign !== "string")
    return none("渡す中身の形が違うので、何もしませんでした");

  // 2. キャンペーンの名前が、渡した中身と設定の1つに合う時だけ（AdsApp.campaigns() は検索とディスプレイのキャンペーン）
  if (payload.campaign !== cfg.campaign) return none("キャンペーンの名前が設定と違うので、何もしませんでした");
  var it = deps.ads
    .campaigns()
    .withCondition("campaign.name = " + q(cfg.campaign))
    .withCondition("campaign.status IN (" + LIVE + ")")
    .get();
  var n = it.totalNumEntities();
  if (n !== 1) return none(n === 0 ? "キャンペーンが見つからないので、何もしませんでした" : "同じ名前のキャンペーンが2つ以上あるので、何もしませんでした");
  var campaign = it.next();

  // 3. 1件ずつ。足すは全部 build してから、後でまとめて確かめる（公式の勧め）
  var rows = [];
  var ops = 0;
  for (var i = 0; i < payload.items.length; i++) {
    var item = payload.items[i] || {};
    // 番号か種類の形が違う案は、結果にも入れない（作品の読み込みは結果の全部の形を確かめるので）。何もせず書き残すだけ
    if (typeof item.id !== "string" || !item.id || (item.kind !== "stop" && item.kind !== "exclude" && item.kind !== "add")) {
      log("形の違う案を飛ばした（何もしていません）");
      continue;
    }
    var row = { id: item.id, kind: item.kind, text: String(item.text || ""), r: null, check: null, run: null };
    rows.push(row);
    var why = itemProblem(item, payload, cfg);
    if (why) {
      row.r = { ok: false, reason: why };
      continue;
    }
    if (ops >= cfg.maxOps) {
      row.r = { ok: false, reason: "1回に行う数の上限（" + cfg.maxOps + "）をこえたので、次の回に" };
      continue;
    }
    ops += 1;
    try {
      var step = item.kind === "stop" ? stopKeyword(campaign, item.text, write) : item.kind === "exclude" ? excludeTerm(campaign, item.text, write) : addKeyword(campaign, cfg.adGroup, item.text, write);
      if (step.check) {
        row.check = step.check;
        row.run = step.run || null;
      }
      else row.r = step;
    } catch (e) {
      row.r = { ok: false, reason: "うまくいきませんでした（" + String(e && e.message ? e.message : e).slice(0, 60) + "）" };
    }
  }

  // 4. 変えた後に確かめる（プレビューと書き込まない設定の時は読み直さない）
  var results = [];
  for (var j = 0; j < rows.length; j++) {
    var x = rows[j];
    var r = x.r;
    if (!r) {
      try {
        if (trial && x.run) x.run();
        r = trial ? { ok: true, trial: true } : x.check();
      } catch (e2) {
        r = { ok: false, reason: "うまくいきませんでした（" + String(e2 && e2.message ? e2.message : e2).slice(0, 60) + "）" };
      }
    }
    // 試しの時は「反映した」と言わない
    if (r.ok && (trial || r.trial)) r = { ok: false, reason: trial };
    results.push(r.ok ? { id: x.id, kind: x.kind, text: x.text, status: "done" } : { id: x.id, kind: x.kind, text: x.text, status: "failed", reason: r.reason });
    log((r.ok ? "反映した：" : "できなかった：") + x.kind + "「" + x.text + "」" + (r.ok ? "" : "（" + r.reason + "）"));
  }

  var result = { format: RESULT_FORMAT, version: SYNC_VERSION, campaign: cfg.campaign, createdAt: nowIso, results: results };

  // 5. 試しの時は送り返さない（プレビューでも UrlFetchApp は本当に動くので）
  if (trial) return { ok: true, note: trial + "。結果は送り返していません", preview: preview, write: write, sent: false, result: result };
  var sent = deps.http.fetch(cfg.endpoint, {
    method: "POST",
    contentType: "application/json",
    payload: JSON.stringify(result),
    headers: headers,
    muteHttpExceptions: true,
  });
  var ok = sent.getResponseCode() === 200;
  return { ok: ok, note: ok ? "結果を送り返しました" : "結果を送り返せませんでした（" + sent.getResponseCode() + "）", preview: false, write: true, sent: ok, result: result };
}

/** 案を行ってよいか（だめなら理由） */
function itemProblem(item, payload, cfg) {
  if (typeof item.approvedAt !== "string" || isNaN(Date.parse(item.approvedAt))) return "承認済みの案ではありません";
  var t = item.text;
  if (typeof t !== "string" || !t.trim() || t.length > cfg.maxTextChars || /["\[\]\n\r]/.test(t)) return "言葉の形が違います";
  if (item.kind === "exclude") {
    if (item.match !== "exact") return "外すのは完全一致だけです";
    if (townIn(t, cfg.towns)) return "町の名前の入った言葉は外さない";
  }
  if (item.kind === "add") {
    if (item.match !== "phrase") return "足すのはフレーズ一致だけです";
    if (payload.adGroup !== cfg.adGroup) return "広告グループの名前が設定と違います";
    if (!featuredWordIn(t, cfg.featuredWords)) return "売りの言葉が入っていないので足しません";
  }
  return null;
}

/** 合い方の飾り（[完全一致]・"フレーズ一致"）を外した言葉（getText() は合い方で形が変わる） */
function bare(text) {
  var t = String(text);
  if (/^\[.*\]$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
  return t;
}

/**
 * 止める：決めたキャンペーンの中で、言葉の文字がちょうど1つ合う物だけ（合い方は問わない。2つ以上なら何もしない）。
 * 返す物：{ check } = 後で読み直して確かめる / { ok, reason } = もう決まった
 */
function stopKeyword(campaign, text, write) {
  var find = function () {
    return campaign
      .keywords()
      .withCondition("ad_group_criterion.keyword.text = " + q(text))
      .withCondition("ad_group_criterion.status IN (" + LIVE + ")")
      .get();
  };
  var it = find();
  var n = it.totalNumEntities();
  if (n !== 1) return { ok: false, reason: n === 0 ? "言葉が見つかりません" : "同じ言葉が2つ以上あります" };
  var kw = it.next();
  if (bare(kw.getText()) !== text) return { ok: false, reason: "言葉の文字が合いません" };
  if (!write) return { check: trialCheck };
  kw.pause(); // 何も返さない
  return {
    check: function () {
      var again = find();
      if (again.totalNumEntities() !== 1 || !again.next().isPaused()) return { ok: false, reason: "読み直しても止まっていませんでした" };
      return { ok: true };
    },
  };
}

/** 外す：決めたキャンペーンに、完全一致の除外の言葉として（もうあれば何もしない） */
function excludeTerm(campaign, text, write) {
  var exists = function () {
    return campaign
      .negativeKeywords()
      .withCondition("ad_group_criterion.keyword.text = " + q(text))
      .withCondition("ad_group_criterion.keyword.match_type = EXACT")
      .get()
      .hasNext();
  };
  if (exists()) return { ok: true };
  if (!write) return { check: trialCheck };
  campaign.createNegativeKeyword("[" + text + "]"); // 何も返さない・成功の印が無いので、後で読み直して確かめる
  return {
    check: function () {
      return exists() ? { ok: true } : { ok: false, reason: "読み直しても外せていませんでした" };
    },
  };
}

/** 足す：決めた広告グループ（名前がちょうど1つ）に、フレーズ一致で（もうあれば何もしない） */
function addKeyword(campaign, adGroupName, text, write) {
  var groups = campaign
    .adGroups()
    .withCondition("ad_group.name = " + q(adGroupName))
    .withCondition("ad_group.status IN (" + LIVE + ")")
    .get();
  var n = groups.totalNumEntities();
  if (n !== 1) return { ok: false, reason: n === 0 ? "広告グループが見つかりません" : "同じ名前の広告グループが2つ以上あります" };
  var group = groups.next();
  var exists = function () {
    return group
      .keywords()
      .withCondition("ad_group_criterion.keyword.text = " + q(text))
      .withCondition("ad_group_criterion.keyword.match_type = PHRASE")
      .withCondition("ad_group_criterion.status IN (" + LIVE + ")")
      .get()
      .hasNext();
  };
  if (exists()) return { ok: true };
  if (!write) return { check: trialCheck };
  // build は KeywordOperation を返す。isSuccessful()・getResult()・getErrors() のどれかを呼んだ時に実行される（後でまとめて確かめる）
  var op = group.newKeywordBuilder().withText('"' + text + '"').build();
  return {
    // プレビューの時：実行だけして（何も作られない）、返りは見ない（プレビューの時の返りは資料に書いていない）
    run: function () {
      op.isSuccessful();
    },
    check: function () {
      if (!op.isSuccessful()) return { ok: false, reason: "足せませんでした（" + String(op.getErrors()).slice(0, 60) + "）" };
      return exists() ? { ok: true } : { ok: false, reason: "読み直しても足せていませんでした" };
    },
  };
}

/** 書き込まない設定の時の確かめ（読み直さない） */
function trialCheck() {
  return { ok: true, trial: true };
}
