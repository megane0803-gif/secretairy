// 慣れていない人でも読める形の小さな部品。
// 数字は大きく、棒は小さく、確認は ✓、細かい所は畳む。

import type { ReactNode } from "react";
import { ACTOR_LABEL, ACTOR_MEANING, type Actor } from "@/lib/actors";

/** 大きな数字。go を渡すと、押せるカードの印（「↓ 見る」など）を右に添える（リンクで包むのは使う側） */
export function BigNumber({ label, value, unit, go }: { label: string; value: number; unit?: string; go?: string }) {
  return (
    <div className="bignum">
      <span className="bignum-label">{label}</span>
      <span className="bignum-value num">{value.toLocaleString("ja-JP")}</span>
      {unit && <span className="bignum-unit">{unit}</span>}
      {go && (
        <span className="bignum-go" aria-hidden>
          {go}
        </span>
      )}
    </div>
  );
}

/** 小さな棒。value / max の割合で横にのびる */
export function MiniBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="minibar" role="img" aria-label={`${label} ${value}/${max}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 小さな縦棒（週ごとなど）。いちばん大きい値の高さを 100% にする */
export function MiniColumns({ values, labels, label }: { values: number[]; labels: string[]; label: string }) {
  const max = Math.max(0, ...values);
  return (
    <div className="minicols" role="img" aria-label={`${label}：${values.map((v, i) => `${labels[i] ?? ""} ${v}`).join("、")}`}>
      {values.map((v, i) => (
        <span key={i} className="minicol" title={`${labels[i] ?? ""} ${v}`}>
          <span style={{ height: `${max > 0 ? Math.max(4, Math.round((v / max) * 100)) : 0}%` }} />
        </span>
      ))}
    </div>
  );
}

/** プログラムが確かめた印 */
export function Checked({ children }: { children: ReactNode }) {
  return (
    <p className="checked">
      <span aria-hidden>✓</span> {children}
    </p>
  );
}

/** 細かい所（畳んでおく） */
export function Fold({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="fold">
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}

/** まだ作っていない所の目印 */
export function NotYet({ children }: { children?: ReactNode }) {
  return <p className="notyet">{children ?? "ここはまだ作っていません"}</p>;
}

/**
 * 右の列の箱。tag（だれの欄かの札）と desc（題名の下の1行）は、渡した時だけ出す（ホーム）。
 * 渡さないタブは今までどおり題名だけ。
 */
export function Panel({ title, id, tag, desc, children }: { title: string; id?: string; tag?: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel" id={id}>
      {tag || desc ? <SectionHead title={title} tag={tag} desc={desc} /> : <h2>{title}</h2>}
      {children}
    </section>
  );
}

/**
 * 欄の題名＋だれの札＋題名の下の1行（ホーム）。畳まない欄に使う（畳む欄は RememberFold.tsx）。
 * aside は題名の行の右に出す物（「翌日へ」のボタンなど）。
 */
export function SectionHead({
  title,
  id,
  level = 2,
  tag,
  desc,
  aside,
}: {
  title: ReactNode;
  id?: string;
  level?: 2 | 3;
  tag?: ReactNode;
  desc?: ReactNode;
  aside?: ReactNode;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <>
      <div className="section-head">
        <H id={id} className="section-title">
          {title}
        </H>
        {tag}
        {aside && <span className="section-aside">{aside}</span>}
      </div>
      {desc && <p className="section-desc">{desc}</p>}
    </>
  );
}

/** プログラムがした事の札（日誌と同じ灰色。色だけに頼らず「プログラム」の文字） */
export function ProgramTag() {
  return (
    <span className="tag who who-program" title="プログラムがした事">
      プログラム
    </span>
  );
}

/** 右の列の入力欄（今は押せない） */
export function InputStub({ placeholder, button }: { placeholder: string; button: string }) {
  return (
    <form className="inputstub" aria-disabled>
      <textarea placeholder={placeholder} rows={3} disabled />
      <button type="button" disabled>
        {button}
      </button>
    </form>
  );
}

/** お客様の名前（「青木 様」）。架空であることは名前ごとではなく、入力欄の近くの注意の1行で伝える（docs/SPEC.md §3.3） */
export function CustomerName({ surname }: { surname: string }) {
  return (
    <span className="customer">
      {surname} 様
    </span>
  );
}

/**
 * だれがしたかの札（AI＝青緑・人＝琥珀・外＝藍）。色だけに頼らず「AI」「人」「外」の文字を必ず出す。
 * children を渡すと、文字のあとに添える（「人 オーナー」など）。使うのは台帳・AI の手順・日誌と、ホームの欄の題名（src/lib/actors.ts）。
 * note を渡した時だけ、ホバーの説明と読み上げに添える（「AI なしの時は決まった返事」など）。
 */
export function ActorTag({ actor, note, children }: { actor: Actor; note?: string; children?: ReactNode }) {
  return (
    <span className={`tag actor actor-${actor}`} title={note ? `${ACTOR_MEANING[actor]}（${note}）` : ACTOR_MEANING[actor]}>
      <b className="actor-mark">{ACTOR_LABEL[actor]}</b>
      {children && <> {children}</>}
      {note && <span className="sr-only">（{note}）</span>}
    </span>
  );
}

/** 細かい所に入れる「どんな形で持つか」の表 */
export function FieldList({ fields }: { fields: { key: string; label: string }[] }) {
  return (
    <dl className="fields">
      {fields.map((f) => (
        <div key={f.key}>
          <dt>
            <code>{f.key}</code>
          </dt>
          <dd>{f.label}</dd>
        </div>
      ))}
    </dl>
  );
}
