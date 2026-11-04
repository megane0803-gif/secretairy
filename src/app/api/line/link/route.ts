// 画面の「LINE とつなぐ」「つなぎを切る」の窓口。合言葉と、その画面だけが持つ印（token）を返す。
// LINE の人の番号は返さない。

import { startLink, unlink } from "@/lib/line/bridge";
import { bridgeDeps, json, noStore, readJson } from "@/lib/line/server";
import { NoStoreError } from "@/lib/line/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { action?: unknown; token?: unknown } | null;
  if (!body || (body.action !== "start" && body.action !== "unlink"))
    return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  const token = typeof body.token === "string" ? body.token.slice(0, 200) : undefined;
  try {
    const d = bridgeDeps();
    if (body.action === "start") return json(await startLink(d, token));
    if (token) await unlink(d, token);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof NoStoreError) return noStore();
    console.error("line link: うまくいきませんでした");
    return json({ ok: false, code: "failed", message: "うまくいきませんでした" }, 500);
  }
}
