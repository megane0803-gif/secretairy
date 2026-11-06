// 文をコピーする（発信の下書き。docs/SPEC.md §1.10）。送信・公開ではない（見ている人のクリップボードに入れるだけ）。
// コピーできないブラウザ（クリップボードが使えない・断られた）では、文を選んだ状態にする（人が長押し・右クリックでコピーできるように）。
// 画面に依らない形（テストは __tests__/copy.test.ts）。

export type CopyResult = "copied" | "selected" | "failed";

export type CopyEnv = {
  /** navigator.clipboard（無いブラウザ・http のページでは無い） */
  clipboard?: { writeText: (text: string) => Promise<void> } | null;
  /** 文を選んだ状態にする。できたら true */
  select: () => boolean;
};

export async function copyText(text: string, env: CopyEnv): Promise<CopyResult> {
  if (env.clipboard && typeof env.clipboard.writeText === "function") {
    try {
      await env.clipboard.writeText(text);
      return "copied";
    } catch {
      // 断られた時は選ぶ方へ
    }
  }
  return env.select() ? "selected" : "failed";
}

export const COPY_MESSAGE: Record<CopyResult, string> = {
  copied: "✓ コピーしました",
  selected: "このブラウザではコピーできないので、文を選びました。長押し（右クリック）でコピーしてください",
  failed: "コピーできませんでした。文を長押し（右クリック）して選んでください",
};
