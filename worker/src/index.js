// 託すノートの中継（Cloudflare Worker）。
// 画面から答えを受け取り、Claude に診断・教材・コーチングを作らせて返す。
// 答えの本文はどこにも保存しない。数えるのは回数だけ（STATS）。

import Anthropic from "@anthropic-ai/sdk";
import { InputError, OutputError, makeHandlers } from "./handlers.js";

export { validCoaching, validDiagnosis, validQuestions } from "./handlers.js";

const MODEL = "claude-sonnet-5-5"; // Opus は費用がかかりすぎるため（2026-10-25）
const MAX_BODY = 32_000; // バイト（日本語は1文字3バイト）

class DailyCapError extends Error {}

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

      // 回数制限（IPごと）
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      if (env.LIMITER) {
        const { success } = await env.LIMITER.limit({ key: ip });
        if (!success) return json({ error: "too_many_requests", message: "少し時間をおいてから試してください。" }, 429, cors);
      }

      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY) return json({ error: "too_large" }, 413, cors);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "bad_json" }, 400, cors);
      }

      // 1日の全体上限は、入力の検証を通って AI を呼ぶ直前にだけ数える（中身の無い呼び出しで使い切らせないため）
      const handlers = makeHandlers({
        ai: async (system, content, schema, maxTokens) => {
          if (await overDailyCap(env)) throw new DailyCapError();
          return callClaude(env, system, content, schema, maxTokens);
        },
        count: (name) => count(env, name),
      });
      const result = await handlers[url.pathname](body);
      return json(result, 200, cors);
    } catch (err) {
      if (err instanceof InputError) return json({ error: "bad_input", message: err.message }, 400, cors);
      if (err instanceof DailyCapError) {
        return json({ error: "daily_cap", message: "本日の利用上限に達しました。明日また試してください。" }, 503, cors);
      }
      // 本文はログに出さない。種類だけ残す
      console.log("error", err?.name, err?.status ?? "");
      const status = err instanceof OutputError ? 502 : 500;
      return json({ error: "ai_failed", message: "診断を作れませんでした。もう一度お試しください。" }, status, cors);
    }
  },
};

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
