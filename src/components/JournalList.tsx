"use client";

// 日誌：道具を呼んだ・ルールで弾かれた・人が押した・ルールを足した／直した／消した、を時刻つきで新しい順に。
// 新しい5行だけを出し、残りは畳む（JOURNAL_SHOW）。行の頭に、だれがしたかの札を付ける：
// AI = 青緑「AI」・オーナー = 琥珀「人」・LINE = 藍「外」（src/lib/actors.ts）。プログラムは今までどおりの灰色の札「プログラム」。

import { journalActor } from "@/lib/actors";
import { JOURNAL_SHOW, type JournalEntry } from "@/lib/journal";
import { useJournal } from "@/lib/useJournal";
import { ActorTag, Fold } from "./parts";

function when(iso: string, timezone: string): string {
  const d = new Date(iso);
  const md = d.toLocaleDateString("ja-JP", { timeZone: timezone, month: "numeric", day: "numeric" });
  const hm = d.toLocaleTimeString("ja-JP", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${md} ${hm}`;
}

/** 日誌の「だれ」の札。AI・人・外は色と文字の両方で（「AI」「人 オーナー」「外 LINE」）、プログラムは今までどおり */
export function JournalWhoTag({ who }: { who: JournalEntry["who"] }) {
  const actor = journalActor(who);
  if (!actor) return <span className="tag who who-program">{who}</span>;
  return <ActorTag actor={actor}>{actor === "ai" ? null : who}</ActorTag>;
}

function Rows({ list, timezone }: { list: ReturnType<typeof useJournal>; timezone: string }) {
  return (
    <ol className="journal">
      {list.map((e) => (
        <li key={e.id}>
          <JournalWhoTag who={e.who} />
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
      <p className="hint">日誌はこのブラウザの中だけに残ります。札：AI＝AI がした事・人＝人が押した事・外＝外の相手（LINE）から来た事・プログラム＝プログラムがした事。</p>
    </>
  );
}
