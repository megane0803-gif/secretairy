"use client";

// カルテのタブの右の列：施術のメモ。スマホのキーボードの音声入力で話して入れる前提。
// PC では、下の「録音からメモを作る」で作った要点もここに入る（その時だけメモの上限を広げる：recordingMaxChars）。
// 「カルテにする」で /api/ai/karte に、メモとこのブラウザのルールを送る（お客様の名前は送らない）。
// 返ってきた案は真ん中に大きいカードで出る。保存は真ん中の「保存」（人のボタン）だけ。

import { CustomerName } from "@/components/parts";
import { AI_BUSY_MESSAGE, failText } from "@/lib/ai/busy";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import type { BookData } from "@/lib/book/data";
import type { KarteExample } from "@/lib/data/types";
import { getDesk, setDesk } from "@/lib/karte/deskStore";
import { removedSentence } from "@/lib/karte/gate";
import { askKarte } from "@/lib/karte/client";
import type { KarteMode, KarteRequest } from "@/lib/karte/wire";
import { writeJournal } from "@/lib/journal";
import { useRules } from "@/lib/rules/useRules";
import { useKarteToday } from "./useKarteToday";
import { DEMO_TAG_NOTE } from "@/lib/notices";

export function KarteMemo({
  data,
  examples,
  maxChars: baseMaxChars,
  recordingMaxChars,
}: {
  data: BookData;
  examples: KarteExample[];
  maxChars: number;
  /** 録音から作ったメモの時だけの上限（字） */
  recordingMaxChars?: number;
}) {
  const { book, desk, selected, key, saved, memo } = useKarteToday(data);
  const { rules } = useRules(data.seedRules);

  if (!selected || !key)
    return <p className="empty">今日のお客様（確定の予約）がいないので、メモを書く方がいません。</p>;

  const fromRecording = desk.sources?.[key] === "recording" && typeof recordingMaxChars === "number";
  const maxChars = fromRecording ? Math.max(baseMaxChars, recordingMaxChars) : baseMaxChars;
  const who = `${selected.customer.surname}（架空）様`;
  const length = [...memo].length;
  const over = length > maxChars;
  const example = examples.find((e) => e.customerId === selected.customer.id);
  const locked = !!saved;
  const canMake = !locked && !desk.busy && memo.trim() !== "" && !over;

  // 手で入れた・例文を入れた時は、録音の印を外す（空にした時も）。録音のメモを手で直した時は印を残す
  const setMemo = (text: string, keepSource = true) =>
    setDesk((s) => {
      const sources = { ...(s.sources ?? {}) };
      if (!keepSource || !text.trim()) delete sources[key];
      return { memos: { ...s.memos, [key]: text }, sources };
    });

  async function make(mode: KarteMode) {
    const text = (getDesk().memos[key!] ?? "").trim();
    if (!text || [...text].length > maxChars || getDesk().busy) return;
    setDesk(() => ({ busy: true, problem: null, mode }));
    const body: KarteRequest = { mode, memo: text, rules: rules.filter((r) => !r.locked), ...(fromRecording ? { source: "recording" as const } : {}) };
    try {
      const out = await askKarte(body);
      if (!out.ok && out.code === "no-ai") {
        setDesk(() => ({ noAi: true }));
        return;
      }
      // 混んでいる（429）・理由の文が無い：メモと今の案はそのまま、1文だけ出す（「undefined」を出さない）
      if (!out.ok) {
        setDesk(() => ({ problem: out.code === "busy" ? AI_BUSY_MESSAGE : failText(out.message) }));
        return;
      }
      const draft = out;
      setDesk((s) => ({ drafts: { ...s.drafts, [key!]: { ...draft, memo: text } }, noAi: mode === "ai" ? false : s.noAi }));
      const lines = Object.values(draft.sections).reduce((n, l) => n + l.length, 0);
      writeJournal(
        {
          who: mode === "ai" ? "AI" : "プログラム",
          text: `カルテの案を作った（${who}・${lines}行${mode === "script" ? "・決まった返事" : ""}${fromRecording ? "・録音の要点から" : ""}。保存は人が押す）`,
        },
        ...draft.removed.map((r) => ({
          who: "プログラム" as const,
          text: `言葉の門：${who}のカルテの案から${removedSentence(r)}：[${r.heading}] ${r.line}`,
        })),
      );
    } catch {
      setDesk(() => ({ noAi: true }));
    } finally {
      setDesk(() => ({ busy: false }));
    }
  }

  return (
    <form
      className="karte-memo"
      onSubmit={(e) => {
        e.preventDefault();
        if (canMake) void make(desk.mode);
      }}
    >
      <p className="karte-memo-who">
        <CustomerName surname={selected.customer.surname} fictional={selected.customer.fictional} />
        <span className="hint">
          {book.today.label} {selected.start} {selected.menu.name}
        </span>
      </p>
      <label className="karte-memo-label" htmlFor="karte-memo-text">
        施術後のメモ
      </label>
      <textarea
        id="karte-memo-text"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        rows={9}
        readOnly={locked}
        aria-describedby="karte-memo-count karte-memo-voice"
        placeholder="例：来た時は根元が5センチくらい伸びてて…（スマホのキーボードのマイクで話して入れられます）"
      />
      <p id="karte-memo-count" className={over ? "karte-count over" : "karte-count"}>
        <span className="num">{length}</span>/{maxChars}字{fromRecording && "（録音の要点）"}{over && "（多すぎます。短くしてください）"}
      </p>
      {locked && <p className="hint">このメモは保存したので変えません（カルテは、保存したカルテの見出しの「直す」で直せます）。</p>}
      <p id="karte-memo-voice" className="hint">
        スマホのキーボードの音声入力（マイクのボタン）で話して入れられます。PC では、下の「録音からメモを作る」で作った要点も入れられます。
      </p>

      <div className="chat-mode" role="group" aria-label="カルテの案を作る物">
        <button
          type="button"
          className={desk.mode === "ai" ? "chat-mode-on" : "chat-mode-off"}
          aria-pressed={desk.mode === "ai"}
          onClick={() => setDesk(() => ({ mode: "ai" }))}
        >
          AI（Claude）
        </button>
        <button
          type="button"
          className={desk.mode === "script" ? "chat-mode-on" : "chat-mode-off"}
          aria-pressed={desk.mode === "script"}
          onClick={() => setDesk(() => ({ mode: "script" }))}
          title="AI を使わず、決まった返事で同じ流れ（見出しに分ける → 言葉の門）を試します"
        >
          決まった返事（AI なし）
        </button>
      </div>

      {desk.noAi && (
        <div className="noai" role="alert">
          <strong>{NO_AI_MESSAGE}</strong>
          <span>台帳・承認の箱・前回までのカルテなど、ほかの画面はそのまま使えます。</span>
          <button
            type="button"
            className="btn small"
            disabled={!canMake}
            onClick={() => {
              setDesk(() => ({ noAi: false }));
              void make("script");
            }}
          >
            決まった返事で試す（AI なし）
          </button>
        </div>
      )}
      {desk.problem && (
        <p className="form-problem" role="status">
          {desk.problem}
        </p>
      )}

      <div className="form-buttons">
        {/* 「例文を入れる」（架空の話し言葉の例）は試すための物なので「デモ」の札を付ける */}
        <span className="tag text" title={DEMO_TAG_NOTE}>
          デモ<span className="sr-only">（{DEMO_TAG_NOTE}）</span>
        </span>
        <button
          type="button"
          className="btn"
          disabled={locked || !example || desk.busy}
          title={example ? "この方の話し言葉の例文をメモに入れます" : "この方の例文はありません"}
          onClick={() => example && setMemo(example.memo, false)}
        >
          例文を入れる
        </button>
        <button type="submit" className="btn primary" disabled={!canMake}>
          {desk.busy ? "作っています…" : "カルテにする"}
        </button>
      </div>
      <p className="hint">
        お客様の名前は AI に送りません（カルテにはプログラムが入れます）。AI の案は、言葉の門（プログラム）を通してから真ん中に出ます。保存は人が押すまでしません。
      </p>
    </form>
  );
}
