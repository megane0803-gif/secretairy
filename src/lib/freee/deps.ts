// 窓口（src/app/api/freee/）で使う本番の道具立て。鍵・秘密は環境変数から読むだけで、画面・ログには出さない。

import { getAccounting } from "../data/seed";
import { getFreeeSettings } from "../settings";
import { cookieKeyFrom } from "./seal";
import { defaultRandom, envFrom, type FreeeDeps } from "./server";

export function freeeDeps(): FreeeDeps {
  return {
    env: envFrom(process.env, cookieKeyFrom(process.env.FREEE_COOKIE_KEY)),
    settings: getFreeeSettings(),
    seed: getAccounting(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    random: defaultRandom,
  };
}
