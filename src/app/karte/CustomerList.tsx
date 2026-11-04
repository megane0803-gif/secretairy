"use client";

// カルテのタブの「お客様一覧」：全員（みな架空）を出し、名字で探す（部分一致）・50音の行で絞る（プログラム。AI は使わない）。
// 1人を開くと、そのお客様の過去のカルテ（最初の状態の物と人が保存した物）を新しい順に並べ、「次回話すこと」も出す。
// 人が保存したカルテは見出しごとに直せる（KarteRecordBody）。

import { useState } from "react";
import { CustomerName } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { calDay } from "@/lib/calendar";
import { resolveMenu } from "@/lib/combo";
import { filterCustomers, KANA_ROWS, kanaRowOf, type KanaRowId } from "@/lib/karte/customers";
import { kartesOf, nextLines } from "@/lib/karte/record";
import type { KarteEditSettings, KarteHeading } from "@/lib/settings";
import { useTodos } from "@/lib/todo/useTodos";
import { KarteRecordBody } from "./KarteRecordBody";

export function CustomerList({ data, headings, editLimits }: { data: BookData; headings: KarteHeading[]; editLimits: KarteEditSettings }) {
  const book = useBook(data);
  const { items: todos } = useTodos(data);
  const [query, setQuery] = useState("");
  const [row, setRow] = useState<KanaRowId | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const menuName = (id: string) => resolveMenu(data.menus, id)?.name ?? id;
  const list = filterCustomers(data.customers, query, row);
  const counts = new Map(KANA_ROWS.map((r) => [r.id, data.customers.filter((c) => kanaRowOf(c.kana) === r.id).length]));
  const person = data.customers.find((c) => c.id === open) ?? null;
  const kartes = person ? kartesOf(book.kartes, person.id) : [];
  const latest = kartes[0];
  const talk = latest ? nextLines(latest, headings) : [];
  const talkTodos = person ? todos.filter((t) => t.source === "karte" && t.title.startsWith(`${person.surname}（架空）様：`)) : [];

  return (
    <section className="karte-customers" aria-labelledby="karte-customers-h">
      <h2 id="karte-customers-h">お客様一覧（{data.customers.length}人・みな架空）</h2>
      <div className="karte-customers-find">
        <label htmlFor="karte-customers-q" className="hint">
          名字で探す
        </label>
        <input id="karte-customers-q" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="例：青（名字の一部・よみでも）" />
      </div>
      <div className="karte-kana" role="group" aria-label="50音の行で絞る">
        <button type="button" className={row === null ? "btn small on" : "btn small"} aria-pressed={row === null} onClick={() => setRow(null)}>
          全部
        </button>
        {KANA_ROWS.map((r) => (
          <button
            key={r.id}
            type="button"
            className={row === r.id ? "btn small on" : "btn small"}
            aria-pressed={row === r.id}
            disabled={(counts.get(r.id) ?? 0) === 0}
            onClick={() => setRow(row === r.id ? null : r.id)}
            title={`${r.label}行（${counts.get(r.id) ?? 0}人）`}
          >
            {r.label}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="empty">当てはまるお客様はいません。</p>
      ) : (
        <ul className="karte-customers-list" role="list">
          {list.map((c) => {
            const n = kartesOf(book.kartes, c.id).length;
            const on = open === c.id;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={on ? "karte-pick on" : "karte-pick"}
                  aria-expanded={on}
                  onClick={() => {
                    setOpen(on ? null : c.id);
                    setDone(null);
                  }}
                >
                  <CustomerName surname={c.surname} fictional={c.fictional} />
                  {c.kana && <small className="hint">{c.kana}</small>}
                  <span className="hint">
                    カルテ <strong className="num">{n}</strong> 枚
                  </span>
                  {c.firstVisit && <span className="slot-first">初めての方</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {person && (
        <div className="karte-customer-open" aria-label={`${person.surname}（架空）様のカルテ`}>
          <h3>
            <CustomerName surname={person.surname} fictional={person.fictional} /> のカルテ（新しい順）
          </h3>
          <div className="karte-talk">
            <p className="hint">次回話すこと（いちばん新しいカルテの次回提案）</p>
            {talk.length ? (
              <ul>
                {talk.map((l, i) => (
                  <li key={i}>・{l}</li>
                ))}
              </ul>
            ) : (
              <p className="empty">{latest ? "次回提案は空です。" : "前回の記録なし"}</p>
            )}
            {talkTodos.length > 0 && (
              <ul className="karte-talk-todos">
                {talkTodos.map((t) => (
                  <li key={t.id}>
                    <span className={t.done ? "tag" : "tag ok"}>{t.done ? "ToDo 済み" : "ToDo"}</span> {t.title}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {kartes.length === 0 ? (
            <p className="empty">カルテはまだありません。</p>
          ) : (
            <ol className="karte-past-list">
              {kartes.map((k) => (
                <li key={k.id} className="karte-card past">
                  <p className="karte-card-head">
                    <span className="num">{calDay(data.shop, k.date).label}</span> {menuName(k.menuId)}{" "}
                    <span className="tag">{k.source === "seed" ? "最初の状態" : "人が保存"}</span>
                  </p>
                  <KarteRecordBody karte={k} data={data} headings={headings} editLimits={editLimits} surname={person.surname} onDone={setDone} />
                </li>
              ))}
            </ol>
          )}
          {done && (
            <p className="hint" role="status">
              {done}
            </p>
          )}
        </div>
      )}
      <p className="hint">名字の一部（よみでも）で探せます。50音の行は名字のよみで分けています。</p>
    </section>
  );
}
