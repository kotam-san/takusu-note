// 託すノートの3つの道（1回目の問い・診断と教材・3分コーチング）の中身。
// 入力の検証・AI に渡す本文の組み立て・出力の検証だけを持ち、AI の呼び方と回数の数え方は外から受け取る。
// 公開の中継（index.js・Anthropic API）と手元の入口（local/server.mjs・claude -p）の両方が使う。

import {
  AXES, COACH_SCHEMA, DIAGNOSE_SCHEMA, START_SCHEMA, coachSystem, diagnoseSystem, startContent, startSystem,
} from "./prompts.js";
import { profileText, validateProfile } from "../../docs/profile.js";
import { QUESTIONS } from "../../docs/questions.js";

const AXIS_KEYS = ["A", "B", "C", "D"];

export class InputError extends Error {}
export class OutputError extends Error {}

// ai(system, content, schema, maxTokens) → 出力の JSON
// count(name) → 回数を1つ足す（成功したときだけ呼ぶ）
export function makeHandlers({ ai, count = async () => {} }) {
  return {
    "/api/start": (body) => start(body, ai, count),
    "/api/diagnose": (body) => diagnose(body, ai, count),
    "/api/coach": (body) => coach(body, ai, count),
  };
}

// ---------------------------------------------------------------- 1回目の問い（プロフィールから）

async function start(body, ai, count) {
  const role = checkRole(body.role);
  const profile = checkProfile(body.profile, role);
  const concern = checkText(body.concern ?? "", 400, "concern");
  const content = startContent(profileText(profile, role), QUESTIONS[role].fixed, concern);
  const out = await ai(startSystem(role), content, START_SCHEMA, 3000);
  if (!validQuestions(out)) throw new OutputError("start shape");
  await count("rounds_profiled");
  return out;
}

// ---------------------------------------------------------------- 診断と教材

async function diagnose(body, ai, count) {
  const role = checkRole(body.role);
  const round = checkInt(body.round, 1, 100, "round");
  const fixed = checkFixed(body.fixed);
  const deep = checkList(body.deep, 8, (d) => ({
    axis: checkAxis(d.axis),
    text: checkText(d.text, 120, "deep.text"),
    score: checkInt(d.score, 1, 4, "deep.score"),
  }));
  const concern = checkText(body.concern ?? "", 400, "concern");
  const history = checkHistory(body.history);
  const prev = body.prev_step
    ? { text: checkText(body.prev_step.text, 80, "prev_step.text"), done: checkDone(body.prev_step.done) }
    : null;
  const profile = body.profile == null ? null : checkProfile(body.profile, role);

  const lines = [
    ...profileBlock(profile, role),
    `回：${round} 回目`,
    "",
    "<history>",
    history.length ? history.map(fmtHistory).join("\n") : "（初回）",
    "</history>",
    "",
    "<answers>",
    "推移用の4問：",
    ...AXIS_KEYS.map((k) => `- ${k}（${AXES[k]}）：${fixed[k].text} → ${fixed[k].score}`),
    "深掘りの問い：",
    ...deep.map((d) => `- [${d.axis}] ${d.text} → ${d.score}`),
    prev ? `前回の一歩「${prev.text}」→ ${prev.done === true ? "やれた" : prev.done === false ? "やれなかった" : "未回答"}` : "",
    "</answers>",
    "",
    "<concern>",
    concern || "（記入なし）",
    "</concern>",
  ];

  const out = await ai(diagnoseSystem(role), lines.join("\n"), DIAGNOSE_SCHEMA, 6000);
  if (!validDiagnosis(out)) throw new OutputError("diagnose shape");

  await count("rounds_started");
  if (round >= 2) await count("rounds_returning");
  if (prev?.done === true) await count("step_done");
  if (prev?.done === false) await count("step_not_done");
  return out;
}

// ---------------------------------------------------------------- 3分コーチング

async function coach(body, ai, count) {
  const role = checkRole(body.role);
  const question = checkText(body.question, 300, "question");
  const reply = checkText(body.reply, 800, "reply");
  const summary = checkText(body.summary ?? "", 600, "summary");
  const concern = checkText(body.concern ?? "", 400, "concern");
  const fixed = checkFixed(body.fixed);
  const history = checkHistory(body.history);
  const prev = body.prev_step
    ? { text: checkText(body.prev_step.text, 80, "prev_step.text"), done: checkDone(body.prev_step.done) }
    : null;
  const profile = body.profile == null ? null : checkProfile(body.profile, role);

  const content = [
    ...profileBlock(profile, role),
    "<history>",
    history.length ? history.map(fmtHistory).join("\n") : "（初回）",
    prev ? `前回の一歩「${prev.text}」→ ${prev.done === true ? "やれた" : prev.done === false ? "やれなかった" : "未回答"}` : "",
    `今回の見立て：${summary}`,
    "推移用の4問：",
    ...AXIS_KEYS.map((k) => `- ${k}：${fixed[k].text} → ${fixed[k].score}`),
    "</history>",
    "",
    "<concern>",
    concern || "（記入なし）",
    "</concern>",
    "",
    `<question>${question}</question>`,
    "",
    "<reply>",
    reply,
    "</reply>",
  ].join("\n");

  const out = await ai(coachSystem(role), content, COACH_SCHEMA, 4000);
  if (!validCoaching(out)) throw new OutputError("coach shape");
  await count("rounds_completed");
  return out;
}

// ---------------------------------------------------------------- AI の出力の形

const filled = (v) => typeof v === "string" && v.trim() !== "";

export function validDiagnosis(out) {
  const n = out?.coaching_choices?.length;
  return out?.axis_notes?.length === 4 && out.lesson?.check?.choices?.length === 3 &&
    [0, 1, 2].includes(out.lesson.check.answer_index) && filled(out.coaching_question) &&
    n >= 2 && n <= 3 && out.coaching_choices.every(filled);
}

export function validCoaching(out) {
  return out?.step_options?.length === 3 && filled(out.reflection) && validQuestions(out);
}

// 次の深掘り6問と推移4問の例（1回目の /api/start と、コーチングの後の両方で使う）
export function validQuestions(out) {
  return out?.next_questions?.length === 6 &&
    out.next_questions.every((q) => AXIS_KEYS.includes(q?.axis) && filled(q.text)) &&
    AXIS_KEYS.every((k) => filled(out.fixed_examples?.[k]));
}

// ---------------------------------------------------------------- 入力の検証

function checkRole(v) {
  if (v !== "ceo" && v !== "leader") throw new InputError("role は ceo か leader です");
  return v;
}
function checkAxis(v) {
  if (!AXIS_KEYS.includes(v)) throw new InputError("axis は A〜D です");
  return v;
}
function checkInt(v, min, max, name) {
  if (!Number.isInteger(v) || v < min || v > max) throw new InputError(`${name} は ${min}〜${max} の整数です`);
  return v;
}
function checkText(v, max, name) {
  if (typeof v !== "string") throw new InputError(`${name} は文字列です`);
  if (v.length > max) throw new InputError(`${name} は ${max} 文字までです`);
  return v.trim();
}
function checkDone(v) {
  if (v === true || v === false || v === null) return v;
  throw new InputError("prev_step.done は true / false / null です");
}
function checkList(v, max, fn) {
  if (!Array.isArray(v) || v.length > max) throw new InputError(`一覧は ${max} 件までです`);
  return v.map(fn);
}
function checkFixed(v) {
  if (!v || typeof v !== "object") throw new InputError("fixed がありません");
  const out = {};
  for (const k of AXIS_KEYS) {
    out[k] = { text: checkText(v[k]?.text, 120, `fixed.${k}.text`), score: checkInt(v[k]?.score, 1, 4, `fixed.${k}.score`) };
  }
  return out;
}
function checkProfile(v, role) {
  const p = validateProfile(v, role);
  if (!p) throw new InputError("profile の形か選択肢が違います");
  return p;
}
function profileBlock(profile, role) {
  return profile ? ["<profile>", profileText(profile, role), "</profile>", ""] : [];
}
function checkHistory(v) {
  return checkList(v ?? [], 24, (h) => ({
    round: checkInt(h.round, 1, 100, "history.round"),
    date: checkText(h.date ?? "", 10, "history.date"),
    scores: Object.fromEntries(AXIS_KEYS.map((k) => [k, checkInt(h.scores?.[k], 1, 4, "history.scores")])),
    step: checkText(h.step ?? "", 80, "history.step"),
    step_done: checkDone(h.step_done ?? null),
  }));
}
function fmtHistory(h) {
  const scores = AXIS_KEYS.map((k) => `${k}=${h.scores[k]}`).join(" ");
  const done = h.step_done === true ? "やれた" : h.step_done === false ? "やれなかった" : "未確認";
  return `- ${h.round}回目（${h.date}）${scores}／一歩「${h.step}」→ ${done}`;
}
