"use client";

// AI の手順：予約チャットの相談ごとに、どの道具で何を調べ、どのルールで外したかを日本語で1行ずつ。

import { useConsultations } from "@/lib/ai/stepsStore";
import { stepWho } from "@/lib/who";
import { Fold, WhoMark } from "./parts";

const KIND: Record<string, string> = { tool: "🔎", reject: "✗", hold: "📌", limit: "⏹", ask: "❓", release: "↩", todo: "📝" };

export function AiSteps() {
  const list = useConsultations();
  if (list.length === 0) return <p className="empty">まだ相談はありません。予約チャットで送ると、ここに手順が出ます。</p>;
  const [latest, ...older] = list;
  const one = (c: (typeof list)[number]) => (
    <>
      <p className="steps-q">
        <WhoMark who="outside" title="お客様（架空）の文" />「{c.question}」
        {c.mode === "script" ? <span className="tag text">決まった返事（AI なし）</span> : <WhoMark who="ai" title="AI（Claude）が返事を作った" />}
      </p>
      {c.steps.length === 0 ? (
        <p className="hint">{c.failed ? "AI につながらなかったので、道具は呼んでいません。" : "道具は呼んでいません。"}</p>
      ) : (
        <ol className="steps">
          {c.steps.map((s, i) => (
            <li key={i} className={`step ${s.kind}`}>
              <WhoMark who={c.mode === "script" && stepWho(s.kind) === "ai" ? "program" : stepWho(s.kind)} /> <span aria-hidden>{KIND[s.kind]}</span> {s.text}
            </li>
          ))}
        </ol>
      )}
    </>
  );
  return (
    <>
      {one(latest)}
      {older.length > 0 && (
        <Fold summary={`前の相談（${older.length}件）`}>
          {older.map((c) => (
            <div key={c.id}>{one(c)}</div>
          ))}
        </Fold>
      )}
    </>
  );
}
