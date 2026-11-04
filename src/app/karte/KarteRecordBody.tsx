"use client";

// カルテの中身を見出しごとに出す（見るだけ）・カルテ1枚の中身（人が保存した物は直せる）。
// カルテのタブの真ん中（今日のカルテ・前回までのカルテ）と、お客様一覧が同じ物を使う。

import type { BookData } from "@/lib/book/data";
import { calDay } from "@/lib/calendar";
import { cleanSections, type KarteSections } from "@/lib/karte/format";
import type { KarteRecord } from "@/lib/karte/record";
import type { KarteEditSettings, KarteHeading } from "@/lib/settings";
import { SavedKarteEditor } from "./KarteDraftEditor";

export function KarteSectionsView({ sections, headings, edited }: { sections: KarteSections; headings: KarteHeading[]; edited?: string[] }) {
  return (
    <dl className="karte-sections">
      {headings.map((h) => {
        const lines = sections[h.id] ?? [];
        return (
          <div key={h.id} className={lines.length ? "karte-sec" : "karte-sec empty"}>
            <dt>
              ■ {h.label}
              {edited?.includes(h.id) && <span className="tag ok">人が直した</span>}
            </dt>
            {lines.length ? lines.map((l, i) => <dd key={i}>・{l}</dd>) : <dd className="karte-none">（メモに無し）</dd>}
          </div>
        );
      })}
    </dl>
  );
}

/** 日時の札（例「11/5 14:02」。店の時間帯） */
export function whenLabel(iso: string, timezone: string): string {
  const d = new Date(iso);
  const md = d.toLocaleDateString("ja-JP", { timeZone: timezone, month: "numeric", day: "numeric" });
  const hm = d.toLocaleTimeString("ja-JP", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${md} ${hm}`;
}

/** カルテ1枚の中身。人が保存したカルテも最初の状態のカルテも、見出しごとに直せる */
export function KarteRecordBody({
  karte,
  data,
  headings,
  editLimits,
  surname,
  onDone,
}: {
  karte: KarteRecord;
  data: BookData;
  headings: KarteHeading[];
  editLimits: KarteEditSettings;
  surname: string;
  onDone?: (text: string) => void;
}) {
  return (
    <SavedKarteEditor
      karte={{ ...karte, sections: cleanSections(karte.sections, headings) }}
      headings={headings}
      limits={editLimits}
      surname={surname}
      dateLabel={calDay(data.shop, karte.date).label}
      whenLabel={(iso) => whenLabel(iso, data.shop.timezone)}
      onDone={onDone}
    />
  );
}

