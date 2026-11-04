// 台帳を画面（ブラウザ）で組み立てるのに要る、最初の状態。サーバーの画面（page.tsx）で読んで、画面の部品に渡す。

import { getCustomers } from "../data/seed";
import type { Customer } from "../data/types";
import { getSeedRules } from "../rules/store";
import type { Rule } from "../rules/types";
import { getMenus, getShop, type Menu, type ShopSettings } from "../settings";

export type BookData = {
  shop: ShopSettings;
  menus: Menu[];
  customers: Customer[];
  seedRules: Rule[];
};

export function getBookData(): BookData {
  return { shop: getShop(), menus: getMenus(), customers: getCustomers(), seedRules: getSeedRules() };
}
