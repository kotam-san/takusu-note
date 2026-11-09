// 画面に依存しない計算（テスト対象）：記録の検証、推移、コーチに送るまとめ。

import { validateProfile } from "./profile.js";
import { AXIS_NAMES, CHEERS, CHEER_GAP_DAYS, CONCERN_KINDS, DEEP_BY_ROUND, MEMO_FROM_ROUND, MEMO_MAX, STEP_MISS_REASONS, STEP_NOTE_MAX } from "./questions.js";

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
    if (r.concern_kind != null && !isConcernKind(r.concern_kind)) return null; // null は無いのと同じ
    if (!validMemos(r.memos)) return null;
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

// 各問いのメモ（任意・3回目から）。{ fixed: { A: 文 }, deep: [{ text, memo }] }。無い古い記録も通す
function validMemos(m) {
  if (m === undefined) return true;
  if (!m || typeof m !== "object" || !m.fixed || typeof m.fixed !== "object" || !Array.isArray(m.deep) || m.deep.length > 8) return false;
  for (const [k, v] of Object.entries(m.fixed)) if (!AXIS_KEYS.includes(k) || !isStr(v, MEMO_MAX)) return false;
  return m.deep.every((d) => d && isStr(d.text, 120) && isStr(d.memo, MEMO_MAX));
}

// これまでのメモを、読み返す形にする。新しい回が先。1つの回の中は、推移の4問（A〜D）→ 深掘りの順。メモの無い回は含めない
export function memoEntries(rounds) {
  return rounds
    .filter((r) => r.memos)
    .map((r) => ({
      round: r.round,
      date: r.date,
      items: [
        ...AXIS_KEYS.filter((k) => r.memos.fixed?.[k]).map((k) => ({ label: AXIS_NAMES[k], memo: r.memos.fixed[k] })),
        ...(r.memos.deep ?? []).map((d) => ({ label: d.text, memo: d.memo })),
      ],
    }))
    .filter((e) => e.items.length)
    .reverse();
}

// この軸の問い（毎回同じ）に、いちばん最近書いたメモ
export function lastMemo(rounds, axis) {
  for (let i = rounds.length - 1; i >= 0; i--) {
    const memo = rounds[i].memos?.fixed?.[axis];
    if (typeof memo === "string" && memo) return { round: rounds[i].round, memo };
  }
  return null;
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

// ---------------------------------------------------------------- 回ごとの深掘りの数

// N 回目に出す深掘りの問い。list（AI が作った6問など）から DEEP_BY_ROUND[N-1] 問を選ぶ。
// 軸（A〜D）が偏らないよう、まだ出ていない軸の問いを、list の並びの順に先に選び、足りなければ残りを順に足す。
// 選んだ問いは、list の並びのまま返す
export const deepCountForRound = (round) => DEEP_BY_ROUND[Math.min(Math.max(Math.trunc(round) || 1, 1), DEEP_BY_ROUND.length) - 1];

export function deepForRound(list, round) {
  const n = deepCountForRound(round);
  const seen = new Set();
  const first = [];
  const rest = [];
  list.forEach((q, i) => {
    if (seen.has(q.axis)) rest.push(i);
    else { seen.add(q.axis); first.push(i); }
  });
  const chosen = new Set([...first, ...rest].slice(0, n));
  return list.filter((_, i) => chosen.has(i));
}

// ---------------------------------------------------------------- 節目のはげまし
// 数と事実（回数・点数・一歩・日付）から、出す言葉を決める。言葉そのものは questions.js の CHEERS。AI は使わない

const fillCheer = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));

// 一歩をやれた回が、最後から何回続いているか
export function trailingDone(rounds) {
  let n = 0;
  for (let i = rounds.length - 1; i >= 0 && rounds[i].step_done === true; i--) n++;
  return n;
}

// 年月日（YYYY-MM-DD）の日数の差。読めないときは 0
export function gapDays(from, to) {
  const t = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? "") ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : NaN);
  const d = Math.round((t(to) - t(from)) / 86400000);
  return Number.isFinite(d) ? d : 0;
}

// 1回の問いの最初の画面に出す一言。rounds は、これから始める回より前の記録（前回の一歩の結果は反映済み）
export function roundStartNotes(rounds) {
  const round = rounds.length + 1;
  const last = rounds.at(-1);
  const notes = [];
  if (last?.step_done === true) notes.push(trailingDone(rounds) === 3 ? CHEERS.streak3 : fillCheer(CHEERS.stepDone, { rate: stepDoneRate(rounds) }));
  else if (last?.step_done === false) notes.push(CHEERS.stepMissed);
  if (round === 2) notes.push(CHEERS.second);
  if (round === MEMO_FROM_ROUND) notes.push(CHEERS.memoOpen);
  if (round === DEEP_BY_ROUND.length) notes.push(fillCheer(CHEERS.full, { round, total: 4 + deepCountForRound(round) }));
  return notes;
}

// 見立ての先頭に出す一言。current は今の回（点数は current.fixed）、rounds はこの回を足す前の記録
export function diagnosisNotes(rounds, current) {
  if (current.round === 1) return [CHEERS.firstDiagnosis];
  const prev = rounds.at(-1)?.scores;
  if (!prev) return [];
  let best = null;
  for (const k of AXIS_KEYS) {
    const to = current.fixed?.[k]?.score;
    const up = Number.isInteger(to) ? to - prev[k] : 0;
    if (up > 0 && (!best || up > best.up)) best = { k, up, from: prev[k], to };
  }
  return best ? [fillCheer(CHEERS.axisUp, { axis: AXIS_NAMES[best.k], from: best.from, to: best.to })] : [];
}

// ホームに出す一言。間が空いて戻ってきたときは、その言葉を。そうでなければ、次の回に問いが増えるとき、その数を伝える
export function homeNotes(rounds, today = localDate()) {
  const last = rounds.at(-1);
  if (!last) return [];
  if (gapDays(last.date, today) >= CHEER_GAP_DAYS) return [CHEERS.gapReturn];
  const next = 4 + deepCountForRound(rounds.length + 1);
  return next > 4 + deepCountForRound(rounds.length) ? [fillCheer(CHEERS.nextCount, { n: next })] : [];
}

export const stepDecidedNote = () => CHEERS.stepDecided;

// ---------------------------------------------------------------- 問いの答え（1問ずつ答える画面）
// 答えそのもの：{ fixed: { A..D: 1〜4 }, deep: [1〜4], concern, kind }。未回答の問いは入れない。
// 下書き（draft.quiz）は { fixed: { A..D: 点|null }, deep: [点|null], concern, kind } で、この形は変えない。
// 下書きは利用者も書き換えられるので、読み戻すときは点の範囲と引っかかりの種類を確かめる。

export const emptyAnswers = () => ({ fixed: {}, deep: [], concern: "", kind: "", memos: { fixed: {}, deep: [] } });

// 問いの順番：推移の4問（AXIS_KEYS の順）→ 深掘り。最後の画面（ひとこと／引っかかり）は含めない
export const quizOrder = (deepCount) => [
  ...AXIS_KEYS.map((k) => ({ type: "fixed", k })),
  ...Array.from({ length: deepCount }, (_, i) => ({ type: "deep", i })),
];

export const scoreOf = (answers, step) => (step.type === "fixed" ? answers.fixed[step.k] : answers.deep[step.i]) || null;

export function setScore(answers, step, value) {
  if (step.type === "fixed") answers.fixed[step.k] = value;
  else answers.deep[step.i] = value;
}

// 各問いのメモ（3回目から）。答えと同じく、問いごとに持つ
export const memoOf = (answers, step) => (step.type === "fixed" ? answers.memos.fixed[step.k] : answers.memos.deep[step.i]) || "";

export function setMemo(answers, step, text) {
  if (step.type === "fixed") answers.memos.fixed[step.k] = text;
  else answers.memos.deep[step.i] = text;
}

// その回のメモを、記録に残す形にする（空のものは持たない。1つも無ければ null）
export function roundMemos(answers, deepList) {
  const fixed = {};
  for (const k of AXIS_KEYS) {
    const t = (answers.memos.fixed[k] ?? "").trim();
    if (t) fixed[k] = t.slice(0, MEMO_MAX);
  }
  const deep = [];
  deepList.forEach((d, i) => {
    const t = (answers.memos.deep[i] ?? "").trim();
    if (t) deep.push({ text: d.text, memo: t.slice(0, MEMO_MAX) });
  });
  return Object.keys(fixed).length || deep.length ? { fixed, deep } : null;
}

// 最初の未回答の問い（番号）。すべて答えてあれば、最後の画面の番号（問いの数）を返す
export function firstOpenStep(answers, deepCount) {
  const order = quizOrder(deepCount);
  const i = order.findIndex((step) => !scoreOf(answers, step));
  return i < 0 ? order.length : i;
}

const isKind = (v) => typeof v === "string" && Object.hasOwn(CONCERN_KINDS, v);

// 答えを下書きの形にする。kind は、1回目ははじめに選んだ種類、2回目以降は最後の画面で選んだ種類
export function answersToQuiz(answers, deepCount, kind = answers.kind) {
  const memoFixed = Object.fromEntries(AXIS_KEYS.filter((k) => (answers.memos.fixed[k] ?? "").trim()).map((k) => [k, answers.memos.fixed[k]]));
  const memoDeep = Array.from({ length: deepCount }, (_, i) => ((answers.memos.deep[i] ?? "").trim() ? answers.memos.deep[i] : null));
  const hasMemos = Object.keys(memoFixed).length > 0 || memoDeep.some(Boolean);
  return {
    fixed: Object.fromEntries(AXIS_KEYS.map((k) => [k, answers.fixed[k] || null])),
    deep: Array.from({ length: deepCount }, (_, i) => answers.deep[i] || null),
    concern: answers.concern,
    kind: kind ?? "",
    ...(hasMemos ? { memos: { fixed: memoFixed, deep: memoDeep } } : {}), // メモは書いたときだけ（3回目から）
  };
}

// 下書きから答えを読み戻す。範囲外の点・知らない種類・文字でない文は捨てる。base に重ねて返す（base は変えない）。
// 種類は2回目以降だけ読む（1回目の種類は、はじめの画面で記録に入っている）
export function answersFromQuiz(quiz, deepCount, round, base = emptyAnswers()) {
  const d = quiz && typeof quiz === "object" ? quiz : {};
  const answers = { fixed: { ...base.fixed }, deep: [...base.deep], concern: base.concern, kind: base.kind, memos: { fixed: { ...base.memos.fixed }, deep: [...base.memos.deep] } };
  for (const k of AXIS_KEYS) if (isScore(d.fixed?.[k])) answers.fixed[k] = d.fixed[k];
  for (let i = 0; i < deepCount; i++) if (isScore(d.deep?.[i])) answers.deep[i] = d.deep[i];
  if (typeof d.concern === "string") answers.concern = d.concern;
  if (round !== 1 && isKind(d.kind)) answers.kind = d.kind;
  const m = d.memos && typeof d.memos === "object" ? d.memos : {};
  const mf = m.fixed && typeof m.fixed === "object" ? m.fixed : {};
  const md = Array.isArray(m.deep) ? m.deep : []; // 文字列を並びとして読まない
  for (const k of AXIS_KEYS) if (typeof mf[k] === "string" && mf[k]) answers.memos.fixed[k] = mf[k].slice(0, MEMO_MAX);
  for (let i = 0; i < deepCount; i++) if (typeof md[i] === "string" && md[i]) answers.memos.deep[i] = md[i].slice(0, MEMO_MAX);
  return answers;
}

// 回答例（架空）を答えにする。深掘りの例が足りない問いは「あまりそう思わない」(2) にする
export function sampleAnswers(sample, deepCount, round, base = emptyAnswers()) {
  return {
    fixed: Object.fromEntries(AXIS_KEYS.map((k) => [k, Number(sample.fixed[k])])),
    deep: Array.from({ length: deepCount }, (_, i) => Number(sample.deep[i] ?? 2)),
    concern: sample.concern,
    kind: round !== 1 && isKind(sample.concern_kind) ? sample.concern_kind : base.kind,
    memos: base.memos, // 回答例では、メモは触らない
  };
}

// ---------------------------------------------------------------- 記録のバックアップ（書き出し・読み込み）
// 公開バージョンの記録はそのブラウザの中にしか無いので、ファイルに書き出して取っておき、読み込んで戻せるようにする。
// ファイルには、答え・メモ・プロフィールなど記録の全部が入る。読み込むときは、託すノートのものか・今の立場のものか・記録の形か、を確かめる

export const BACKUP_APP = "takusu-note";
export const BACKUP_MAX_CHARS = 1_000_000; // 記録は100回分でも、これよりずっと小さい

export function makeBackup(role, store, now = new Date()) {
  return { app: BACKUP_APP, version: STORE_VERSION, role, exported_on: localDate(now), store };
}

// 読み込む。読めたら { store }、だめなら { error: "size" | "format" | "role" | "shape", fileRole? }
export function readBackup(text, role) {
  if (typeof text !== "string" || text.length > BACKUP_MAX_CHARS) return { error: "size" };
  let data;
  try { data = JSON.parse(text); } catch { return { error: "format" }; }
  if (!data || typeof data !== "object" || data.app !== BACKUP_APP || (data.role !== "ceo" && data.role !== "leader")) return { error: "format" };
  if (data.role !== role) return { error: "role", fileRole: data.role };
  const store = validateStore(data.store);
  return store ? { store } : { error: "shape" };
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
  if (from != null && to != null && to - from >= CHEER_GAP_DAYS) out.push({ kind: "gap", days: to - from });
  return out;
}

// 同じ合図は、前に出してから3回たつまで出さない。間が空いた合図はまれなので、回が変われば出す（同じ回では一度だけ）
export function nudgeToShow(signals, last, round) {
  if (!last) return signals;
  return signals.filter((s) => (s.kind === "gap"
    ? !(last.round === round && last.kinds.includes("gap"))
    : !(last.kinds.includes(s.kind) && round - last.round < NUDGE_STREAK)));
}

export function nudgeLines(signals) {
  return signals.map((s) =>
    s.kind === "miss" ? "ここ3回、決めた一歩が形になりにくい状態が続いています。一歩の大きさか場面が、今の状況と合っていないのかもしれません。"
      : s.kind === "same_kind" ? `ここ3回、『${CONCERN_KINDS[s.concern_kind]}』が引っかかりに挙がっています。`
        : `前回から${s.days}日空きました。間が空くのは、一人で回すのが難しくなっている合図のこともあります。`);
}
