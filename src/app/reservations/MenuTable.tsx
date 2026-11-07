"use client";

// 予約のページの「くわしく」：メニューのかかる時間と最終受付。ルールのタブの「メニュー」で直した分も出す（台帳の book.data.menus から読む）。

import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { lastStartOf } from "@/lib/reservations";

export function MenuTable({ data }: { data: BookData }) {
  const book = useBook(data);
  const menus = book.data.menus;
  const anyClose = Object.values(data.shop.hours).find((h) => h)?.close ?? "";
  return (
    <table className="table">
      <thead>
        <tr>
          <th>メニュー</th>
          <th>かかる時間</th>
          <th>最終受付</th>
        </tr>
      </thead>
      <tbody>
        {menus.map((m) => (
          <tr key={m.id}>
            <td>
              {m.name}
              {m.includes && <small className="hint"> （{m.includes.map((id) => menus.find((x) => x.id === id)?.name ?? id).join("・")}のルールも効く）</small>}
            </td>
            <td className="num">{m.minutes}分</td>
            <td className="num">{lastStartOf(m, anyClose)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
