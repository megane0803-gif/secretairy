"use client";

// 広告タブの真ん中：架空の広告の4週分。
// AdsWeeks は一番上の「検索広告の4週分」（大きい数字3つと週ごとの小さい縦棒）。
// AdsReport はその下の「広告の管理画面」と、そのすぐ下のテスト用の広告アカウントの今の様子（AdsLiveRead）と、2つの一覧。
// 数はどれもプログラムが表から出す（AI は数を作らない）。止めた・外した行は薄くする。

import { BigNumber, MiniColumns } from "@/components/parts";
import { addedRows, totalOf, townIn, WEEK_LABELS, weeklyTotals, yen, type AdTableRow } from "@/lib/ads/report";
import { realMarkedNos } from "@/lib/ads/connect";
import { useAds } from "@/lib/ads/useAds";
import { useLiveLink } from "@/lib/ads/live/usePanel";
import { AdsLiveRead } from "./AdsLiveRead";

/** 足した言葉の行（広告を出す言葉の一覧の下。数はまだ無いので「—」） */
function AddedRow({ r }: { r: AdTableRow }) {
  return (
    <tr className="added">
      <td className="num">—</td>
      <td>
        <span className="ad-word">
          {r.text}
          <span className="tag ok">足した</span>
          <small className="hint">（{r.no}番の調べた言葉から）</small>
        </span>
      </td>
      <td className="num">—</td>
      <td className="num">—</td>
      <td className="num">—</td>
      <td>—</td>
    </tr>
  );
}

function Rows({ rows, towns, offWord, added = [] }: { rows: AdTableRow[]; towns: string[]; offWord: string; added?: AdTableRow[] }) {
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
                    {r.addMark === "added" && <span className="tag ok">もう足した</span>}
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
          {added.map((r) => (
            <AddedRow key={`added-${r.no}`} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 一番上の「検索広告の4週分」：大きい数字3つと週ごとの小さい縦棒（広告を出す言葉の4週の合計） */
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
        {settings.channel}の4週分
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

/** 「広告の管理画面」と、広告を出す言葉・お客さんが調べた言葉の2つの一覧 */
export function AdsReport() {
  const { table, settings, state } = useAds();
  const link = useLiveLink();
  // つないでいない時（プレビュー・手元・環境変数が足りない）は、ここだけに反映する
  const off = !!link && link !== "unknown" && !link.connected;
  // 「本物に反映済み」の印（くわしくの中で結果を読み込んだ物だけ。無ければ何も出さない）
  const real = realMarkedNos(state);
  const realTag = (no: number) => (real.has(no) ? <span className="tag ok">本物に反映済み</span> : null);
  const stopped = table.keywords.filter((r) => r.off);
  const excluded = table.searchTerms.filter((r) => r.off);
  // 足した言葉（数はまだ無い。週ごとの合計・止める案には入れない）
  const added = addedRows(table);

  return (
    <>
      <section className="ad-site" aria-labelledby="ad-site">
        <h2 id="ad-site">
          広告の管理画面
        </h2>
        {off ? (
          <p className="hint">承認すると、ここに反映します（言葉が止まる・外れる・足される）。いまはテスト用の広告アカウントにつないでいないので、ここだけです。</p>
        ) : (
          <p className="hint">
            承認すると、ここに反映し、テスト用の広告アカウントにも、元の形に戻してからその1件を本当に送ります。広告は出ず、お金は動きません。テスト用アカウントの今の様子は、下の「読み直す」でだれでも見られます。
          </p>
        )}
        <strong>広告を出す言葉</strong>
        <ul>
          {table.keywords.map((r) => (
            <li key={r.no} className={r.off ? "off" : undefined}>
              {r.no}番 {r.text}
              <span className={r.off ? "tag offtag" : "tag ok"}>{r.off ? "止めた" : "出している"}</span>
              {r.off && realTag(r.no)}
            </li>
          ))}
          {added.map((r) => (
            <li key={`added-${r.no}`}>
              — {r.text}
              <span className="tag ok">足した</span>
              {realTag(r.no)}
              <small className="hint">（フレーズ一致・数はまだ無い）</small>
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
                {realTag(r.no)}
              </li>
            ))}
          </ul>
        )}
        {stopped.length + excluded.length + added.length > 0 && (
          <p className="hint">
            止めた {stopped.length}・外した {excluded.length}
            {added.length > 0 && `・足した ${added.length}`}
          </p>
        )}
      </section>

      <AdsLiveRead />

      <h2>広告を出す言葉（止められる）</h2>
      <Rows rows={table.keywords} towns={settings.towns} offWord="止めた" added={added} />
      <h2 style={{ marginTop: 16 }}>お客さんが調べた言葉（多い順・外せる）</h2>
      <Rows rows={table.searchTerms} towns={settings.towns} offWord="外した" />
      <p className="hint">町の名前（{settings.towns.join("・")}）が入った言葉は、近くのお客様の言葉なので外しません（プログラムが確かめます）。</p>
    </>
  );
}
