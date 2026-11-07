// 来た人の送り元を数える形（サーバーの側）。広告のだれでも試す（src/lib/ads/live/server.ts）と、経理の来た人の試し
// （src/lib/freee/try.ts）が、どちらもここを通す（2つ作らない）。
//   - 送り元は Vercel が付ける IP だけ（x-real-ip、無ければ x-vercel-forwarded-for の最初）。ブラウザが付けられる x-forwarded-for などは見ない
//   - 数える単位（束）：IPv4 は1つの番地・IPv6 は前の半分（/64）・IPv4 を写した IPv6 は IPv4
//   - 置くのは日ごとの塩と合わせたハッシュだけ（生の IP は置かない・返さない・ログに出さない）

import { createHash } from "node:crypto";

/** 送り元（Vercel が付ける送り元の IP だけ。ブラウザが付けられる x-forwarded-for などは見ない） */
export function sourceIp(request: Request): string {
  const real = (request.headers.get("x-real-ip") ?? "").trim();
  if (real) return real.slice(0, 64);
  const vf = (request.headers.get("x-vercel-forwarded-for") ?? "").split(",")[0].trim();
  return vf ? vf.slice(0, 64) : "unknown";
}

/**
 * 数える単位（送り元の束）。IPv4 は1つの番地のまま。IPv6 は前の半分（/64）でまとめる
 * （1人が手元で後ろの半分を変えて、同じ送り元の上限をすり抜けられないように）。IPv4 を写した IPv6（::ffff:a.b.c.d）は IPv4 として数える。
 * 読めない形は、そのままの文字を1つの束にする（ハッシュにするので置き場には生の文字は残らない）。
 */
export function sourceBucket(ip: string): string {
  const s = ip.trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!s.includes(":")) return s;
  const v4tail = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let text = s;
  if (v4tail) {
    const oct = v4tail[2].split(".").map(Number);
    if (oct.some((n) => n > 255)) return s;
    if (/^(0{0,4}:){0,5}:?ffff:$/.test(v4tail[1]) || v4tail[1] === "::ffff:") return v4tail[2];
    text = `${v4tail[1]}${((oct[0] << 8) | oct[1]).toString(16)}:${((oct[2] << 8) | oct[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return s;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return s;
  return `${all
    .slice(0, 4)
    .map((h) => parseInt(h, 16).toString(16))
    .join(":")}::/64`;
}

/** 送り元のハッシュ（塩と合わせる。生の IP は返さない・置かない） */
export function sourceHash(salt: string, ip: string): string {
  return createHash("sha256").update(`${salt}\n${ip}`).digest("hex").slice(0, 32);
}
