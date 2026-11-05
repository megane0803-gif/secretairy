"use client";

// 発信のタブの真ん中：③見て、手で直して「下書きを保存」。保存した下書きを種類ごとに並べる。
// 保存はオーナーのボタンだけ（isTrusted で確かめる）。承認の箱は通さない。送信・公開はしない。

import { useState } from "react";
import { writeJournal } from "@/lib/journal";
import { setPostsDesk, usePostsDesk } from "@/lib/posts/deskStore";
import { KEPT_AFTER_FAIL } from "@/lib/posts/redo";
import { COULD_NOT_WRITE } from "@/lib/posts/write";
import { savedByKind, withSavedPost } from "@/lib/posts/state";
import { usePosts } from "@/lib/posts/usePosts";
import type { PostInsert, PostsSettings } from "@/lib/settings";

/** 入れた物（ブログのリンクの印は「リンクは印だけ」の ✓ と同じなので出さない） */
const INSERT_LABEL: Partial<Record<PostInsert, string>> = {
  openings: "空き枠の日時（台帳から）",
  closed: "お休みの日付（店の設定から）",
};

function timeLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function firstLine(text: string): string {
  const l = text.split("\n").find((x) => x.trim()) ?? "";
  return l.replace(/^#+\s*/, "").slice(0, 40);
}

export function PostsBoard({ settings, timezone }: { settings: PostsSettings; timezone: string }) {
  const desk = usePostsDesk();
  const posts = usePosts();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const draft = desk.draft;
  const kindOf = (id: string) => settings.kinds.find((k) => k.id === id);
  const kind = draft ? kindOf(draft.kind) : null;
  const failedKind = desk.failed ? kindOf(desk.failed.kind) : null;
  const grouped = savedByKind(posts.state, settings.kinds);

  const save = (e: React.MouseEvent) => {
    // 🔒 人のボタンだけ
    if (!e.nativeEvent.isTrusted || !draft || !kind) return;
    const r = withSavedPost(posts.state, draft, {
      id: `po-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      nowIso: new Date().toISOString(),
      gateWords: settings.gateWords,
      maxPerKind: settings.maxSavedPerKind,
    });
    if (!r.ok) {
      setNote({ ok: false, text: r.reason });
      if (r.code === "dup") writeJournal({ who: "プログラム", text: `${kind.label}の下書き：同じ文はもう保存してあるので、二重に保存しなかった` });
      if (r.code === "words") writeJournal({ who: "プログラム", text: `${kind.label}の下書き：手で直した文に使わない言葉があったので、保存しなかった` });
      return;
    }
    posts.update(() => r.state);
    writeJournal({
      who: "オーナー",
      text: `${kind.label}の下書きを保存した（${[...r.post.text].length}字${draft.text !== draft.made ? "・手で直した" : ""}。送信・公開はしていない）`,
    });
    setNote({ ok: true, text: `保存しました（${kind.label}）。` });
  };

  const drop = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || !draft || !kind) return;
    setPostsDesk(() => ({ draft: null }));
    writeJournal({ who: "オーナー", text: `${kind.label}の下書きをやめた（保存していない）` });
    setNote(null);
  };

  return (
    <>
      <section className="karte-now" aria-labelledby="posts-step3">
        <h2 id="posts-step3">③ 見て、手で直して保存</h2>
        {draft && kind ? (
          <article className="karte-card ai" aria-label={`${kind.label}の下書き`}>
            <header className="karte-card-head">
              <span className="tag who-ai">{draft.mode === "ai" ? "AI の下書き" : "決まった返事の下書き"}</span>
              <strong>{kind.label}</strong>
            </header>
            <p className="karte-before">
              <span className="hint">前：</span>材料（{kind.materials[0]?.label ?? "お題"}「{draft.topic}」）とお店のメモ
              <span aria-hidden> → </span>
              <span className="hint">後：</span>
              {kind.label}の下書き
            </p>
            <ul className="gate" aria-label="確認">
              {draft.checks.map((c) => (
                <li key={c.id} className={c.ok ? "ok" : "ng"}>
                  {c.ok ? "✓" : "✗"} {c.label}
                </li>
              ))}
              {draft.inserted
                .filter((i) => INSERT_LABEL[i])
                .map((i) => (
                  <li key={i} className="ok">
                    ✓ {INSERT_LABEL[i]}
                  </li>
                ))}
            </ul>
            <label className="posts-edit">
              <span className="karte-memo-label">下書き（手で直せます）</span>
              <textarea
                value={draft.text}
                rows={Math.min(30, Math.max(8, draft.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / 36)), 1)))}
                onChange={(e) => {
                  const text = e.target.value;
                  setPostsDesk((s) => (s.draft ? { draft: { ...s.draft, text } } : {}));
                  setNote(null);
                }}
              />
              <span className="karte-count">
                <span className="num">{[...draft.text].length}</span>字（目安 {kind.targetChars}字前後・{kind.shape}）
              </span>
            </label>
            {draft.cut && <p className="problems">長くなったので、途中までの下書きです。</p>}
            {desk.failed && (
              <p className="problems" role="status">
                作り直しは{failedKind?.label ?? ""}の下書きを{COULD_NOT_WRITE}（{desk.failed.problems.join("。")}）。{KEPT_AFTER_FAIL}
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
            {note && (
              <p className={note.ok ? "checked" : "problems"} role="status">
                {note.ok && <span aria-hidden>✓ </span>}
                {note.text}
              </p>
            )}
          </article>
        ) : desk.failed && failedKind ? (
          <article className="karte-card posts-failed" role="status">
            <p className="karte-card-head">
              <strong>{failedKind.label}の下書きを{COULD_NOT_WRITE}</strong>
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
          <p className="checked" role="status">
            <span aria-hidden>✓ </span>
            {note.text}
          </p>
        )}
      </section>

      <section aria-labelledby="posts-saved">
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
                        <p className="posts-full">{p.text}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </section>
    </>
  );
}
