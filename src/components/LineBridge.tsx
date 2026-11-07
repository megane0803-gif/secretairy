"use client";

// LINE のつなぎ（オーナー側）の、画面の側の働き手。どのタブを開いていても動く（layout.tsx に置く）。何も描かない。
// - つながっている（かつなぐ番号を出している）間だけ、数秒ごとに /api/line/poll へ受け取りに行く（画面が開いている印にもなる）。
// - オーナーの一言 → /api/ai/line で振り分け（予約は仮押さえまで）→ 台帳・ToDo・カルテのメモに入れる → LINE に1行で返事。
// - 承認のボタン（合言葉でつないだ LINE から押した物だけ。サーバーが確かめ済み）→ 承認BOXの画面のボタンと同じ変え方。
// - 承認BOXに新しい行が入ったら、LINE に「何を・いつ・理由」とボタンを届ける（1行1回。1日の上限まで）。
// 🔒 確定は人：確定するのは press の知らせ（LINE のボタン）だけ。一言（text）や AI の答えからは確定しない。

import { useEffect, useRef } from "react";
import { readAdsState, useAds, writeAdsState } from "@/lib/ads/useAds";
import type { BookData } from "@/lib/book/data";
import { currentEpoch, readBook, updateBook } from "@/lib/book/store";
import { useBook, useBookState } from "@/lib/book/useBook";
import { shopToday } from "@/lib/calendar";
import { deskKey, setDesk } from "@/lib/karte/deskStore";
import { writeJournal, type JournalWho } from "@/lib/journal";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { adCard, applyAsk, karteTargetFor, lineApprovalIds, reservationCard, stillOk, type ApplyOutcome } from "@/lib/line/apply";
import type { LineAskResponse } from "@/lib/line/ask";
import { LINE_TEXT, sentStatus } from "@/lib/line/messages";
import { commitPress, LINE_PRESS_FAILED_STATUS, type PressStore } from "@/lib/line/press";
import { maskNames } from "@/lib/line/sort";
import { codeExpired, linkExpired, withHandled, withLinked, withNotified } from "@/lib/line/state";
import { lineApi, problemText, readLineState, setLineStatus, updateLineState, useLineState } from "@/lib/line/useLine";
import type { OutMessage, ScreenEvent } from "@/lib/line/wire";
import { useRules } from "@/lib/rules/useRules";
import { getAdSettings, getLineSettings, getMemoMaxChars, getShop } from "@/lib/settings";

/** 1回に届ける承認待ちの行の数（送る通数を減らすため） */
const NOTIFY_PER_RUN = 2;

export function LineBridge({ data }: { data: BookData }) {
  const line = useLineState();
  const book = useBook(data);
  const bookState = useBookState();
  const ads = useAds();
  const { rules } = useRules(data.seedRules);
  const settings = getLineSettings();

  // 受け取った知らせは、いちばん新しい台帳・ルールで処理する
  const latest = useRef({ book, bookState, ads, rules });
  latest.current = { book, bookState, ads, rules };
  const busy = useRef(false);
  const notifying = useRef(false);

  const s = line.state;
  const nowIso = book.nowIso;
  const active = !!s && (s.linked ? !linkExpired(s, nowIso) : !codeExpired(s, nowIso));
  const token = s?.token ?? null;

  // 期限の切れたつなぎ・つなぐ番号は消す
  useEffect(() => {
    if (s && !active) {
      updateLineState(() => null);
      if (s.linked) writeJournal({ who: "LINE", text: "LINE とのつなぎの期限が切れた（もう一度つなぐときはホームの「LINE とつなぐ」）" });
    }
  }, [s, active]);

  // 受け取りに行く（画面が開いている間だけ）
  useEffect(() => {
    if (!active || !token) return;
    let stopped = false;
    const tick = async () => {
      if (busy.current || stopped) return;
      busy.current = true;
      try {
        // 受け取りに行く前の「最初に戻す」の印。ボタンの知らせは、この印のままの時だけ書く（途中で戻したら確定しない）
        const epoch = currentEpoch();
        const res = await lineApi.poll(token);
        if (stopped) return;
        if (!res.ok) {
          if (res.code === "gone") {
            const was = readLineState();
            updateLineState(() => null);
            if (was?.linked) writeJournal({ who: "LINE", text: "LINE とのつなぎが切れた（期限が切れたか、同じ LINE で別の画面とつないだ）" });
          } else setLineStatus({ problem: problemText(res.code, res.message) });
          return;
        }
        setLineStatus({ problem: null });
        const cur = readLineState();
        if (!cur || cur.token !== token) return;
        if (res.linked && !cur.linked) {
          const L = latest.current;
          const ids = lineApprovalIds(L.book.pending.map((p) => p.approval.id), L.ads.state);
          updateLineState((x) => (x && x.token === token ? withLinked(x, res.until, ids) : x));
          writeJournal({ who: "LINE", text: `つなぐ番号で LINE とつないだ（期限 ${when(res.until, data.shop.timezone)} まで。画面を開いている間だけ動く）` });
        }
        for (const ev of res.events) await handle(ev, token, epoch);
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), Math.max(2, settings.pollSeconds) * 1000);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
    // handle は毎回 latest を読むので、ここでは token と active だけで回しなおす
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, token, settings.pollSeconds]);

  // 承認BOXに新しい行が入ったら、LINE に届ける（1行1回。サーバーでも once で1回だけ通す）
  // 足す案・戻す案は LINE に届けない（line/apply.ts の lineApprovalIds）
  const pendingIds = lineApprovalIds(book.pending.map((p) => p.approval.id), ads.state).join(",");
  useEffect(() => {
    if (!s?.linked || !active || notifying.current) return;
    const fresh = pendingIds.split(",").filter((id) => id && !s.notified.includes(id));
    if (fresh.length === 0) return;
    notifying.current = true;
    void (async () => {
      try {
        const L = latest.current;
        const ctx = slotCtx(L);
        const pick = fresh.slice(0, NOTIFY_PER_RUN);
        // 先に「届けた」と書く（2つの窓で同じ行を2回送らないように）
        updateLineState((x) => (x ? withNotified(x, fresh) : x));
        for (const id of pick) {
          const row = L.book.pending.find((p) => p.approval.id === id);
          const ad = L.ads.pending && L.ads.pending.id === id ? L.ads.pending : null;
          const card = row ? reservationCard(row, L.book.data, stillOk(ctx, row)) : ad ? adCard(ad, getAdSettings().channel) : null;
          if (!card) continue;
          const res = await lineApi.send({ token: s.token, messages: [{ type: "approval", card }], once: id });
          if (res.ok && res.via !== "skipped") writeJournal({ who: "プログラム", text: `LINE に承認待ちを届けた：${card.what} ${card.when}` });
          else if (!res.ok) {
            writeJournal({ who: "プログラム", text: `LINE に承認待ちを届けなかった（${res.code === "limit" ? "送る上限" : "送れなかった"}）：${card.what}。画面の承認BOXで押せます` });
            if (res.code !== "limit") setLineStatus({ problem: problemText(res.code, res.message) });
          }
        }
        if (fresh.length > pick.length)
          writeJournal({ who: "プログラム", text: `ほかに承認待ちが ${fresh.length - pick.length} 件（送る通数を減らすため LINE には届けない。画面の承認BOXで）` });
      } finally {
        notifying.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIds, s?.linked, active]);

  function slotCtx(L: typeof latest.current) {
    return {
      shop: L.book.shop,
      // メニューは台帳の book.data.menus（ルールのタブで直した分も）
      menus: L.book.data.menus,
      rules: L.rules,
      booked: L.book.booked,
      customer: { id: "", surname: "", firstVisit: false },
      now: L.book.now,
      today: L.book.today,
    };
  }

  function applyCtx() {
    const L = latest.current;
    return {
      shop: L.book.shop,
      menus: L.book.data.menus,
      customers: data.customers,
      nowIso: new Date().toISOString(),
      today: L.book.today.date,
      now: L.book.now,
      adSettings: getAdSettings(),
    };
  }

  /** 台帳と広告を同じ1回で変える（書く直前に読みなおした物で） */
  function commit(f: (b: ApplyOutcome["book"], a: ApplyOutcome["ads"]) => ApplyOutcome): ApplyOutcome {
    const L = latest.current;
    let out: ApplyOutcome | null = null;
    L.ads.update((a) => {
      L.bookState.update((b) => {
        out = f(b, a);
        return out.book;
      });
      return out!.ads;
    });
    return out!;
  }

  async function reply(token: string, ev: ScreenEvent, text: string, extra: OutMessage[] = [], once?: string) {
    const res = await lineApi.send({ token, replyTo: ev.id, messages: [{ type: "text", text }, ...extra], ...(once ? { once } : {}) });
    if (!res.ok) {
      writeJournal({ who: "プログラム", text: `LINE に返事を送れなかった（${res.code === "limit" ? "送る上限" : "うまくいかなかった"}）：${text.slice(0, 60)}` });
      setLineStatus({ problem: problemText(res.code, res.message) });
    } else setLineStatus({ last: sentStatus(res.via === "push" ? "push" : "reply", text) });
  }

  /** 台帳と広告を書く所（書く直前に読みなおす。書けたかを返す。book/store.ts・ads/useAds.ts と同じ） */
  function pressStore(): PressStore {
    const todayDate = shopToday(getShop()).today.date;
    return {
      readBook: () => readBook(todayDate),
      writeBook: (next) => updateBook(() => next, todayDate),
      readAds: readAdsState,
      writeAds: writeAdsState,
    };
  }

  async function handle(ev: ScreenEvent, token: string, epoch: string | undefined) {
    const cur = readLineState();
    if (!cur || cur.handled.includes(ev.id)) return;
    updateLineState((x) => (x ? withHandled(x, ev.id) : x));

    if (ev.kind === "press") {
      // 🔒 合言葉でつないだ LINE のボタン（サーバーが署名・つなぎ・1回だけの印を確かめた物）。画面のボタンと同じ変え方。
      // 書けた時だけ日誌と確定の返事。書けなければ承認待ちのまま残し、日誌は書かない（line/press.ts）
      const out = commitPress(ev, pressStore(), applyCtx(), epoch);
      if (out.journal.length) writeJournal(...out.journal);
      if (out.failed) setLineStatus({ problem: LINE_PRESS_FAILED_STATUS });
      await reply(token, ev, out.reply);
      return;
    }

    // オーナーの一言：名字を〔お客様〕に置きかえてから AI に送る（だれかは画面のプログラムが名字で決める）
    const L = latest.current;
    const { masked, found } = maskNames(ev.text, data.customers);
    const mode = cur.mode;
    const body = {
      text: masked,
      customer: found.length === 1 ? { id: found[0].id, surname: found[0].surname, firstVisit: found[0].firstVisit } : null,
      booked: L.book.booked,
      rules: L.rules.filter((r) => !r.locked),
      dayOffset: L.book.dayOffset,
      seats: L.book.shop.seats,
      // 休みの日（予約のページで決めた分）。サーバーは形と数を確かめてから判定に使う
      holidays: L.book.shop.ownerHolidays ?? [],
      // 直したメニュー（ルールのタブ）。サーバーは id・名前・色・組み合わせの中身と数の幅を確かめてから使う
      menus: L.book.data.menus,
    };
    // 送った時のメニューの設定の印。返事を待つ間にメニューを直したら、その返事の仮押さえは入れない
    const menusAt = L.book.menusMark;
    let res: LineAskResponse = await lineApi.ask({ ...body, mode });
    let note = "";
    if (!res.ok && res.code === "no-ai" && mode === "ai") {
      // AI につながらないときは、決まった返事（AI なし）で振り分ける
      writeJournal({ who: "プログラム", text: `${NO_AI_MESSAGE}。LINE の一言は決まった返事で振り分ける` });
      res = await lineApi.ask({ ...body, mode: "script" });
      note = "（今は AI につながらないので、決まった返事で振り分けました）";
    }
    if (!res.ok) {
      writeJournal({ who: "プログラム", text: `LINE の一言を振り分けられなかった：${res.message}` });
      await reply(token, ev, LINE_TEXT.retry(res.message));
      return;
    }
    if (res.kind === "hold" && latest.current.book.menusMark !== menusAt) {
      writeJournal({ who: "プログラム", text: "LINE の一言の仮押さえを入れなかった（返事を待つ間にメニューを直したため）" });
      await reply(token, ev, LINE_TEXT.retry("返事を待つ間にメニューを直したので、入れませんでした"));
      return;
    }
    const answer = res;
    const todays = L.book.all
      .filter((r) => r.date === L.book.today.date)
      .map((r) => ({ customerId: r.customer.id, date: r.date, status: r.status }));
    const karte = karteTargetFor(found, todays, L.bookState.state);
    const ctx = { ...applyCtx(), found, karte, memoMax: getMemoMaxChars() };
    // 返事に承認のボタンを付ける行（仮押さえ）は、台帳に書く前に「届けた」ことにする（別に送らない）
    const cardId = answer.kind === "hold" ? `ap-${answer.hold.id}` : undefined;
    if (cardId) updateLineState((x) => (x ? withNotified(x, [cardId]) : x));
    let memo: ReturnType<typeof applyAsk>["memo"];
    const out = commit((b, a) => {
      const o = applyAsk(ev, answer, b, a, ctx);
      memo = o.memo;
      return o;
    });
    const m = memo as ReturnType<typeof applyAsk>["memo"];
    if (m) {
      const key = deskKey(m.customerId, m.date);
      setDesk((d) => {
        const before = d.memos[key]?.trim();
        const text = (before ? `${before}\n${m.text}` : m.text).slice(0, getMemoMaxChars());
        return { memos: { ...d.memos, [key]: text } };
      });
    }
    writeJournal(...(out.journal as { who: JournalWho; text: string }[]));
    await reply(token, ev, `${out.reply}${note}`, out.card ? [{ type: "approval", card: out.card }] : [], cardId);
  }

  return null;
}

function when(iso: string | undefined, timezone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("ja-JP", { timeZone: timezone, month: "numeric", day: "numeric" })} ${d.toLocaleTimeString("ja-JP", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })}`;
}
