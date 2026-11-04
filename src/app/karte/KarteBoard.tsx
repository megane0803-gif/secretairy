"use client";

// カルテのタブの真ん中：今日の予約のお客様（架空）・カルテの案（大きいカード1枚）・前回までのカルテ。
// カルテのお客様の名前・日付・メニューは、選んだ予約からプログラムが入れる（Claude には書かせない）。
// 🔒 保存は人の「保存」ボタンだけ（ブラウザの本物の操作か isTrusted で確かめる）。AI・自動の処理からは保存しない。

import { resolveMenu } from "@/lib/combo";
import { CustomerName, Fold } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import { calDay } from "@/lib/calendar";
import { setDesk } from "@/lib/karte/deskStore";
import { cleanSections, type KarteSections } from "@/lib/karte/format";
import { gateKarte, removedSentence } from "@/lib/karte/gate";
import { kartesOf, nextTalkTitle, withKarteSaved, type SaveOutcome, type SavedKarte } from "@/lib/karte/record";
import { writeJournal } from "@/lib/journal";
import type { KarteHeading } from "@/lib/settings";
import { useState } from "react";
import { useKarteToday } from "./useKarteToday";

export function KarteSectionsView({ sections, headings }: { sections: KarteSections; headings: KarteHeading[] }) {
  return (
    <dl className="karte-sections">
      {headings.map((h) => {
        const lines = sections[h.id] ?? [];
        return (
          <div key={h.id} className={lines.length ? "karte-sec" : "karte-sec empty"}>
            <dt>■ {h.label}</dt>
            {lines.length ? lines.map((l, i) => <dd key={i}>・{l}</dd>) : <dd className="karte-none">（メモに無し）</dd>}
          </div>
        );
      })}
    </dl>
  );
}

export function KarteBoard({ data, headings }: { data: BookData; headings: KarteHeading[] }) {
  const { book, desk, todays, selected, key, saved, draft } = useKarteToday(data);
  const [done, setDone] = useState<string | null>(null);
  const menuName = (id: string) => resolveMenu(data.menus, id)?.name ?? id;

  const save = (e: React.MouseEvent) => {
    // 人がボタンを押したときだけ（スクリプトから押したことにはできない）
    if (!e.nativeEvent.isTrusted || !selected || !key || !draft) return;
    const c = selected.customer;
    // 保存する直前に、もう一度言葉の門を通す（同じ結果になる。ブラウザの中で書きかえられていても外す）
    const sections = gateKarte(cleanSections(draft.sections, headings), draft.memo, headings).sections;
    const now = new Date().toISOString();
    const k: SavedKarte = {
      id: `k-${book.today.date}-${c.id}-${Date.now().toString(36)}`,
      customerId: c.id,
      date: book.today.date,
      menuId: selected.menu.id,
      reservationId: selected.id,
      memo: draft.memo,
      sections,
      savedAt: now,
    };
    let out: SaveOutcome | null = null;
    book.update((s) => {
      out = withKarteSaved(s, k, c.surname, headings);
      return out.state;
    });
    const result = out as SaveOutcome | null;
    const who = `${c.surname}（架空）様`;
    if (!result || !result.ok) {
      setDone(result?.reason ?? "保存できませんでした。もう一度押してください。");
      return;
    }
    const todoText =
      result.todo !== null
        ? `ToDo「次回話すこと」に1件足した：${result.todo.title}`
        : result.todoSkipped === "same"
          ? "ToDo「次回話すこと」は同じ物があるので足さなかった"
          : "次回提案が空なので ToDo には足さなかった";
    writeJournal({ who: "オーナー", text: `人が保存：${who}のカルテ（${book.today.label} ${selected.menu.name}）。${todoText}` });
    setDesk((s) => {
      const drafts = { ...s.drafts };
      delete drafts[key];
      return { drafts };
    });
    setDone(`✓ 保存しました。${todoText}`);
  };

  const cancel = () => {
    if (!key || !selected) return;
    setDesk((s) => {
      const drafts = { ...s.drafts };
      delete drafts[key];
      return { drafts };
    });
    writeJournal({ who: "オーナー", text: `カルテの案をやめた：${selected.customer.surname}（架空）様（保存していない）` });
    setDone("案をやめました。メモはそのまま残っています。");
  };

  const past = selected ? kartesOf(book.kartes, selected.customer.id).filter((k) => k.date < book.today.date) : [];

  return (
    <>
      <h2>今日の予約のお客様（{book.today.label}・みな架空）</h2>
      {book.dayOffset > 0 && <p className="shifted">デモ：「翌日へ」で {book.today.label} を「今日」にしています。</p>}
      {todays.length === 0 ? (
        <p className="empty">今日の予約（確定）はありません。</p>
      ) : (
        <ul className="karte-today" role="list">
          {todays.map((r) => {
            const on = selected?.id === r.id;
            const isSaved = book.state.kartes.some((k) => k.customerId === r.customer.id && k.date === book.today.date);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className={on ? "karte-pick on" : "karte-pick"}
                  aria-pressed={on}
                  onClick={() => {
                    setDesk(() => ({ selected: r.id, problem: null }));
                    setDone(null);
                  }}
                >
                  <span className="num karte-pick-time">{r.start}</span>
                  <CustomerName surname={r.customer.surname} fictional={r.customer.fictional} />
                  <span className="karte-pick-menu">{r.menu.name}</span>
                  {isSaved && <span className="tag ok">保存済み</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <section className="karte-now" aria-label="今日のカルテ">
          {saved ? (
            <article className="karte-card saved">
              <header className="karte-card-head">
                <span className="tag ok">保存済み</span>
                <CustomerName surname={selected.customer.surname} fictional={selected.customer.fictional} />
                <span className="num">{book.today.label}</span>
                <strong>{menuName(saved.menuId)}</strong>
              </header>
              <KarteSectionsView sections={cleanSections(saved.sections, headings)} headings={headings} />
              <p className="hint">人が保存しました。保存したメモは、この日はもう直しません。</p>
              <Fold summary="保存した施術のメモ">
                <p className="karte-memo-text">{saved.memo}</p>
              </Fold>
            </article>
          ) : draft ? (
            <article className="karte-card ai" aria-label="AI のカルテの案">
              <header className="karte-card-head">
                <span className="tag who-ai">{draft.mode === "ai" ? "AI の案" : "決まった返事の案"}</span>
                {/* 名前・日付・メニューはプログラムが入れる（AI は書かない） */}
                <CustomerName surname={selected.customer.surname} fictional={selected.customer.fictional} />
                <span className="num">{book.today.label}</span>
                <strong>{selected.menu.name}</strong>
              </header>
              <p className="karte-before">
                <span className="hint">前：</span>施術のメモ（<span className="num">{[...draft.memo].length}</span>字）
                <span aria-hidden> → </span>
                <span className="hint">後：</span>カルテ（見出し{headings.length}つ）
              </p>
              <KarteSectionsView sections={draft.sections} headings={headings} />
              {draft.removed.length > 0 && (
                <ul className="karte-removed" aria-label="言葉の門で外した行">
                  {draft.removed.map((r, i) => (
                    <li key={i}>
                      <span aria-hidden>✓</span> {removedSentence(r)}
                      <small>
                        [{r.heading}] {r.line}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
              {draft.cut && <p className="problems small">長くなったので、途中までの案です。</p>}
              <p className="karte-why">
                理由：施術のメモを見出しごとに分けました（メモに無いことは足さず、無い見出しは空のまま。プログラムが言葉と数字を確かめました）。
              </p>
              {(() => {
                const t = nextTalkTitle(draft, selected.customer.surname, headings);
                return (
                  <p className="hint">
                    保存すると ToDo「次回話すこと」に{t ? `「${t}」を1件足します` : "は足しません（次回提案が空です）"}。
                  </p>
                );
              })()}
              <div className="approval-buttons" role="group" aria-label="この案をどうするか">
                <button type="button" className="btn primary" onClick={save}>
                  保存
                </button>
                <button type="button" className="btn" onClick={cancel}>
                  やめる
                </button>
              </div>
              <Fold summary="前：施術のメモ（くわしく）">
                <p className="karte-memo-text">{draft.memo}</p>
              </Fold>
            </article>
          ) : (
            <p className="karte-wait">
              右の列（スマホでは下）に施術後のメモを入れて「カルテにする」を押すと、ここにカルテの案が出ます。
            </p>
          )}
          {done && (
            <p className="hint" role="status">
              {done}
            </p>
          )}
          {desk.busy && <p className="hint">カルテの案を作っています…</p>}
        </section>
      )}

      {selected && (
        <section className="karte-past" aria-labelledby="karte-past-h">
          <h2 id="karte-past-h">
            前回までのカルテ（<CustomerName surname={selected.customer.surname} fictional={selected.customer.fictional} />）
          </h2>
          {past.length === 0 ? (
            <p className="empty">前回の記録なし</p>
          ) : (
            <ol className="karte-past-list">
              {past.map((k, i) => {
                const head = (
                  <>
                    <span className="num">{calDay(data.shop, k.date).label}</span> {menuName(k.menuId)}{" "}
                    <span className="tag">{k.source === "seed" ? "最初の状態" : "人が保存"}</span>
                  </>
                );
                return (
                  <li key={k.id} className="karte-card past">
                    {i === 0 ? (
                      <>
                        <p className="karte-card-head">{head}</p>
                        <KarteSectionsView sections={cleanSections(k.sections, headings)} headings={headings} />
                      </>
                    ) : (
                      <details className="fold">
                        <summary>{head}</summary>
                        <KarteSectionsView sections={cleanSections(k.sections, headings)} headings={headings} />
                      </details>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <p className="hint">保存したカルテを新しい順に並べています（AI は使いません）。</p>
        </section>
      )}
    </>
  );
}
