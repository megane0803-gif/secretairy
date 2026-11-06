// スマホの下から出る1枚：数字のキーボードが出ている間、キーボードの高さだけ1枚を上げるための数（画面に依らない形）。
// 見えている所（visualViewport）が、ページの高さより下で欠けている分 = キーボード（などの下の物）の高さ。
// 指で拡大している時（scale > 1）は上げない（拡大で見えている所が小さくなっただけなので）。

export type ViewportLike = { height: number; offsetTop: number; scale?: number };

/** 1枚を上げる高さ（px。0 以上の整数） */
export function keyboardInset(innerHeight: number, vv: ViewportLike | null | undefined): number {
  if (!vv || !(innerHeight > 0) || !(vv.height > 0)) return 0;
  if ((vv.scale ?? 1) > 1.01) return 0;
  const gap = Math.round(innerHeight - vv.height - vv.offsetTop);
  return gap > 0 ? gap : 0;
}
