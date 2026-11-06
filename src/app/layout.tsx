import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AdsFeeds } from "@/components/AdsFeeds";
import { HideOnEval } from "@/components/HideOnEval";
import { LineBridge } from "@/components/LineBridge";
import { TabNav } from "@/components/TabNav";
import { TodoFeeds } from "@/components/TodoFeeds";
import { getBookData } from "@/lib/book/data";
import { BROWSER_PREFIX, LOOK_KEY, NAV_KEY, RIGHT_KEY } from "@/lib/browser";
import { lookRestoreScript } from "@/lib/look";
import { getShop, getTabSwitches } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "SecretAIry",
  description: "美容室のための AI 秘書",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// 畳んだ左のタブ・右の列の幅・選んだ見た目を、画面が出る前に効かせる（ちらつかないように。一瞬スマートが見えないように）
const restoreLayout = `(function(){try{var d=document.documentElement,p=${JSON.stringify(BROWSER_PREFIX)};
if(localStorage.getItem(p+${JSON.stringify(NAV_KEY)})==="1")d.dataset.nav="collapsed";
var w=Number(localStorage.getItem(p+${JSON.stringify(RIGHT_KEY)}));if(w>0)d.style.setProperty("--right-w",w+"px");}catch(e){}})();
${lookRestoreScript(BROWSER_PREFIX + LOOK_KEY)}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: restoreLayout }} />
      </head>
      <body>
        <div className="shell">
          {/* 試験10問（/eval）では左のタブを出さない（開いただけで台帳に書かないように） */}
          <HideOnEval>
            <TabNav baseSwitches={getTabSwitches()} shopName={getShop().name} />
          </HideOnEval>
          {children}
        </div>
        {/* 下の3つは何も描かない見張り。試験10問（/eval）では動かさない（ふだんの台帳・LINE・日誌に何も残さない） */}
        <HideOnEval>
          {/* LINE のつなぎ（オーナー側）。つないでいる間だけ、どのタブでも受け取りに行く。何も描かない */}
          <LineBridge data={getBookData()} />
          {/* 予約サイトで枠が埋まった仮押さえを、ToDo「別の日時を案内」に足す（プログラム）。何も描かない */}
          <TodoFeeds data={getBookData()} />
          {/* 広告：判定日が来た言葉を判定する（プログラム）。結果は広告タブ・日誌・ToDo へ。何も描かない */}
          <AdsFeeds />
        </HideOnEval>
      </body>
    </html>
  );
}
