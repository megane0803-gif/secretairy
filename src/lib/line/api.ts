// LINE に送る所（サーバーの側だけ。鍵は環境変数の LINE_CHANNEL_ACCESS_TOKEN）。
// 返事（reply）は数えられない。送る（push）は月の無料の通数から数えられるので、できるだけ返事で済ませる。
// LINE の人の番号・鍵は、ログにも画面にも出さない（うまくいかなかったときも、出すのは数字の状態だけ）。

export type LineMessage = Record<string, unknown>;
export type LineResult = { ok: boolean; status: number };

export interface LineClient {
  reply(replyToken: string, messages: LineMessage[]): Promise<LineResult>;
  push(to: string, messages: LineMessage[]): Promise<LineResult>;
}

/** LINE につながらない（鍵が無い など） */
export class NoLineError extends Error {}

const API = "https://api.line.me/v2/bot/message";

export function lineClient(accessToken: string | undefined = process.env.LINE_CHANNEL_ACCESS_TOKEN): LineClient {
  if (!accessToken) throw new NoLineError("LINE_CHANNEL_ACCESS_TOKEN がありません");
  async function post(path: string, body: unknown): Promise<LineResult> {
    try {
      const res = await fetch(`${API}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (!res.ok) console.warn(`line ${path}: status ${res.status}`);
      return { ok: res.ok, status: res.status };
    } catch {
      console.warn(`line ${path}: つながりませんでした`);
      return { ok: false, status: 0 };
    }
  }
  return {
    reply: (replyToken, messages) => post("reply", { replyToken, messages: messages.slice(0, 5) }),
    push: (to, messages) => post("push", { to, messages: messages.slice(0, 5) }),
  };
}
