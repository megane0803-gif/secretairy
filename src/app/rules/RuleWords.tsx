"use client";

// 「言葉で書いて欄を埋める」：100字までの文（例「縮毛矯正の日は前後を3時間あける」）を AI（Haiku。/api/ai/rules）が読み、
// 下の足す欄（種類・どこに効くか・メニュー・数）を埋めるだけ。AI は保存しない。足すのは人の「足す」ボタン（今の確かめを通す）。
// 数と単位はプログラムが文から読み直して「3時間（180分）」の形で出す。単位が無ければ聞き返す。
// 🔒 を緩める文は欄を埋めずに理由をつけて断り、日誌に1行。今の種類に当てはまらなければ「まだ足せません」。
// AI が使えないときは、この欄を出さない（手で足す欄はそのまま）。

import { useId, useState } from "react";
import { writeJournal } from "@/lib/journal";
import { lockedConflict } from "@/lib/rules/validate";
import {
  interpretWords,
  type RuleDraft,
  type RuleReading,
  type RuleWordsRequest,
  type RuleWordsResponse,
  type WordsMenu,
  type WordsResult,
} from "@/lib/rules/words";

export function RuleWords({
  menus,
  maxChars,
  onFill,
  onNoAi,
}: {
  menus: WordsMenu[];
  maxChars: number;
  /** 読み取った中身で下の足す欄を埋める（保存はしない）。null = 前に埋めた中身を消す（断った・聞き返し中・まだ足せない） */
  onFill: (draft: RuleDraft | null) => void;
  /** AI につながらなかった（この欄を出さなくする） */
  onNoAi: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // 聞き返しに答えるときは、同じ文と読みをプログラムに通しなおす（AI はもう呼ばない）
  const [asked, setAsked] = useState<{ text: string; reading: RuleReading } | null>(null);
  const [result, setResult] = useState<WordsResult | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const length = [...text].length;
  const over = length > maxChars;
  const canSend = !busy && text.trim() !== "" && !over;

  const refuse = (sentence: string, reason: string) => {
    setResult({ status: "locked", reason });
    writeJournal({ who: "プログラム", text: `ルールを言葉で足す：🔒 とぶつかるので欄を埋めなかった（「${sentence}」。${reason}）` });
  };

  const show = (sentence: string, reading: RuleReading | null, r: WordsResult) => {
    setResult(r);
    setAsked(r.status === "ask" && reading ? { text: sentence, reading } : null);
    if (r.status === "locked") refuse(sentence, r.reason);
    // 前の文で埋めた中身が残らないように、埋めないときは足す欄を空に戻す
    onFill(r.status === "filled" ? r.draft : null);
  };

  async function send() {
    const sentence = text.replace(/\s+/g, " ").trim();
    if (!sentence || [...sentence].length > maxChars || busy) return;
    setNote(null);
    setAsked(null);
    // 🔒 を緩める文は送らずに断る（サーバーでも同じように確かめる）
    const locked = lockedConflict(sentence);
    if (locked) {
      refuse(sentence, locked);
      onFill(null);
      return;
    }
    setBusy(true);
    setResult(null);
    const body: RuleWordsRequest = { mode: "ai", text: sentence };
    try {
      const res = await fetch("/api/ai/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      let out: RuleWordsResponse | null = null;
      try {
        out = (await res.json()) as RuleWordsResponse;
      } catch {
        out = null;
      }
      if (!out || (!out.ok && out.code === "no-ai")) {
        onNoAi();
        return;
      }
      if (!out.ok) {
        setNote(`うまくいきませんでした。${out.message}。`);
        return;
      }
      show(sentence, out.reading, out.result);
    } catch {
      onNoAi();
    } finally {
      setBusy(false);
    }
  }

  const answer = (a: string) => {
    if (!asked) return;
    show(asked.text, asked.reading, interpretWords(asked.text, asked.reading, menus, a));
  };

  return (
    <div className="rule-words">
      <form
        className="memo-throw"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) void send();
        }}
      >
        <label htmlFor={`${id}-text`} className="memo-throw-label">
          言葉で書いて欄を埋める（AI）
        </label>
        <div className="memo-throw-row">
          <input
            id={`${id}-text`}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例：縮毛矯正の日は前後を3時間あける"
            aria-describedby={`${id}-count`}
            enterKeyHint="send"
            autoComplete="off"
          />
          <button type="submit" className="btn primary" disabled={!canSend}>
            {busy ? "読んでいます…" : "欄を埋める"}
          </button>
        </div>
        <p id={`${id}-count`} className={over ? "karte-count over" : "karte-count"}>
          <span className="num">{length}</span>/{maxChars}字{over && "（多すぎます。短くしてください）"}
        </p>
        <small className="hint">AI は下の欄を埋めるだけで、足しません。見直して「足す」を押したときだけ足します。</small>
      </form>

      {note && <p className="form-problem" role="alert">{note}</p>}

      {result?.status === "filled" && (
        <div className="verdict ok" role="status">
          <p className="verdict-head">こう読みました（下の欄に入れました）</p>
          <ul className="words-summary">
            {result.summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {result.readback && (
            <p>
              数の読み直し：<strong className="num">{result.readback}</strong>
            </p>
          )}
          {result.notes.map((n) => (
            <p key={n} className="hint">
              {n}
            </p>
          ))}
          {result.problem && <p className="form-problem">このままでは足せません。{result.problem}</p>}
          <p className="hint">ちがうときは、下の欄で直してから「足す」を押してください。</p>
        </div>
      )}
      {result?.status === "ask" && (
        <div className="verdict" role="status">
          <p className="verdict-head">{result.question}</p>
          <div className="form-buttons">
            {result.choices.map((c) => (
              <button key={c.answer} type="button" className="btn" onClick={() => answer(c.answer)}>
                {c.label}
              </button>
            ))}
            <button
              type="button"
              className="btn"
              onClick={() => {
                setResult(null);
                setAsked(null);
              }}
            >
              やめる
            </button>
          </div>
        </div>
      )}
      {result?.status === "unsupported" && (
        <div className="verdict ng" role="status">
          <p className="verdict-head">{result.message}</p>
          <p className="hint">文のまま AI に読ませたいときは、下の欄で「文（AI が読む）」を選んで書けます。</p>
        </div>
      )}
      {result?.status === "locked" && (
        <div className="verdict ng" role="alert">
          <p className="verdict-head">🔒 欄を埋めませんでした</p>
          <p>{result.reason}</p>
        </div>
      )}
    </div>
  );
}
