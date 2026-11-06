"use client";

// 「メモを投げる」：思いついたことを1行で投げると、Claude（Haiku。/api/ai/todo）が短いタスクの文に直し、
// プログラムが ToDo の「投げたメモ」に足す（鍵は「メモ:番号」。元のメモはそのまましまい、行の印を押すと開く）。
// Claude が決めるのは文だけ（期限・並べ方・出どころはプログラム）。お客様の名字は〔お客様〕に置きかえてから送る。
// ホームと ToDo のタブ（PC は右の列・スマホはページの上）に1つずつ置く。Enter でも投げられる。
// 入力欄の下に種類の札を4つ（お客様・仕入れと材料・お店のこと・お金と事務）。1つだけ選べ、もう一度押すと外す。
// 選ばなくても送れる（ToDo の「その他」の箱に入る）。種類はオーナーが選んだ物だけで、AI には送らない・決めさせない。

import { useId, useState } from "react";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import type { BookData } from "@/lib/book/data";
import { writeJournal } from "@/lib/journal";
import { useRules } from "@/lib/rules/useRules";
import { memoDue } from "@/lib/todo/due";
import { KIND_LABEL, MEMO_KINDS, type MemoKind } from "@/lib/todo/kinds";
import { maskNames, restoreNames } from "@/lib/todo/names";
import { commitMemoTodo } from "@/lib/todo/throw";
import { useTodos } from "@/lib/todo/useTodos";
import type { TodoMode, TodoRequest, TodoResponse } from "@/lib/todo/wire";

/** label・hideLabel は渡した時だけ使う（ホームは欄の題名を外に出すので、入力欄の名前は読み上げだけにする） */
export function MemoThrow({ data, maxChars, label = "メモを投げる", hideLabel = false }: { data: BookData; maxChars: number; label?: string; hideLabel?: boolean }) {
  const id = useId();
  const todos = useTodos(data);
  const { rules } = useRules(data.seedRules);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<TodoMode>("ai");
  const [busy, setBusy] = useState(false);
  const [noAi, setNoAi] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [kind, setKind] = useState<MemoKind | null>(null);

  const length = [...text].length;
  const over = length > maxChars;
  const canSend = !busy && text.trim() !== "" && !over;

  async function send(how: TodoMode) {
    const memo = text.replace(/\s+/g, " ").trim();
    if (!memo || [...memo].length > maxChars || busy) return;
    setBusy(true);
    setNote(null);
    const { masked, found } = maskNames(memo, data.customers);
    const body: TodoRequest = { mode: how, memo: masked, rules: rules.filter((r) => !r.locked) };
    try {
      const res = await fetch("/api/ai/todo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let out: TodoResponse | null = null;
      try {
        out = (await res.json()) as TodoResponse;
      } catch {
        out = null;
      }
      if (!out || (!out.ok && out.code === "no-ai")) {
        setNoAi(true);
        return;
      }
      if (!out.ok) {
        setNote(`うまくいきませんでした。${out.message}。`);
        return;
      }
      const title = restoreNames(out.title, memo, found);
      // 書けた時だけ日誌・「足しました」・入力を空に（todo/throw.ts）。書けなかった時は入力と種類を残す
      const r = commitMemoTodo(
        { update: todos.book.update, journal: writeJournal },
        { title, memo, due: memoDue(memo, todos.today), category: kind, via: out.via, how, note: out.note, seedItems: todos.seedItems, shop: data.shop, nowIso: new Date().toISOString() },
      );
      setNote(r.message);
      if (!r.ok) return;
      setText("");
      setKind(null);
      if (how === "ai") setNoAi(false);
    } catch {
      setNoAi(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="memo-throw"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) void send(mode);
      }}
    >
      <label htmlFor={`${id}-text`} className={hideLabel ? "sr-only" : "memo-throw-label"}>
        {label}
      </label>
      <div className="memo-throw-row">
        <input
          id={`${id}-text`}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例：カラー剤の7番が少ない"
          aria-describedby={`${id}-count`}
          enterKeyHint="send"
          autoComplete="off"
        />
        <button type="submit" className="btn primary" disabled={!canSend}>
          {busy ? "直しています…" : "投げる"}
        </button>
      </div>
      <div className="memo-kinds" role="group" aria-label="種類（選ばなくても送れます。選ばなければ その他）">
        {MEMO_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={kind === k ? "memo-kind on" : "memo-kind"}
            aria-pressed={kind === k}
            onClick={() => setKind((v) => (v === k ? null : k))}
          >
            {kind === k && <span aria-hidden>✓ </span>}
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <p id={`${id}-count`} className={over ? "karte-count over" : "karte-count"}>
        <span className="num">{length}</span>/{maxChars}字{over && "（多すぎます。短くしてください）"}
      </p>
      <div className="chat-mode" role="group" aria-label="メモを直す物">
        <button type="button" className={mode === "ai" ? "chat-mode-on" : "chat-mode-off"} aria-pressed={mode === "ai"} onClick={() => setMode("ai")}>
          AI（Claude）
        </button>
        <button
          type="button"
          className={mode === "script" ? "chat-mode-on" : "chat-mode-off"}
          aria-pressed={mode === "script"}
          onClick={() => setMode("script")}
          title="AI を使わず、メモの最初の文をそのまま ToDo にします"
        >
          決まった返事（AI なし）
        </button>
      </div>
      {noAi && (
        <div className="noai" role="alert">
          <strong>{NO_AI_MESSAGE}</strong>
          <span>ToDo の一覧・チェックはそのまま使えます。</span>
          <button
            type="button"
            className="btn small"
            disabled={!canSend}
            onClick={() => {
              setNoAi(false);
              void send("script");
            }}
          >
            決まった返事で足す（AI なし）
          </button>
        </div>
      )}
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </form>
  );
}
