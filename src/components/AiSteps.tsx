"use client";

// AI の手順：予約チャットの相談ごとに、どの道具で何を調べ、どのルールで外したかを日本語で1行ずつ。
// 各行の頭に短い印（✓ 通った／! 断った・気をつける／→ 次にしたこと。src/lib/ai/stepMarks.ts）。
// だれの札：お客様の文 = 外・AI（決まった返事のときは「決まった返事（AI なし）」）。色だけに頼らず文字を添える（src/lib/actors.ts）。

import { useConsultations, type Consultation } from "@/lib/ai/stepsStore";
import { STEP_MARK, stepMark } from "@/lib/ai/stepMarks";
import type { Step } from "@/lib/ai/wire";
import { ActorTag, Fold } from "./parts";

/** 1行（印 + 文） */
export function StepLine({ step }: { step: Step }) {
  const m = STEP_MARK[stepMark(step)];
  return (
    <li className={`step ${step.kind} mark-${stepMark(step)}`}>
      <span className="step-mark" title={m.label} aria-label={m.label}>
        {m.mark}
      </span>
      <span className="step-text">{step.text}</span>
    </li>
  );
}

/** 1つの相談（お客様の文・AI か決まった返事か・手順の行） */
export function ConsultationSteps({ c }: { c: Consultation }) {
  return (
    <>
      <p className="steps-q">
        <ActorTag actor="outside">お客様</ActorTag>
        <span className="steps-q-text">「{c.question}」</span>
        {c.mode === "script" ? <span className="tag text">決まった返事（AI なし）</span> : <ActorTag actor="ai" />}
      </p>
      {c.steps.length === 0 ? (
        <p className="hint">{c.failed ? "AI につながらなかったので、道具は呼んでいません。" : "道具は呼んでいません。"}</p>
      ) : (
        <ol className="steps">
          {c.steps.map((s, i) => (
            <StepLine key={i} step={s} />
          ))}
        </ol>
      )}
    </>
  );
}

export function AiSteps() {
  const list = useConsultations();
  if (list.length === 0) return <p className="empty">まだ相談はありません。予約チャットで送ると、ここに手順が出ます。</p>;
  const [latest, ...older] = list;
  return (
    <>
      <p className="steps-key hint">
        <span className="step-mark mark-ok">✓</span> 通った　<span className="step-mark mark-warn">!</span> 断った・気をつける
        <span className="step-mark mark-next">→</span> 次にしたこと
      </p>
      <ConsultationSteps c={latest} />
      {older.length > 0 && (
        <Fold summary={`前の相談（${older.length}件）`}>
          {older.map((c) => (
            <div key={c.id}>
              <ConsultationSteps c={c} />
            </div>
          ))}
        </Fold>
      )}
    </>
  );
}
