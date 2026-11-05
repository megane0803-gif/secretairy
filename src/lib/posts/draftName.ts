// 発信の下書きの呼び名。種類の名前（config/posts.json の label）が「下書き」で終わる時（「ブログの下書き」）は
// 「の下書き」を足さない（「ブログの下書きの下書き」にしない）。画面と日誌の文の両方でこれを使う。種類の名前そのものは変えない。

const DRAFT = "下書き";

/** 「お客様への配信」→「お客様への配信の下書き」・「ブログの下書き」→「ブログの下書き」 */
export function draftName(label: string): string {
  return label.trimEnd().endsWith(DRAFT) ? label : `${label}の${DRAFT}`;
}
