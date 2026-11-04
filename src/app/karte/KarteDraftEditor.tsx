"use client";

// カルテを人が見出しごとに直す所（AI は使わない）。保存の前の案（KarteDraftEditor）と、保存したカルテ（SavedKarteEditor）で同じ形。
// 「直す」で見出し1つの欄を開き、「決める」で入れる。直した見出しには「人が直した」の印。
// 案では「元に戻す」で AI の案に戻る。保存したカルテでは、直した日時も出す。
// 人が書いた行は言葉の門を通さない。直した・戻したことは日誌に1行ずつ残す。

import { useState } from "react";
import { useBookState } from "@/lib/book/useBook";
import { setDesk, type DeskDraft } from "@/lib/karte/deskStore";
import { isEdited, linesText, withHumanEdit, withReverted, withSavedKarteEdited, type SavedEditOutcome } from "@/lib/karte/edit";
import type { KarteSections } from "@/lib/karte/format";
import type { KarteRecord } from "@/lib/karte/record";
import { writeJournal } from "@/lib/journal";
import type { KarteEditSettings, KarteHeading } from "@/lib/settings";

type EditorProps = {
  sections: KarteSections;
  headings: KarteHeading[];
  limits: KarteEditSettings;
  edited: string[];
  /** 見出しごとの直した日時（の札。例「11/5 14:02」） */
  editedWhen?: Record<string, string>;
  /** 開いている見出しの id（1つだけ） */
  editing: string | null;
  setEditing: (id: string | null) => void;
  onCommit: (h: KarteHeading, text: string) => void;
  onRevert?: (h: KarteHeading) => void;
};

export function KarteSectionsEditor({ sections, headings, limits, edited, editedWhen, editing, setEditing, onCommit, onRevert }: EditorProps) {
  const [text, setText] = useState("");
  return (
    <dl className="karte-sections karte-edit">
      {headings.map((h) => {
        const lines = sections[h.id] ?? [];
        const mine = edited.includes(h.id);
        const on = editing === h.id;
        return (
          <div key={h.id} className={["karte-sec", lines.length ? "" : "empty", mine ? "edited" : ""].join(" ").trim()}>
            <dt className="karte-edit-head">
              <span>■ {h.label}</span>
              {mine && <span className="tag ok">人が直した</span>}
              {mine && editedWhen?.[h.id] && <small className="hint num">{editedWhen[h.id]}</small>}
              {!on && (
                <span className="karte-edit-buttons">
                  <button
                    type="button"
                    className="btn small"
                    onClick={(e) => {
                      if (!e.nativeEvent.isTrusted) return;
                      setText(linesText(lines));
                      setEditing(h.id);
                    }}
                    disabled={editing !== null}
                  >
                    直す
                  </button>
                  {mine && onRevert && (
                    <button type="button" className="btn small" onClick={(e) => e.nativeEvent.isTrusted && onRevert(h)}>
                      元に戻す
                    </button>
                  )}
                </span>
              )}
            </dt>
            {on ? (
              <dd className="karte-edit-box">
                <label className="hint" htmlFor={`karte-edit-${h.id}`}>
                  1行に1つ（{limits.maxLines}行・1行{limits.maxLineChars}字まで）。空にすると「メモに無し」になります。
                </label>
                <textarea id={`karte-edit-${h.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(3, lines.length + 1))} />
                <span className="karte-edit-buttons">
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={(e) => {
                      // 🔒 人が押した時だけ
                      if (!e.nativeEvent.isTrusted) return;
                      onCommit(h, text);
                      setEditing(null);
                    }}
                  >
                    決める
                  </button>
                  <button type="button" className="btn small" onClick={() => setEditing(null)}>
                    やめる
                  </button>
                </span>
              </dd>
            ) : lines.length ? (
              lines.map((l, i) => <dd key={i}>・{l}</dd>)
            ) : (
              <dd className="karte-none">（メモに無し）</dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

/** 保存の前の案を直す（画面を開いている間だけの案。deskStore） */
export function KarteDraftEditor({
  draft,
  deskKey,
  headings,
  limits,
  who,
  editing,
  setEditing,
}: {
  draft: DeskDraft;
  deskKey: string;
  headings: KarteHeading[];
  limits: KarteEditSettings;
  /** 「○○（架空）様」 */
  who: string;
  editing: string | null;
  setEditing: (id: string | null) => void;
}) {
  const put = (f: (d: DeskDraft) => DeskDraft) =>
    setDesk((s) => {
      const d = s.drafts[deskKey];
      return d ? { drafts: { ...s.drafts, [deskKey]: f(d) } } : {};
    });
  return (
    <KarteSectionsEditor
      sections={draft.sections}
      headings={headings}
      limits={limits}
      edited={draft.edited ?? []}
      editing={editing}
      setEditing={setEditing}
      onCommit={(h, text) => {
        const next = withHumanEdit(draft, h.id, text, limits);
        put(() => next);
        if (isEdited(next, h.id))
          writeJournal({ who: "オーナー", text: `人が直した：${who}のカルテの案［${h.label}］（${(next.sections[h.id] ?? []).length}行。人が書いた行は言葉の門を通さない。保存はまだ）` });
        else if (isEdited(draft, h.id)) writeJournal({ who: "オーナー", text: `AI の案に戻した：${who}のカルテの案［${h.label}］（同じ中身に直したため）` });
      }}
      onRevert={(h) => {
        put((d) => withReverted(d, h.id));
        if (editing === h.id) setEditing(null);
        writeJournal({ who: "オーナー", text: `AI の案に戻した：${who}のカルテの案［${h.label}］` });
      }}
    />
  );
}

/** 保存したカルテを後から直す（secretairy:book の kartes。「最初に戻す」で消える） */
export function SavedKarteEditor({
  karte,
  headings,
  limits,
  surname,
  dateLabel,
  whenLabel,
  onDone,
}: {
  karte: KarteRecord;
  headings: KarteHeading[];
  limits: KarteEditSettings;
  surname: string;
  /** そのカルテの日（例 11/4（水）） */
  dateLabel: string;
  /** ISO の日時を「11/5 14:02」のような札に */
  whenLabel: (iso: string) => string;
  /** 結果の1文（画面に出す） */
  onDone?: (text: string) => void;
}) {
  const { update } = useBookState();
  const [editing, setEditing] = useState<string | null>(null);
  const editedWhen = Object.fromEntries(Object.entries(karte.editedAt ?? {}).map(([id, at]) => [id, `${whenLabel(at)} 人が直した`]));
  return (
    <KarteSectionsEditor
      sections={karte.sections}
      headings={headings}
      limits={limits}
      edited={karte.edited ?? []}
      editedWhen={editedWhen}
      editing={editing}
      setEditing={setEditing}
      onCommit={(h, text) => {
        let out: SavedEditOutcome | null = null;
        const nowIso = new Date().toISOString();
        update((s) => {
          out = withSavedKarteEdited(s, karte.id, h.id, text, { limits, headings, surname, nowIso });
          return out.state;
        });
        const r = out as SavedEditOutcome | null;
        if (!r || !r.ok) {
          onDone?.(r?.reason ?? "直せませんでした。もう一度押してください。");
          return;
        }
        if (!r.changed) {
          onDone?.("同じ中身なので、変えませんでした。");
          return;
        }
        const todo =
          r.todo === "updated"
            ? `ToDo「次回話すこと」の文を書きかえた：${r.title}`
            : r.todo === "done"
              ? "ToDo「次回話すこと」は済みなので触らなかった"
              : r.todo === "none"
                ? "ToDo「次回話すこと」は無いので足さなかった"
                : r.todo === "empty"
                  ? "次回提案が空になったので ToDo の文は変えなかった"
                  : "";
        writeJournal({
          who: "オーナー",
          text: `人が直した：${surname}（架空）様の保存したカルテ（${dateLabel}）［${h.label}］（${(r.state.kartes.find((k) => k.id === karte.id)?.sections[h.id] ?? []).length}行。言葉の門は通さない）${todo ? `。${todo}` : ""}`,
        });
        onDone?.(`✓ ［${h.label}］を直しました。${todo}`);
      }}
    />
  );
}
