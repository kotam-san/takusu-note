// 画面に依存しない計算（テスト対象）：記録の検証、推移、コーチに送るまとめ。

import { validateProfile } from "./profile.js";
import { AXIS_NAMES, CONCERN_KINDS, STEP_MISS_REASONS, STEP_NOTE_MAX } from "./questions.js";

export const AXIS_KEYS = ["A", "B", "C", "D"];
export const STORE_VERSION = 1;
export const LESSON_TITLE_MAX = 40;
export const LESSON_BODY_MAX = 600;

// ---------------------------------------------------------------- 記録の形の検証
// localStorage は利用者も書き換えられるので、読み込むたびに形と範囲を確かめる。
// 壊れていれば null を返し、画面は「記録が読めませんでした」と出して新しく始める。

const isScore = (v) => Number.isInteger(v) && v >= 1 && v <= 4;
const isStr = (v, max) => typeof v === "string" && v.length <= max;

export function validateStore(data) {
  if (!data || typeof data !== "object" || data.version !== STORE_VERSION) return null;
  if (!Array.isArray(data.rounds) || data.rounds.length > 100) return null;
  for (const r of data.rounds) {
    if (!r || typeof r !== "object") return null;
    if (!Number.isInteger(r.round) || !isStr(r.date, 10)) return null;
    if (!AXIS_KEYS.every((k) => isScore(r.scores?.[k]))) return null;
    if (!isStr(r.step ?? "", 80)) return null;
    if (![true, false, null, undefined].includes(r.step_done)) return null;
    if (r.lesson != null && !(isStr(r.lesson?.title, LESSON_TITLE_MAX) && isStr(r.lesson?.body, LESSON_BODY_MAX))) return null;
    if (!validMiss(r)) return null;
  }
  if (data.next_deep != null) {
    if (!Array.isArray(data.next_deep) || data.next_deep.length > 8) return null;
    for (const q of data.next_deep) {
      if (!AXIS_KEYS.includes(q?.axis) || !isStr(q?.text, 120) || !isStr(q?.because ?? "", 120)) return null;
    }
  }
  if (data.profile != null && !validateProfile(data.profile)) return null;
  if (data.first_concern != null && !isStr(data.first_concern, 400)) return null;
  if (data.next_examples != null) {
    if (typeof data.next_examples !== "object" || !AXIS_KEYS.every((k) => isStr(data.next_examples[k], 120))) return null;
  }
  return data;
}

// 候補のキーか（文字列でないものは、キーの文字に化けて通らないよう先に断る）
export const isMissReason = (v) => typeof v === "string" && Object.hasOwn(STEP_MISS_REASONS, v);

// やれなかった理由と一言は、やれなかった回にだけ、候補と長さの内で持つ（無い古い記録も通す）
function validMiss(r) {
  if (r.step_reason === undefined && r.step_note === undefined) return true;
  if (r.step_done !== false) return false;
  if (r.step_reason !== undefined && !isMissReason(r.step_reason)) return false;
  return r.step_note === undefined || (isStr(r.step_note, STEP_NOTE_MAX) && !r.step_note.includes("\n"));
}

export function emptyStore() {
  return { version: STORE_VERSION, rounds: [], next_deep: null, next_examples: null, profile: null, first_concern: null };
}

// ---------------------------------------------------------------- 学びと途中の回

// その回の学びを記録に残す形にする。AI の出力は長さが保証されないので、ここで切る（記録全体を壊さないため）
export function clipLesson(lesson) {
  if (!lesson || typeof lesson.title !== "string" || typeof lesson.body !== "string") return null;
  return { title: lesson.title.slice(0, LESSON_TITLE_MAX), body: lesson.body.slice(0, LESSON_BODY_MAX) };
}

// 途中の回の下書き（ページを離れて戻っても続きから開くため）。開いてよいのは、
// まだ保存していない次の回で、同じ深掘りの問いに答えている途中のものだけ（保存済みの回を二重に積まない）
export const DRAFT_STAGES = ["quiz", "diagnosis", "steps"];
export function draftMatches(draft, rounds, deepTexts) {
  if (!draft || typeof draft !== "object") return false;
  if (draft.round !== rounds.length + 1 || !DRAFT_STAGES.includes(draft.stage)) return false;
  if (JSON.stringify(draft.deep_texts) !== JSON.stringify(deepTexts)) return false;
  if (draft.stage !== "quiz" && !(draft.current?.diagnosis && typeof draft.current.diagnosis === "object")) return false;
  if (draft.stage === "steps" && !Array.isArray(draft.current?.coaching?.step_options)) return false;
  return true;
}

// ---------------------------------------------------------------- 日付

// その Mac・その端末の時計での年月日（toISOString は世界標準時なので、日本の朝は前日になる）
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------- 推移

// 回ごとの点数を軸別の系列にする（グラフ用）
export function seriesByAxis(rounds) {
  return Object.fromEntries(AXIS_KEYS.map((k) => [k, rounds.map((r) => ({ round: r.round, value: r.scores[k] }))]));
}

// 最初の回から最新の回への変化
export function changeSinceFirst(rounds) {
  if (rounds.length < 2) return null;
  const first = rounds[0].scores;
  const last = rounds[rounds.length - 1].scores;
  return Object.fromEntries(AXIS_KEYS.map((k) => [k, last[k] - first[k]]));
}

// 一歩をやれた割合（確認済みの回だけで数える）
export function stepDoneRate(rounds) {
  const checked = rounds.filter((r) => r.step_done === true || r.step_done === false);
  if (!checked.length) return null;
  return Math.round((checked.filter((r) => r.step_done === true).length / checked.length) * 100);
}

// ---------------------------------------------------------------- やれなかった理由

const oneLine = (v) => v.replace(/\s*\n\s*/g, " / ");

// 理由と一言は、やれなかったときだけ持つ。候補にない理由は持たず、一言は1行・80字にそろえる。
// 記録・中継・手元モードの書き出しで同じ決まりを使う（どの道でも「やれたのに理由がある」を出さない）
export function stepMiss(done, reason, note) {
  if (done !== false) return {};
  const out = {};
  if (isMissReason(reason)) out.reason = reason;
  const n = typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, STEP_NOTE_MAX) : "";
  if (n) out.note = n;
  return out;
}

// 「（理由：…／ひとこと：…）」。どちらも無ければ空
export function missDetail({ reason, note } = {}) {
  const parts = [reason ? `理由：${STEP_MISS_REASONS[reason]}` : "", note ? `ひとこと：${note}` : ""].filter(Boolean);
  return parts.length ? `（${parts.join("／")}）` : "";
}

// ---------------------------------------------------------------- コーチに送るまとめ

// index 番目の回のまとめ（本人がコピーして送る平文）。pick で選んだ項目だけ入れる。
// 前回の一歩と結果は1つ前の回の記録から、今週の一歩はその回から取る（その回の一歩の結果は次の回のまとめに出る）。
// extra はその回の終わりの画面でだけ渡せるもの（引っかかりと中身・3分コーチングへの答え。記録には残らない）
export function roundSummary(roleName, rounds, index, pick = {}, extra = {}) {
  const r = rounds[index];
  const prev = rounds[index - 1];
  const lines = [`託すノート｜${roleName}・${r.round}回目（${r.date}）`];
  if (pick.step) {
    if (prev?.step) {
      const miss = stepMiss(prev.step_done, prev.step_reason, prev.step_note);
      const result = prev.step_done === true ? "やれた"
        : prev.step_done === false ? `やれなかった${miss.reason ? `（${STEP_MISS_REASONS[miss.reason]}）` : ""}`
        : "まだ確かめていない";
      lines.push(`前回の一歩：${prev.step} → ${result}`);
      if (pick.note && miss.note) lines.push(`　ひとこと：${miss.note}`);
    }
    if (r.step) lines.push(`今週の一歩：${r.step}`);
  }
  if (pick.scores) lines.push(`4つの軸（1〜4）：${AXIS_KEYS.map((k) => `${AXIS_NAMES[k]} ${r.scores[k]}`).join("／")}`);
  if (pick.lesson && r.lesson?.title) lines.push(`今日の学び：${r.lesson.title}`);
  const concern = typeof extra.concern === "string" ? extra.concern.trim() : "";
  if (pick.concern && concern) {
    const kind = Object.hasOwn(CONCERN_KINDS, extra.concern_kind ?? "") ? `（中身：${CONCERN_KINDS[extra.concern_kind]}）` : "";
    lines.push(`いちばん引っかかっていること：${oneLine(concern)}${kind}`);
  }
  const reply = typeof extra.reply === "string" ? extra.reply.trim() : "";
  if (pick.reply && reply) lines.push(`3分コーチングでの答え：${oneLine(reply)}`);
  return lines.join("\n");
}
