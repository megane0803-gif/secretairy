// ToDo の種類（箱）。どの箱に入るかはプログラムが出どころで決める（AI には決めさせない。docs/SPEC.md §1.11）。
// 画面に依らない関数だけを置く（ToDo のタブの箱・メモの欄の札・テストが同じ物を使う）。
//
//   予約（直す・見送り・枠が埋まった）・予約チャット・カルテの次回話すこと → お客様
//   広告の判定日 → 広告
//   投げたメモ → 送る時にオーナーが選んだ種類（お客様・仕入れと材料・お店のこと・お金と事務）。選ばなかった時は その他
//   LINE の一言・知らない出どころ・前からブラウザに残っていた種類の無いメモ → その他

/** customer = お客様 / supply = 仕入れと材料 / shop = お店のこと / office = お金と事務 / ad = 広告 / other = その他 */
export type TodoKind = "customer" | "supply" | "shop" | "office" | "ad" | "other";

/** 箱の並び（上から） */
export const KIND_ORDER: readonly TodoKind[] = ["customer", "supply", "shop", "office", "ad", "other"];

export const KIND_LABEL: Record<TodoKind, string> = {
  customer: "お客様",
  supply: "仕入れと材料",
  shop: "お店のこと",
  office: "お金と事務",
  ad: "広告",
  other: "その他",
};

/** 投げたメモで、送る時に選べる種類（4つ。広告・その他は選ばせない） */
export type MemoKind = "customer" | "supply" | "shop" | "office";

export const MEMO_KINDS: readonly MemoKind[] = ["customer", "supply", "shop", "office"];

/** 選んだ種類として読めれば返す。それ以外（無い・知らない文字・広告・その他）は undefined */
export function readMemoKind(x: unknown): MemoKind | undefined {
  return typeof x === "string" && (MEMO_KINDS as readonly string[]).includes(x) ? (x as MemoKind) : undefined;
}

/** その ToDo がどの箱に入るか。source は出どころ（keys.ts の TodoSource）、category は投げたメモで選んだ種類 */
export function todoKind(t: { source?: string; category?: unknown }): TodoKind {
  switch (t.source) {
    case "reserve":
    case "chat":
    case "karte":
      return "customer";
    case "ad":
      return "ad";
    case "memo":
      return readMemoKind(t.category) ?? "other";
    default:
      // LINE の一言・知らない出どころ
      return "other";
  }
}

export type KindBox<T> = { kind: TodoKind; label: string; items: T[] };

/** 行を種類の箱に分ける。箱は KIND_ORDER の順・空の箱は出さない・箱の中は渡した順のまま（並べ方は items.ts の sortTodos） */
export function kindBoxes<T extends { source?: string; category?: unknown }>(items: readonly T[]): KindBox<T>[] {
  const by = new Map<TodoKind, T[]>();
  for (const t of items) {
    const k = todoKind(t);
    const list = by.get(k);
    if (list) list.push(t);
    else by.set(k, [t]);
  }
  return KIND_ORDER.filter((k) => by.has(k)).map((k) => ({ kind: k, label: KIND_LABEL[k], items: by.get(k)! }));
}
