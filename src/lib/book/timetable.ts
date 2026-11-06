// 1週間の予約台帳の「時間割」の形（PC の予約タブの真ん中の列の一番上に出す。右の列の予約チャットと横に並ぶ）。
// 横に今日から7日、縦に営業時間。予約は時間の長さの分だけ縦に伸びる帯にする。
// ここは並べ方の計算だけ（どこに・どの高さで出すか）。数（件数・埋まり）は台帳（reservations.ts の weekLedger）の物をそのまま使う。
// 同じ時間に受ける人数が2人以上で時間が重なるときは、重なった帯を横に分けて並べる。

import { ACTOR_LABEL, ACTOR_MEANING, reservationActor, type Actor } from "../actors";
import { toHHMM, toMinutes } from "../calendar";
import type { LedgerDay, Reservation } from "../reservations";
import { menuColorOf, type MenuColor } from "./menuColor";
import { guestName } from "../guestName";

/** 縦の位置と高さ（時間割の上から何 %） */
export type Span = { top: number; height: number };

export type TimetableBand = Span & {
  id: string;
  /** confirmed = 確定（実線の枠）/ hold = 仮押さえ（点線のしま模様） */
  status: Reservation["status"];
  /** 承認で確定した予約（予約チャットから入った確定） */
  fresh: boolean;
  /** 予約サイトから入った予約（お客様が自分で決めた確定。承認の箱は通らない） */
  site?: boolean;
  /** だれが入れた物か（仮押さえ = AI・承認で確定と店が受けた確定 = 人・予約サイトから = 外。src/lib/actors.ts）。帯の頭の札だけに使う */
  actor: Actor;
  /** 帯の色（メニューごと。src/lib/book/menuColor.ts。設定に色の無いメニューは none = 灰色） */
  menuColor: MenuColor;
  start: string;
  end: string;
  minutes: number;
  menuName: string;
  surname: string;
  firstVisit: boolean;
  /** 重なった帯の中で何番目か（0 から）と、その重なりの帯の数 */
  lane: number;
  lanes: number;
};

export type TimetableColumn = {
  date: string;
  label: string;
  isToday: boolean;
  /** 定休日・休みの日は false（列を灰色にする） */
  open: boolean;
  hours: LedgerDay["hours"];
  count: number;
  usedMinutes: number;
  capacityMinutes: number;
  /** 営業時間の外（その日だけ時間が短いとき）。灰色にする */
  off: Span[];
  bands: TimetableBand[];
};

export type Timetable = {
  /** 縦の始まりと終わり（分） */
  from: number;
  to: number;
  /** 1時間ごとの目盛り */
  ticks: { label: string; top: number }[];
  columns: TimetableColumn[];
  /** いまの時刻の線（今日の列が7日の中にあり、営業時間の幅の中のときだけ） */
  now: { date: string; top: number } | null;
};

const round = (n: number) => Math.round(n * 100) / 100;

/** 重なった帯を横に分ける：始まりの早い順に、空いているいちばん左の場所へ。重なりの一まとまりごとに数を決める */
function lanesOf(list: Reservation[]): Map<string, { lane: number; lanes: number }> {
  const out = new Map<string, { lane: number; lanes: number }>();
  const sorted = [...list].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let group: { id: string; lane: number }[] = [];
  let groupEnd = -1;
  let laneEnds: number[] = [];
  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const g of group) out.set(g.id, { lane: g.lane, lanes });
    group = [];
    laneEnds = [];
  };
  for (const r of sorted) {
    if (group.length && r.startMin >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= r.startMin);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(r.endMin);
    } else laneEnds[lane] = r.endMin;
    group.push({ id: r.id, lane });
    groupEnd = Math.max(groupEnd, r.endMin);
  }
  flush();
  return out;
}

/**
 * 7日分の台帳を時間割の形にする。
 * 縦の幅は、7日の中でいちばん早い開店からいちばん遅い閉店まで（1時間の区切りにそろえる）。
 * 営業日が1日も無ければ 10:00〜20:00。
 */
export function timetable(week: LedgerDay[], now?: { date: string; time: string }): Timetable {
  const openDays = week.filter((d) => d.hours);
  const opens = openDays.map((d) => toMinutes(d.hours!.open));
  const closes = openDays.map((d) => toMinutes(d.hours!.close));
  const from = Math.floor((opens.length ? Math.min(...opens) : 600) / 60) * 60;
  const to = Math.max(from + 60, Math.ceil((closes.length ? Math.max(...closes) : 1200) / 60) * 60);
  const total = to - from;
  const at = (min: number) => round(((Math.min(to, Math.max(from, min)) - from) / total) * 100);
  const span = (a: number, b: number): Span => ({ top: at(a), height: round(at(b) - at(a)) });

  const ticks: Timetable["ticks"] = [];
  for (let t = from; t <= to; t += 60) ticks.push({ label: toHHMM(t), top: at(t) });

  const columns = week.map((d): TimetableColumn => {
    const lanes = lanesOf(d.reservations);
    const off: Span[] = [];
    if (d.hours) {
      const o = toMinutes(d.hours.open);
      const c = toMinutes(d.hours.close);
      if (o > from) off.push(span(from, o));
      if (c < to) off.push(span(c, to));
    }
    return {
      date: d.date,
      label: d.label,
      isToday: d.isToday,
      open: d.open && d.hours !== null,
      hours: d.hours,
      count: d.reservations.length,
      usedMinutes: d.usedMinutes,
      capacityMinutes: d.capacityMinutes,
      off,
      bands: d.reservations.map((r) => ({
        ...span(r.startMin, r.endMin),
        id: r.id,
        status: r.status,
        fresh: r.status === "confirmed" && r.source === "chat",
        ...(r.source === "site" ? { site: true } : {}),
        actor: reservationActor(r),
        menuColor: menuColorOf(r.menu),
        start: r.start,
        end: r.end,
        minutes: r.menu.minutes,
        menuName: r.menu.name,
        surname: r.customer.surname,
        firstVisit: r.customer.firstVisit,
        ...(lanes.get(r.id) ?? { lane: 0, lanes: 1 }),
      })),
    };
  });

  let line: Timetable["now"] = null;
  if (now && week.some((d) => d.date === now.date && d.hours)) {
    const m = toMinutes(now.time);
    if (m >= from && m <= to) line = { date: now.date, top: at(m) };
  }

  return { from, to, ticks, columns, now: line };
}

/** 帯の読み上げ・ホバーの文（「10:00–11:00 カット 久保様 仮押さえ（承認待ち）［AI：AI がした事］」） */
export function bandTitle(b: TimetableBand): string {
  const who = guestName(b.surname);
  const state = b.status === "hold" ? "仮押さえ（承認待ち）" : b.fresh ? "確定（承認で確定）" : b.site ? "確定（予約サイトから）" : "確定";
  const by = `［${ACTOR_LABEL[b.actor]}：${ACTOR_MEANING[b.actor]}］`;
  return `${b.start}–${b.end} ${b.menuName} ${who} ${state}${b.firstVisit ? " 初めての方" : ""} ${by}`;
}
