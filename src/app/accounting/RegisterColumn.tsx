"use client";

// 経理タブの右の列。どちらに登録するかを決める：
// - このブラウザが freee（テスト事業所）とつながっている（サーバーが cookie を確かめた）・つながった印がある・freee に送り始めた記録がある → freee の欄
// - それ以外（cookie が無い画面・審査員の画面も）→ 今のまま「会計に登録」
// 鍵が切れた・途中まで freee に送った記録がある時は、つながりが切れても画面の中の会計に切り替えない（真ん中の一覧と同じ答え。useFreeeMode）。

import { Panel } from "@/components/parts";
import { useFreee, useFreeeMode } from "@/lib/freee/useFreee";
import { getAccountingSettings } from "@/lib/settings";
import { FreeePanel } from "./FreeePanel";
import { RegisterPanel } from "./RegisterPanel";

export function RegisterColumn() {
  const freee = useFreee();
  const settings = getAccountingSettings();
  const toFreee = useFreeeMode();
  return (
    <Panel title={toFreee ? `${settings.freee.label}に登録` : `${settings.service}に登録`}>
      {toFreee ? <FreeePanel freee={freee} /> : <RegisterPanel freee={freee} />}
    </Panel>
  );
}
