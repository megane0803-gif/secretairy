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
  const [withId, setWithId] = useState(c?.kind === "notTogether" ? c.with : (menus.find((m) => m.id !== menuId)?.id ?? ""));
  const [text, setText] = useState(c?.kind === "text" ? (initial?.label ?? "") : "");
  const [problem, setProblem] = useState<string | null>(null);

  const isText = kind === "text";
  const tabChoices = isText ? [...TAB_IDS] : PROGRAM_TABS;
  const tabValue = tabChoices.includes(tab) ? tab : tabChoices[0];
  const menuName = (id: string) => menus.find((m) => m.id === id)?.name ?? id;

  const scope: RuleScope =
    level === "global" ? { level } : level === "tab" ? { level, tab: tabValue } : { level, menuId };

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
      case "lastStart":
        return time ? { kind, time } : null;
      case "notTogether":
        return withId ? { kind, with: withId } : null;
      case "text":
        return { kind };
    }
  })();
  const label = check ? (check.kind === "text" ? text.trim() : labelFor(scope, check, menuName)) : "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!check) {
      setProblem(
        kind === "lastStart" ? "時刻を入れてください。" : kind === "notTogether" ? "いっしょに入れないメニューを選んでください。" : "数を入れてください。",
      );
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
                  // 組み合わせのルールはメニューに付ける
                  if (k === "notTogether") setLevel("menu");
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
      </fieldset>

      <fieldset>
        <legend>3. {isText ? "ルールの文" : kind === "lastStart" ? "時刻" : kind === "notTogether" ? "いっしょに入れないメニュー" : "数"}</legend>
        {kind === "notTogether" && (
          <div className="num-row">
            <span>{level === "menu" ? menuName(menuId) : "（2. でメニューを選ぶ）"}と</span>
            <select value={withId} onChange={(e) => setWithId(e.target.value)} aria-label="いっしょに入れないメニュー">
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
        {kind === "notTogether" && level !== "menu" && <small className="hint">この種類は「メニュー」に付けます。</small>}
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
        {kind === "noSameDay" && <p className="hint">数は要りません。来店と同じ日の予約は受けません。</p>}
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
