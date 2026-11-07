// 本番のサイトだけで動かす窓口の、共通の守り（サーバーの側）。freee（src/lib/freee/server.ts）と、
// 広告のテスト用アカウント（src/lib/ads/live/server.ts）の窓口が、どちらもここを通す（2つ作らない）。
//   - 本番（VERCEL_ENV=production）で、本番のサイトの名前（host）に来た呼び出しだけ。プレビュー・手元・別の URL では "off"
//   - 受ける形（GET か POST）のほかは "method"
//   - POST は、Origin が本番のサイトで、sec-fetch-site があれば same-origin の時だけ（ほかは "origin"）
// サイトの場所は config/accounting.json の freee.siteOrigin の1か所（settings.ts の getSiteOrigin）。
// Origin の確かめは本人の確かめではない（合言葉・cookie は窓口ごとに別に確かめる）。

export type SiteCheck = "off" | "method" | "origin" | null;

export function siteCheck(request: Request, p: { vercelEnv: string | null; siteOrigin: string; method: "GET" | "POST" }): SiteCheck {
  const site = new URL(p.siteOrigin);
  if (p.vercelEnv !== "production" || (request.headers.get("host") ?? "").toLowerCase() !== site.host) return "off";
  if (request.method !== p.method) return "method";
  if (p.method === "POST") {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (origin !== site.origin || (fetchSite !== null && fetchSite !== "same-origin")) return "origin";
  }
  return null;
}

/** 本番のサイトか（プレビュー・手元ではない）だけを見る。呼び出しの形は見ない（つながっているかの札など） */
export function onProductionSite(request: Request, p: { vercelEnv: string | null; siteOrigin: string }): boolean {
  return p.vercelEnv === "production" && (request.headers.get("host") ?? "").toLowerCase() === new URL(p.siteOrigin).host;
}
