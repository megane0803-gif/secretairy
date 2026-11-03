"use client";

import { useEffect, useRef, useState } from "react";
import { readBrowser, RIGHT_KEY, writeBrowser } from "@/lib/browser";

const DEFAULT = 340;
const MIN = 260;
const MIN_MAIN = 360;

function clamp(w: number, pageWidth: number): number {
  const max = Math.max(MIN, Math.min(760, pageWidth - MIN_MAIN));
  return Math.round(Math.min(max, Math.max(MIN, w)));
}

function apply(w: number) {
  document.documentElement.style.setProperty("--right-w", `${w}px`);
}

/** 真ん中と右の列の境目。つまんで動かす・矢印キーで動かす・2回押すと元の幅 */
export function Splitter() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT);

  useEffect(() => {
    const saved = Number(readBrowser(RIGHT_KEY));
    if (saved > 0) setWidth(saved);
  }, []);

  const pageWidth = () => ref.current?.parentElement?.getBoundingClientRect().width ?? 1200;

  const set = (w: number, save: boolean) => {
    const v = clamp(w, pageWidth());
    setWidth(v);
    apply(v);
    if (save) writeBrowser(RIGHT_KEY, v === DEFAULT ? null : String(v));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const page = el.parentElement!.getBoundingClientRect();
    // 右の列の右端は、ページの右端からページの余白の分だけ内側
    const pad = parseFloat(getComputedStyle(el.parentElement!).paddingRight) || 0;
    const rightEdge = page.right - pad;
    const move = (ev: PointerEvent) => set(rightEdge - ev.clientX - el.offsetWidth / 2, false);
    const up = (ev: PointerEvent) => {
      set(rightEdge - ev.clientX - el.offsetWidth / 2, true);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("dragging");
    };
    document.documentElement.classList.add("dragging");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === "ArrowLeft") set(width + step, true);
    else if (e.key === "ArrowRight") set(width - step, true);
    else if (e.key === "Home" || e.key === "Enter") set(DEFAULT, true);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="真ん中と右の列の境目（左右の矢印キーで動かせます）"
      aria-valuenow={width}
      aria-valuemin={MIN}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => set(DEFAULT, true)}
      title="つまんで左右に動かせます（2回押すと元の幅）"
    />
  );
}
