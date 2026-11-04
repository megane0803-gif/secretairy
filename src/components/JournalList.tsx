"use client";

// 日誌：道具を呼んだ・ルールで弾かれた・人が押した・ルールを足した／直した／消した、を時刻つきで新しい順に。
// 新しい5行だけを出し、残りは畳む。行の頭に、だれがしたかの札（AI・人・プログラム・外）を付ける（色だけに頼らず文字で）。

import { JOURNAL_SHOW, journalWhoKind } from "@/lib/journal";
import { useJournal } from "@/lib/useJournal";
import { Fold, WhoMark } from "./parts";

function when(iso: string, timezone: string): string {
  const d = new Date(iso);
  const md = d.toLocaleDateString("ja-JP", { timeZone: timezone, month: "numeric", day: "numeric" });
  const hm = d.toLocaleTimeString("ja-JP", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${md} ${hm}`;
}

const TITLE = { AI: "AI がした事", オーナー: "人（オーナー）がした事", プログラム: "プログラムがした事", LINE: "外の相手（LINE）から来た事" } as const;

function Rows({ list, timezone }: { list: ReturnType<typeof useJournal>; timezone: string }) {
  return (
    <ol className="journal">
      {list.map((e) => (
        <li key={e.id}>
          <WhoMark who={journalWhoKind(e.who)} title={TITLE[e.who]} />
          <time className="num" dateTime={e.at}>
            {when(e.at, timezone)}
          </time>
          <span className="journal-text">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function JournalList({ timezone }: { timezone: string }) {
  const list = useJournal();
  if (list.length === 0) return <p className="empty">まだありません。AI が道具を呼ぶ・人がボタンを押すと、ここに1行ずつ入ります。</p>;
  return (
    <>
      <Rows list={list.slice(0, JOURNAL_SHOW)} timezone={timezone} />
      {list.length > JOURNAL_SHOW && (
        <Fold summary={`前の日誌（${list.length - JOURNAL_SHOW}行）`}>
          <Rows list={list.slice(JOURNAL_SHOW)} timezone={timezone} />
        </Fold>
      )}
      <p className="hint">日誌はこのブラウザの中だけに残ります。札：AI＝AI がした事・人＝人が押した事・プログラム＝プログラムがした事・外＝外の相手（LINE）から来た事。</p>
    </>
  );
}
