// 3つの道の中身（worker/src/handlers.js）の試験。偽の AI 関数で、渡す中身と数え方を確かめる。
// 公開の中継と手元の入口が同じ中身を使うことの確かめ。実行：node --test tests/handlers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError, OutputError, makeHandlers } from "../worker/src/handlers.js";
import { COACH_SCHEMA, DIAGNOSE_SCHEMA, START_SCHEMA, coachSystem, diagnoseSystem, startSystem } from "../worker/src/prompts.js";

const qs = ["A", "A", "B", "B", "C", "D"].map((axis) => ({ axis, text: "q", because: "b" }));
const ex = { A: "a", B: "b", C: "c", D: "d" };
const OUT = {
  start: { next_questions: qs, fixed_examples: ex },
  diagnose: {
    summary: "s", axis_notes: [1, 2, 3, 4], coaching_question: "q", coaching_choices: ["a", "b"],
    lesson: { check: { choices: ["1", "2", "3"], answer_index: 0 } },
  },
  coach: { reflection: "r", step_options: [1, 2, 3], next_questions: qs, fixed_examples: ex },
};

function setup(out) {
  const sent = [];
  const counted = [];
  const handlers = makeHandlers({
    ai: async (system, content, schema, maxTokens) => (sent.push({ system, content, schema, maxTokens }), out),
    count: async (name) => counted.push(name),
  });
  return { handlers, sent, counted };
}

const fixed = Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, { text: "問い" + k, score: 2 }]));
const profile = { employees: "6-20", years: "1-3", industry: "other", industry_other: "印刷" };

test("1回目の問い：指示・形・長さとプロフィールを渡し、成功したら数える", async () => {
  const { handlers, sent, counted } = setup(OUT.start);
  await handlers["/api/start"]({ role: "ceo", profile, concern: "悩み" });
  assert.equal(sent[0].system, startSystem("ceo"));
  assert.equal(sent[0].schema, START_SCHEMA);
  assert.equal(sent[0].maxTokens, 3000);
  assert.match(sent[0].content, /その他（印刷）/);
  assert.match(sent[0].content, /悩み/);
  assert.deepEqual(counted, ["rounds_profiled"]);
});

test("診断：回・前回の一歩に応じて数える", async () => {
  const { handlers, sent, counted } = setup(OUT.diagnose);
  await handlers["/api/diagnose"]({ role: "leader", round: 2, fixed, deep: [], prev_step: { text: "x", done: true } });
  assert.equal(sent[0].system, diagnoseSystem("leader"));
  assert.equal(sent[0].schema, DIAGNOSE_SCHEMA);
  assert.equal(sent[0].maxTokens, 6000);
  assert.match(sent[0].content, /回：2 回目/);
  assert.match(sent[0].content, /前回の一歩「x」→ やれた/);
  assert.deepEqual(counted, ["rounds_started", "rounds_returning", "step_done"]);
});

test("コーチング：問いと答えを渡す", async () => {
  const { handlers, sent, counted } = setup(OUT.coach);
  await handlers["/api/coach"]({ role: "ceo", question: "問いQ", reply: "答えR", fixed });
  assert.equal(sent[0].system, coachSystem("ceo"));
  assert.equal(sent[0].schema, COACH_SCHEMA);
  assert.equal(sent[0].maxTokens, 4000);
  assert.match(sent[0].content, /<question>問いQ<\/question>/);
  assert.match(sent[0].content, /答えR/);
  assert.deepEqual(counted, ["rounds_completed"]);
});

test("出力の形が違えば OutputError で、数えない", async () => {
  for (const [p, body] of [
    ["/api/start", { role: "ceo", profile }],
    ["/api/diagnose", { role: "ceo", round: 1, fixed, deep: [] }],
    ["/api/coach", { role: "ceo", question: "q", reply: "r", fixed }],
  ]) {
    const { handlers, counted } = setup({ wrong: true });
    await assert.rejects(handlers[p](body), OutputError, p);
    assert.deepEqual(counted, [], p);
  }
});

test("入力が違えば InputError で、AI を呼ばない", async () => {
  const { handlers, sent } = setup(OUT.start);
  await assert.rejects(handlers["/api/start"]({ role: "ceo", profile: { employees: "x" } }), InputError);
  await assert.rejects(handlers["/api/diagnose"]({ role: "ceo", round: 0, fixed, deep: [] }), InputError);
  assert.equal(sent.length, 0);
});
