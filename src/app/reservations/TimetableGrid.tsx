// 1週間の予約台帳の時間割（見た目だけ。並べ方は src/lib/book/timetable.ts）。
// 横に今日から7日、縦に営業時間。予約は時間の長さの分だけ縦に伸びる帯で、確定は塗りつぶし、仮押さえは点線のしま模様。
// 今日の列は目立たせ、定休日の列は灰色。列の頭に件数（大きい数字）と埋まり（小さい棒）。
// 帯の色はだれが入れたか（仮押さえ = AI 青緑・承認で確定 = 人 琥珀・前からの確定 = 外 藍）。色だけに頼らず帯の頭に「AI」「人」「外」の札。

import type { CSSProperties } from "react";
import { ActorTag, CustomerName, MiniBar } from "@/components/parts";
import { bandTitle, type Timetable, type TimetableBand } from "@/lib/book/timetable";

function bandClass(b: TimetableBand): string {
  return ["tt-band", b.status === "hold" ? "hold" : "confirmed", `actor-${b.actor}`, b.fresh ? "fresh" : "", b.minutes <= 30 ? "short" : ""]
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

const round = (n: number) => Math.round(n * 100) / 100;

export function TimetableGrid({ tt }: { tt: Timetable }) {
  const hours = (tt.to - tt.from) / 60;
  return (
    <div className="tt" style={{ "--tt-hours": hours } as CSSProperties} role="group" aria-label="1週間の予約台帳（時間割）">
      <div className="tt-corner" aria-hidden />
      {tt.columns.map((c) => (
        <div key={c.date} className={["tt-head", c.isToday ? "today" : "", c.open ? "" : "closed"].filter(Boolean).join(" ")}>
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
          className={["tt-col", c.isToday ? "today" : "", c.open ? "" : "closed"].filter(Boolean).join(" ")}
          aria-label={`${c.label}${c.isToday ? "（今日）" : ""}${c.open ? `：${c.count}件` : "：お休み"}`}
        >
          {c.off.map((s, i) => (
            <span key={i} className="tt-offhours" style={{ top: `${s.top}%`, height: `${s.height}%` }} aria-hidden />
          ))}
          {!c.open && <span className="tt-closed-label">お休み</span>}
          {tt.now?.date === c.date && <span className="tt-now" style={{ top: `${tt.now.top}%` }} title="いま" aria-hidden />}
          <ul className="tt-bands">
            {c.bands.map((b) => (
              <li key={b.id} className={bandClass(b)} style={bandStyle(b)} title={bandTitle(b)}>
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
                  {b.firstVisit && <span className="tt-band-first">初めての方</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
