"use client";

// ホームの「今日の注意」（朝の要点の AI の一言）：今日の予約・承認待ち・ToDo から、気をつける点を数個まで Claude（Haiku）が書く。
// 送るのは印（【予約1】など）と、名前を〔お客様〕にした材料だけ。日時・数字・お名前はプログラムが印から入れる。
// 言葉の門（サーバーと、ここでもう一度）を通った行だけ出す。🔒 健康の判断はしない・確定はしない。
// AI につながらない時は、この欄ごと出さない。同じ材料では、画面を開いている間はもう一度呼ばない。
// 欄は畳める（RememberFold）。閉じてもこの部品は外さないので、閉じた・開いたで呼び直さない。

import { useEffect, useMemo, useState } from "react";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { gateBriefLine } from "@/lib/brief/gate";
import { briefKey, briefMaterial, fillMarks } from "@/lib/brief/items";
import type { BriefResponse, BriefResult } from "@/lib/brief/wire";
import { calDay } from "@/lib/calendar";
import { resolveMenu } from "@/lib/combo";
import { writeJournal } from "@/lib/journal";
import { useRules } from "@/lib/rules/useRules";
import type { BriefAiSettings, KarteHeading } from "@/lib/settings";
import { useTodos } from "@/lib/todo/useTodos";
import { useApprovals } from "@/lib/useApprovals";
import { ActorTag, Checked } from "@/components/parts";
import { RememberFold } from "@/components/RememberFold";

/** 画面を開いている間だけ覚える（同じ材料で何回も呼ばない）。null = AI につながらなかった */
const cache = new Map<string, BriefResult | null>();

export function BriefNotes({ data, headings, limits }: { data: BookData; headings: KarteHeading[]; limits: Omit<BriefAiSettings, "model"> }) {
  const book = useBook(data);
  const approvals = useApprovals();
  const { items: todos } = useTodos(data);
  const { rules } = useRules(data.seedRules);

  const material = useMemo(
    () =>
      briefMaterial({
        today: book.today.date,
        todays: book.all.filter((r) => r.date === book.today.date),
        kartes: book.kartes,
        headings,
        approvals,
        todos,
        customers: data.customers,
        menuName: (id) => resolveMenu(data.menus, id)?.name ?? id,
        dayLabel: (d) => calDay(data.shop, d).label,
        maxItems: limits.maxItems,
        maxItemChars: limits.maxItemChars,
      }),
    [book.today.date, book.all, book.kartes, headings, approvals, todos, data, limits],
  );
  const ownerRules = rules.filter((r) => !r.locked);
  const key = material.items.length ? briefKey(material.items, ownerRules) : "";
  const [result, setResult] = useState<{ key: string; value: BriefResult | null } | null>(null);

  useEffect(() => {
    if (!key) return;
    if (cache.has(key)) {
      setResult({ key, value: cache.get(key) ?? null });
      return;
    }
    let stop = false;
    // 材料が少しずつ変わる間は待つ（何回も呼ばない）
    const t = window.setTimeout(async () => {
      let value: BriefResult | null = null;
      try {
        const res = await fetch("/api/ai/brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "ai", items: material.items, rules: ownerRules }),
        });
        const out = (await res.json()) as BriefResponse;
        value = out.ok ? { mode: out.mode, notes: out.notes, dropped: out.dropped } : null;
      } catch {
        value = null;
      }
      cache.set(key, value);
      if (stop) return;
      setResult({ key, value });
      if (value)
        writeJournal(
          { who: "AI", text: `朝の要点の一言を書いた（${value.notes.length}行。日時・お名前はプログラムが入れる）` },
          ...value.dropped.map((d) => ({ who: "プログラム" as const, text: `言葉の門：朝の一言から1行を外した（${d.reason}）` })),
        );
    }, 1200);
    return () => {
      stop = true;
      window.clearTimeout(t);
    };
  }, [key]);

  const value = result && result.key === key ? result.value : null;
  // 画面でももう一度門を通し、印を日時・お名前に置きかえる
  const lines = (value?.notes ?? [])
    .filter((n) => gateBriefLine(n, material.items, limits.maxNoteChars) === null)
    .map((n) => fillMarks(n, material.labels))
    .filter((n): n is string => n !== null)
    .slice(0, limits.maxNotes);
  // AI につながらない・まだ届いていない・材料が無い時は、欄ごと出さない
  if (!key || !value || lines.length === 0) return null;

  return (
    <RememberFold
      id="notes"
      className="brief brief-ai"
      title="今日の注意"
      tag={<ActorTag actor="ai" />}
      count={`${lines.length}つ`}
      desc="今日の予約（前回のカルテを含む）・承認待ち・ToDo から、AI が気をつける事を選びました"
    >
      <ul className="brief-ai-list">
        {lines.map((l, i) => (
          <li key={i}>・{l}</li>
        ))}
      </ul>
      <Checked>日時・お名前はプログラムが入れました。言葉の門を通した行だけ出しています（健康の判断はしません）</Checked>
    </RememberFold>
  );
}
