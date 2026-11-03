"use client";

import { useRef, useState } from "react";

type Msg = { from: "guest" | "ai" | "note"; text: string };

/**
 * 予約チャットの「練習モード」の枠。本物のチャット（AI につなぐ・仮押さえ）はまだ作っていない。
 * 打った文はこの画面を開いている間だけ出る。どこにも送らない・残さない。
 */
export function PracticeChat({ shopName }: { shopName: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "ai", text: `${shopName} の予約の係です。ご希望のメニューと日にちを教えてください。` },
  ]);
  const [text, setText] = useState("");
  const logRef = useRef<HTMLOListElement>(null);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setMsgs((m) => [
      ...m,
      { from: "guest", text: t },
      { from: "note", text: "練習モードの枠だけです。ここに AI の返事が出ます（まだ AI にはつながっていません）" },
    ]);
    setText("");
    requestAnimationFrame(() => logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" }));
  };

  return (
    <div className="chat">
      <div className="chat-mode" role="group" aria-label="チャットのモード">
        <span className="chat-mode-on" aria-current="true">
          練習モード
        </span>
        <span className="chat-mode-off" title="まだ作っていません">
          本番（まだ）
        </span>
      </div>
      <p className="chat-note">練習モードでは本物の予約は入りません。お客様にも届きません。</p>
      <ol className="chat-log" ref={logRef} aria-live="polite">
        {msgs.map((m, i) => (
          <li key={i} className={`bubble ${m.from}`}>
            <span className="bubble-who">{m.from === "guest" ? "お客様（練習）" : m.from === "ai" ? "AI" : "お知らせ"}</span>
            {m.text}
          </li>
        ))}
      </ol>
      <form className="chat-input" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例：土曜の午後にカットをお願いしたいです"
          rows={2}
          aria-label="お客様のつもりで書く"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(e);
          }}
        />
        <button type="submit" disabled={!text.trim()}>
          送る
        </button>
      </form>
    </div>
  );
}
