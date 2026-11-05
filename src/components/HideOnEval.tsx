"use client";

// 試験10問（/eval）では、中身を出さない（描かない・動かさない）。
// 左のタブ・LINE のつなぎ・ToDo と広告の見張りは、開いただけでふだんの台帳・LINE に書くことがあるので、
// 試験のページでは動かさない（試験は専用の架空の状態で流し、ふだんの台帳・LINE・日誌に何も残さない。docs/SPEC.md §1.13）。

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export const EVAL_PATH = "/eval";

export function isEvalPath(pathname: string | null): boolean {
  return !!pathname && (pathname === EVAL_PATH || pathname.startsWith(`${EVAL_PATH}/`));
}

export function HideOnEval({ children }: { children: ReactNode }) {
  return isEvalPath(usePathname()) ? null : <>{children}</>;
}
