// 「予約を入れる」の1枚（OwnerBookSheet.tsx）を3つの段に分ける流れ。画面に依らない（テストできる形）。
//   ① お客様を選ぶ（枠を押すと最初にこれ）→ ② メニューを選ぶ →「メニューを決める」→ ③ 確かめて入れる
// どの段でも上に「戻る」（①では閉じる。back が null を返す）。戻るだけでは選んだ物を消さない（確かめの印「もう一度押せば入れる」だけは消す）。
// 段を戻って選び直した時は、選び直した所から先を消す：
//   ・違うお客様を選び直した → メニュー・始まる時刻（③で変えた分）・確かめの印を消す（同じお客様を押しただけなら消さない）
//   ・メニューを選び直した → 始まる時刻（③で変えた分）・確かめの印を消す
//   ・③で始まる時刻を変えた → 確かめの印を消す（今の reset と同じ）
// 「入れる」は人のボタンだけ（画面の press）。ここは確定しない。

export type OwnerStage = "customer" | "menu" | "confirm";

export const STAGE_LABEL: Record<OwnerStage, string> = { customer: "お客様を選ぶ", menu: "メニューを選ぶ", confirm: "確かめて入れる" };
export const STAGES: OwnerStage[] = ["customer", "menu", "confirm"];

export type OwnerFlow = {
  stage: OwnerStage;
  customerId: string | null;
  menuIds: string[];
  /** 始まる時刻（枠を押した時刻。③で変えられる） */
  start: string;
  /** 1回目に押した時に見せたルール（もう一度押せば入れる） */
  asked: string[] | null;
  note: string | null;
};

export type OwnerFlowAction =
  | { kind: "customer"; id: string }
  | { kind: "toggleMenu"; id: string }
  /** 前回・よく使うの1行：それだけを選ぶ（同じ物がもう選んであれば、画面が [] を渡して外す） */
  | { kind: "setMenus"; ids: string[] }
  | { kind: "decide" }
  | { kind: "back" }
  | { kind: "start"; time: string }
  | { kind: "asked"; keys: string[]; note: string }
  | { kind: "note"; note: string | null };

export function freshOwnerFlow(start: string): OwnerFlow {
  return { stage: "customer", customerId: null, menuIds: [], start, asked: null, note: null };
}

/** 「メニューを決める」を押せるか（何も選んでいない時は押せない） */
export const canDecide = (s: OwnerFlow): boolean => !!s.customerId && s.menuIds.length > 0;

/**
 * 1つ進める。target.start は枠を押した時刻（選び直した時は始まる時刻もここへ戻す）。
 * ①で「戻る」は null（閉じる）。
 */
export function ownerFlowReduce(s: OwnerFlow, a: OwnerFlowAction, target: { start: string }): OwnerFlow | null {
  const clearAfterMenu = { start: target.start, asked: null, note: null };
  switch (a.kind) {
    case "customer":
      if (a.id === s.customerId) return { ...s, stage: "menu" };
      return { ...s, stage: "menu", customerId: a.id, menuIds: [], ...clearAfterMenu };
    case "toggleMenu": {
      if (!s.customerId) return s;
      const menuIds = s.menuIds.includes(a.id) ? s.menuIds.filter((x) => x !== a.id) : [...s.menuIds, a.id];
      return { ...s, menuIds, ...clearAfterMenu };
    }
    case "setMenus":
      if (!s.customerId) return s;
      return { ...s, menuIds: [...a.ids], ...clearAfterMenu };
    case "decide":
      return s.stage === "menu" && canDecide(s) ? { ...s, stage: "confirm" } : s;
    case "back":
      if (s.stage === "customer") return null;
      return { ...s, stage: s.stage === "confirm" ? "menu" : "customer", asked: null, note: null };
    case "start":
      return a.time === s.start ? s : { ...s, start: a.time, asked: null, note: null };
    case "asked":
      return { ...s, asked: a.keys, note: a.note };
    case "note":
      return { ...s, note: a.note };
  }
}
