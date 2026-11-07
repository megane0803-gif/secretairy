"use client";

// 経理タブの右の列：来た人（cookie が無い画面）が、そのまま試す欄（docs/SPEC.md §1.8.2）。
// サーバーがオーナーのつないだつながりを持っている時だけ出す。オーナーのブラウザ（cookie がある）は今どおりの FreePanel。
// できるのは、未処理の明細を読む → 1件を店用か私用に決める → 登録 → 読み直すまで。送るのは明細の番号と店用か私用かだけ。
// 試した物は、決めた分だけたった後に、次にだれかが経理のタブを開いた時に、サーバーが元の形に戻す（自動で戻ったとは書かない）。
// AI は使わない。科目も金額もサーバーとプログラムが決める。
//
// 🔒 確定は人：登録は、人が画面のボタンを押したとき（isTrusted）だけ。1回に1件。結果が分からない時は自動で呼び直さない。

import { useMemo, useState } from "react";
import { ACCOUNT_LABEL, freeeRows } from "@/lib/accounting/rows";
import { md, yen } from "@/lib/accounting/sales";
import { USE_LABEL } from "@/lib/accounting/sort";
import { useAccounting } from "@/lib/accounting/useAccounting";
import type { CardUse } from "@/lib/data/types";
import { markIn, useAllowed } from "@/lib/freee/match";
import { phaseLine, restoreNote } from "@/lib/freee/tryClient";
import { tryRegisterOne, tryReload, useFreeeList, useFreeeTry } from "@/lib/freee/useFreee";
import { writeJournal } from "@/lib/journal";
import { getFreeeSettings } from "@/lib/settings";

export function TryPanel() {
  const settings = getFreeeSettings();
  const { seed } = useAccounting();
  const list = useFreeeList();
  const t = useFreeeTry();
  const info = t.info;
  const [pick, setPick] = useState<number | null>(null);
  const [use, setUse] = useState<CardUse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // 登録した明細は未処理の一覧から消えるので、名前はこの画面のメモリの中に覚えておく
  const [names, setNames] = useState<Record<number, string>>({});

  // 試せる明細：印のある出金（見本の明細）。本当に見本と合うかはサーバーが確かめる
  const rows = list.phase === "ok" ? list.list.rows : [];
  const candidates = useMemo(() => {
    const shown = freeeRows(rows, seed.merchants, settings.markPrefix);
    return rows
      .map((r, i) => ({ raw: r, row: shown[i] }))
      .filter((x) => x.raw.side === "expense" && markIn(x.raw.description, settings.markPrefix) !== null);
  }, [rows, seed.merchants, settings.markPrefix]);
  const chosen = candidates.find((c) => c.raw.id === pick) ?? null;
  const allowed = (u: CardUse) => !!chosen && useAllowed(chosen.raw.description, u, seed);
  const holdMinutes = info?.holdMinutes ?? Math.round(settings.try.holdSeconds / 60);
  const line = info ? phaseLine(info) : null;
  const blocked = !info || info.phase === "repair" || info.phase === "restoring" || (info.phase === "holding" && !info.mine);

  const onPick = (id: number | null) => {
    setPick(id);
    const c = candidates.find((x) => x.raw.id === id);
    // 購入先の自動のルールがあれば、その選びを先に入れる（逆は押せない）
    const only = c ? (["shop", "private"] as const).filter((u) => useAllowed(c.raw.description, u, seed)) : [];
    setUse(only.length === 1 ? only[0] : null);
  };

  const onRegister = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || t.busy || !chosen || !use || !allowed(use)) return;
    setNote("テスト用の事業所に1件だけ送っています…");
    setNames((m) => ({ ...m, [chosen.raw.id]: `${ACCOUNT_LABEL[chosen.row.account]} ${md(chosen.row.date)} ${chosen.row.text}` }));
    const r = await tryRegisterOne({ id: chosen.raw.id, use, label: `登録した 1件（${USE_LABEL[use]}）` });
    setNote(r.message);
    if (r.result === "registered" || r.result === "unconfirmed") {
      writeJournal({ who: "オーナー", text: `人が登録：テスト用の事業所に、明細（出金）1件を${USE_LABEL[use]}の取引として登録した（${holdMinutes}分たった後に元に戻る）` });
      setPick(null);
      setUse(null);
    }
  };

  const onReload = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || t.busy) return;
    const r = await tryReload();
    setNote(r.kind === "ok" ? `読み直しました（何も書いていません）。まだ処理していない明細 ${r.list.rows.length}件` : r.kind === "off" ? null : r.message);
  };

  const tried = info?.items ?? [];
  const nameOf = (id: number) => {
    const c = candidates.find((x) => x.raw.id === id);
    return c ? `${ACCOUNT_LABEL[c.row.account]} ${md(c.row.date)} ${c.row.text}` : (names[id] ?? `明細 ${id}`);
  };

  return (
    <div className="ad-review" id="freee">
      <p>
        <span className="tag ok">{settings.label}</span> <span className="hint">経理（テスト用の事業所）につながっています・だれでも試せます</span>
      </p>
      <p className="hint">{restoreNote(holdMinutes)}</p>
      {line && (
        <p className={info?.phase === "repair" ? "problems" : "hint"} role="status">
          {line}
        </p>
      )}

      <div className="freee-try">
        <label>
          <span>試す明細を1件</span>
          <select value={pick ?? ""} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)} disabled={t.busy || blocked || candidates.length === 0}>
            <option value="">{candidates.length ? "選んでください" : "試せる明細はありません"}</option>
            {candidates.map((c) => (
              <option key={c.raw.id} value={c.raw.id}>
                {md(c.row.date)} {ACCOUNT_LABEL[c.row.account]} {c.row.text} {yen(c.row.amount)}
              </option>
            ))}
          </select>
        </label>
        <span className="acct-use" role="group" aria-label="店用か私用か">
          {(["shop", "private"] as const).map((u) => (
            <button
              key={u}
              type="button"
              className={use === u ? `acct-use-btn on ${u}` : "acct-use-btn"}
              aria-pressed={use === u}
              disabled={!chosen || t.busy || blocked || !allowed(u)}
              onClick={() => setUse(u)}
            >
              {USE_LABEL[u]}
            </button>
          ))}
        </span>
        {chosen && !(allowed("shop") && allowed("private")) && <p className="hint">この購入先には自動のルールがあるので、ルールと同じ方だけ選べます。</p>}
      </div>

      <button type="button" className="btn primary big" onClick={onRegister} disabled={t.busy || blocked || !chosen || !use || !allowed(use)}>
        テスト用の事業所に登録
      </button>
      <p className="hint">
        1回に1件です。サーバーが送る直前にテスト用の事業所から読み直し、見本の明細と日付・金額・出金・口座・摘要がちょうど合い、まだ処理していない時だけ登録します。店用は「{settings.accountItemName}」・{settings.taxName}、私用はプライベート取引です。入金は登録しません。
      </p>
      <button type="button" className="btn" onClick={onReload} disabled={t.busy}>
        読み直す
      </button>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {t.busy && (
        <p className="hint" role="status">
          やりとりしています…
        </p>
      )}

      {tried.length > 0 && (
        <section className="acct-service" aria-labelledby="freee-tried">
          <h3 id="freee-tried" className="acct-h3">
            いま試した明細（{tried.length}件）
          </h3>
          <ul className="acct-trial-rows">
            {tried.map((i) => (
              <li key={i.id}>
                <span>
                  {nameOf(i.id)} <span className={`tag use-${i.use}`}>{USE_LABEL[i.use]}</span>
                </span>
                <span className={i.state === "registered" ? "tag ok" : "tag hold"}>{i.state === "registered" ? "登録した" : i.state === "open" ? "まだ処理していない" : "確かめが要る"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="hint">オーナーの帳簿ではなく、この作品のためだけに作ったテスト用の事業所です。「明細を入れる」と「つなぎを外す」は、オーナーのブラウザからだけです。</p>
    </div>
  );
}
