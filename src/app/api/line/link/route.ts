// 画面の「LINE とつなぐ」「つなぎを切る」「最初に戻す（預かり物を消す）」の窓口。合言葉と、その画面だけが持つ印（token）を返す。
// LINE の人の番号は返さない。

import { clearInbox, startLink, unlink } from "@/lib/line/bridge";
import { bridgeDeps, clientOf, json, noStore, readJson } from "@/lib/line/server";
import { NoStoreError } from "@/lib/line/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { action?: unknown; token?: unknown; passcode?: unknown } | null;
  if (!body || (body.action !== "start" && body.action !== "unlink" && body.action !== "clear"))
    return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  const token = typeof body.token === "string" ? body.token.slice(0, 200) : undefined;
  try {
    const d = bridgeDeps();
    if (body.action === "start") {
      // オーナー用の合言葉（LINE_OWNER_PASSCODE）があるときだけ見る。合言葉は日誌・ログに出さない
      const passcode = typeof body.passcode === "string" ? body.passcode.slice(0, 200) : undefined;
      const r = await startLink(d, token, { passcode, client: clientOf(request) });
      return json(r, r.ok || r.code !== "passcode" ? 200 : 403);
    }
    if (body.action === "clear") return json({ ok: token ? await clearInbox(d, token) : false });
    if (token) await unlink(d, token);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof NoStoreError) return noStore();
    console.error("line link: うまくいきませんでした");
    return json({ ok: false, code: "failed", message: "うまくいきませんでした" }, 500);
  }
}
