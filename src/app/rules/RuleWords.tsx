"use client";

// 「言葉で書いて欄を埋める」：100字までの文（例「カラーの後は15分あける」）を AI（Haiku。/api/ai/rules）が読み、
// 下の足す欄（種類・どこに効くか・メニュー・数）を埋めるだけ。AI は保存しない。足すのは人の「足す」ボタン（今の確かめを通す）。
// 保存の前に、もとの文と読み取った結果（種類・数と単位・効く所・メニュー）を並べて出す。
// 文の一部しか表せないときは埋めずに「この部分はまだ足せません」。効く所・メニュー・単位があいまいなときは聞き返す
// （答えもサーバーの /api/ai/rules でもう一度確かめる。そのときは AI を呼ばない）。
// 🔒 を緩める文は欄を埋めずに理由をつけて断り、日誌に1行。今の種類に当てはまらなければ「まだ足せません」。
// AI が使えないときは、この欄を出さない（手で足す欄はそのまま）。

import type { Menu } from "@/lib/settings";
import { useId, useState } from "react";
import { writeJournal } from "@/lib/journal";
import { lockedConflict } from "@/lib/rules/validate";
import { AI_BUSY_MESSAGE, failText } from "@/lib/ai/busy";
import { askRuleWords } from "@/lib/rules/client";
import type { RuleDraft, RuleReading, RuleWordsRequest, WordsAnswers, WordsResult } from "@/lib/rules/words";

export function RuleWords({
  maxChars,
  menus,
  onFill,
  onNoAi,
}: {
  maxChars: number;
  /** 今のメニュー（台帳の book.data.menus。ルールのタブで直した時間・最終受付も）。窓口へいっしょに送る */
  menus: Menu[];
  /** 読み取った中身で下の足す欄を埋める（保存はしない）。null = 前に埋めた中身を消す（断った・聞き返し中・まだ足せない） */
  onFill: (draft: RuleDraft | null) => void;
  /** AI につながらなかった（この欄を出さなくする） */
  onNoAi: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // 読んだ文と、聞き返しに答えるときに送り返す読みと答え
  const [asked, setAsked] = useState<{ text: string; reading: RuleReading | null; answers: WordsAnswers } | null>(null);
  const [result, setResult] = useState<WordsResult | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const length = [...text].length;
  const over = length > maxChars;
  const canSend = !busy && text.trim() !== "" && !over;

  const refuse = (sentence: string, reason: string) => {
    setResult({ status: "locked", reason });
    writeJournal({ who: "プログラム", text: `ルールを言葉で足す：🔒 とぶつかるので欄を埋めなかった（「${sentence}」。${reason}）` });
  };

  async function ask(body: RuleWordsRequest) {
    setBusy(true);
    setNote(null);
    try {
      const out = await askRuleWords(body);
      if (!out.ok && out.code === "no-ai") {
        onNoAi();
        return;
      }
      // 混んでいる（429）は欄を隠さず、待ってから押しなおせる。理由の文が無い時は決まった1文（文と前の読みはそのまま）
      if (!out.ok) {
        setNote(out.code === "busy" ? AI_BUSY_MESSAGE : failText(out.message));
        return;
      }
      const r = out.result;
      setResult(r);
      setAsked({ text: body.text, reading: out.reading, answers: body.answers ?? {} });
      if (r.status === "locked") refuse(body.text, r.reason);
      // 前の文で埋めた中身が残らないように、埋めないときは足す欄を空に戻す
      onFill(r.status === "filled" ? r.draft : null);
    } catch {
      onNoAi();
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const sentence = text.replace(/\s+/g, " ").trim();
    if (!sentence || [...sentence].length > maxChars || busy) return;
    setAsked(null);
    // 🔒 を緩める文は送らずに断る（サーバーでも同じように確かめる）
    const locked = lockedConflict(sentence);
    if (locked) {
      setAsked({ text: sentence, reading: null, answers: {} });
      refuse(sentence, locked);
      onFill(null);
      return;
    }
    setResult(null);
    void ask({ mode: "ai", text: sentence, menus });
  }

  // 聞き返しに答える：前の読みと答えをサーバーに送り返し、プログラムでもう一度通す（AI は呼ばない）
  const answer = (key: keyof WordsAnswers, value: string) => {
    if (!asked?.reading || busy) return;
    void ask({ mode: "ai", text: asked.text, reading: asked.reading, answers: { ...asked.answers, [key]: value }, menus });
  };

  const original = asked && (
    <div className="words-original">
      <span className="words-col-head">もとの文</span>
      <p>「{asked.text}」</p>
    </div>
  );

  return (
    <div className="rule-words">
      <form
        className="memo-throw"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send();
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
            placeholder="例：カラーの後は15分あける"
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
        <small className="hint">AI は下の欄を埋めるだけで、足しません。見直して「足す」を押したときだけ足します。1文に1つの決まりを書いてください。</small>
      </form>

      {note && (
        <p className="form-problem" role="alert">
          {note}
        </p>
      )}

      {result?.status === "filled" && (
        <div className="verdict ok" role="status">
          <p className="verdict-head">こう読みました（下の欄に入れました）</p>
          <div className="words-compare">
            {original}
            <div>
              <span className="words-col-head">読み取った結果</span>
              <dl className="words-rows">
                {result.rows.map((r) => (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <p className="hint">ちがうときは、下の欄で直してから「足す」を押してください。</p>
        </div>
      )}
      {result?.status === "ask" && (
        <div className="verdict" role="status">
          <p className="verdict-head">{result.question}</p>
          {original}
          <div className="form-buttons">
            {result.choices.map((c) => (
              <button key={`${c.key}:${c.answer}`} type="button" className="btn" disabled={busy} onClick={() => answer(c.key, c.answer)}>
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
      {result?.status === "partial" && (
        <div className="verdict ng" role="status">
          <p className="verdict-head">この部分はまだ足せません</p>
          {original}
          <ul className="words-summary">
            {result.parts.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="hint">{result.message.replace(/^この部分はまだ足せません。/, "")}</p>
        </div>
      )}
      {(result?.status === "unsupported" || result?.status === "cannot") && (
        <div className="verdict ng" role="status">
          <p className="verdict-head">{result.status === "unsupported" ? "まだ足せません" : "欄を埋めませんでした"}</p>
          {original}
          <p>{result.message}</p>
        </div>
      )}
      {result?.status === "locked" && (
        <div className="verdict ng" role="alert">
          <p className="verdict-head">🔒 欄を埋めませんでした</p>
          {original}
          <p>{result.reason}</p>
        </div>
      )}
    </div>
  );
}
