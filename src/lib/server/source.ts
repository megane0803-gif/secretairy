// 来た人の送り元を数える形（サーバーの側）。広告のだれでも試す（src/lib/ads/live/server.ts）と、経理の来た人の試し
// （src/lib/freee/try.ts）が、どちらもここを通す（2つ作らない）。
//   - 送り元は Vercel が付ける IP だけ（x-real-ip、無ければ x-vercel-forwarded-for の最初）。ブラウザが付けられる x-forwarded-for などは見ない
//   - 数える単位（束）：IPv4 は1つの番地・IPv6 は前の半分（/64）・IPv4 を写した IPv6 は IPv4
//   - IPv6 は、もう1つ広い束（/48）でも数える（sourceBuckets の wide。IPv4 には無い）
//   - 置くのは日ごとの塩と合わせたハッシュだけ（生の IP は置かない・返さない・ログに出さない）

import { createHash } from "node:crypto";

/** 送り元（Vercel が付ける送り元の IP だけ。ブラウザが付けられる x-forwarded-for などは見ない） */
export function sourceIp(request: Request): string {
  const real = (request.headers.get("x-real-ip") ?? "").trim();
  if (real) return real.slice(0, 64);
  const vf = (request.headers.get("x-vercel-forwarded-for") ?? "").split(",")[0].trim();
  return vf ? vf.slice(0, 64) : "unknown";
}

/** IPv6 の8つの区切り（16進の数）。IPv6 でない・読めない形は null（IPv4 を写した IPv6 は "v4" とその番地） */
function v6Groups(s: string): number[] | { v4: string } | null {
  const v4tail = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let text = s;
  if (v4tail) {
    const oct = v4tail[2].split(".").map(Number);
    if (oct.some((n) => n > 255)) return null;
    if (/^(0{0,4}:){0,5}:?ffff:$/.test(v4tail[1]) || v4tail[1] === "::ffff:") return { v4: v4tail[2] };
    text = `${v4tail[1]}${((oct[0] << 8) | oct[1]).toString(16)}:${((oct[2] << 8) | oct[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

const tidyIp = (ip: string) => ip.trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
const prefixOf = (g: number[], n: number, bits: number) => `${g.slice(0, n).map((h) => h.toString(16)).join(":")}::/${bits}`;

/**
 * 数える単位（送り元の束）。IPv4 は1つの番地のまま。IPv6 は前の半分（/64）でまとめる
 * （1人が手元で後ろの半分を変えて、同じ送り元の上限をすり抜けられないように）。IPv4 を写した IPv6（::ffff:a.b.c.d）は IPv4 として数える。
 * 読めない形は、そのままの文字を1つの束にする（ハッシュにするので置き場には生の文字は残らない）。
 */
export function sourceBucket(ip: string): string {
  return sourceBuckets(ip).narrow;
}

/**
 * 送り元の束を2つ：narrow は今の束（sourceBucket と同じ）・wide は IPv6 の /48（1つの家や会社に配られる広さ。
 * その中で /64 を変えても、/48 の上限で止まる）。IPv4・IPv4 を写した IPv6・読めない形は wide なし（null）。
 */
export function sourceBuckets(ip: string): { narrow: string; wide: string | null } {
  const s = tidyIp(ip);
  if (!s.includes(":")) return { narrow: s, wide: null };
  const g = v6Groups(s);
  if (!g) return { narrow: s, wide: null };
  if (!Array.isArray(g)) return { narrow: g.v4, wide: null };
  return { narrow: prefixOf(g, 4, 64), wide: prefixOf(g, 3, 48) };
}

/** 送り元のハッシュ（塩と合わせる。生の IP は返さない・置かない） */
export function sourceHash(salt: string, ip: string): string {
  return createHash("sha256").update(`${salt}\n${ip}`).digest("hex").slice(0, 32);
}

/** 送り元の束2つのハッシュ（wide は IPv6 の /48 の時だけ。束の文字の頭が違うので、narrow と wide のハッシュは混ざらない） */
export function sourceHashes(salt: string, ip: string): { narrow: string; wide: string | null } {
  const b = sourceBuckets(ip);
  return { narrow: sourceHash(salt, b.narrow), wide: b.wide ? sourceHash(salt, b.wide) : null };
}
