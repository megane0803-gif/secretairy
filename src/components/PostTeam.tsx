"use client";

// 発信の下書きの「AI のチーム」の会議（docs/SPEC.md §1.10.1）。発信のタブの真ん中、今の下書きのカードの下に出す。
// 下書きを、オーナーに出す前にチームが読む：リサーチャー（プログラム）・分身・野党・補佐（Claude）の4つの小さいカード。
// 🔒 AI は下書きを書きかえない。補佐の直しを入れるかは、オーナーが1つずつ「入れる」「入れない」で選ぶ。保存・送信・公開はしない。
// 会議は1つの下書きに1回（作り直したら、また押せる）。答えは、下書きが会議を始めた時と同じ時だけ出す。

import { useState } from "react";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import type { PostMemo } from "@/lib/data/types";
import { writeJournal } from "@/lib/journal";
import { getPostsDesk, setPostsDesk, type PostDraft } from "@/lib/posts/deskStore";
import { askPostsTeam } from "@/lib/posts/team/client";
import { RESEARCH_TAG, researchPost, type PostResearch } from "@/lib/posts/team/research";
import {
  applyPostPick,
  canMeetPost,
  pickState,
  pickSummary,
  postTeamJournal,
  skipPostPick,
  withPostTeamFailed,
  withPostTeamResult,
  withPostTeamStarted,
  type PickRef,
  type PostTeamArrival,
} from "@/lib/posts/team/state";
import { CONCERN_LABEL, DRAFT_CHANGED, POST_ROLE_DESC, POST_ROLE_NAME, type PostTeamResult, type PostTeamRole } from "@/lib/posts/team/types";
import { useRules } from "@/lib/rules/useRules";
import type { PostKind, PostsSettings } from "@/lib/settings";
import { getPostsTeamLimits } from "@/lib/settings";
import { TeamVoice } from "./TeamVoice";

const LIMITS = getPostsTeamLimits();

function Voice({ role, ai, children }: { role: PostTeamRole; ai: boolean; children: React.ReactNode }) {
  return (
    <TeamVoice name={POST_ROLE_NAME[role]} desc={POST_ROLE_DESC[role]} ai={ai} programTag={role === "researcher" ? "プログラム" : "AI なし"}>
      {children}
    </TeamVoice>
  );
}

function Edit({ from, to }: { from: string; to: string }) {
  return (
    <p className="team-edit">
      <span className="hint">前：</span>
      {from}
      <span aria-hidden> → </span>
      <span className="hint">後：</span>
      <strong>{to}</strong>
    </p>
  );
}

/** 日誌に書いて、選び終わっていれば「補佐の直し：入れた…」も */
function journalSummary() {
  let line: string | null = null;
  setPostsDesk((s) => {
    const r = pickSummary(s.draft);
    if (!r) return {};
    line = r.line;
    return { draft: r.draft };
  });
  if (line) writeJournal({ who: "オーナー", text: line });
}

/** 手で直した時（PostsBoard の欄から呼ぶ）：残りの候補が使えなくなれば、選び終わりの1行も */
export function afterHandEdit(): void {
  journalSummary();
}

function Voices({ draft, result, research, gateWords }: { draft: PostDraft; result: PostTeamResult; research: PostResearch; gateWords: string[] }) {
  const ai = result.mode === "ai";
  const t = draft.team!;
  const [notes, setNotes] = useState<Record<number, string>>({});

  const press = (e: React.MouseEvent, no: number, apply: boolean) => {
    // 人がボタンを押したときだけ
    if (!e.nativeEvent.isTrusted) return;
    const cur = getPostsDesk().draft;
    const ref: PickRef = { draftId: cur?.id, version: cur?.version ?? 0, meetingId: t.meetingId, no };
    const pick = result.aide?.picks.find((p) => p.no === no);
    if (!pick) return;
    if (!apply) {
      let done = false;
      setPostsDesk((s) => {
        const r = skipPostPick(s.draft, ref);
        done = r.outcome === "skipped";
        return { draft: r.draft };
      });
      if (done) writeJournal({ who: "オーナー", text: `${POST_ROLE_NAME.aide}の直し（${no}番）を入れなかった` });
      journalSummary();
      return;
    }
    let outcome = "missing";
    let problems: string[] = [];
    setPostsDesk((s) => {
      const r = applyPostPick(s.draft, ref, { gateWords, maxLineChars: LIMITS.maxLineChars });
      outcome = r.outcome;
      problems = r.problems;
      return { draft: r.draft };
    });
    if (outcome === "applied") writeJournal({ who: "オーナー", text: `${POST_ROLE_NAME.aide}の直し（${no}番）を入れた：「${pick.from}」→「${pick.to}」` });
    else if (outcome === "changed") {
      writeJournal({ who: "プログラム", text: `${POST_ROLE_NAME.aide}の直し（${no}番）は入れなかった：${DRAFT_CHANGED}` });
      setNotes((n) => ({ ...n, [no]: DRAFT_CHANGED }));
    } else if (outcome === "blocked") {
      writeJournal({ who: "プログラム", text: `${POST_ROLE_NAME.aide}の直し（${no}番）は入れなかった（${problems.join("。")}）` });
      setNotes((n) => ({ ...n, [no]: `入れられませんでした（${problems.join("。")}）` }));
    }
    journalSummary();
  };

  return (
    <section className="team" aria-label="AI のチームが読んだ">
      <p className="team-head">
        <strong>AI のチームが読みました</strong>
        {!ai && <span className="tag who-program">AI なし</span>}
        {result.noAi && <span className="hint small">AI につながらないので、決まった返事（AI なし）で読みました</span>}
      </p>
      <div className="team-voices">
        <Voice role="researcher" ai={false}>
          <p className="voice-guess">
            <span className="tag who-program">{RESEARCH_TAG}</span>
          </p>
          <ul className="gate voice-checks" aria-label="リサーチャーの確かめ">
            {research.lines.map((l, i) => (
              <li key={i} className={l.state === "ng" ? "ng" : l.state === "ok" ? "ok" : "info"}>
                {l.state === "ok" ? "✓" : l.state === "ng" ? "✗" : "・"} <span className="hint">{l.label}：</span>
                <span className="num">{l.value}</span>
              </li>
            ))}
          </ul>
        </Voice>
        <Voice role="twin" ai={ai}>
          {result.twin ? (
            result.twin.edits.length ? (
              result.twin.edits.map((e, i) => <Edit key={i} {...e} />)
            ) : (
              <p className="hint">直したい所はありません</p>
            )
          ) : (
            <p className="hint">分身の直しを確かめられませんでした</p>
          )}
        </Voice>
        <Voice role="opposition" ai={ai}>
          {result.opposition ? (
            <dl className="voice-facts">
              <div>
                <dt>{CONCERN_LABEL[result.opposition.concern]}所</dt>
                <dd>{result.opposition.why}</dd>
              </div>
              <div>
                <dt>代わりの言い方</dt>
                <dd>
                  <Edit {...result.opposition.edit} />
                </dd>
              </div>
            </dl>
          ) : (
            <p className="hint">反対意見を確かめられませんでした</p>
          )}
        </Voice>
        <Voice role="aide" ai={ai}>
          {result.aide ? (
            result.aide.picks.length ? (
              <ol className="team-picks">
                {result.aide.picks.map((p) => {
                  const st = pickState(draft, p.no);
                  return (
                    <li key={p.no} className="team-pick">
                      <small className="hint">
                        {p.no}番（{p.source === "twin" ? POST_ROLE_NAME.twin : POST_ROLE_NAME.opposition}の直し）
                      </small>
                      <Edit from={p.from} to={p.to} />
                      {p.reason && <p className="hint small">理由：{p.reason}</p>}
                      {st === "open" ? (
                        <div className="posts-buttons">
                          <button type="button" className="btn primary small" onClick={(e) => press(e, p.no, true)}>
                            入れる
                          </button>
                          <button type="button" className="btn small" onClick={(e) => press(e, p.no, false)}>
                            入れない
                          </button>
                        </div>
                      ) : (
                        <p className={st === "applied" ? "checked" : "hint small"} role="status">
                          {st === "applied" ? "✓ 入れました" : st === "skipped" ? "入れませんでした" : st === "changed" ? DRAFT_CHANGED : (notes[p.no] ?? "入れられませんでした")}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="hint">入れたい直しは選びませんでした</p>
            )
          ) : (
            <p className="hint">{result.candidates.length ? "補佐のまとめを確かめられませんでした" : "確かめ済みの直しが無いので、補佐は選んでいません"}</p>
          )}
        </Voice>
      </div>
      <p className="hint small">入れるかどうかは、オーナーが1つずつ選びます（AI は下書きを書きかえません。会議は1つの下書きに1回まで）。</p>
    </section>
  );
}

export function PostTeam({
  draft,
  kind,
  settings,
  data,
  memos,
}: {
  draft: PostDraft;
  kind: PostKind;
  settings: PostsSettings;
  data: BookData;
  memos: PostMemo[];
}) {
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const can = canMeetPost(draft, LIMITS.maxDraftChars);

  const start = async (e: React.MouseEvent) => {
    // 人がボタンを押したときだけ
    if (!e.nativeEvent.isTrusted || busy || !can.ok) return;
    const meetingId = `pt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let started: PostDraft | null = null;
    setPostsDesk((s) => {
      if (!s.draft || s.draft.id !== draft.id) return {};
      const next = withPostTeamStarted(s.draft, meetingId, new Date().toISOString(), s.draft.mode, LIMITS.maxDraftChars);
      if (next === s.draft) return {};
      started = next;
      return { draft: next };
    });
    const snap = started as PostDraft | null;
    if (!snap) return;
    setBusy(true);
    setNote(null);
    writeJournal({ who: "オーナー", text: `${kind.label}の下書きを AI のチームに読んでもらった${snap.mode === "script" ? "（決まった返事）" : ""}` });
    const ask = await askPostsTeam(snap, { kind, memos, rules, gateWords: settings.gateWords, limits: LIMITS });
    setBusy(false);
    const ref = { draftId: snap.id, meetingId };
    if (!ask.ok) {
      setPostsDesk((s) => ({ draft: withPostTeamFailed(s.draft, ref) }));
      writeJournal({ who: "プログラム", text: `チームの答えが戻らなかった（${ask.message}）` });
      setNote(`うまくいきませんでした：${ask.message}。下書きはそのまま直して保存できます。`);
      return;
    }
    let arrival = "missing" as PostTeamArrival;
    let shownDraft: PostDraft | null = null;
    setPostsDesk((s) => {
      const out = withPostTeamResult(s.draft, ref, ask.result);
      arrival = out.arrival;
      shownDraft = out.draft;
      return arrival === "missing" ? {} : { draft: out.draft };
    });
    if (arrival === "shown" && shownDraft) {
      const r = researchPost(shownDraft, { kind, shop: book.shop, settings, today: book.today, now: book.now, all: book.all });
      writeJournal(...postTeamJournal(ask.result, r));
    } else writeJournal({ who: "プログラム", text: "チームの答えは出さなかった：会議の間に下書きが変わった（手で直した・作り直した）" });
  };

  const t = draft.team;
  if (!t)
    return (
      <div className="team-start">
        <button type="button" className="btn" onClick={(e) => void start(e)} disabled={busy || !can.ok}>
          チームに読んでもらう
        </button>
        {can.ok ? (
          <small className="hint">リサーチャーが日時・空き枠を確かめ、分身・野党・補佐が直しを出します。入れるかはオーナーが1つずつ選びます</small>
        ) : (
          <p className="problems" role="status">
            {can.message}
          </p>
        )}
        {note && (
          <p className="hint" role="status">
            {note}
          </p>
        )}
      </div>
    );

  if (t.result && !t.dropped) {
    // リサーチャーは、画面で今の台帳と設定から毎回出しなおす
    const research = researchPost(draft, { kind, shop: book.shop, settings, today: book.today, now: book.now, all: book.all });
    return <Voices draft={draft} result={t.result} research={research} gateWords={settings.gateWords} />;
  }
  if (t.dropped === "failed")
    return (
      <p className="hint small" role="status">
        {note ?? "チームの答えが戻りませんでした（会議は1つの下書きに1回までです。作り直すと、また押せます）。"}
      </p>
    );
  if (t.dropped === "changed")
    return (
      <p className="hint small" role="status">
        会議の間に下書きが変わったので、チームの答えは出していません（作り直すと、また押せます）。
      </p>
    );
  return (
    <p className="hint small" role="status">
      {busy ? "チームが読んでいます…（分身と野党が別々に読み、補佐が選びます）" : "チームの答えを待っています。"}
    </p>
  );
}
