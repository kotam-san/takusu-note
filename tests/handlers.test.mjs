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

test("引っかかりの中身：選んだものを渡し、未選択は「まだ分からない」、本文なしなら渡さない、不正値は止める", async () => {
  const base = {
    "/api/diagnose": { role: "ceo", round: 1, fixed, deep: [] },
    "/api/coach": { role: "ceo", question: "q", reply: "r", fixed },
  };
  for (const [path, body] of Object.entries(base)) {
    const out = path === "/api/coach" ? OUT.coach : OUT.diagnose;
    const cases = [
      [{ concern: "事務担当との関係", concern_kind: "relation" }, /<concern_kind>\n関係・気持ちの行き違い\n<\/concern_kind>/],
      [{ concern: "事務担当との関係", concern_kind: "unknown" }, /<concern_kind>\nまだ分からない\n<\/concern_kind>/],
      [{ concern: "事務担当との関係", concern_kind: "" }, /<concern_kind>\nまだ分からない\n<\/concern_kind>/],
      [{ concern: "事務担当との関係" }, /<concern_kind>\nまだ分からない\n<\/concern_kind>/],
    ];
    for (const [extra, re] of cases) {
      const { handlers, sent } = setup(out);
      await handlers[path]({ ...body, ...extra });
      assert.match(sent[0].content, re, `${path} ${JSON.stringify(extra)}`);
    }
    const { handlers, sent } = setup(out);
    await handlers[path]({ ...body, concern: "", concern_kind: "relation" });
    assert.doesNotMatch(sent[0].content, /concern_kind/, `${path} 本文なし`);
    assert.match(sent[0].content, /（記入なし）/);
    await assert.rejects(handlers[path]({ ...body, concern: "x", concern_kind: "money" }), InputError);
    await assert.rejects(handlers[path]({ ...body, concern: "x", concern_kind: 3 }), InputError);
  }
});

test("1回目：従業員が数人の社長には、推移4問を「幹部」なしで渡す", async () => {
  const { handlers, sent } = setup(OUT.start);
  await handlers["/api/start"]({ role: "ceo", profile: { employees: "1-5", years: "3-10", industry: "service", industry_other: "" } });
  assert.match(sent[0].content, /問題が起きたとき、仕事を任せている人が/);
  assert.match(sent[0].content, /会社の数字と今後の方向を、仕事を任せている人と/);
});

test("前回の一歩：やれなかった理由と一言を渡し、やれたときは捨て、候補にない理由と長すぎる一言は止める", async () => {
  const base = {
    "/api/diagnose": [{ role: "ceo", round: 2, fixed, deep: [] }, OUT.diagnose],
    "/api/coach": [{ role: "ceo", question: "q", reply: "r", fixed }, OUT.coach],
  };
  for (const [path, [body, out]] of Object.entries(base)) {
    let { handlers, sent } = setup(out);
    await handlers[path]({ ...body, prev_step: { text: "朝会を任せる", done: false, reason: "no_scene", note: "出張が\n続いた" } });
    assert.match(sent[0].content, /前回の一歩「朝会を任せる」→ やれなかった（理由：その場面が来なかった／ひとこと：出張が 続いた）/, path);

    ({ handlers, sent } = setup(out));
    await handlers[path]({ ...body, prev_step: { text: "朝会を任せる", done: false } });
    assert.match(sent[0].content, /前回の一歩「朝会を任せる」→ やれなかった\n/, path);

    ({ handlers, sent } = setup(out));
    await handlers[path]({ ...body, prev_step: { text: "朝会を任せる", done: true, reason: "time", note: "x" } });
    assert.match(sent[0].content, /→ やれた\n/, path);
    assert.doesNotMatch(sent[0].content, /理由：|ひとこと：/, path);

    await assert.rejects(handlers[path]({ ...body, prev_step: { text: "x", done: false, reason: "money" } }), InputError, path);
    await assert.rejects(handlers[path]({ ...body, prev_step: { text: "x", done: false, note: "あ".repeat(81) } }), InputError, path);
    await assert.rejects(handlers[path]({ ...body, prev_step: { text: "x", done: false, reason: ["time"] } }), InputError, path);
    await assert.rejects(handlers[path]({ ...body, prev_step: { text: "x", done: false, reason: { toString: null } } }), InputError, path);
    await assert.rejects(handlers[path]({ ...body, concern: "x", concern_kind: { toString: null } }), InputError, path);
  }
});

test("これまでの記録：やれなかった回の理由だけを添え、やれた回の理由は捨てる", async () => {
  const { handlers, sent } = setup(OUT.diagnose);
  const h = (round, step_done, step_reason) => ({ round, date: "2026-11-01", scores: { A: 1, B: 2, C: 3, D: 4 }, step: "一歩" + round, step_done, step_reason });
  await handlers["/api/diagnose"]({ role: "ceo", round: 4, fixed, deep: [], history: [h(1, false, "heavy"), h(2, true, "time"), h(3, false)] });
  assert.match(sent[0].content, /一歩「一歩1」→ やれなかった（気が進まなかった・言い出しにくかった）/);
  assert.match(sent[0].content, /一歩「一歩2」→ やれた\n/);
  assert.match(sent[0].content, /一歩「一歩3」→ やれなかった\n/);
  await assert.rejects(handlers["/api/diagnose"]({ role: "ceo", round: 2, fixed, deep: [], history: [h(1, false, "money")] }), InputError);
});
