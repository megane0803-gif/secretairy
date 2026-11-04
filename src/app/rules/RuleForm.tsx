"use client";

// ルールを足す・直す入力欄。「種類を選んで、どこに効くか（メニューなど）と数を入れる」だけ。
// 型に入らない決まりは「文（AI が読む）」を選んで書く。文は Claude への指示に入る。

import { useId, useState } from "react";
import { formatMinutes, KIND_INFO, labelFor, scopeTag } from "@/lib/rules/describe";
import type { Rule, RuleCheck, RuleKind, RuleScope } from "@/lib/rules/types";
import { PROGRAM_KINDS } from "@/lib/rules/types";
import { LIMITS, PROGRAM_TABS, validateOwnerRule } from "@/lib/rules/validate";
import { TAB_IDS, TABS, type TabId } from "@/lib/tabs";

export type MenuOption = { id: string; name: string };

const KINDS: RuleKind[] = [...PROGRAM_KINDS, "text"];
type Unit = "分" | "時間" | "日";
const UNIT_MIN: Record<Unit, number> = { 分: 1, 時間: 60, 日: 1440 };

function splitLead(m: number): { num: string; unit: Unit } {
  // 表の文（formatMinutes）と同じく、1日ちょうどは「24時間」で出す
  if (m >= 2880 && m % 1440 === 0) return { num: String(m / 1440), unit: "日" };
  if (m % 60 === 0) return { num: String(m / 60), unit: "時間" };
  return { num: String(m), unit: "分" };
}

function newId(): string {
  return `own-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function RuleForm({
  menus,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  menus: MenuOption[];
  initial?: Rule;
  submitLabel: string;
  onSubmit: (r: Rule) => void;
  onCancel?: () => void;
}) {
  const uid = useId();
  const c = initial?.check;
  const [kind, setKind] = useState<RuleKind>(c?.kind ?? "minLeadMinutes");
  const [level, setLevel] = useState<Rule["level"]>(initial?.level ?? "global");
  const [tab, setTab] = useState<TabId>(initial?.level === "tab" ? initial.tab : "reservations");
  const [menuId, setMenuId] = useState(initial?.level === "menu" ? initial.menuId : (menus[0]?.id ?? ""));
  const lead = c?.kind === "minLeadMinutes" ? splitLead(c.value) : { num: "", unit: "時間" as Unit };
  const [num, setNum] = useState(
    c?.kind === "minLeadMinutes"
      ? lead.num
      : c?.kind === "maxNewCustomersPerDay" || c?.kind === "bufferAfterMinutes"
        ? String(c.value)
        : "",
  );
  const [unit, setUnit] = useState<Unit>(lead.unit);
  const [time, setTime] = useState(c?.kind === "lastStart" ? c.time : "18:00");
  // 「いっしょに受けない組み合わせ」の2つ目のメニュー（1つ目はどこに効くかのメニュー）
  const [withId, setWithId] = useState(c?.kind === "notTogether" ? c.with : "");
  const [text, setText] = useState(c?.kind === "text" ? (initial?.label ?? "") : "");
  const [problem, setProblem] = useState<string | null>(null);

  const isText = kind === "text";
  const tabChoices = isText ? [...TAB_IDS] : PROGRAM_TABS;
  const tabValue = tabChoices.includes(tab) ? tab : tabChoices[0];
  const menuName = (id: string) => menus.find((m) => m.id === id)?.name ?? id;

  // 「いっしょに受けない組み合わせ」は2つのメニューを選ぶ種類なので、いつもメニューに付ける（1つ目のメニュー）
  const isPair = kind === "notTogether";
  const pairWith = withId && withId !== menuId ? withId : (menus.find((m) => m.id !== menuId)?.id ?? "");
  const scope: RuleScope =
    isPair || level === "menu" ? { level: "menu", menuId } : level === "global" ? { level } : { level, tab: tabValue };

  const n = Number(num);
  const check: RuleCheck | null = (() => {
    switch (kind) {
      case "minLeadMinutes":
        return num.trim() ? { kind, value: Math.round(n * UNIT_MIN[unit]) } : null;
      case "maxNewCustomersPerDay":
      case "bufferAfterMinutes":
        return num.trim() ? { kind, value: n } : null;
      case "noSameDay":
        return { kind };
      case "notTogether":
        return pairWith ? { kind, with: pairWith } : null;
      case "lastStart":
        return time ? { kind, time } : null;
      case "text":
        return { kind };
    }
  })();
  const label = check ? (check.kind === "text" ? text.trim() : labelFor(scope, check, menuName)) : "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!check) {
      setProblem(kind === "lastStart" ? "時刻を入れてください。" : isPair ? "2つのメニューを選んでください。" : "数を入れてください。");
      return;
    }
    const v = validateOwnerRule(
      { ...scope, id: initial?.id ?? newId(), label, check },
      menus.map((m) => m.id),
    );
    if (!v.ok) {
      setProblem(v.reason);
      return;
    }
    setProblem(null);
    onSubmit(v.value);
    if (!initial) {
      setText("");
    }
  };

  return (
    <form className="ruleform" onSubmit={submit} noValidate>
      <fieldset>
        <legend>1. 種類</legend>
        <div className="choices">
          {KINDS.map((k) => (
            <label key={k} className={k === kind ? "choice on" : "choice"}>
              <input
                type="radio"
                name={`${uid}-kind`}
                value={k}
                checked={k === kind}
                onChange={() => {
                  setKind(k);
                  setNum("");
                  setProblem(null);
                }}
              />
              <span className="choice-name">{KIND_INFO[k].name}</span>
              <small>例：{KIND_INFO[k].example}</small>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>2. どこに効くか</legend>
        {isPair && <p className="hint">メニューごとのルールです（下の 3. で選ぶ1つ目のメニューに付けます）。2つのどちらを頼まれたときにも効きます。</p>}
        {!isPair && (
        <>
        <div className="scope-row">
          {(["global", "tab", "menu"] as const).map((lv) => (
            <label key={lv} className={lv === level ? "pill on" : "pill"}>
              <input type="radio" name={`${uid}-level`} value={lv} checked={lv === level} onChange={() => setLevel(lv)} />
              {lv === "global" ? "全体" : lv === "tab" ? "タブ" : "メニュー"}
            </label>
          ))}
        </div>
        {level === "tab" && (
          <select value={tabValue} onChange={(e) => setTab(e.target.value as TabId)} aria-label="どのタブ">
            {tabChoices.map((t) => (
              <option key={t} value={t}>
                {TABS[t].label}
              </option>
            ))}
          </select>
        )}
        {level === "tab" && !isText && <small className="hint">この種類は予約の判定で使うので、タブは「予約」だけです。</small>}
        {level === "menu" && (
          <select value={menuId} onChange={(e) => setMenuId(e.target.value)} aria-label="どのメニュー">
            {menus.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        </>
        )}
      </fieldset>

      <fieldset>
        <legend>3. {isText ? "ルールの文" : kind === "lastStart" ? "時刻" : isPair ? "2つのメニュー" : kind === "noSameDay" ? "数は要りません" : "数"}</legend>
        {isPair && (
          <div className="num-row">
            <select value={menuId} onChange={(e) => setMenuId(e.target.value)} aria-label="1つ目のメニュー">
              {menus.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span>と</span>
            <select value={pairWith} onChange={(e) => setWithId(e.target.value)} aria-label="2つ目のメニュー">
              {menus
                .filter((m) => m.id !== menuId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
            <span>は同じ日に受けない</span>
          </div>
        )}
        {isPair && (
          <p className="hint">1回の来店の組み合わせにも、同じお客様のその日のほかの予約にも効きます。</p>
        )}
        {kind === "minLeadMinutes" && (
          <div className="num-row">
            <span>来店の</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={num}
              onChange={(e) => setNum(e.target.value)}
              aria-label="何分・何時間・何日"
            />
            <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} aria-label="単位">
              <option>分</option>
              <option>時間</option>
              <option>日</option>
            </select>
            <span>前まで</span>
          </div>
        )}
        {kind === "maxNewCustomersPerDay" && (
          <div className="num-row">
            <span>1日</span>
            <input
              type="number"
              inputMode="numeric"
              min={LIMITS.maxNewCustomersPerDay.min}
              max={LIMITS.maxNewCustomersPerDay.max}
              value={num}
              onChange={(e) => setNum(e.target.value)}
              aria-label="何人まで"
            />
            <span>人まで</span>
          </div>
        )}
        {kind === "bufferAfterMinutes" && (
          <div className="num-row">
            <span>後に</span>
            <input
              type="number"
              inputMode="numeric"
              min={LIMITS.bufferAfterMinutes.min}
              max={LIMITS.bufferAfterMinutes.max}
              value={num}
              onChange={(e) => setNum(e.target.value)}
              aria-label="何分あけるか"
            />
            <span>分あける</span>
          </div>
        )}
        {kind === "lastStart" && (
          <div className="num-row">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="最終受付の時刻" />
            <span>までに始める</span>
          </div>
        )}
        {kind === "noSameDay" && <p className="hint">来店と同じ日（当日）の予約は受けません。メニューに付けると、そのメニューを含む組み合わせにも効きます。</p>}
        {isText && (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={LIMITS.textLength}
              placeholder="例：日曜は新しいお客様を受けない"
              aria-label="ルールの文"
            />
            <small className="hint">
              文のルールはプログラムでは確かめず、AI（Claude）への指示に入れます。AI の答えは承認の箱を通るので、最後は人が見ます。
            </small>
          </>
        )}
      </fieldset>

      {label && (
        <p className="preview">
          こう入ります：<strong>{label}</strong> <span className="tag">{scopeTag(scope, menuName)}</span>
          {kind === "minLeadMinutes" && check && "value" in check && check.value >= 60 && (
            <small>（{formatMinutes(check.value)}＝{check.value}分）</small>
          )}
        </p>
      )}
      {problem && (
        <p className="form-problem" role="alert">
          うまくいきませんでした。{problem}
        </p>
      )}
      <div className="form-buttons">
        <button type="submit" className="btn primary">
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            やめる
          </button>
        )}
      </div>
    </form>
  );
}
