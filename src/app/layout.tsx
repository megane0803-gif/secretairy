import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { LineBridge } from "@/components/LineBridge";
import { TabNav } from "@/components/TabNav";
import { getBookData } from "@/lib/book/data";
import { BROWSER_PREFIX, NAV_KEY, RIGHT_KEY } from "@/lib/browser";
import { getShop, getTabSwitches } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "SecretAIry",
  description: "美容室のための AI 秘書（架空の店）",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// 畳んだ左のタブ・右の列の幅を、画面が出る前に効かせる（ちらつかないように）
const restoreLayout = `(function(){try{var d=document.documentElement,p=${JSON.stringify(BROWSER_PREFIX)};
if(localStorage.getItem(p+${JSON.stringify(NAV_KEY)})==="1")d.dataset.nav="collapsed";
var w=Number(localStorage.getItem(p+${JSON.stringify(RIGHT_KEY)}));if(w>0)d.style.setProperty("--right-w",w+"px");}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: restoreLayout }} />
      </head>
      <body>
        <div className="shell">
          <TabNav baseSwitches={getTabSwitches()} shopName={getShop().name} />
          {children}
        </div>
        {/* LINE のつなぎ（オーナー側）。つないでいる間だけ、どのタブでも受け取りに行く。何も描かない */}
        <LineBridge data={getBookData()} />
      </body>
    </html>
  );
}
