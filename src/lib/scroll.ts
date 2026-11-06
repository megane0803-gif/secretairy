// 同じページの中の欄まで画面を動かす（ブラウザの中だけ。ホームの数字のカード・カルテの案・経理の選ぶ所など）。
// 開いた欄や新しく出た案が描き直されてから動かすため、2回待ってから動かす。読み上げのために飛んだ先へ focus も移す。

/** 1列（スマホ）の幅か。globals.css の @media (max-width: 1023.98px) と同じ */
export function isOneColumn(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 1023.98px)").matches;
}

export function scrollToId(id: string, opts: { hash?: boolean } = {}): void {
  window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      if (opts.hash) window.history.replaceState(null, "", `#${id}`);
    }),
  );
}

/**
 * 横にはみ出す帯（スマホのタブの帯）の中で、1つの物が見える位置にする scrollLeft。
 * 見えていれば今のまま。はみ出していれば、その物が帯の真ん中に来るように（端では帯の端で止める）。
 * 位置はどれも帯の左端から（itemLeft は今の scrollLeft を足す前の、見えている所での位置）。
 */
export function scrollLeftToShow(box: { width: number; scrollLeft: number; scrollWidth: number }, item: { left: number; width: number }): number {
  const max = Math.max(0, box.scrollWidth - box.width);
  const inView = item.left >= 0 && item.left + item.width <= box.width;
  if (inView) return box.scrollLeft;
  const center = box.scrollLeft + item.left - (box.width - item.width) / 2;
  return Math.round(Math.min(max, Math.max(0, center)));
}
