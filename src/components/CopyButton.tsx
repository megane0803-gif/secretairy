"use client";

// 「コピー」ボタン（発信の下書き：見て直す所と、保存した一覧）。押したら「✓ コピーしました」。
// コピーできないブラウザでは、targetId の文（textarea か、ふつうの要素）を選んだ状態にする（src/lib/copy.ts）。

import { useEffect, useRef, useState } from "react";
import { COPY_MESSAGE, copyText, type CopyResult } from "@/lib/copy";

function selectById(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.focus();
    el.select();
    return true;
  }
  const sel = window.getSelection();
  if (!sel) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

export function CopyButton({ text, targetId, label = "コピー" }: { text: string; targetId: string; label?: string }) {
  const [result, setResult] = useState<CopyResult | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  // 文が変わったら、前の「コピーしました」は消す
  useEffect(() => setResult(null), [text]);

  return (
    <span className="copy-wrap">
      <button
        type="button"
        className="btn small"
        onClick={async () => {
          const r = await copyText(text, { clipboard: navigator.clipboard, select: () => selectById(targetId) });
          setResult(r);
          if (timer.current) window.clearTimeout(timer.current);
          if (r === "copied") timer.current = window.setTimeout(() => setResult(null), 4000);
        }}
      >
        {label}
      </button>
      <span className={result === "copied" ? "copy-note ok" : "copy-note"} role="status">
        {result ? COPY_MESSAGE[result] : ""}
      </span>
    </span>
  );
}
