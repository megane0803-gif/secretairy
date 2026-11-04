// 画面から LINE へ送る窓口。返事で済むときは返事（数えない）、そうでなければ送る（1日の上限まで）。
// 承認待ちの行には、1回だけ効くボタン（承認／見送り）をサーバーが付ける。

import { sendFromScreen } from "@/lib/line/bridge";
import { bridgeDeps, json, noStore, readJson } from "@/lib/line/server";
import { NoStoreError } from "@/lib/line/store";
import { parseSendRequest } from "@/lib/line/wire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const req = parseSendRequest(await readJson(request));
  if (!req) return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  try {
    return json(await sendFromScreen(bridgeDeps(), req));
  } catch (e) {
    if (e instanceof NoStoreError) return noStore();
    console.error("line send: うまくいきませんでした");
    return json({ ok: false, code: "failed", message: "うまくいきませんでした" }, 500);
  }
}
