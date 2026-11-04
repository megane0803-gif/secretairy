// 発信の下書きを作る物（Claude か、決まった返事か）の形。流れ（write.ts）はどちらでも同じに動く。
// テストでは Claude を呼ばず、決まった返事（script.ts）や、決まった文を返す物に置きかえる。

export type PostsMessage = { role: "user" | "assistant"; content: string };

export type PostsModelRequest = {
  system: string;
  messages: PostsMessage[];
  /** 1回の返事の長さの上限（トークン。config/ai.json の posts.maxReplyTokens） */
  maxTokens: number;
};

export type PostsTurn = {
  text: string;
  stop: "end" | "max_tokens" | "refusal";
};

export interface PostsModel {
  turn(req: PostsModelRequest): Promise<PostsTurn>;
}
