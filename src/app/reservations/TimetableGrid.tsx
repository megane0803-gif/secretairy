// 1週間の予約台帳の時間割（見た目だけ。並べ方は src/lib/book/timetable.ts）。
// 横に今日から7日、縦に営業時間。予約は時間の長さの分だけ縦に伸びる帯で、確定は実線、仮押さえは点線のしま模様（形で分ける）。
// 今日の列は目立たせ、定休日の列は灰色。列の頭に件数（大きい数字）と埋まり（小さい棒）。
// 帯の色はメニュー（薄い背景＋左の太い線。src/lib/book/menuColor.ts・globals.css の --menu-<名前>）。字はふつうの字の色。
// だれが入れたか（AI・人・外）は色ではなく、帯の頭の札（ActorTag）だけで見せる。

import type { CSSProperties } from "react";
import { ActorTag, CustomerName, MiniBar } from "@/components/parts";
import { bandTitle, type Timetable, type TimetableBand } from "@/lib/book/timetable";
import { OWNER_TAG } from "@/lib/book/owner";

function bandClass(b: TimetableBand): string {
  return ["tt-band", b.status === "hold" ? "hold" : "confirmed", `menu-c-${b.menuColor}`, b.fresh ? "fresh" : "", b.minutes <= 30 ? "short" : ""]
    .filter(Boolean)
    .join(" ");
}

function bandStyle(b: TimetableBand): CSSProperties {
  const w = 100 / b.lanes;
  return {
    top: `${b.top}%`,
    height: `calc(${b.height}% - 2px)`,
    left: `calc(${round(w * b.lane)}% + 2px)`,
    width: `calc(${round(w)}% - 4px)`,
  };
}

/** 帯・行を押せるようにする（li のまま。見た目は変えない）。Enter と スペースでも開く */
export function openProps(open: () => void, label: string) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    },
  } as const;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function TimetableGrid({
  tt,
  onPick,
  onOpen,
}: {
  tt: Timetable;
  onPick?: (date: string, start: string) => void;
  /** 予約の帯を押した時（その予約の1枚を開く。見た目は変えない） */
  onOpen?: (id: string) => void;
}) {
  const hours = (tt.to - tt.from) / 60;
  return (
    <div className="tt" style={{ "--tt-hours": hours } as CSSProperties} role="group" aria-label="1週間の予約台帳（時間割）">
      <div className="tt-corner" aria-hidden />
      {tt.columns.map((c) => (
        <div key={c.date} className={["tt-head", c.isToday ? "today" : "", c.open ? "" : "closed", c.outside ? "outside" : ""].filter(Boolean).join(" ")}>
          <span className="tt-date">
            {c.label}
            {c.isToday && <span className="tag">今日</span>}
          </span>
          {c.open ? (
            <>
              <span className="tt-count">
                <strong className="num">{c.count}</strong> 件
              </span>
              <MiniBar value={c.usedMinutes} max={c.capacityMinutes} label="埋まり" />
            </>
          ) : (
            <span className="tt-off-label">お休み</span>
          )}
        </div>
      ))}

      <div className="tt-axis" aria-hidden>
        {tt.ticks.map((t) => (
          <span key={t.label} className="tt-tick num" style={{ top: `${t.top}%` }}>
            {t.label}
          </span>
        ))}
      </div>
      {tt.columns.map((c) => (
        <div
          key={c.date}
          id={`tt-col-${c.date}`}
          className={["tt-col", c.isToday ? "today" : "", c.open ? "" : "closed", c.outside ? "outside" : ""].filter(Boolean).join(" ")}
          aria-label={`${c.label}${c.isToday ? "（今日）" : ""}${c.open ? `：${c.count}件` : "：お休み"}`}
        >
          {c.off.map((s, i) => (
            <span key={i} className="tt-offhours" style={{ top: `${s.top}%`, height: `${s.height}%` }} aria-hidden />
          ))}
          {!c.open && <span className="tt-closed-label">お休み</span>}
          {onPick &&
            c.picks.map((p) => (
              <button
                key={p.start}
                type="button"
                className="tt-pick"
                style={{ top: `${p.top}%`, height: `${p.height}%` }}
                onClick={() => onPick(c.date, p.start)}
                aria-label={`${c.label} ${p.start} に予約を入れる`}
                title={`${c.label} ${p.start} に予約を入れる`}
              >
                <span aria-hidden>＋</span>
              </button>
            ))}
          {tt.now?.date === c.date && <span className="tt-now" style={{ top: `${tt.now.top}%` }} title="いま" aria-hidden />}
          <ul className="tt-bands">
            {c.bands.map((b) => (
              <li
                key={b.id}
                className={onOpen ? `${bandClass(b)} openable` : bandClass(b)}
                style={bandStyle(b)}
                title={bandTitle(b)}
                {...(onOpen ? openProps(() => onOpen(b.id), `${bandTitle(b)}。押すと中身を見る`) : {})}
              >
                <span className="tt-band-top">
                  <ActorTag actor={b.actor} />
                  <span className="tt-band-time num">
                    {b.start}
                    <small>–{b.end}</small>
                  </span>
                </span>
                <CustomerName surname={b.surname} fictional={b.fictional} />
                <span className="tt-band-menu">
                  {b.menuName}
                  {b.status === "hold" && <span className="tag hold">仮押さえ</span>}
                  {b.fresh && <span className="tag ok">承認で確定</span>}
                  {b.site && <span className="tag from-site">予約サイトから</span>}
                  {b.owner && <span className="tag owner">{OWNER_TAG}</span>}
                  {b.firstVisit && <span className="tag first">初めての方</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
