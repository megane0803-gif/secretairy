"use client";

// 広告タブの真ん中：架空の広告の4週分。
// AdsWeeks は一番上の「検索広告（架空）の4週分」（大きい数字3つと週ごとの小さい縦棒）。
// AdsReport はその下の「広告（架空）の画面」と2つの一覧。
// 数はどれもプログラムが表から出す（AI は数を作らない）。止めた・外した行は薄くする。

import { BigNumber, MiniColumns } from "@/components/parts";
import { totalOf, townIn, WEEK_LABELS, weeklyTotals, yen, type AdTableRow } from "@/lib/ads/report";
import { useAds } from "@/lib/ads/useAds";

function Rows({ rows, towns, offWord }: { rows: AdTableRow[]; towns: string[]; offWord: string }) {
  return (
    <div className="ad-scroll">
      <table className="table ad-table">
        <thead>
          <tr>
            <th className="num">番号</th>
            <th>言葉</th>
            <th className="num">押された</th>
            <th className="num">お金</th>
            <th className="num">予約</th>
            <th>週ごと（押された）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const t = totalOf(r);
            const town = townIn(r.text, towns);
            return (
              <tr key={r.no} className={r.off ? "off" : undefined}>
                <td className="num">
                  <strong>{r.no}</strong>番
                </td>
                <td>
                  <span className="ad-word">
                    {r.text}
                    {r.featured && <span className="tag featured">売り</span>}
                    {town && (
                      <span className="tag town" title="町の名前の言葉は外しません">
                        町の名前
                      </span>
                    )}
                    {r.off && <span className="tag offtag">{offWord}</span>}
                  </span>
                </td>
                <td className="num">{t.clicks.toLocaleString("ja-JP")}回</td>
                <td className="num">{yen(t.cost)}</td>
                <td className="num">{t.bookings}件</td>
                <td>
                  <MiniColumns values={r.weeks.map((w) => w.clicks)} labels={WEEK_LABELS} label={`${r.no}番の週ごとの押された回数`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 一番上の「検索広告（架空）の4週分」：大きい数字3つと週ごとの小さい縦棒（広告を出す言葉の4週の合計） */
export function AdsWeeks() {
  const { table, settings } = useAds();
  const weeks = weeklyTotals(table.keywords);
  const sum = weeks.reduce((s, w) => ({ clicks: s.clicks + w.clicks, cost: s.cost + w.cost, bookings: s.bookings + w.bookings }), { clicks: 0, cost: 0, bookings: 0 });
  const cols = (label: string, values: number[]) => (
    <>
      <MiniColumns values={values} labels={WEEK_LABELS} label={`${label}（週ごと）`} />
      <div className="minicols-labels" aria-hidden>
        {WEEK_LABELS.map((l) => (
          <span key={l}>{l.replace("週前", "")}</span>
        ))}
      </div>
    </>
  );

  return (
    <section className="ad-weeks" aria-labelledby="ad-weeks">
      <h2 id="ad-weeks">
        {settings.channel}の4週分 <span className="tag fictional">架空</span>
      </h2>
      <div className="bignums">
        <div>
          <BigNumber label="押された回数" value={sum.clicks} unit="回" />
          {cols("押された回数", weeks.map((w) => w.clicks))}
        </div>
        <div>
          <BigNumber label="かかったお金" value={sum.cost} unit="円" />
          {cols("かかったお金", weeks.map((w) => w.cost))}
        </div>
        <div>
          <BigNumber label="予約" value={sum.bookings} unit="件" />
          {cols("予約", weeks.map((w) => w.bookings))}
        </div>
      </div>
      <p className="hint">小さい縦棒は左から 4週前・3週前・2週前・先週。数はどれもプログラムが表から出しています。</p>
    </section>
  );
}

/** 「広告（架空）の画面」と、広告を出す言葉・お客さんが調べた言葉の2つの一覧 */
export function AdsReport() {
  const { table, settings } = useAds();
  const stopped = table.keywords.filter((r) => r.off);
  const excluded = table.searchTerms.filter((r) => r.off);

  return (
    <>
      <section className="ad-site" aria-labelledby="ad-site">
        <h2 id="ad-site">
          広告（架空）の画面 <span className="tag fictional">架空</span>
        </h2>
        <p className="hint">承認すると、ここで言葉が止まります（外れます）。本物の広告にはつながっていません。</p>
        <strong>広告を出す言葉</strong>
        <ul>
          {table.keywords.map((r) => (
            <li key={r.no} className={r.off ? "off" : undefined}>
              {r.no}番 {r.text}
              <span className={r.off ? "tag offtag" : "tag ok"}>{r.off ? "止めた" : "出している"}</span>
            </li>
          ))}
        </ul>
        <strong>外した言葉（この言葉で調べた方には出さない）</strong>
        {excluded.length === 0 ? (
          <p className="hint">まだありません</p>
        ) : (
          <ul>
            {excluded.map((r) => (
              <li key={r.no}>
                {r.no}番 {r.text}
                <span className="tag offtag">外した</span>
              </li>
            ))}
          </ul>
        )}
        {stopped.length + excluded.length > 0 && (
          <p className="hint">
            止めた {stopped.length}・外した {excluded.length}
          </p>
        )}
      </section>

      <h2>広告を出す言葉（止められる）</h2>
      <Rows rows={table.keywords} towns={settings.towns} offWord="止めた" />
      <h2 style={{ marginTop: 16 }}>お客さんが調べた言葉（多い順・外せる）</h2>
      <Rows rows={table.searchTerms} towns={settings.towns} offWord="外した" />
      <p className="hint">町の名前（{settings.towns.join("・")}）が入った言葉は、近くのお客様の言葉なので外しません（プログラムが確かめます）。</p>
    </>
  );
}
