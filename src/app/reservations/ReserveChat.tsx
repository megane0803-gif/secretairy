"use client";

// 予約チャット（お客様のスマホ画面のつもり）。予約タブの右の列。
// 送るたびに、このブラウザの台帳とルールをいっしょに /api/ai/reserve へ送り、返事を少しずつ受け取る。
// サーバーは何も残さない。仮押さえ・日誌・AI の手順を残すのは、この画面（ブラウザ）の側。
// AI は仮押さえまで。確定はオーナーが承認の箱で押す。

import { useMemo, useRef, useState } from "react";
import { NO_REAL_NAMES_NOTE } from "@/lib/notices";
import { carryOver } from "@/lib/ai/carry";
import { BUSY_NOTICE as BUSY_TEXT, createChatRuns, sendBlocked } from "@/lib/ai/chatRuns";
import { buildExamples, type Example } from "@/lib/ai/examples";
import { candidateLabel, previousVisit, type SlotContext } from "@/lib/ai/slots";
import { addStep, markFailed, startConsultation } from "@/lib/ai/stepsStore";
import {
  NO_AI_MESSAGE,
  parseHoldOffer,
  type Candidate,
  type ChatMode,
  type ChatTurn,
  type ReserveEvent,
  type ReserveRequest,
} from "@/lib/ai/wire";
import type { BookData } from "@/lib/book/data";
import { withChatTodo, withGuestReleased, withHold } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { useRules } from "@/lib/rules/useRules";
import { getChatMaxChars } from "@/lib/settings";

type Msg = { from: "guest" | "ai" | "note"; text: string };

// お客様の1回の文の長さ（config/ai.json の maxMessageChars。サーバーも同じ数で切る）
const MAX_CHARS = getChatMaxChars();

export function ReserveChat({ data }: { data: BookData }) {
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  // 「前と同じで」は、前回のカルテがある方で話す
  const withPast = data.customers.find((c) => book.kartes.some((k) => k.customerId === c.id && k.date <= book.today.date));
  const [customerId, setCustomerId] = useState(withPast?.id ?? data.customers[0]?.id ?? "");
  const customer = data.customers.find((c) => c.id === customerId) ?? data.customers[0];
  const greeting = (): Msg[] => [
    { from: "ai", text: `${data.shop.name} の予約の係です。ご希望のメニューと日にちを教えてください。` },
  ];
  const [msgs, setMsgs] = useState<Msg[]>(greeting);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ChatMode>("ai");
  const [noAi, setNoAi] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  // この会話で作った仮押さえ（「ずらしたい」「やめたい」で外せるのは、この中の承認待ちの物だけ）
  const [convHolds, setConvHolds] = useState<string[]>([]);
  // 送れなかったときの理由（黙って捨てない）
  const [notice, setNotice] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);
  // いま流れている返事（お客様を切り替えたら止める）
  const runs = useRef(createChatRuns()).current;

  const ctx: SlotContext | null = useMemo(
    () =>
      customer
        ? {
            shop: book.shop,
            menus: data.menus,
            rules,
            booked: book.booked,
            customer: { id: customer.id, surname: customer.surname, firstVisit: customer.firstVisit },
            now: book.now,
            today: book.today,
          }
        : null,
    [data, book.shop, rules, book.booked, customer, book.now, book.today],
  );
  // 例文は、いまの台帳・ルール・時刻でプログラムが選んだ日時で作る（どの曜日に開いても同じ働きになるように）
  const examples = useMemo(() => (ctx ? buildExamples(ctx) : []), [ctx]);

  const scroll = () => requestAnimationFrame(() => logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" }));

  const reset = (id: string) => {
    // 流れている返事は止める（前のお客様の返事・仮押さえ・ToDo を新しい会話に混ぜない）
    const stopped = runs.stop();
    if (stopped) {
      setBusy(false);
      const was = data.customers.find((c) => c.id === stopped);
      writeJournal({ who: "プログラム", text: `お客様を切り替えたので、流れていた返事を止めた（${was ? `${was.surname}（架空）様` : "前のお客様"}の相談）` });
    }
    setNotice(null);
    setCustomerId(id);
    setMsgs(greeting());
    setCandidates([]);
    setConvHolds([]);
  };

  /** over.fresh = 新しい会話（候補・この会話の仮押さえを引きつがない）。やり直し（trySample）は fresh にしない */
  async function send(raw: string, over?: { mode?: ChatMode; msgs?: Msg[]; customerId?: string; fresh?: boolean }) {
    const t = raw.trim().slice(0, MAX_CHARS);
    const customer = data.customers.find((c) => c.id === (over?.customerId ?? customerId));
    // 送れないときは黙って捨てず、理由を出す（文は入力欄に残す）
    const blocked = sendBlocked({ text: t, busy: runs.busy(), hasCustomer: !!customer });
    if (blocked !== null || !customer) {
      if (blocked) setNotice(blocked);
      return;
    }
    setNotice(null);
    const run = runs.start(customer.id);
    const live = () => runs.isCurrent(run.id);
    const useMode = over?.mode ?? mode;
    const before = over?.msgs ?? msgs;
    const history: ChatTurn[] = [
      ...before.filter((m) => m.from !== "note").map((m) => ({ role: m.from === "guest" ? ("user" as const) : ("assistant" as const), text: m.text })),
      { role: "user", text: t },
    ];
    setMsgs([...before, { from: "guest", text: t }]);
    setText("");
    setBusy(true);
    scroll();
    const cid = startConsultation(t, useMode);
    const who = `${customer.surname}（架空）様`;

    const body: ReserveRequest = {
      mode: useMode,
      messages: history,
      ...carryOver(over?.fresh === true, { candidates, holds: convHolds }),
      customer: { id: customer.id, surname: customer.surname, firstVisit: customer.firstVisit },
      booked: book.booked,
      rules: rules.filter((r) => !r.locked),
      // そのお客様のカルテの日付とメニューだけ（中身は送らない）
      visits: book.visits.filter((v) => v.customerId === customer.id),
      dayOffset: book.dayOffset,
      // 同じ時間に受ける人数（ルールのタブで変えた分）。サーバーは幅を確かめなおして使う
      seats: book.shop.seats,
      // 休みの日（予約のページで決めた分）。サーバーは形と数を確かめてから使う
      holidays: book.shop.ownerHolidays ?? [],
    };
    // この相談の中で増えた・外した仮押さえ（画面の側でも、この会話の物かを確かめる）
    const mine = new Set(body.holds);

    let aiText = "";
    let gotAny = false;
    let aiFailed = false;
    const showAi = (d: string) => {
      if (!live()) return;
      aiText += d;
      const shown = aiText;
      setMsgs((m) => {
        const last = m[m.length - 1];
        if (gotAny && last?.from === "ai") return [...m.slice(0, -1), { from: "ai", text: shown }];
        return [...m, { from: "ai", text: shown }];
      });
      gotAny = true;
      scroll();
    };
    const failed = () => {
      if (!live()) return;
      aiFailed = true;
      markFailed(cid);
      setNoAi(true);
      setMsgs((m) => [...m, { from: "note", text: `${NO_AI_MESSAGE}。ほかの画面はそのまま使えます。` }]);
      scroll();
    };

    const onEvent = (e: ReserveEvent) => {
      // 止めた返事（お客様を切り替えた）の知らせは使わない
      if (!live()) return;
      switch (e.t) {
        case "text":
          showAi(e.d);
          break;
        case "step":
          addStep(cid, e.step);
          // 仮押さえは下の hold で1行書く
          // 仮押さえ・外した・ToDo は下の hold・release・todo で1行書く
          if (e.step.kind === "reject" || e.step.kind === "limit")
            writeJournal({ who: "プログラム", text: `${e.step.kind === "reject" ? "弾いた" : "止めた"}（${who}の相談）：${e.step.text}` });
          else if (e.step.kind === "ask") writeJournal({ who: "プログラム", text: `聞き返した（${who}の相談）：${e.step.text}` });
          else if (e.step.kind === "price") writeJournal({ who: "プログラム", text: `料金を答えた（${who}の相談）：${e.step.text}` });
          else if (e.step.kind === "tool") writeJournal({ who: "AI", text: `道具を呼んだ（${who}の相談）：${e.step.text}` });
          break;
        case "candidates":
          setCandidates(e.list);
          break;
        case "hold": {
          const h = parseHoldOffer(e.hold);
          if (!h || h.customerId !== customer.id) break;
          book.update((s) => withHold(s, h));
          mine.add(h.id);
          setConvHolds((l) => (l.includes(h.id) ? l : [...l, h.id]));
          writeJournal({ who: "AI", text: `仮押さえした：${who} ${candidateLabel(data, h)}（承認の箱へ）` });
          break;
        }
        case "release": {
          // この会話で作った、まだ承認待ちの仮押さえだけ外す（withGuestReleased でもう一度確かめる）
          if (typeof e.holdId !== "string" || !mine.has(e.holdId)) break;
          const r = book.state.chat.find((x) => x.id === e.holdId);
          book.update((s) => withGuestReleased(s, e.holdId, customer.id, new Date().toISOString()));
          mine.delete(e.holdId);
          setConvHolds((l) => l.filter((x) => x !== e.holdId));
          writeJournal({ who: "AI", text: `仮押さえを外した（${who}の頼み）：${r ? candidateLabel(data, r) : e.holdId}（承認の箱から外した）` });
          break;
        }
        case "todo": {
          // 言うだけで終わらせない：ToDo に「○○（架空）様：用件の1行」を足し、日誌に1行
          let line: string | null = null;
          book.update((s) => {
            const out = withChatTodo(s, e.todo, customer.surname, new Date().toISOString(), book.today.date);
            line = out.journal;
            return out.state;
          });
          if (line) writeJournal({ who: "プログラム", text: line });
          break;
        }
        case "error":
          if (e.code === "no-ai") failed();
          else setMsgs((m) => [...m, { from: "note", text: `うまくいきませんでした。${e.message}。もう一度送ってください。` }]);
          break;
        case "done":
          break;
      }
    };

    try {
      const res = await fetch("/api/ai/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: run.signal,
      });
      if (!res.ok || !res.body) {
        let msg = "";
        try {
          msg = ((await res.json()) as { message?: string }).message ?? "";
        } catch {}
        if (res.status >= 500 || !msg) failed();
        else if (live()) setMsgs((m) => [...m, { from: "note", text: `うまくいきませんでした。${msg}。文を短くして送ってください。` }]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !live()) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const lineText = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!lineText) continue;
          try {
            onEvent(JSON.parse(lineText) as ReserveEvent);
          } catch {
            // 形の崩れた行は読み飛ばす
          }
        }
      }
      if (useMode === "ai" && !aiFailed && live()) setNoAi(false);
    } catch {
      // 止めた返事（お客様を切り替えた）は「つながらない」にしない
      if (!run.signal.aborted) failed();
    } finally {
      if (live()) {
        runs.finish(run.id);
        setBusy(false);
      }
    }
  }

  const tryExample = (ex: Example) => {
    if (runs.busy()) {
      setNotice(BUSY_TEXT);
      return;
    }
    if (ex.id === "previous" && ctx && !previousVisit({ ...ctx, visits: book.visits }) && withPast) {
      // 前回の来店がある方に切りかえて話す
      const fresh = greeting();
      setNotice(null);
      setCustomerId(withPast.id);
      setMsgs(fresh);
      setCandidates([]);
      setConvHolds([]);
      void send(ex.text, { msgs: fresh, customerId: withPast.id, fresh: true });
      return;
    }
    void send(ex.text);
  };

  const trySample = () => {
    // AI につながらないとき：決まった返事（AI なし）で、同じ道具・同じ流れを試す
    setMode("script");
    setNoAi(false);
    const lastGuest = [...msgs].reverse().find((m) => m.from === "guest");
    const idx = lastGuest ? msgs.lastIndexOf(lastGuest) : -1;
    const before = idx >= 0 ? msgs.slice(0, idx).filter((m) => m.from !== "note") : msgs;
    if (lastGuest) void send(lastGuest.text, { mode: "script", msgs: before });
  };

  return (
    <div className="phone" aria-label="お客様のスマホの画面（架空）">
      <div className="phone-bar">
        <span className="phone-shop">{data.shop.name} の予約</span>
        <span className="tag fictional">架空の店</span>
      </div>
      <div className="phone-who">
        <label>
          お客様
          <select
            value={customerId}
            onChange={(e) => reset(e.target.value)}
            title={busy ? "切り替えると、いま作っている返事は止めます" : undefined}
          >
            {data.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.surname} 様（架空）{c.firstVisit ? "・初めて" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="chat-mode" role="group" aria-label="返事を作る物">
          <button type="button" className={mode === "ai" ? "chat-mode-on" : "chat-mode-off"} aria-pressed={mode === "ai"} onClick={() => setMode("ai")}>
            AI（Claude）
          </button>
          <button
            type="button"
            className={mode === "script" ? "chat-mode-on" : "chat-mode-off"}
            aria-pressed={mode === "script"}
            onClick={() => setMode("script")}
            title="AI を使わず、決まった返事で同じ道具を試します"
          >
            決まった返事（AI なし）
          </button>
        </div>
      </div>

      {noAi && (
        <div className="noai" role="alert">
          <strong>{NO_AI_MESSAGE}</strong>
          <span>台帳・承認の箱・ルールなど、ほかの画面はそのまま使えます。</span>
          <button type="button" className="btn small" onClick={trySample} disabled={busy}>
            決まった返事で試す（AI なし）
          </button>
        </div>
      )}

      <ol className="chat-log" ref={logRef} aria-live="polite">
        {msgs.map((m, i) => (
          <li key={i} className={`bubble ${m.from}`}>
            <span className="bubble-who">
              {m.from === "guest" ? `${customer?.surname ?? ""} 様（架空）` : m.from === "ai" ? (mode === "script" ? "係（決まった返事）" : "係（AI）") : "お知らせ"}
            </span>
            {m.text}
          </li>
        ))}
        {busy && (
          <li className="bubble ai typing" aria-label="返事を作っています">
            …
          </li>
        )}
      </ol>

      {candidates.length > 0 && (
        <p className="chat-cands">
          候補：
          {candidates.map((c, i) => (
            <button key={i} type="button" className="btn small" disabled={busy} onClick={() => void send(`${i + 1}つ目で`)}>
              {i + 1}つ目で
            </button>
          ))}
        </p>
      )}

      <div className="chat-examples" role="group" aria-label="例文">
        {examples.map((ex) => (
          <button key={ex.id} type="button" className="btn small" onClick={() => tryExample(ex)} disabled={busy} title={`${ex.text}（${ex.note}）`}>
            {ex.button}
          </button>
        ))}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例：土曜の15時にカットをお願いしたいです"
          rows={2}
          maxLength={MAX_CHARS}
          aria-label="お客様のつもりで書く"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="submit" disabled={!text.trim() || busy}>
          送る
        </button>
      </form>
      <p className="chat-privacy">{NO_REAL_NAMES_NOTE}</p>
      {notice && (
        <p className="chat-blocked" role="status">
          {notice}
        </p>
      )}
      <p className="chat-note">
        お客様はみな架空の方です。AI は「仮押さえ」まで。確定はお店（承認の箱）で人が押します。
      </p>
    </div>
  );
}
