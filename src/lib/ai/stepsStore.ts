"use client";

// 「AI の手順」：予約チャットの相談ごとに、どの道具で何を調べ、どのルールで外したかを1行ずつ。
// 画面を開いている間だけ覚える（日誌にも同じことを書くので、残るのは日誌の方）。

import { useSyncExternalStore } from "react";
import type { Step } from "./wire";

export type Consultation = { id: number; at: string; question: string; mode: "ai" | "script"; steps: Step[]; failed?: boolean };

let list: Consultation[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export function startConsultation(question: string, mode: Consultation["mode"]): number {
  seq += 1;
  list = [{ id: seq, at: new Date().toISOString(), question, mode, steps: [] }, ...list].slice(0, 10);
  notify();
  return seq;
}

export function addStep(id: number, step: Step): void {
  list = list.map((c) => (c.id === id ? { ...c, steps: [...c.steps, step] } : c));
  notify();
}

export function markFailed(id: number): void {
  list = list.map((c) => (c.id === id ? { ...c, failed: true } : c));
  notify();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
const EMPTY: Consultation[] = [];

export function useConsultations(): Consultation[] {
  return useSyncExternalStore(subscribe, () => list, () => EMPTY);
}
