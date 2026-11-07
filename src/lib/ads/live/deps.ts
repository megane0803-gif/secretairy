// 窓口（src/app/api/ads/live/）で使う本番の道具立て。鍵・番号・合言葉は環境変数から読むだけで、画面・ログには出さない。

import { getAds } from "../../data/seed";
import { storeEnv, upstashStore } from "../../line/store";
import { getAdSettings, getMenus, getShop, getSiteOrigin } from "../../settings";
import { featuredWords } from "../featured";
import { liveEnvFrom } from "./env";
import type { LiveDeps } from "./server";

export function liveDeps(): LiveDeps {
  const ads = getAdSettings();
  const kv = storeEnv();
  return {
    env: liveEnvFrom(process.env),
    settings: ads.live,
    connect: ads.connect,
    towns: ads.towns,
    words: featuredWords(ads, getMenus()),
    setupKeywords: getAds().keywords.map((k) => k.text),
    siteOrigin: getSiteOrigin(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    // 置き場は LINE・試験と同じ Upstash（KV の環境変数が無ければ null。その時は数えられないので動かさない）
    store: kv ? upstashStore(kv) : null,
    timeZone: getShop().timezone,
  };
}
