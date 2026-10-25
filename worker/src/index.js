// 託すノートの中継（Cloudflare Worker）。
// 画面から答えを受け取り、Claude に診断・教材・コーチングを作らせて返す。
// 答えの本文はどこにも保存しない。数えるのは回数だけ（STATS）。

import Anthropic from "@anthropic-ai/sdk";
import {
  AXES, COACH_SCHEMA, DIAGNOSE_SCHEMA, START_SCHEMA, coachSystem, diagnoseSystem, startContent, startSystem,
} from "./prompts.js";
import { profileText, validateProfile } from "../../docs/profile.js";
import { QUESTIONS } from "../../docs/questions.js";

const MODEL = "claude-sonnet-5-5"; // Opus は費用がかかりすぎるため（2026-10-25）
const MAX_BODY = 32_000; // バイト（日本語は1文字3バイト）
const AXIS_KEYS = ["A", "B", "C", "D"];

// ---------------------------------------------------------------- 入口

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/stats") {
        return json(await readStats(env), 200, cors);
      }
      if (request.method !== "POST" || !["/api/start", "/api/diagnose", "/api/coach"].includes(url.pathname)) {
        return json({ error: "not_found" }, 404, cors);
      }
      if (!cors["Access-Control-Allow-Origin"]) return json({ error: "origin_not_allowed" }, 403, cors);

      // 回数制限（IPごと）と、1日の全体上限
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      if (env.LIMITER) {
        const { success } = await env.LIMITER.limit({ key: ip });
        if (!success) return json({ error: "too_many_requests", message: "少し時間をおいてから試してください。" }, 429, cors);
      }
      if (await overDailyCap(env)) {
        return json({ error: "daily_cap", message: "本日の利用上限に達しました。明日また試してください。" }, 503, cors);
      }

      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY) return json({ error: "too_large" }, 413, cors);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "bad_json" }, 400, cors);
      }

      const handlers = { "/api/start": start, "/api/diagnose": diagnose, "/api/coach": coach };
      const result = await handlers[url.pathname](body, env);
      return json(result, 200, cors);
    } catch (err) {
      if (err instanceof InputError) return json({ error: "bad_input", message: err.message }, 400, cors);
      // 本文はログに出さない。種類だけ残す
      console.log("error", err?.name, err?.status ?? "");
      const status = err instanceof OutputError ? 502 : 500;
      return json({ error: "ai_failed", message: "診断を作れませんでした。もう一度お試しください。" }, status, cors);
    }
  },
};

// ---------------------------------------------------------------- 1回目の問い（プロフィールから）

async function start(body, env) {
  const role = checkRole(body.role);
  const profile = checkProfile(body.profile, role);
  const concern = checkText(body.concern ?? "", 400, "concern");
  const content = startContent(profileText(profile, role), QUESTIONS[role].fixed, concern);
  const out = await callClaude(env, startSystem(role), content, START_SCHEMA, 3000);
  if (!validQuestions(out)) throw new OutputError("start shape");
  await count(env, "rounds_profiled");
  return out;
}

// ---------------------------------------------------------------- 診断と教材

async function diagnose(body, env) {
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

  const out = await callClaude(env, diagnoseSystem(role), lines.join("\n"), DIAGNOSE_SCHEMA, 6000);
  if (!validDiagnosis(out)) throw new OutputError("diagnose shape");

  await count(env, "rounds_started");
  if (round >= 2) await count(env, "rounds_returning");
  if (prev?.done === true) await count(env, "step_done");
  if (prev?.done === false) await count(env, "step_not_done");
  return out;
}

// ---------------------------------------------------------------- 3分コーチング

async function coach(body, env) {
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

  const out = await callClaude(env, coachSystem(role), content, COACH_SCHEMA, 4000);
  if (!validCoaching(out)) throw new OutputError("coach shape");
  await count(env, "rounds_completed");
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

// ---------------------------------------------------------------- Claude を呼ぶ

async function callClaude(env, system, content, schema, maxTokens) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // 安全上の理由で断られたときは、推奨の別モデルでやり直す
  });
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    throw new OutputError(response.stop_reason);
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new OutputError("no text");
  return JSON.parse(text);
}

// ---------------------------------------------------------------- 入力の検証

class InputError extends Error {}
class OutputError extends Error {}

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

// ---------------------------------------------------------------- 回数を数える（本文は残さない）

function today() {
  return new Date().toISOString().slice(0, 10);
}
async function overDailyCap(env) {
  if (!env.STATS) return false;
  const cap = Number(env.DAILY_CAP || 300);
  const n = Number((await env.STATS.get(`calls:${today()}`)) || 0);
  await env.STATS.put(`calls:${today()}`, String(n + 1), { expirationTtl: 60 * 60 * 48 });
  return n >= cap;
}
async function count(env, name) {
  if (!env.STATS) return;
  const n = Number((await env.STATS.get(`total:${name}`)) || 0);
  await env.STATS.put(`total:${name}`, String(n + 1));
}
async function readStats(env) {
  const names = ["rounds_profiled", "rounds_started", "rounds_completed", "rounds_returning", "step_done", "step_not_done"];
  const v = {};
  for (const n of names) v[n] = env.STATS ? Number((await env.STATS.get(`total:${n}`)) || 0) : 0;
  const rate = (a, b) => (b ? Math.round((a / b) * 100) : null);
  return {
    ...v,
    completion_rate: rate(v.rounds_completed, v.rounds_started), // 1周を終えた率
    returning_rate: rate(v.rounds_returning, v.rounds_started), // 2回目以降の回の割合
    step_done_rate: rate(v.step_done, v.step_done + v.step_not_done), // 前回の一歩をやれた率
  };
}

// ---------------------------------------------------------------- 返し方

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && env.ALLOW_LOCALHOST === "1";
  const h = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
  if (allowed.includes(origin) || local) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
