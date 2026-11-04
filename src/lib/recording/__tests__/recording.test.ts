// 録音からメモを作る：区切り方・黙っている所を飛ばす・要点のまとめ方・言葉の門・再開・2回読まない・上限・スマホで出さない・最初に戻す。
// 本物の声は使わない。プログラムで作った音（無音・ずっと同じ音・声のように上がり下がりする音）と、決まった文字起こしの結果に置きかえる。
// Claude は呼ばない（要点は決まった返事・置きかえた書く物）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import aiJson from "../../../../config/ai.json";
import recordingJson from "../../../../config/recording.json";
import { getCustomers } from "../../data/seed";
import { deskKey, setDesk, getDesk } from "../../karte/deskStore";
import { parseKarteRequest } from "../../karte/request";
import { runKarte } from "../../karte/run";
import { scriptKarteWriter, type KarteWriter } from "../../karte/writer";
import { resetAll } from "../../reset";
import { getRules } from "../../rules/store";
import { getAiSettings, getKarteHeadings, getMenus, getRecordingAiSettings, getRecordingMemoMaxChars, getRecordingSettings } from "../../settings";
import { canWatchFolder, isPcDevice } from "../device";
import { checkFile, formatOf, lengthCheck, limitText } from "../formats";
import { adtsHeader, fakeMp3Frame, mp3Header, planFrames } from "../frames";
import { isComplete, memoryRecordingStore, newJob, nextChunk, runJob, textDone, type JobDeps, type RecordingStore } from "../job";
import { fakeM4a, parseMp4Audio, planSamples, samplesToAdts } from "../mp4";
import { cleanTranscript, combineNotes, gateNotes, maskNames, parseNotes } from "../notes";
import { bytesReader, chunkBytes, planAudio, planWav, type ChunkPlan } from "../plan";
import { runNotes } from "../run";
import { fileKey, oldFileKeys, readyFiles, type FolderEntry } from "../seen";
import { joinSpans, quietWatch, speechSpans, spansSeconds } from "../silence";
import { setRecordingStore } from "../store";
import { decodeWav16, encodeWav16, parseWav } from "../wav";
import { clipText, parseNotesRequest } from "../wire";
import { scriptNotesWriter, type NotesWriter } from "../writer";

const ROOT = join(__dirname, "../../../..");
const rec = getRecordingSettings();
const recAi = getRecordingAiSettings();
const headings = getKarteHeadings();
const RATE = 16000;

// ---- プログラムで作る音 ----
/** 小さなざわざわ（黙っている所） */
function quiet(sec: number, amp = 0.001): Float32Array {
  const out = new Float32Array(Math.round(sec * RATE));
  let x = 1;
  for (let i = 0; i < out.length; i++) {
    x = (x * 16807) % 2147483647;
    out[i] = ((x / 2147483647) * 2 - 1) * amp;
  }
  return out;
}
/** ずっと同じ大きさの音（ドライヤーのような「音だけの所」） */
function steady(sec: number, amp = 0.3, hz = 440): Float32Array {
  return Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / RATE) * amp);
}
/** 声のように、音の大きさが細かく上がり下がりする音（0.15秒鳴って0.1秒やむ、のくり返し） */
function speechLike(sec: number, amp = 0.3): Float32Array {
  return Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => {
    const t = i / RATE;
    const on = t % 0.25 < 0.15;
    return on ? Math.sin(2 * Math.PI * 220 * t) * amp * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0.0005;
  });
}
function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

describe("設定と上限（config/recording.json・config/ai.json）", () => {
  test("受けるのは m4a・mp3・wav・aac、4時間半・300MBまで。区切りは10分", () => {
    assert.deepEqual(rec.accept, ["m4a", "mp3", "wav", "aac"]);
    assert.equal(rec.maxSeconds, 4.5 * 3600);
    assert.equal(rec.maxBytes, 300 * 1024 * 1024);
    assert.equal(rec.chunkSeconds, 600);
    assert.equal(limitText(rec), "4時間半・300MBまで");
    assert.equal(rec.recorder.segmentSeconds, 600);
    assert.equal(rec.language, "japanese");
  });

  test("ファイルの形と大きさ：受けない形・大きすぎる物・空の物は受けない", () => {
    assert.ok(checkFile({ name: "rec.M4A", size: 10 }, rec).ok);
    for (const n of ["a.mp3", "b.wav", "c.aac"]) assert.ok(checkFile({ name: n, size: 10 }, rec).ok, n);
    assert.equal(checkFile({ name: "a.flac", size: 10 }, rec).ok, false);
    assert.equal(checkFile({ name: "a.mp4", size: 10 }, rec).ok, false);
    assert.equal(checkFile({ name: "a.mp3", size: rec.maxBytes + 1 }, rec).ok, false);
    assert.ok(checkFile({ name: "a.mp3", size: rec.maxBytes }, rec).ok);
    assert.equal(checkFile({ name: "a.mp3", size: 0 }, rec).ok, false);
    assert.equal(formatOf("a.ogg", rec.accept), null);
  });

  test("長さ：4時間半までは受け、超えたら理由を返す", () => {
    assert.equal(lengthCheck(4 * 3600, rec), null);
    assert.equal(lengthCheck(rec.maxSeconds, rec), null);
    assert.match(lengthCheck(rec.maxSeconds + 60, rec) ?? "", /4時間半・300MBまで/);
    assert.ok(lengthCheck(0, rec));
  });

  test("要点づくりの上限は config にあって効く（区切りの文字の長さ・要点の数と長さ・窓口の大きさ）", () => {
    const ai = aiJson as Record<string, any>;
    for (const k of ["maxReplyTokens", "maxTextChars", "maxNotes", "maxNoteChars", "maxRequestChars", "minIntervalSeconds"]) assert.ok(ai.recording[k] > 0, k);
    assert.equal(recAi.maxTextChars, ai.recording.maxTextChars);
    const ids = getMenus().map((m) => m.id);
    assert.ok(parseNotesRequest({ text: "あ".repeat(recAi.maxTextChars), rules: [] }, recAi.maxTextChars, ids).ok);
    assert.equal(parseNotesRequest({ text: "あ".repeat(recAi.maxTextChars + 1), rules: [] }, recAi.maxTextChars, ids).ok, false);
    assert.equal(parseNotesRequest({ text: "  ", rules: [] }, recAi.maxTextChars, ids).ok, false);
    assert.equal([...clipText("あ".repeat(recAi.maxTextChars + 50), recAi.maxTextChars)].length, recAi.maxTextChars);
  });

  test("録音の流れの時だけ、カルテのメモの上限を広げる（数は config）", () => {
    const ai = getAiSettings();
    const ids = getMenus().map((m) => m.id);
    const big = getRecordingMemoMaxChars();
    assert.ok(big > ai.karte.maxMemoChars);
    const long = "あ".repeat(ai.karte.maxMemoChars + 100);
    // ふだんのメモは今のまま 1,500字まで
    assert.equal(parseKarteRequest({ memo: long, rules: [] }, ai.karte.maxMemoChars, ids, big).ok, false);
    // 録音から作ったメモは広げた上限まで
    const r = parseKarteRequest({ memo: long, rules: [], source: "recording" }, ai.karte.maxMemoChars, ids, big);
    assert.ok(r.ok && r.value.source === "recording");
    assert.equal(parseKarteRequest({ memo: "あ".repeat(big + 1), rules: [], source: "recording" }, ai.karte.maxMemoChars, ids, big).ok, false);
    // 窓口が広げた上限を渡さなければ、録音の印があっても広げない
    assert.equal(parseKarteRequest({ memo: long, rules: [], source: "recording" }, ai.karte.maxMemoChars, ids).ok, false);
  });
});

describe("区切り方（ファイル全体を一度に広げない）", () => {
  test("wav：10分ごとに切り、4時間なら24区切り。時刻もバイトもすき間なくつながる", () => {
    const info = { formatTag: 1 as const, channels: 1, sampleRate: 16000, bitsPerSample: 16, blockAlign: 2, byteRate: 32000, dataOffset: 44, dataBytes: 4 * 3600 * 32000 };
    const chunks = planWav(info, rec.chunkSeconds);
    assert.equal(chunks.length, 24);
    chunks.forEach((c, i) => {
      assert.equal(c.index, i);
      assert.equal(c.endSec - c.startSec, 600);
      if (i > 0) {
        assert.equal(c.start, chunks[i - 1].end);
        assert.equal(c.startSec, chunks[i - 1].endSec);
      }
    });
    assert.equal(chunks[23].end, 44 + info.dataBytes);
  });

  test("wav：作った音を区切りに分け、区切りごとの小さい wav を広げなおすと元の音になる", async () => {
    const audio = concat(speechLike(4), quiet(3), speechLike(2.5));
    const file = encodeWav16(audio, RATE);
    const plan = await planAudio("wav", file.length, bytesReader(file), 4);
    assert.ok(plan);
    assert.deepEqual(plan.chunks.map((c) => c.endSec - c.startSec), [4, 4, 1.5]);
    const back: Float32Array[] = [];
    for (const c of plan.chunks) back.push(decodeWav16(await chunkBytes(plan, c, bytesReader(file))));
    const joined = concat(...back);
    assert.equal(joined.length, audio.length);
    assert.ok(Math.abs(joined[RATE] - audio[RATE]) < 1e-3);
    assert.equal(parseWav(file, file.length)?.sampleRate, RATE);
  });

  test("mp3：頭の札（ID3）とゴミを飛ばし、こまを数えて区切る", async () => {
    const frame = fakeMp3Frame();
    const h = mp3Header(frame, 0)!;
    assert.equal(h.samples, 1152);
    assert.equal(h.length, frame.length);
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20, ...Array(20).fill(0)]);
    const frames = 1000; // 1000 × 1152 / 44100 ≒ 26.1秒
    const file = new Uint8Array(id3.length + 7 + frames * frame.length);
    file.set(id3);
    file.set([1, 2, 3, 0xff, 0x00, 9, 9], id3.length); // ゴミ（こまの頭に見える 0xff も入れる）
    for (let i = 0; i < frames; i++) file.set(frame, id3.length + 7 + i * frame.length);
    const plan = await planFrames("mp3", file.length, bytesReader(file), 10);
    assert.ok(plan);
    assert.equal(plan.chunks.length, 3);
    assert.ok(Math.abs(plan.durationSec - (frames * 1152) / 44100) < 1e-6);
    assert.equal(plan.chunks[0].start, id3.length + 7);
    plan.chunks.slice(1).forEach((c, i) => assert.equal(c.start, plan.chunks[i].end));
    assert.equal(plan.chunks[2].end, file.length);
    // どの区切りも、こまの頭から始まる
    for (const c of plan.chunks) assert.ok(mp3Header(file, c.start));
  });

  test("aac（ADTS）：こまの頭から長さを読み、区切る", async () => {
    const len = 200;
    const frame = new Uint8Array(len);
    frame.set([0xff, 0xf1, (1 << 6) | (4 << 2), (1 << 6) | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
    const h = adtsHeader(frame, 0)!;
    assert.equal(h.length, len);
    assert.equal(h.sampleRate, 44100);
    const frames = 1300; // 1300 × 1024 / 44100 ≒ 30.2秒
    const file = new Uint8Array(frames * len);
    for (let i = 0; i < frames; i++) file.set(frame, i * len);
    const plan = await planAudio("aac", file.length, bytesReader(file), 10);
    assert.ok(plan);
    assert.equal(plan.chunks.length, 4);
    assert.ok(Math.abs(plan.durationSec - (frames * 1024) / 44100) < 1e-6);
  });

  test("m4a：後ろにある目次（moov）だけを読み、こまの番号で区切り、区切りごとに ADTS の頭を付ける", async () => {
    const sizes = Array.from({ length: 1300 }, (_, i) => 5 + (i % 7));
    const file = fakeM4a(sizes, 44100, 1);
    const a = await parseMp4Audio(file.length, bytesReader(file));
    assert.ok(a);
    assert.equal(a.sampleRate, 44100);
    assert.equal(a.profile, 2);
    assert.ok(Math.abs(a.durationSec - (1300 * 1024) / 44100) < 1e-6);
    const chunks = planSamples(a, 10);
    assert.equal(chunks.length, 4);
    assert.equal(chunks[0].first, 0);
    assert.equal(chunks[3].last, 1299);
    chunks.slice(1).forEach((c, i) => assert.equal(c.first, chunks[i].last + 1));
    const adts = await samplesToAdts(a, chunks[1], bytesReader(file));
    // こまごとに ADTS の頭（7バイト）が付き、長さは中身＋7
    let pos = 0;
    for (let i = chunks[1].first; i <= chunks[1].last; i++) {
      const h = adtsHeader(adts, pos);
      assert.ok(h, `こま ${i}`);
      assert.equal(h.length, sizes[i] + 7);
      assert.equal(h.sampleRate, 44100);
      assert.equal(adts[pos + 7], i & 255, "中身はファイルのこまのまま");
      pos += h.length;
    }
    assert.equal(pos, adts.length);
  });
});

describe("黙っている所・音だけの所を飛ばす", () => {
  const audio = concat(quiet(5), speechLike(4), steady(6), speechLike(3), quiet(5));

  test("声のように上がり下がりする所だけを拾い、無音とずっと同じ音は飛ばす", () => {
    const spans = speechSpans(audio, RATE, rec.silence);
    // 声（5〜9秒・15〜18秒）は拾う。ずっと同じ音（9〜15秒）は、声とのさかい目の少し（まわりの幅の半分ほど）のほかは飛ばす
    assert.equal(spans.length, 2, JSON.stringify(spans));
    const [a, b] = spans;
    assert.ok(a.start > 4.5 && a.start <= 5 && a.end >= 9 && a.end < 10.6, JSON.stringify(a));
    assert.ok(b.start > 13.4 && b.start <= 15 && b.end >= 18 && b.end < 18.6, JSON.stringify(b));
    assert.ok(a.end < 11 && b.start > 13, "ずっと同じ音のまん中（11〜13秒）は入らない");
    assert.ok(a.start > 4, "はじめの無音は入らない");
    const joined = joinSpans(audio, RATE, spans);
    assert.ok(joined.length < audio.length * 0.5, "文字にする音は、声のある所だけ");
    assert.ok(spansSeconds(spans) < 10.5);
  });

  test("無音だけ・ずっと同じ音だけの区切りには、声が無い", () => {
    assert.deepEqual(speechSpans(quiet(20), RATE, rec.silence), []);
    assert.deepEqual(speechSpans(steady(20), RATE, rec.silence), []);
    assert.deepEqual(speechSpans(new Float32Array(RATE * 5), RATE, rec.silence), []);
  });

  test("画面の録音：小さい音が続いたら「音が入っていません」を出す（音が入れば消える）", () => {
    const w = quietWatch(rec.recorder.quietLevel, rec.recorder.quietWarnSeconds);
    assert.equal(w.push(0.001, 0), false);
    assert.equal(w.push(0.001, (rec.recorder.quietWarnSeconds - 1) * 1000), false);
    assert.equal(w.push(0.001, rec.recorder.quietWarnSeconds * 1000), true);
    assert.equal(w.push(0.2, rec.recorder.quietWarnSeconds * 1000 + 200), false);
    assert.equal(w.push(0.001, rec.recorder.quietWarnSeconds * 1000 + 400), false);
  });

  test("文字起こしの決まり文句（無音で出やすい）と、同じ言葉のくり返しを外す", () => {
    assert.equal(cleanTranscript("ご視聴ありがとうございました。"), "");
    assert.equal(cleanTranscript("根元が伸びてます。ご視聴ありがとうございました。"), "根元が伸びてます。");
    assert.equal(cleanTranscript("はい。はい。はい。はい。はい。"), "はい。");
  });
});

describe("要点のまとめ方", () => {
  test("AI の返事から「・」の行だけを取り、数と長さを上限にそろえる。「なし」は0行", () => {
    const text = "前置きです\n・根元が5センチ伸びている\n- 前髪は短めが希望\n・" + "あ".repeat(100) + "\n・なし";
    const notes = parseNotes(text, recAi.maxNotes, recAi.maxNoteChars);
    assert.deepEqual(notes.slice(0, 2), ["根元が5センチ伸びている", "前髪は短めが希望"]);
    assert.equal([...notes[2]].length, recAi.maxNoteChars);
    assert.equal(notes.length, 3);
    assert.deepEqual(parseNotes("・なし", 12, 60), []);
    assert.equal(parseNotes(Array.from({ length: 30 }, (_, i) => `・行${i}`).join("\n"), recAi.maxNotes, 60).length, recAi.maxNotes);
  });

  test("全部の区切りの要点を順に1つのメモに。同じ物は1つに、上限を超える分は入れずに数を返す", () => {
    const c = combineNotes([["根元が伸びている", "前髪は短めが希望"], null, ["前髪は 短めが希望。", "次は2か月後"]], 100);
    assert.deepEqual(c.lines, ["・根元が伸びている", "・前髪は短めが希望", "・次は2か月後"]);
    assert.equal(c.memo, "・根元が伸びている\n・前髪は短めが希望\n・次は2か月後");
    assert.equal(c.dropped, 0);
    const small = combineNotes([["あいうえお", "かきくけこ", "さしすせそ"]], 13);
    assert.deepEqual(small.lines, ["・あいうえお", "・かきくけこ"]);
    assert.equal(small.dropped, 1);
    assert.ok([...small.memo].length <= 13);
  });

  test("決まった返事（AI なし）：カルテの見出しの手がかりの言葉が入った文だけ拾い、雑談は捨てる", async () => {
    const text = "いい天気ですね。えーと、根元が伸びてパサついてます。昨日のドラマ見ました？次は2か月後にリタッチしたいです。";
    const r = await runNotes({ text, mode: "script", writer: scriptNotesWriter(headings), headings, rules: getRules(), maxTokens: recAi.maxReplyTokens, maxNotes: recAi.maxNotes, maxNoteChars: recAi.maxNoteChars });
    assert.deepEqual(r.notes, ["根元が伸びてパサついてます", "次は2か月後にリタッチしたいです"]);
    assert.equal(r.removed.length, 0);
    const none = await runNotes({ text: "いい天気ですね。昨日のドラマ見ました？", mode: "script", writer: scriptNotesWriter(headings), headings, rules: getRules(), maxTokens: 600, maxNotes: 12, maxNoteChars: 60 });
    assert.deepEqual(none.notes, []);
  });

  test("お客様の名字（＋様・さん）は〔お客様〕に置きかえてから送る", () => {
    const surnames = getCustomers().map((c) => c.surname);
    const s = surnames[0];
    assert.equal(maskNames(`${s}さん、今日は${s}様の前髪を`, surnames), "〔お客様〕、今日は〔お客様〕の前髪を");
  });
});

describe("言葉の門（録音から作ったカルテにも、そのまま通す）", () => {
  const transcript = "今日は根元が5センチくらい伸びてます。頭皮が赤かったです。次は2か月後にリタッチで。";
  /** AI の書きすぎを置きかえた書く物：文字起こしに無い「おすすめ」「改善」や数字を足す */
  const overWriter: NotesWriter = {
    async write() {
      return { text: "・根元が5センチ伸びている\n・頭皮が赤かった\n・頭皮の改善におすすめのシャンプー\n・次は3か月後にリタッチ\n・次は2か月後にリタッチ", stop: "end" };
    },
  };

  test("要点の門：その区切りの文字に無い言葉や数字の行は外し、話した言葉（「頭皮が赤かった」）は残す", async () => {
    const r = await runNotes({ text: transcript, mode: "ai", writer: overWriter, headings, rules: getRules(), maxTokens: 600, maxNotes: 12, maxNoteChars: 60 });
    assert.deepEqual(r.notes, ["根元が5センチ伸びている", "頭皮が赤かった", "次は2か月後にリタッチ"]);
    assert.equal(r.removed.length, 2);
    assert.match(r.removed[0].reason, /「(改善|おすすめ)」「(改善|おすすめ)」はメモに無い言葉です/);
    assert.match(r.removed[1].reason, /「3」はメモに無い数字です/);
    assert.deepEqual(gateNotes(["肌が荒れている"], "根元が伸びた").notes, []);
  });

  test("まとめた要点をメモとして「カルテにする」：見出し8つ・メモに無い見出しは空・門はまとめた要点と照らす", async () => {
    const { memo } = combineNotes([["根元が5センチ伸びている", "頭皮が赤かった"], ["次は2か月後にリタッチ"]], getRecordingMemoMaxChars());
    // AI の書きすぎ：メモ（まとめた要点）に無い「おすすめ」「受診」と数字を足した行
    const karteWriter: KarteWriter = {
      async write() {
        return {
          text: [
            "■ 来店時の状態",
            "・根元が5センチ伸びている",
            "■ お客様のご希望",
            "■ 施術内容",
            "■ 薬剤・設定",
            "・6トーンで放置20分",
            "■ 仕上がり",
            "■ 次回提案",
            "・次は2か月後にリタッチ",
            "■ 注意点・申し送り",
            "・頭皮が赤かった",
            "・頭皮は受診をおすすめ",
            "■ 会話メモ",
          ].join("\n"),
          stop: "end",
        };
      },
    };
    const d = await runKarte({ memo, mode: "ai", writer: karteWriter, headings, rules: getRules(), maxTokens: 1000 });
    assert.equal(Object.keys(d.sections).length, 8);
    assert.deepEqual(d.sections.condition, ["根元が5センチ伸びている"]);
    assert.deepEqual(d.sections.notes, ["頭皮が赤かった"]);
    assert.deepEqual(d.sections.next, ["次は2か月後にリタッチ"]);
    for (const id of ["request", "treatment", "chemicals", "finish", "talk"]) assert.deepEqual(d.sections[id], [], `${id} はメモに無いので空`);
    assert.deepEqual(d.removed.map((r) => r.line).sort(), ["・6トーンで放置20分", "・頭皮は受診をおすすめ"].map((l) => l.slice(1)).sort());
  });

  test("決まった返事（AI なし）でも、まとめた要点のメモを見出しに分ける", async () => {
    const { memo } = combineNotes([["根元が伸びてパサついている", "次回は2か月後"]], getRecordingMemoMaxChars());
    const d = await runKarte({ memo, mode: "script", writer: scriptKarteWriter([], headings), headings, rules: getRules(), maxTokens: 1000 });
    assert.equal(Object.keys(d.sections).length, 8);
    assert.ok(d.sections.condition.some((l) => l.includes("パサ")));
    assert.deepEqual(d.sections.next, ["次回は2か月後"], "「・」の印は外して読む");
    assert.equal(d.removed.length, 0);
  });
});

/** 区切り4つのジョブ。区切りごとの音は、作った音（区切り3は無音だけ） */
function makeJob(store: RecordingStore, id = "rec.wav|1|1") {
  const chunks: ChunkPlan[] = [0, 1, 2, 3].map((i) => ({ index: i, startSec: i * 600, endSec: (i + 1) * 600, start: i, end: i + 1 }));
  return store.putJob(newJob({ id, name: "rec.wav", origin: "file", format: "wav", size: 1, lastModified: 1, durationSec: 2400, chunks, nowIso: "2026-11-04T00:00:00.000Z" }));
}
const CHUNK_AUDIO = [concat(quiet(2), speechLike(3)), speechLike(3), quiet(6), concat(steady(3), speechLike(2))];
const SCRIPTED_TEXT = ["根元が伸びてパサついてます。", "いい天気ですね。", "（呼ばれないはず）", "次は2か月後にリタッチで。"];

function deps(store: RecordingStore, calls: { transcribe: number[]; summarize: number[] }, over: Partial<JobDeps> = {}): JobDeps {
  return {
    store,
    sampleRate: RATE,
    silence: rec.silence,
    audioOf: async (c) => CHUNK_AUDIO[c.index],
    // 決まった文字起こしの結果（Whisper は呼ばない）
    transcribe: async (_a, c) => {
      calls.transcribe.push(c.index);
      return SCRIPTED_TEXT[c.index];
    },
    summarize: async (text, c) => {
      calls.summarize.push(c.index);
      const r = await runNotes({ text, mode: "script", writer: scriptNotesWriter(headings), headings, rules: getRules(), maxTokens: 600, maxNotes: 12, maxNoteChars: 60 });
      return { notes: r.notes, removed: r.removed.length };
    },
    ...over,
  };
}

describe("止めても、済んだ区切りは残して続きから再開する", () => {
  test("黙っている区切りは文字にしない。最後まで行けば「済み」で、要点をまとめられる", async () => {
    const store = memoryRecordingStore();
    await makeJob(store);
    const calls = { transcribe: [] as number[], summarize: [] as number[] };
    const job = await runJob("rec.wav|1|1", deps(store, calls));
    assert.equal(job.state, "done");
    assert.deepEqual(calls.transcribe, [0, 1, 3], "無音だけの区切り（2）は文字にしない");
    assert.equal(job.texts[2], "");
    assert.equal(job.speechSec[2], 0);
    assert.deepEqual(calls.summarize, [0, 1, 3], "文字の無い区切りは AI に送らない");
    assert.deepEqual(combineNotes(job.notes, 6000).lines, ["・根元が伸びてパサついてます", "・次は2か月後にリタッチで"]);
    assert.ok(isComplete(job));
  });

  test("2つ目の区切りで止めると、済んだ区切りは残り、続きからは残りの区切りだけ文字にする", async () => {
    const store = memoryRecordingStore();
    await makeJob(store);
    const calls = { transcribe: [] as number[], summarize: [] as number[] };
    const ctl = new AbortController();
    const d = deps(store, calls, {
      transcribe: async (_a, c) => {
        calls.transcribe.push(c.index);
        if (c.index === 1) ctl.abort();
        return SCRIPTED_TEXT[c.index];
      },
      signal: ctl.signal,
    });
    const stopped = await runJob("rec.wav|1|1", d);
    assert.equal(stopped.state, "stopped");
    assert.equal(textDone(stopped), 1, "止めた区切りの文字は使わない");
    assert.equal(nextChunk(stopped), 1);
    // ブラウザの置き場所に残っている
    assert.equal((await store.getJob("rec.wav|1|1"))?.texts[0], SCRIPTED_TEXT[0]);

    const calls2 = { transcribe: [] as number[], summarize: [] as number[] };
    const done = await runJob("rec.wav|1|1", deps(store, calls2));
    assert.equal(done.state, "done");
    assert.deepEqual(calls2.transcribe, [1, 3], "済んだ区切り（0）はもう一度文字にしない");
    assert.deepEqual(calls2.summarize, [1, 3]);
  });

  test("AI につながらないときは、文字にするのは最後まで続け、要点はあとで続きから", async () => {
    const store = memoryRecordingStore();
    await makeJob(store);
    const calls = { transcribe: [] as number[], summarize: [] as number[] };
    const noAi = await runJob("rec.wav|1|1", deps(store, calls, { summarize: async () => { throw new Error("今は AI につながりません"); } }));
    assert.equal(noAi.state, "stopped");
    assert.match(noAi.problem ?? "", /要点にできなかった区切りがあります/);
    assert.equal(textDone(noAi), 4);
    const calls2 = { transcribe: [] as number[], summarize: [] as number[] };
    const done = await runJob("rec.wav|1|1", deps(store, calls2));
    assert.equal(done.state, "done");
    assert.deepEqual(calls2.transcribe, [], "文字はもう一度作らない");
    assert.deepEqual(calls2.summarize, [0, 1, 3]);
  });
});

describe("録音フォルダ：読んだファイルは2回は読まない", () => {
  const NOW = Date.parse("2026-11-04T12:00:00Z");
  const STABLE = rec.folder.pollSeconds * 2000;
  const e = (name: string, size: number, ago: number): FolderEntry => ({ name, size, lastModified: NOW - ago });

  test("閉じている間にたまった物はまとめて拾い、読んだ物・受けない形は拾わない", () => {
    const entries = [e("a.m4a", 100, 3_600_000), e("b.mp3", 200, 7_200_000), e("memo.txt", 5, 3_600_000), e("c.wav", 300, 1_000_000)];
    const seen = new Set([fileKey(entries[3])]);
    const { ready, sizes } = readyFiles(entries, seen, {}, rec.accept, NOW, STABLE);
    assert.deepEqual(ready.map((x) => x.name), ["b.mp3", "a.m4a"], "古い順");
    assert.equal(sizes["memo.txt"], undefined);
    // 読んだ印を付けたら、次に見た時は拾わない
    for (const r of ready) seen.add(fileKey(r));
    assert.deepEqual(readyFiles(entries, seen, sizes, rec.accept, NOW + 20_000, STABLE).ready, []);
  });

  test("コピーの途中（大きさが変わっている・書いたばかり）は読まず、大きさが落ち着いてから読む", () => {
    const seen = new Set<string>();
    const first = readyFiles([e("new.m4a", 1000, 1000)], seen, {}, rec.accept, NOW, STABLE);
    assert.deepEqual(first.ready, [], "書いたばかり");
    const growing = readyFiles([e("new.m4a", 5000, 500)], seen, first.sizes, rec.accept, NOW + 20_000, STABLE);
    assert.deepEqual(growing.ready, [], "大きさが変わっている");
    const settled = readyFiles([e("new.m4a", 5000, 500)], seen, growing.sizes, rec.accept, NOW + 40_000, STABLE);
    assert.deepEqual(settled.ready.map((x) => x.name), ["new.m4a"]);
  });

  test("はじめてフォルダを選んだ時、今日より前の録音は読まずに印だけ付ける", () => {
    const today = Date.parse("2026-11-04T00:00:00Z");
    const entries = [e("old.m4a", 10, NOW - today + 86_400_000), e("today.m4a", 10, 3_600_000), e("x.txt", 1, NOW - today + 86_400_000)];
    const keys = oldFileKeys(entries, rec.accept, today);
    assert.deepEqual(keys, [fileKey(entries[0])]);
    assert.deepEqual(readyFiles(entries, new Set(keys), {}, rec.accept, NOW, STABLE).ready.map((x) => x.name), ["today.m4a"]);
  });

  test("印は名前・大きさ・書いた時刻（同じ物は同じ印）", () => {
    assert.equal(fileKey({ name: "a.m4a", size: 1, lastModified: 2 }), fileKey({ name: "a.m4a", size: 1, lastModified: 2 }));
    assert.notEqual(fileKey({ name: "a.m4a", size: 1, lastModified: 2 }), fileKey({ name: "a.m4a", size: 1, lastModified: 3 }));
  });
});

describe("PC だけ（スマホでは入口を出さない）", () => {
  const pc = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36", maxTouchPoints: 0, wideScreen: true, finePointer: true };

  test("PC の Chrome は出す。スマホ・iPad・狭い画面・指で触る画面は出さない", () => {
    assert.equal(isPcDevice(pc), true);
    assert.equal(isPcDevice({ ...pc, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" }), false);
    assert.equal(isPcDevice({ ...pc, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36" }), false);
    assert.equal(isPcDevice({ ...pc, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", maxTouchPoints: 5 }), false, "iPad");
    assert.equal(isPcDevice({ ...pc, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15" }), true, "Mac");
    assert.equal(isPcDevice({ ...pc, wideScreen: false }), false);
    assert.equal(isPcDevice({ ...pc, finePointer: false }), false);
  });

  test("録音フォルダは、フォルダを選べるブラウザ（Chrome・Edge）だけ", () => {
    assert.equal(canWatchFolder({ showDirectoryPicker() {} }), true);
    assert.equal(canWatchFolder({}), false);
  });

  test("画面：PC でなければ「この機能は PC で開いてください」だけを出し、入口（RecordingBody）は出さない。スイッチで隠せる", () => {
    const src = readFileSync(join(ROOT, "src/app/karte/RecordingPanel.tsx"), "utf8");
    assert.match(src, /!device\.pc \? \(\s*<p className="rec-pc-only">この機能は PC で開いてください<\/p>\s*\) : \(\s*<RecordingBody/);
    assert.match(src, /useRecordingSwitch\(p\.settings\.visible\)/);
    assert.match(src, /!on \?/);
    assert.equal((recordingJson as { visible: boolean }).visible, true);
  });
});

describe("声は外に出さない・書き方", () => {
  const NOTICE = ["声はこの PC のブラウザの外に出しません。文字にした中身は、要点とカルテを作るために Claude に送ります。", "録音は、お客様の了解を得てから行ってください。"];

  test("画面と README に、同じ2文を出す", () => {
    const panel = readFileSync(join(ROOT, "src/app/karte/RecordingPanel.tsx"), "utf8");
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const t of NOTICE) {
      assert.ok(panel.includes(t), `画面：${t}`);
      assert.ok(readme.includes(t), `README：${t}`);
    }
  });

  test("声を扱う所（Worker・広げる・録音・フォルダ）は、どこにも送らない（fetch しない）", () => {
    for (const f of ["whisper.worker.ts", "transcriber.ts", "decode.ts", "recorder.ts", "folder.ts", "plan.ts", "silence.ts"]) {
      const src = readFileSync(join(ROOT, "src/lib/recording", f), "utf8");
      assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/, f);
    }
    // AI に送るのは文字だけ（/api/ai/recording の body は mode・text・rules）
    const ui = readFileSync(join(ROOT, "src/lib/recording/useRecording.ts"), "utf8");
    assert.deepEqual(ui.match(/fetch\("[^"]+"/g), ['fetch("/api/ai/recording"']);
    assert.match(ui, /const body = \{ mode: getDesk\(\)\.mode, text: clipText\(maskNames\(/);
    // 窓口は /api/ai/ の下（Vercel の Firewall の1分10回に入る）
    assert.ok(readFileSync(join(ROOT, "src/app/api/ai/recording/route.ts"), "utf8").includes("runNotes"));
  });

  test("店の録音の長さや大きさの数字は書かない（「2〜4時間の録音でも読める」とだけ）", () => {
    const files = ["README.md", "docs/SPEC.md", "src/app/karte/RecordingPanel.tsx", "src/app/karte/page.tsx"];
    for (const f of files) {
      const t = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(t, /平均約?2時間|100〜300MB|100-300MB|長いと4時間/, f);
    }
    assert.ok(readFileSync(join(ROOT, "README.md"), "utf8").includes("2〜4時間の録音でも読め"));
  });
});

describe("最初に戻す", () => {
  const store = memoryRecordingStore();
  const local = new Map<string, string>();
  const g = globalThis as { window?: unknown };
  let had: unknown;
  before(() => {
    had = g.window;
    g.window = {
      localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
      addEventListener() {},
      removeEventListener() {},
    };
    setRecordingStore(store);
  });
  after(() => {
    g.window = had;
    setRecordingStore(null);
  });

  test("残した文字・要点・録音の区切り・読んだ印も消える（録音のメモの印も）", async () => {
    await makeJob(store);
    await runJob("rec.wav|1|1", deps(store, { transcribe: [], summarize: [] }));
    await store.putSegment("rec-1-0", new Blob([new Uint8Array(10)]));
    await store.addSeen(["a.m4a|1|1"]);
    await store.setMeta("folder", { name: "録音" });
    const k = deskKey("c01", "2026-11-04");
    setDesk((s) => ({ memos: { ...s.memos, [k]: "・根元が伸びた" }, sources: { [k]: "recording" } }));
    resetAll("2026-11-04");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(await store.listJobs(), []);
    assert.equal(await store.getSegment("rec-1-0"), null);
    assert.deepEqual(await store.getSeen(), []);
    assert.equal(await store.getMeta("folder"), null);
    assert.deepEqual(getDesk().sources, {});
    assert.deepEqual(getDesk().memos, {});
  });
});
