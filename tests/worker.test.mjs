// 中継の入口の検証（AI は呼ばない）。実行：node --test tests/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/src/index.js";

const ORIGIN = "https://kotam-san.github.io";
const env = { ALLOWED_ORIGINS: ORIGIN, DAILY_CAP: "300" };

const call = (path, { method = "POST", origin = ORIGIN, body } = {}) =>
  worker.fetch(
    new Request("https://w.example" + path, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body ?? {})) : undefined,
    }),
    env,
  );

const fixed = Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, { text: "問い", score: 2 }]));

test("許可していない呼び出し元は 403", async () => {
  const res = await call("/api/diagnose", { origin: "https://evil.example", body: { role: "ceo" } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("localhost は ALLOW_LOCALHOST=1 のときだけ通る", async () => {
  const res = await call("/api/diagnose", { origin: "http://localhost:8768", body: {} });
  assert.equal(res.status, 403);
  const allowed = await worker.fetch(
    new Request("https://w.example/api/diagnose", { method: "POST", headers: { Origin: "http://localhost:8768" }, body: "{}" }),
    { ...env, ALLOW_LOCALHOST: "1" },
  );
  assert.equal(allowed.status, 400); // 呼び出し元は通り、入力の検証で止まる
});

test("存在しない道は 404", async () => {
  assert.equal((await call("/api/admin")).status, 404);
  assert.equal((await call("/api/diagnose", { method: "GET" })).status, 404);
});

test("壊れた JSON は 400", async () => {
  assert.equal((await call("/api/diagnose", { body: "{bad" })).status, 400);
});

test("大きすぎる本文は 413", async () => {
  assert.equal((await call("/api/diagnose", { body: JSON.stringify({ x: "あ".repeat(12000) }) })).status, 413);
});

test("立場・点数・長さが範囲外なら 400（AI は呼ばれない）", async () => {
  const cases = [
    { role: "admin" },
    { role: "ceo", round: 1, fixed: { ...fixed, A: { text: "問い", score: 9 } }, deep: [] },
    { role: "ceo", round: 1, fixed, deep: [], concern: "あ".repeat(401) },
    { role: "ceo", round: 1, fixed, deep: Array(9).fill({ axis: "A", text: "q", score: 2 }) },
    { role: "ceo", round: 1, fixed, deep: [{ axis: "Z", text: "q", score: 2 }] },
  ];
  for (const body of cases) {
    const res = await call("/api/diagnose", { body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await res.json()).error, "bad_input");
  }
  const res = await call("/api/coach", { body: { role: "leader", question: "q", reply: "あ".repeat(801), fixed } });
  assert.equal(res.status, 400);
});

test("回数制限にかかったら 429", async () => {
  const limited = { ...env, LIMITER: { limit: async () => ({ success: false }) } };
  const res = await worker.fetch(
    new Request("https://w.example/api/diagnose", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }),
    limited,
  );
  assert.equal(res.status, 429);
});

test("1日の全体上限を超えたら 503", async () => {
  const store = new Map([[`calls:${new Date().toISOString().slice(0, 10)}`, "300"]]);
  const kv = { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) };
  const res = await worker.fetch(
    new Request("https://w.example/api/diagnose", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }),
    { ...env, STATS: kv },
  );
  assert.equal(res.status, 503);
});

test("stats は回数だけを返す", async () => {
  const res = await call("/api/stats", { method: "GET" });
  const data = await res.json();
  assert.deepEqual(Object.keys(data).sort(), [
    "completion_rate", "returning_rate", "rounds_completed", "rounds_returning", "rounds_started",
    "step_done", "step_done_rate", "step_not_done",
  ]);
});
