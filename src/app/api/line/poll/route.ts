// 画面が LINE の知らせを受け取りに来る窓口（画面が開いている間だけ、数秒ごと）。
// 来たことを「画面が開いている」の印にする。預かり物は渡したら消える。

import { pollScreen } from "@/lib/line/bridge";
import { bridgeDeps, json, noStore, readJson } from "@/lib/line/server";
import { NoStoreError } from "@/lib/line/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as { token?: unknown } | null;
  if (!body || typeof body.token !== "string") return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  try {
    return json(await pollScreen(bridgeDeps(), body.token.slice(0, 200)));
  } catch (e) {
    if (e instanceof NoStoreError) return noStore();
    console.error("line poll: うまくいきませんでした");
    return json({ ok: false, code: "failed", message: "うまくいきませんでした" }, 500);
  }
}
