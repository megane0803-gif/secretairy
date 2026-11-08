"use client";

// ホームの「今日の注意」（朝の要点の AI の一言）：今日の予約・承認待ち・ToDo から、気をつける点を数個まで Claude（Haiku）が書く。
// 送るのは印（【予約1】など）と、名前を〔お客様〕にした材料だけ。日時・数字・お名前はプログラムが印から入れる。
// 言葉の門（サーバーと、ここでもう一度）を通った行だけ出す。🔒 健康の判断はしない・確定はしない。
// AI につながらない時は、この欄ごと出さない。同じ材料では、もう一度呼ばない（答えはブラウザに残し、開き直しても使う。brief/cache.ts）。
// 直しY：AI の窓口を呼ぶのは config/ai.json の brief.minIntervalSeconds に1回まで（brief/pace.ts）。その間に材料が変わったら、
// 秒数がたった後に、いちばん新しい材料で1回だけ呼ぶ。待っている間は前に出した一言を出す。開いた時の1回目と「翌日へ」の後は今どおり。
// 欄は畳める（RememberFold）。閉じてもこの部品は外さないので、閉じた・開いたで呼び直さない。

import { useEffect, useMemo, useState } from "react";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { postAi } from "@/lib/ai/busy";
import { briefKey, briefMaterial } from "@/lib/brief/items";
import { briefShown, newBriefPace, shownBriefNotes, wantBrief, type BriefLastShown } from "@/lib/brief/pace";
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

/** 画面を開いている間の覚え（同じ材料で何回も呼ばない）。null = AI につながらなかった・混んでいた（ブラウザには残さない） */
const cache = new Map<string, BriefResult | null>();
/** AI の窓口を最後に呼んだ時刻と、その時の今日（画面を開いている間だけ。ほかのタブへ移って戻っても同じ。読み込み直したら消える） */
const pace = newBriefPace();
/** 最後に出した一言（次の答えを待つ間に出す。ほかのタブへ移って戻った時も） */
let lastShown: BriefLastShown | null = null;

export function BriefNotes({ data, headings, limits }: { data: BookData; headings: KarteHeading[]; limits: Omit<BriefAiSettings, "model"> }) {
  const book = useBook(data);
  const approvals = useApprovals();
  const { items: todos } = useTodos(data);
  const { rules } = useRules(data.seedRules);
  const today = book.today.date;

  const material = useMemo(
    () =>
      briefMaterial({
        today,
        todays: book.all.filter((r) => r.date === today),
        kartes: book.kartes,
        headings,
        approvals,
        todos,
        customers: data.customers,
        menuName: (id) => resolveMenu(book.data.menus, id)?.name ?? id,
        dayLabel: (d) => calDay(data.shop, d).label,
        maxItems: limits.maxItems,
        maxItemChars: limits.maxItemChars,
      }),
    [today, book.all, book.kartes, headings, approvals, todos, data, limits],
  );
  const ownerRules = rules.filter((r) => !r.locked);
  const key = material.items.length ? briefKey(material.items, ownerRules) : "";
  const [result, setResult] = useState<{ key: string; value: BriefResult | null } | null>(null);

  useEffect(() => {
    if (!key) return;
    // AI の窓口に頼む（この材料で）。答え無し（つながらない・混んでいる）は null
    const call = async (): Promise<BriefResult | null> => {
      const res = await postAi("/api/ai/brief", { mode: "ai", items: material.items, rules: ownerRules });
      if (res.kind !== "answer") return null;
      const out = res.data as BriefResponse | null;
      return out && out.ok === true ? { mode: out.mode, notes: out.notes, dropped: out.dropped } : null;
    };
    // 画面の覚え → ブラウザに残した答え → AI の窓口の順（brief/cache.ts の briefAnswer）。窓口を呼ぶ間合いは brief/pace.ts
    return wantBrief(
      key,
      today,
      {
        pace,
        memory: cache,
        max: limits.maxCachedAnswers,
        call,
        minIntervalSeconds: limits.minIntervalSeconds,
        now: () => Date.now(),
        setTimer: (f, ms) => window.setTimeout(f, ms),
        clearTimer: (t) => window.clearTimeout(t),
      },
      ({ value, fresh }) => {
        setResult({ key, value });
        // 日誌は、AI の窓口が答えた時だけ（残した答えを出した時は書かない）
        if (value && fresh)
          writeJournal(
            { who: "AI", text: `朝の要点の一言を書いた（${value.notes.length}行。日時・お名前はプログラムが入れる）` },
            ...value.dropped.map((d) => ({ who: "プログラム" as const, text: `言葉の門：朝の一言から1行を外した（${d.reason}）` })),
          );
      },
    );
  }, [key]);

  const resolved = !!key && result !== null && result.key === key;
  const value = resolved ? result.value : null;
  // 画面でももう一度門を通し、印を日時・お名前に置きかえる。答えを待つ間は、前に出した一言（同じ今日の物だけ）
  const lines = key ? briefShown({ today, resolved, lines: shownBriefNotes(value, material, limits) }, lastShown) : [];
  const shownText = lines.join("\n");
  useEffect(() => {
    // いま出している行を覚える（出していない時は消す：答え無し・材料が無い・今日が変わった後は、待つ間にも出さない）。
    // 行の中身が変わった時だけ（shownText）
    lastShown = lines.length ? { today, lines } : null;
  }, [shownText, today]);
  // AI につながらない・まだ届いていない（前に出した一言も無い）・材料が無い時は、欄ごと出さない
  if (!key || lines.length === 0) return null;

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
