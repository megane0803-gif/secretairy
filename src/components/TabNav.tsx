"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { TabDef } from "@/lib/tabs";

export function TabNav({ tabs, shopName }: { tabs: TabDef[]; shopName: string }) {
  const pathname = usePathname();
  return (
    <nav className="tabnav" aria-label="タブ">
      <div className="tabnav-brand">
        <strong>SecretAIry</strong>
        <span>{shopName}</span>
      </div>
      <ul>
        {tabs.map((t) => {
          const active = pathname === t.path || pathname.startsWith(t.path + "/");
          return (
            <li key={t.id}>
              <Link href={t.path} aria-current={active ? "page" : undefined}>
                <span aria-hidden>{t.icon}</span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
