"use client";

// 発信のタブ：③見て、手で直して「下書きを保存」（PostsDraft。真ん中の列の「下書きを作る」の下）と、
// 保存した下書きを種類ごとに並べる所（PostsSaved。右の列）。
// 保存はオーナーのボタンだけ（isTrusted で確かめる）。承認の箱は通さない。送信・公開はしない。
// 保存できた時だけ、③の下書きの欄と②の材料の欄を空にする（選んだ種類は残す。posts/save.ts）。保存できなかった時は何も消さない。
// どちらにも「コピー」（クリップボードに入れるだけ。コピーできないブラウザでは文を選ぶ。src/lib/copy.ts）。

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { afterHandEdit, PostTeam } from "@/components/PostTeam";
import type { BookData } from "@/lib/book/data";
import type { PostMemo } from "@/lib/data/types";
import { writeJournal } from "@/lib/journal";
import { CLOSED_UNREADABLE } from "@/lib/posts/closed";
import { setPostsDesk, usePostsDesk } from "@/lib/posts/deskStore";
import { CAUTION_HEAD, CLOSED_FROM_LABEL } from "@/lib/posts/facts";
import { KEPT_AFTER_FAIL } from "@/lib/posts/redo";
import { withHandEdit } from "@/lib/posts/team/state";
import { COULD_NOT_WRITE } from "@/lib/posts/write";
import { draftName } from "@/lib/posts/draftName";
import { savedByKind } from "@/lib/posts/state";
import { browserPostsStore, usePosts } from "@/lib/posts/usePosts";
import { deskAfterSave, savedNote, savePostDraft } from "@/lib/posts/save";
import type { PostInsert, PostsSettings } from "@/lib/settings";

/** 入れた物（ブログのリンクの印は「リンクは印だけ」の ✓ と同じなので出さない） */
const INSERT_LABEL: Partial<Record<PostInsert, string>> = {
  openings: "空き枠の日時（台帳から）",
  closed: CLOSED_FROM_LABEL.shop,
};

/** ✓ に出す言葉（お休みは入れ元で分ける。読み取れなかった時はお休みも空き枠も ✓ にしない） */
function insertLabel(i: PostInsert, draft: { closedFrom?: "materials" | "shop"; unreadable?: boolean }): string | undefined {
  if (draft.unreadable && (i === "openings" || i === "closed")) return undefined;
  return i === "closed" ? CLOSED_FROM_LABEL[draft.closedFrom ?? "shop"] : INSERT_LABEL[i];
}

/** 見て直す所の下書きの欄（コピーできない時に選ぶ先） */
const DRAFT_TEXT_ID = "posts-draft-text";

function timeLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function firstLine(text: string): string {
  const l = text.split("\n").find((x) => x.trim()) ?? "";
  return l.replace(/^#+\s*/, "").slice(0, 40);
}

/** ③ 見て、手で直して保存（真ん中の列。「下書きを作る」のすぐ下） */
export function PostsDraft({ settings, data, memos }: { settings: PostsSettings; data: BookData; memos: PostMemo[] }) {
  const desk = usePostsDesk();
  // draftId：どの下書きの時の1文か（保存して空にした後に新しい下書きを作ったら、前の1文はその下書きのカードに出さない）
  const [note, setNote] = useState<{ ok: boolean; text: string; kindLabel?: string; draftId?: string } | null>(null);
  const draft = desk.draft;
  const kindOf = (id: string) => settings.kinds.find((k) => k.id === id);
  const kind = draft ? kindOf(draft.kind) : null;
  const failedKind = desk.failed ? kindOf(desk.failed.kind) : null;

  const save = (e: React.MouseEvent) => {
    // 🔒 人のボタンだけ
    if (!e.nativeEvent.isTrusted || !draft || !kind) return;
    const r = savePostDraft(
      { ...browserPostsStore, journal: writeJournal },
      {
        draft,
        kindLabel: kind.label,
        id: `po-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        nowIso: new Date().toISOString(),
        gateWords: settings.gateWords,
        maxPerKind: settings.maxSavedPerKind,
      },
    );
    if (!r.ok) {
      // 保存できなかった時は何も消さない（下書きも材料もそのまま）
      setNote({ ok: false, text: r.reason, draftId: draft.id });
      return;
    }
    // 保存できた時だけ、③の下書きと②の材料を空にする（選んだ種類は残す）
    setPostsDesk((s) => deskAfterSave(s, draft.kind));
    setNote({ ok: true, text: savedNote(kind.label, "右"), kindLabel: kind.label });
  };

  const drop = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || !draft || !kind) return;
    setPostsDesk(() => ({ draft: null }));
    writeJournal({ who: "オーナー", text: `${draftName(kind.label)}をやめた（保存していない）` });
    setNote(null);
  };

  return (
    <section className="karte-now" aria-labelledby="posts-step3">
      <h2 id="posts-step3">③ 見て、手で直して保存</h2>
      {draft && kind ? (
        <>
          <article className="karte-card ai" aria-label={draftName(kind.label)}>
            <header className="karte-card-head">
              <span className="tag who-ai">{draft.mode === "ai" ? "AI の下書き" : "決まった返事の下書き"}</span>
              <strong>{kind.label}</strong>
            </header>
            <p className="karte-before">
              <span className="hint">前：</span>材料（{kind.materials[0]?.label ?? "お題"}「{draft.topic}」）とお店のメモ
              <span aria-hidden> → </span>
              <span className="hint">後：</span>
              {draftName(kind.label)}
            </p>
            <ul className="gate" aria-label="確認">
              {draft.checks.map((c) => (
                <li key={c.id} className={c.ok ? "ok" : "ng"}>
                  {c.ok ? "✓" : "✗"} {c.label}
                </li>
              ))}
              {draft.inserted
                .filter((i) => insertLabel(i, draft))
                .map((i) => (
                  <li key={i} className="ok">
                    ✓ {insertLabel(i, draft)}
                  </li>
                ))}
            </ul>
            {draft.unreadable && (
              <p className="problems" role="status">
                {CLOSED_UNREADABLE}材料のお休みの日付は推して入れず、空き枠も入れていません。「12月31日から1月5日まで休みます」のように書くと読めます。
              </p>
            )}
            {(draft.cautions ?? []).map((c, i) => (
              <p key={i} className="problems" role="status">
                {CAUTION_HEAD}
                {c}
              </p>
            ))}
            <label className="posts-edit">
              <span className="karte-memo-label">下書き（手で直せます）</span>
              <textarea
                id={DRAFT_TEXT_ID}
                value={draft.text}
                rows={Math.min(30, Math.max(8, draft.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / 36)), 1)))}
                onChange={(e) => {
                  const text = e.target.value;
                  // 手で直したら、チームの残りの候補は使えなくする（「下書きが変わったので入れられません」）
                  setPostsDesk((s) => (s.draft ? { draft: withHandEdit(s.draft, text) } : {}));
                  afterHandEdit();
                  setNote(null);
                }}
              />
              <span className="karte-count">
                <span className="num">{[...draft.text].length}</span>字（目安 {kind.targetChars}字前後・{kind.shape}）
              </span>
            </label>
            {/* コピー（クリップボードに入れるだけ。送信・公開ではない）。手で直した後の文をそのまま */}
            <p className="posts-copy">
              <CopyButton text={draft.text} targetId={DRAFT_TEXT_ID} />
            </p>
            {draft.cut && <p className="problems">長くなったので、途中までの下書きです。</p>}
            {desk.failed && (
              <p className="problems" role="status">
                作り直しは{failedKind ? draftName(failedKind.label) : "下書き"}を{COULD_NOT_WRITE}（{desk.failed.problems.join("。")}）。{KEPT_AFTER_FAIL}
              </p>
            )}
            <p className="karte-why">
              理由：お店のメモと材料にある事だけで、{kind.label}の形に書きました{draft.tries > 1 ? "（1回作り直した下書きです）" : ""}。
            </p>
            <div className="posts-buttons">
              <button type="button" className="btn primary" onClick={save}>
                下書きを保存
              </button>
              <span className="posts-nosend">送信・公開はしません</span>
              <button type="button" className="btn" onClick={drop}>
                やめる
              </button>
            </div>
            {note && note.draftId === draft.id && (
              <p className={note.ok ? "checked" : "problems"} role="status">
                {note.ok && <span aria-hidden>✓ </span>}
                {note.text}
              </p>
            )}
          </article>
          {/* 下書きのカードの下：AI のチーム（今の下書きだけ。保存した下書きには出さない） */}
          <PostTeam draft={draft} kind={kind} settings={settings} data={data} memos={memos} />
        </>
      ) : desk.failed && failedKind ? (
        <article className="karte-card posts-failed" role="status">
          <p className="karte-card-head">
            <strong>{draftName(failedKind.label)}を{COULD_NOT_WRITE}</strong>
          </p>
          <ul className="gate">
            {desk.failed.problems.map((p, i) => (
              <li key={i} className="ng">
                ✗ {p}
              </li>
            ))}
          </ul>
          <p className="hint">保存していません（日誌に書きました）。材料を変えて、もう一度「下書きを作る」を押せます。</p>
        </article>
      ) : (
        <p className="karte-wait">{desk.busy ? "下書きを作っています…" : "①で種類を選び、②で材料を入れて「下書きを作る」を押すと、ここに下書きが出ます。"}</p>
      )}
      {!draft && note?.ok && (
        <p className="checked posts-saved-note" role="status">
          <span aria-hidden>✓ </span>
          {/* 保存した下書きの欄は、PC は右の列・スマホはこのページの下 */}
          <span className="posts-where-pc">{note.kindLabel ? savedNote(note.kindLabel, "右") : note.text}</span>
          <span className="posts-where-sp">{note.kindLabel ? savedNote(note.kindLabel, "下") : note.text}</span>
        </p>
      )}
    </section>
  );
}

/** 保存した下書き（右の列。種類ごと） */
export function PostsSaved({ settings, timezone }: { settings: PostsSettings; timezone: string }) {
  const posts = usePosts();
  const grouped = savedByKind(posts.state, settings.kinds);
  return (
    <section className="panel" aria-labelledby="posts-saved">
      <h2 id="posts-saved">保存した下書き</h2>
      {settings.kinds.map((k) => {
        const list = grouped[k.id] ?? [];
        return (
          <section key={k.id} className="posts-group" aria-labelledby={`posts-g-${k.id}`}>
            <h3 id={`posts-g-${k.id}`} className="todo-group">
              {k.label}（<span className="num">{list.length}</span>件）
            </h3>
            {list.length === 0 ? (
              <p className="empty">まだありません。</p>
            ) : (
              <ul className="posts-saved">
                {list.map((p) => (
                  <li key={p.id}>
                    <details className="posts-row">
                      <summary>
                        <span className="num posts-at">{timeLabel(p.at, timezone)}</span>
                        <span className="posts-first">{firstLine(p.text)}</span>
                      </summary>
                      <p className="posts-full" id={`posts-full-${p.id}`}>
                        {p.text}
                      </p>
                      <p className="posts-copy">
                        <CopyButton text={p.text} targetId={`posts-full-${p.id}`} />
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}
