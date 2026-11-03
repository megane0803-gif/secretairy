import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { TabNav } from "@/components/TabNav";
import { getShop, getVisibleTabs } from "@/lib/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "SecretAIry",
  description: "美容室のための AI 秘書（架空の店）",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="shell">
          <TabNav tabs={getVisibleTabs()} shopName={getShop().name} />
          {children}
        </div>
      </body>
    </html>
  );
}
