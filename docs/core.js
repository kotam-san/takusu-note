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
    if (r.concern_kind !== undefined && !isConcernKind(r.concern_kind)) return null;
  }
  if (data.next_deep != null) {
    if (!Array.isArray(data.next_deep) || data.next_deep.length > 8) return null;
    for (const q of data.next_deep) {
      if (!AXIS_KEYS.includes(q?.axis) || !isStr(q?.text, 120) || !isStr(q?.because ?? "", 120)) return null;
    }
  }
  if (data.profile != null && !validateProfile(data.profile)) return null;
  if (data.first_concern != null && !isStr(data.first_concern, 400)) return null;
  if (data.first_concern_kind != null && !(typeof data.first_concern_kind === "string" && Object.hasOwn(CONCERN_KINDS, data.first_concern_kind))) return null;
  if (data.outside_nudge != null) {
    const n = data.outside_nudge;
    if (typeof n !== "object" || !Number.isInteger(n.round) || n.round < 1) return null;
    if (!Array.isArray(n.kinds) || n.kinds.length > NUDGE_KINDS.length || !n.kinds.every((k) => NUDGE_KINDS.includes(k))) return null;
  }
  if (data.next_examples != null) {
    if (typeof data.next_examples !== "object" || !AXIS_KEYS.every((k) => isStr(data.next_examples[k], 120))) return null;
  }
  return data;
}

const isConcernKind = (v) => typeof v === "string" && Object.hasOwn(CONCERN_KINDS, v);

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
  return { version: STORE_VERSION, rounds: [], next_deep: null, next_examples: null, profile: null, first_concern: null, first_concern_kind: null, outside_nudge: null };
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
  const kindKey = typeof extra.concern_kind === "string" && Object.hasOwn(CONCERN_KINDS, extra.concern_kind) ? extra.concern_kind : "";
  if (pick.concern && concern) {
    const kind = kindKey ? `（中身：${CONCERN_KINDS[kindKey]}）` : "";
    lines.push(`いちばん引っかかっていること：${oneLine(concern)}${kind}`);
  } else if (pick.concern && kindKey && kindKey !== "unknown") {
    lines.push(`引っかかりの中身：${CONCERN_KINDS[kindKey]}`); // 文章は書かず、中身だけ選んだとき
  }
  const reply = typeof extra.reply === "string" ? extra.reply.trim() : "";
  if (pick.reply && reply) lines.push(`3分コーチングでの答え：${oneLine(reply)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- 一人で回りにくくなった合図
// 記録の数字と日付だけで見る（AI は使わない）。合図が出たら、コーチ（いなければ話せる相手）に話すことを勧める。

export const NUDGE_KINDS = ["miss", "same_kind", "gap"];
const NUDGE_STREAK = 3; // 直近この回数
const NUDGE_GAP_DAYS = 21; // 週1回の道具なので、2回分飛ばした目安
export const NUDGE_TITLE = "一人で回すのが難しい時期かもしれません";
export const NUDGE_BODY = "次のコーチングのセッションで（コーチがいなければ、話せる相手に）、このことを話してみませんか。書いてきたことをそのまま話すだけで、考えが進むことがあります。終わりの画面の「コーチに送るまとめ」で、一歩とやれたかを送れます。";

// "YYYY-MM-DD" を日の通し番号にする。日付として読めなければ null
function dayNumber(s) {
  const m = typeof s === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86400000;
}

// 合図の一覧（miss → same_kind → gap の順）。無ければ []
export function outsideTalkSignals(rounds, today) {
  const out = [];
  const recent = rounds.slice(-NUDGE_STREAK);
  if (recent.length === NUDGE_STREAK) {
    if (recent.every((r) => r.step_done === false)) out.push({ kind: "miss" });
    const k = recent[0].concern_kind;
    if (isConcernKind(k) && k !== "unknown" && recent.every((r) => r.concern_kind === k)) out.push({ kind: "same_kind", concern_kind: k });
  }
  const last = rounds.at(-1);
  const from = dayNumber(last?.date);
  const to = dayNumber(today);
  if (from != null && to != null && to - from >= NUDGE_GAP_DAYS) out.push({ kind: "gap", days: to - from });
  return out;
}

// 同じ合図は、前に出してから3回たつまで出さない。間が空いた合図はまれなので毎回出す
export function nudgeToShow(signals, last, round) {
  if (!last) return signals;
  return signals.filter((s) => s.kind === "gap" || !(last.kinds.includes(s.kind) && round - last.round < NUDGE_STREAK));
}

export function nudgeLines(signals) {
  return signals.map((s) =>
    s.kind === "miss" ? "ここ3回、決めた一歩が形になりにくい状態が続いています。一歩の大きさか場面が、今の状況と合っていないのかもしれません。"
      : s.kind === "same_kind" ? `ここ3回、『${CONCERN_KINDS[s.concern_kind]}』が引っかかりに挙がっています。`
        : `前回から${s.days}日空きました。戻ってきてくれてありがとうございます。`);
}
