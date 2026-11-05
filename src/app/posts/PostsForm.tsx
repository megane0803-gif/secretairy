"use client";

// 発信のタブの右の列：①種類を選ぶ ②材料を入れて「下書きを作る」。
// 材料・お店のメモ（全部）・ルールを /api/ai/posts へ送り、言葉の門を通った下書きに、
// 空き枠の日時（台帳から）・お休みの日付（材料に書いた日付を先に。無ければ店の設定から）・ブログのリンクの印をこの画面で入れて、真ん中に出す。
// 材料のお休みの日付を読み取れなかった時は推して入れず（空き枠も入れない）、ぶつかる所があれば「確かめてください」を出す。
// 2回とも門に当たったら下書きは出さず、真ん中と日誌に「作れませんでした」（手で直した下書きがあれば消さずに残す）。
// 手で直した下書きがある時に「下書きを作る」を押したら、先に「作り直すと今の下書きが置き換わります」と聞く（戻る／作り直す）。

import { useState } from "react";
import { Fold } from "@/components/parts";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import type { PostMemo } from "@/lib/data/types";
import { writeJournal } from "@/lib/journal";
import { askPostDraft } from "@/lib/posts/client";
import { getPostsDesk, setPostsDesk, usePostsDesk } from "@/lib/posts/deskStore";
import { CLOSED_UNREADABLE, readOwnerClosed } from "@/lib/posts/closed";
import { CAUTION_HEAD, CLOSED_FROM_LABEL, fillPost, periodOf, postFacts } from "@/lib/posts/facts";
import { gatePost } from "@/lib/posts/gate";
import { afterFailedRedo, needsRedoConfirm, REDO_CONFIRM } from "@/lib/posts/redo";
import type { PostsMode } from "@/lib/posts/wire";
import { COULD_NOT_WRITE } from "@/lib/posts/write";
import { useRules } from "@/lib/rules/useRules";
import type { PostsSettings } from "@/lib/settings";

const INSERT_JOURNAL = { openings: "空き枠の日時（台帳から）", blogLink: "ブログのリンクの印" } as const;

export function PostsForm({ data, settings, memos, maxChars }: { data: BookData; settings: PostsSettings; memos: PostMemo[]; maxChars: number }) {
  const desk = usePostsDesk();
  /** 手で直した下書きがある時に、作り直すか聞いている間の作る物 */
  const [asking, setAsking] = useState<PostsMode | null>(null);
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  const kind = settings.kinds.find((k) => k.id === desk.kind) ?? null;
  const materials = (kind && desk.materials[kind.id]) || {};
  const first = kind?.materials[0];
  const over = kind ? kind.materials.some((f) => [...(materials[f.id] ?? "")].length > maxChars) : false;
  const can = !!kind && !!first && !!materials[first.id]?.trim() && !over && !desk.busy;

  const setMaterial = (id: string, v: string) =>
    kind && setPostsDesk((s) => ({ materials: { ...s.materials, [kind.id]: { ...(s.materials[kind.id] ?? {}), [id]: v } } }));

  async function make(useMode: PostsMode) {
    if (!kind || desk.busy) return;
    setPostsDesk(() => ({ busy: true, failed: null, problem: null, mode: useMode }));
    writeJournal({ who: "オーナー", text: `${kind.label}の下書きを頼んだ（${useMode === "script" ? "決まった返事・AI なし" : "AI"}）` });
    const res = await askPostDraft({ mode: useMode, kind: kind.id, materials, memos, rules: rules.filter((r) => !r.locked) });
    if (!res.ok) {
      if (res.code === "no-ai") {
        writeJournal({ who: "プログラム", text: `${NO_AI_MESSAGE}でした。${kind.label}の下書きは作っていません` });
        setPostsDesk(() => ({ busy: false, noAi: true }));
        return;
      }
      if (res.code === "bad-request") {
        setPostsDesk((s) => ({ busy: false, noAi: useMode === "ai" ? false : s.noAi, problem: `うまくいきませんでした。${res.message}。` }));
        return;
      }
      writeJournal(...res.steps);
      setPostsDesk((s) => ({ busy: false, noAi: false, ...afterFailedRedo(s.draft, { kind: kind.id, problems: res.problems, checks: res.checks }) }));
      return;
    }
    // 受け取った下書きを、この画面でももう一度門で確かめてから出す
    const again = gatePost(res.text, settings.gateWords);
    if (!again.ok) {
      writeJournal(...res.steps, { who: "プログラム", text: `画面の確認で弾いた：${again.problems.join("。")}（${kind.label}の下書きを${COULD_NOT_WRITE}）` });
      setPostsDesk((s) => ({ busy: false, ...afterFailedRedo(s.draft, { kind: kind.id, problems: again.problems, checks: again.checks }) }));
      return;
    }
    // 材料に時期（「年末」など）があれば、その時期の日から空き枠とお休みを出す。材料に書いたお休みの日付は先に使う
    const period = periodOf(kind.materials.map((f) => materials[f.id] ?? "").join(" "), book.today.date, settings.periods);
    const owner = readOwnerClosed(kind.materials.map((f) => materials[f.id] ?? "").join("\n"), book.today.date);
    const facts = postFacts(book.shop, settings, book.today, book.now, book.all, period, owner);
    const filled = fillPost(res.text, kind, facts);
    const put = filled.inserted.filter((i) => !(facts.unreadable && (i === "openings" || i === "closed")));
    const putLabel = (i: (typeof put)[number]) => (i === "closed" ? CLOSED_FROM_LABEL[facts.closedFrom] : INSERT_JOURNAL[i]);
    writeJournal(
      ...res.steps,
      ...(put.length ? [{ who: "プログラム" as const, text: `${kind.label}の下書きに入れた：${put.map(putLabel).join("・")}${period ? `（時期「${period.label}」の日から）` : ""}` }] : []),
      ...(facts.unreadable
        ? [{ who: "プログラム" as const, text: `${kind.label}の下書き：材料のお休みの日付を読み取れなかったので、お休みは「${CLOSED_UNREADABLE}」とし、空き枠も入れなかった（推して入れていない）` }]
        : []),
      ...facts.cautions.map((c) => ({ who: "プログラム" as const, text: `${kind.label}の下書き：${CAUTION_HEAD}${c}` })),
    );
    setPostsDesk((s) => ({
      busy: false,
      noAi: useMode === "ai" ? false : s.noAi,
      failed: null,
      draft: {
        kind: kind.id,
        text: filled.text,
        made: filled.text,
        checks: again.checks,
        inserted: filled.inserted,
        tries: res.tries,
        cut: res.cut,
        mode: useMode,
        topic: materials[first?.id ?? ""] ?? "",
        closedFrom: facts.closedFrom,
        unreadable: facts.unreadable,
        cautions: facts.cautions,
      },
    }));
  }

  /** 「下書きを作る」：手で直した下書きがあれば、すぐ作らずに先に聞く */
  function request(useMode: PostsMode) {
    if (needsRedoConfirm(getPostsDesk().draft)) {
      setAsking(useMode);
      return;
    }
    void make(useMode);
  }

  return (
    <div className="posts-form">
      <fieldset className="posts-step">
        <legend>① 種類を選ぶ</legend>
        <div className="scope-row" role="radiogroup" aria-label="下書きの種類">
          {settings.kinds.map((k) => (
            <label key={k.id} className={desk.kind === k.id ? "pill on" : "pill"}>
              <input type="radio" name="post-kind" value={k.id} checked={desk.kind === k.id} onChange={() => setPostsDesk(() => ({ kind: k.id }))} />
              {k.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="posts-step" disabled={!kind}>
        <legend>② 材料を入れる</legend>
        {!kind ? (
          <p className="hint">先に種類を選んでください。</p>
        ) : (
          <>
            {kind.materials.map((f, i) => {
              const v = materials[f.id] ?? "";
              const n = [...v].length;
              return (
                <label key={`${kind.id}-${f.id}`} className="posts-field">
                  <span className="karte-memo-label">
                    {f.label}
                    {i > 0 && <small className="hint">（なくてもよい）</small>}
                  </span>
                  <textarea rows={i === 0 ? 2 : 3} value={v} placeholder={f.placeholder} onChange={(e) => setMaterial(f.id, e.target.value)} />
                  <span className={n > maxChars ? "karte-count over" : "karte-count"}>
                    <span className="num">{n}</span>/{maxChars}字
                  </span>
                </label>
              );
            })}
            <p className="hint">
              長さの目安：{kind.targetChars}字前後・{kind.shape}
            </p>
          </>
        )}
      </fieldset>

      <Fold summary={`お店のメモ（架空・${memos.length}つ）`}>
        <ul className="posts-memos">
          {memos.map((m) => (
            <li key={m.id}>
              <strong>{m.title}</strong>
              <span className="tag fictional">架空</span>
              <span>{m.text}</span>
            </li>
          ))}
        </ul>
      </Fold>

      <div className="chat-mode" role="group" aria-label="下書きを作る物">
        <button type="button" className={desk.mode === "ai" ? "chat-mode-on" : "chat-mode-off"} aria-pressed={desk.mode === "ai"} onClick={() => setPostsDesk(() => ({ mode: "ai" }))}>
          AI（Claude）
        </button>
        <button
          type="button"
          className={desk.mode === "script" ? "chat-mode-on" : "chat-mode-off"}
          aria-pressed={desk.mode === "script"}
          onClick={() => setPostsDesk(() => ({ mode: "script" }))}
        >
          決まった返事（AI なし）
        </button>
      </div>
      <button type="button" className="btn primary big" onClick={() => request(desk.mode)} disabled={!can || asking !== null}>
        {desk.busy ? "下書きを作っています…" : "下書きを作る"}
      </button>
      {asking && (
        <div className="posts-confirm" role="alertdialog" aria-label={REDO_CONFIRM}>
          <p>{REDO_CONFIRM}</p>
          <div className="posts-buttons">
            <button type="button" className="btn" onClick={() => setAsking(null)}>
              戻る
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const m = asking;
                setAsking(null);
                void make(m);
              }}
            >
              作り直す
            </button>
          </div>
        </div>
      )}
      {desk.problem && (
        <p className="problems" role="status">
          {desk.problem}
        </p>
      )}
      {desk.noAi && (
        <div className="noai" role="alert">
          <strong>{NO_AI_MESSAGE}</strong>
          <span>保存した下書き・日誌など、ほかの画面はそのまま使えます。</span>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setPostsDesk(() => ({ noAi: false, mode: "script" }));
              request("script");
            }}
            disabled={!can || asking !== null}
          >
            決まった返事で試す（AI なし）
          </button>
        </div>
      )}
    </div>
  );
}
