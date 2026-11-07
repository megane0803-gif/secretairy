// 窓口（src/app/api/freee/）で使う本番の道具立て。鍵・秘密は環境変数から読むだけで、画面・ログには出さない。

import { getAccounting } from "../data/seed";
import { storeEnv, upstashStore } from "../line/store";
import { getFreeeSettings, getShop } from "../settings";
import { cookieKeyFrom } from "./seal";
import { defaultRandom, envFrom, type FreeeDeps } from "./server";

export function freeeDeps(): FreeeDeps {
  const kv = storeEnv();
  return {
    env: envFrom(process.env, cookieKeyFrom(process.env.FREEE_COOKIE_KEY)),
    settings: getFreeeSettings(),
    seed: getAccounting(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    random: defaultRandom,
    timeZone: getShop().timezone,
    // 置き場は LINE・試験・広告と同じ Upstash（KV の環境変数が無ければ null。その時は来た人用の窓口は動かない）
    store: kv ? upstashStore(kv) : null,
  };
}
