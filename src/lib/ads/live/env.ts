// 広告のテスト用アカウントの環境変数（サーバーの側だけで読む。画面・ブラウザ・ログ・エラーの文に出さない）。
// 4つだけ：鍵（サービスアカウントの鍵の JSON 全体）・テスト用の管理アカウントの番号・テスト用の広告アカウントの番号・オーナー用の合言葉。
// どれにもブラウザに渡す前置き（NEXT_ で始まる公開用の名前）を付けない（ブラウザ向けの JavaScript に入らないように）。
// 鍵の JSON を読めない時は、元のエラーを捨てて「鍵の形が違う」だけにする（中身をどこにも出さない）。

import { createPrivateKey, type KeyObject } from "node:crypto";

export const LIVE_ENV = {
  key: "GOOGLE_ADS_SERVICE_ACCOUNT_KEY",
  loginCustomerId: "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  customerId: "GOOGLE_ADS_CUSTOMER_ID",
  ownerPasscode: "GOOGLE_ADS_OWNER_PASSCODE",
} as const;

export type ServiceKey = { email: string; privateKey: KeyObject; id: string };

export type LiveEnv = {
  vercelEnv: string | null;
  /** 読めた鍵（無い・読めない時は null） */
  key: ServiceKey | null;
  /** 鍵の環境変数に何か入っている（読めない時に「無い」と分けるため。中身は持たない） */
  keyGiven: boolean;
  /** テスト用の管理アカウントの番号（数字だけの10桁。違う形なら null） */
  loginCustomerId: string | null;
  /** テスト用の広告アカウントの番号（数字だけの10桁。違う形なら null）。送る・確かめる URL はこの1つだけを使う */
  customerId: string | null;
  /** オーナー用の合言葉（そのまま。短い時の扱いは passcode.ts の passcodeUsable） */
  ownerPasscode: string | null;
};

/** 番号を「数字だけの1つの値」に（ハイフンは除く。10桁でなければ null） */
export function customerIdFrom(raw: string | undefined): string | null {
  const d = String(raw ?? "").trim().replace(/-/g, "");
  return /^\d{10}$/.test(d) ? d : null;
}

/** 鍵の JSON を読む（Vercel に貼った private_key の「\n」の文字は改行に直す）。読めなければ null（理由は持たない） */
export function serviceKeyFrom(raw: string | undefined): ServiceKey | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== "object") return null;
    const email = typeof j.client_email === "string" ? j.client_email.trim() : "";
    const pem = typeof j.private_key === "string" ? j.private_key.replace(/\\n/g, "\n") : "";
    if (!email || !pem.includes("PRIVATE KEY")) return null;
    const privateKey = createPrivateKey({ key: pem, format: "pem" });
    if (privateKey.asymmetricKeyType !== "rsa") return null;
    const id = typeof j.private_key_id === "string" && /^[0-9a-f]{8,64}$/i.test(j.private_key_id) ? j.private_key_id : "";
    return { email, privateKey, id };
  } catch {
    return null;
  }
}

export function liveEnvFrom(e: Record<string, string | undefined>): LiveEnv {
  // 名前は LIVE_ENV と同じ（環境変数の名前の見本 .env.example と照らすテストが読めるように、ここでは名前を直に書く）
  return {
    vercelEnv: e.VERCEL_ENV ?? null,
    key: serviceKeyFrom(e.GOOGLE_ADS_SERVICE_ACCOUNT_KEY),
    keyGiven: !!e.GOOGLE_ADS_SERVICE_ACCOUNT_KEY?.trim(),
    loginCustomerId: customerIdFrom(e.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    customerId: customerIdFrom(e.GOOGLE_ADS_CUSTOMER_ID),
    ownerPasscode: e.GOOGLE_ADS_OWNER_PASSCODE ?? null,
  };
}

/** 鍵と2つの番号の3つがそろっているか（Google は呼ばない。プレビューかどうかは窓口の守りで見る） */
export function liveReady(env: LiveEnv): boolean {
  return !!env.key && !!env.loginCustomerId && !!env.customerId;
}
