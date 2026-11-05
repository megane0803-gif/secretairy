"use client";

// 広告の案の「AI のチーム」の会議（docs/SPEC.md §1.7.4）。承認の箱の広告の案の行（AdApprovalRows）の中、カードの下に出す。
// SecretAIry はオーナーの側近。案をチームで話し合ってからオーナーに出す：
//   リサーチャー（プログラム）・分身（Claude）・野党（Claude）・補佐（Claude）の4つの小さいカード。
// 🔒 決めるのは、今の承認の箱のボタン（承認／直す／見送り）だけ。会議には確定・承認の道具を渡さない。
// 会議は1つの案に1回まで。答えが戻った時に、案がまだ承認待ちで中身が同じ時だけ出す。

import { useState } from "react";
import { proposalLabel } from "@/lib/ads/gate";
import { askAdsTeam, type TeamAskContext } from "@/lib/ads/team/client";
import { research, researchLines, judgementsOf } from "@/lib/ads/team/research";
import {
  canMeet,
  guessWord,
  shownTeam,
  teamJournal,
  withTeamFailed,
  withTeamResult,
  withTeamStarted,
  type TeamArrival,
} from "@/lib/ads/team/state";
import { ROLE_DESC, ROLE_NAME, type TeamResult, type TeamRole } from "@/lib/ads/team/types";
import type { AdProposal } from "@/lib/ads/state";
import type { useAds } from "@/lib/ads/useAds";
import { writeJournal } from "@/lib/journal";
import type { Rule } from "@/lib/rules/types";
import { getAdsTeamLimits, getShop } from "@/lib/settings";
import { TeamVoice } from "./TeamVoice";

const LIMITS = getAdsTeamLimits();

function Voice({ role, ai, children }: { role: TeamRole; ai: boolean; children: React.ReactNode }) {
  return (
    <TeamVoice name={ROLE_NAME[role]} desc={ROLE_DESC[role]} ai={ai} programTag={role === "researcher" ? "プログラム" : "AI なし"}>
      {children}
    </TeamVoice>
  );
}

function Voices({ p, result, ads }: { p: AdProposal; result: TeamResult; ads: ReturnType<typeof useAds> }) {
  const ai = result.mode === "ai";
  const r = research(ads.table, p, judgementsOf(ads.state), ads.settings.towns);
  return (
    <section className="team" aria-label="AI のチームの会議">
      <p className="team-head">
        <strong>AI のチームの会議</strong>
        {!ai && <span className="tag who-program">AI なし</span>}
        {result.noAi && <span className="hint small">AI につながらないので、決まった返事（AI なし）で話し合いました</span>}
      </p>
      <div className="team-voices">
        <Voice role="researcher" ai={false}>
          {r ? (
            <dl className="voice-facts">
              {researchLines(r).map((l) => (
                <div key={l.label}>
                  <dt>{l.label}</dt>
                  <dd className="num">{l.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="hint small">この言葉は表にありません</p>
          )}
        </Voice>
        <Voice role="twin" ai={ai}>
          {result.twin ? (
            <>
              {result.twin.noHistory && <p className="hint small">過去の判断はまだありません</p>}
              <p>{result.twin.text}</p>
              <p className="voice-guess">
                <strong>私なら{guessWord(p.action, result.twin.guess)}</strong>
                <small className="hint">（{result.twin.guess === "approve" ? "承認" : "見送り"}）</small>
              </p>
            </>
          ) : (
            <p className="hint">分身の意見を確かめられませんでした</p>
          )}
        </Voice>
        <Voice role="opposition" ai={ai}>
          {result.opposition ? (
            <dl className="voice-facts">
              <div>
                <dt>危ない所</dt>
                <dd>{result.opposition.risk}</dd>
              </div>
              <div>
                <dt>代わりの選び方</dt>
                <dd>{result.opposition.alternative}</dd>
              </div>
            </dl>
          ) : (
            <p className="hint">反対意見を確かめられませんでした</p>
          )}
        </Voice>
        <Voice role="aide" ai={ai}>
          {result.aide ? (
            <>
              <p className="voice-guess">
                <strong>{ROLE_NAME[result.aide.adopt]}の理由を採りました</strong>
              </p>
              <dl className="voice-facts">
                {result.aide.conclusion && (
                  <div>
                    <dt>結論</dt>
                    <dd>{result.aide.conclusion}</dd>
                  </div>
                )}
                {result.aide.reason && (
                  <div>
                    <dt>理由</dt>
                    <dd>{result.aide.reason}</dd>
                  </div>
                )}
                {result.aide.next && (
                  <div>
                    <dt>次の一手</dt>
                    <dd>{result.aide.next}</dd>
                  </div>
                )}
              </dl>
            </>
          ) : (
            <p className="hint">補佐のまとめを確かめられませんでした</p>
          )}
        </Voice>
      </div>
      <p className="hint small">決めるのは、上の「承認」「直す」「見送り」のボタンだけです（会議は1つの案に1回まで）。</p>
    </section>
  );
}

export function AdTeam({ p, ads, rules, anchor }: { p: AdProposal; ads: ReturnType<typeof useAds>; rules: Rule[]; anchor: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const start = async (e: React.MouseEvent) => {
    // 人がボタンを押したときだけ
    if (!e.nativeEvent.isTrusted || busy || !canMeet(p)) return;
    const startedAt = new Date().toISOString();
    let started = false;
    ads.update((s) => {
      const next = withTeamStarted(s, p.id, startedAt, p.mode);
      started = next !== s;
      return next;
    });
    if (!started) return; // 別の画面でもう会議にかけた（1つの案に1回まで）
    setBusy(true);
    setNote(null);
    writeJournal({ who: "オーナー", text: `会議にかけた：広告の案「${proposalLabel(p)}」を AI のチームの会議にかけた${p.mode === "script" ? "（決まった返事）" : ""}` });
    const ctx: TeamAskContext = {
      table: ads.table,
      rules,
      ads: ads.state,
      seedPast: ads.report.past ?? [],
      anchor,
      shop: getShop(),
      settings: ads.settings,
      limits: LIMITS,
    };
    const ask = await askAdsTeam(p, ctx);
    setBusy(false);
    if (!ask.ok) {
      ads.update((s) => withTeamFailed(s, p.id, startedAt));
      writeJournal({ who: "プログラム", text: `会議の答えが戻らなかった（${ask.message}）` });
      setNote(`うまくいきませんでした：${ask.message}。承認の箱のボタンはそのまま押せます。`);
      return;
    }
    let arrival = "missing" as TeamArrival;
    ads.update((s) => {
      const out = withTeamResult(s, p.id, startedAt, ask.result);
      arrival = out.arrival;
      return out.state;
    });
    if (arrival === "shown") writeJournal(...teamJournal(p, ask.result));
    else if (arrival === "decided") writeJournal({ who: "プログラム", text: "会議の答えは出さなかった：案はもう決まっていた（LINE・別の画面で押した）" });
    else if (arrival === "changed") writeJournal({ who: "プログラム", text: "会議の答えは出さなかった：会議の間に案の中身が変わった（直す・別の画面）" });
  };

  if (canMeet(p))
    return (
      <div className="team-start">
        <button type="button" className="btn" onClick={(e) => void start(e)} disabled={busy}>
          チームの会議にかける
        </button>
        <small className="hint">分身・野党・補佐が話し合い、リサーチャーが数を並べます。決めるのは承認の箱のボタンだけです</small>
        {note && (
          <p className="hint" role="status">
            {note}
          </p>
        )}
      </div>
    );

  const t = p.team;
  if (!t) return null;
  const shown = shownTeam(p);
  if (shown) return <Voices p={p} result={shown} ads={ads} />;
  if (t.dropped === "failed")
    return (
      <p className="hint small" role="status">
        {note ?? "会議の答えが戻りませんでした（会議は1つの案に1回までです）。"}
      </p>
    );
  if (t.dropped === "changed" || t.result)
    return (
      <p className="hint small" role="status">
        案の中身が変わったので、会議の答えは出していません（会議は1つの案に1回までです）。
      </p>
    );
  return (
    <p className="hint small" role="status">
      {busy ? "会議中…（分身と野党が別々に読み、補佐がまとめます）" : "会議の答えを待っています（会議は1つの案に1回までです）。"}
    </p>
  );
}
