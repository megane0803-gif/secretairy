// 慣れていない人でも読める形の小さな部品。
// 数字は大きく、棒は小さく、確認は ✓、細かい所は畳む。

import type { ReactNode } from "react";

export function BigNumber({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div className="bignum">
      <span className="bignum-label">{label}</span>
      <span className="bignum-value num">{value}</span>
      {unit && <span className="bignum-unit">{unit}</span>}
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

/** 右の列の箱 */
export function Panel({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section className="panel" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
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

/** お客様の名前。架空のお客様には必ず「架空」の札を付ける */
export function CustomerName({ surname, fictional }: { surname: string; fictional: boolean }) {
  return (
    <span className="customer">
      {surname} 様{fictional && <span className="tag fictional">架空</span>}
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
