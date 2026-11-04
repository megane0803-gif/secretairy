"use client";

// 発信のタブの右の列：①種類を選ぶ ②材料を入れて「下書きを作る」。
// 材料・お店のメモ（全部）・ルールを /api/ai/posts へ送り、言葉の門を通った下書きに、
// 空き枠の日時（台帳から）・お休みの日付（設定から）・ブログのリンクの印をこの画面で入れて、真ん中に出す。
// 2回とも門に当たったら下書きは出さず、真ん中と日誌に「作れませんでした」。

import { Fold } from "@/components/parts";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import type { PostMemo } from "@/lib/data/types";
import { writeJournal } from "@/lib/journal";
import { askPostDraft } from "@/lib/posts/client";
import { setPostsDesk, usePostsDesk } from "@/lib/posts/deskStore";
import { fillPost, postFacts } from "@/lib/posts/facts";
import { gatePost } from "@/lib/posts/gate";
import type { PostsMode } from "@/lib/posts/wire";
import { COULD_NOT_WRITE } from "@/lib/posts/write";
import { useRules } from "@/lib/rules/useRules";
import type { PostsSettings } from "@/lib/settings";

const INSERT_JOURNAL = { openings: "空き枠の日時（台帳から）", closed: "お休みの日付（店の設定から）", blogLink: "ブログのリンクの印" } as const;

export function PostsForm({ data, settings, memos, maxChars }: { data: BookData; settings: PostsSettings; memos: PostMemo[]; maxChars: number }) {
  const desk = usePostsDesk();
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
      setPostsDesk(() => ({ busy: false, noAi: false, draft: null, failed: { kind: kind.id, problems: res.problems, checks: res.checks } }));
      return;
    }
    // 受け取った下書きを、この画面でももう一度門で確かめてから出す
    const again = gatePost(res.text, settings.gateWords);
    if (!again.ok) {
      writeJournal(...res.steps, { who: "プログラム", text: `画面の確認で弾いた：${again.problems.join("。")}（${kind.label}の下書きを${COULD_NOT_WRITE}）` });
      setPostsDesk(() => ({ busy: false, draft: null, failed: { kind: kind.id, problems: again.problems, checks: again.checks } }));
      return;
    }
    const facts = postFacts(data.shop, settings, book.today, book.now, book.all);
    const filled = fillPost(res.text, kind, facts);
    writeJournal(...res.steps, ...(filled.inserted.length ? [{ who: "プログラム" as const, text: `${kind.label}の下書きに入れた：${filled.inserted.map((i) => INSERT_JOURNAL[i]).join("・")}` }] : []));
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
      },
    }));
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
      <button type="button" className="btn primary big" onClick={() => void make(desk.mode)} disabled={!can}>
        {desk.busy ? "下書きを作っています…" : "下書きを作る"}
      </button>
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
              void make("script");
            }}
            disabled={!can}
          >
            決まった返事で試す（AI なし）
          </button>
        </div>
      )}
    </div>
  );
}
