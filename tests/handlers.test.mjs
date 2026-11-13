// 3つの道の中身（worker/src/handlers.js）の試験。偽の AI 関数で、渡す中身と数え方を確かめる。
// 公開の中継と手元の入口が同じ中身を使うことの確かめ。実行：node --test tests/handlers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError, OutputError, makeHandlers } from "../worker/src/handlers.js";
import { COACH_SCHEMA, DIAGNOSE_SCHEMA, REFLECT_SCHEMA, START_SCHEMA, coachSystem, diagnoseSystem, reflectSystem, startSystem } from "../worker/src/prompts.js";

const qs = ["A", "A", "B", "B", "C", "D"].map((axis) => ({ axis, text: "q", because: "b" }));
const qs3 = ["A", "B", "C"].map((axis) => ({ axis, text: "q", because: "b" })); // 1回目は深掘り3問
const ex = { A: "a", B: "b", C: "c", D: "d" };
const OUT = {
  start: { next_questions: qs3, fixed_examples: ex },
  diagnose: {
    summary: "s", axis_notes: [1, 2, 3, 4], coaching_question: "q", coaching_choices: ["a", "b"],
    lesson: { check: { question: "どれに近いですか", choices: ["1", "2", "3"], follow_ups: ["f1", "f2", "f3"] } },
  },
  coach: { reflection: "r", step_options: ["一歩1", "一歩2", "一歩3"], next_questions: qs, fixed_examples: ex },
  reflect: { organized: { events: ["出来事"], did: ["やったこと"], insights: ["気づき"] }, reply: "受け止め", step_options: ["一歩1", "一歩2", "一歩3"] },
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

test("3分コーチング：一歩の候補が4つ返っても、空でない先頭の3つに切って通す。足りなければ通さない", async () => {
  const body = { role: "ceo", question: "q", reply: "r", fixed };
  const run = async (step_options) => {
    const { handlers, counted } = setup({ ...OUT.coach, step_options });
    return { out: await handlers["/api/coach"](body).catch((e) => e), counted };
  };
  let r = await run(["a", "b", "c", "d"]);
  assert.deepEqual(r.out.step_options, ["a", "b", "c"]);
  assert.deepEqual(r.counted, ["rounds_completed"]);
  r = await run(["a", " ", "b", "c", "d"]);
  assert.deepEqual(r.out.step_options, ["a", "b", "c"]);
  r = await run(["a", "b"]);
  assert.ok(r.out instanceof OutputError);
  assert.deepEqual(r.counted, []);
  r = await run(["a", "", "b", " "]);
  assert.ok(r.out instanceof OutputError);
  r = await run("a, b, c");
  assert.ok(r.out instanceof OutputError);
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
    assert.match(sent[0].content, /<concern_kind>\n関係・気持ちの行き違い\n<\/concern_kind>/, `${path} 文章なしでも選んだ中身は渡す`);
    assert.match(sent[0].content, /（記入なし）/);
    const none = setup(out);
    await none.handlers[path]({ ...body, concern: "", concern_kind: "" });
    assert.doesNotMatch(none.sent[0].content, /concern_kind/, `${path} 文章も中身もなければ渡さない`);
    await assert.rejects(handlers[path]({ ...body, concern: "x", concern_kind: "money" }), InputError);
    await assert.rejects(handlers[path]({ ...body, concern: "x", concern_kind: 3 }), InputError);
  }
});

test("1回目の問い：深掘りは3問だけ通し、選んだ引っかかりの中身は文章がなくても渡す", async () => {
  const { handlers, sent } = setup(OUT.start);
  await handlers["/api/start"]({ role: "ceo", profile, concern: "", concern_kind: "scope" });
  assert.match(sent[0].content, /<concern_kind>\nどこまで任せるかの線引き\n<\/concern_kind>/);
  assert.match(sent[0].content, /（記入なし）/);
  const plain = setup(OUT.start);
  await plain.handlers["/api/start"]({ role: "ceo", profile });
  assert.doesNotMatch(plain.sent[0].content, /concern_kind/);
  await assert.rejects(handlers["/api/start"]({ role: "ceo", profile, concern_kind: "money" }), InputError);
  for (const bad of [qs, qs3.slice(1), []]) {
    const { handlers: h } = setup({ next_questions: bad, fixed_examples: ex });
    await assert.rejects(h["/api/start"]({ role: "ceo", profile }), OutputError);
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

// ---------------------------------------------------------------- 振り返りだけの回

test("振り返り：文と前回の一歩とこれまでを渡し、rounds_short と一歩の結果を数える", async () => {
  const { handlers, sent, counted } = setup(OUT.reflect);
  const out = await handlers["/api/reflect"]({ role: "ceo", round: 3, text: "  月曜に朝会を任せた  ", prev_step: { text: "朝会を任せる", done: false, reason: "time" }, profile });
  assert.equal(sent[0].system, reflectSystem("ceo"));
  assert.equal(sent[0].schema, REFLECT_SCHEMA);
  assert.equal(sent[0].maxTokens, 3000);
  assert.match(sent[0].content, /<reflection>\n月曜に朝会を任せた\n<\/reflection>/);
  assert.match(sent[0].content, /回：3 回目/);
  assert.match(sent[0].content, /前回の一歩「朝会を任せる」→ やれなかった/);
  assert.match(sent[0].content, /<profile>/);
  assert.deepEqual(counted, ["rounds_short", "step_not_done"]);
  assert.deepEqual(out, OUT.reflect);
  const done = setup(OUT.reflect);
  await done.handlers["/api/reflect"]({ role: "leader", round: 2, text: "文", prev_step: { text: "a", done: true } });
  assert.deepEqual(done.counted, ["rounds_short", "step_done"]);
});

test("振り返り：空・空白だけ・2001字の文は InputError で、AI を呼ばない", async () => {
  const { handlers, sent } = setup(OUT.reflect);
  for (const text of ["", "   \n ", "x".repeat(2001), undefined]) {
    await assert.rejects(handlers["/api/reflect"]({ role: "ceo", round: 2, text }), InputError);
  }
  await assert.rejects(handlers["/api/reflect"]({ role: "ceo", round: 0, text: "文" }), InputError);
  assert.equal(sent.length, 0);
});

test("振り返り：候補が4つなら先頭3つ、整理が6件・81字なら切って通す。reply が空・候補が2つなら OutputError で数えない", async () => {
  const long = { ...OUT.reflect, step_options: ["a", "", "b", "c", "d"], organized: { events: ["x".repeat(81), "2", "3", "4", "5", "6"], did: [], insights: ["", "i"] } };
  const out = await setup(long).handlers["/api/reflect"]({ role: "ceo", round: 2, text: "文" });
  assert.deepEqual(out.step_options, ["a", "b", "c"]);
  assert.equal(out.organized.events.length, 5);
  assert.equal(out.organized.events[0], "x".repeat(80));
  assert.deepEqual(out.organized.insights, ["i"]);
  for (const bad of [{ ...OUT.reflect, reply: " " }, { ...OUT.reflect, step_options: ["a", "b"] }, { ...OUT.reflect, organized: null }]) {
    const { handlers, counted } = setup(bad);
    await assert.rejects(handlers["/api/reflect"]({ role: "ceo", round: 2, text: "文" }), OutputError);
    assert.deepEqual(counted, []);
  }
});

test("これまでの記録：ショート回の行は点数なしで通り、「振り返りの回」と気づきを1行添える。いつもの回で点数が無ければ InputError", async () => {
  const { handlers, sent } = setup(OUT.diagnose);
  const history = [
    { round: 1, date: "2026-11-01", scores: { A: 1, B: 2, C: 3, D: 4 }, step: "一歩1", step_done: true },
    { round: 2, date: "2026-11-05", kind: "short", step: "一歩2", step_done: false, step_reason: "time", insight: "気づきX" },
  ];
  await handlers["/api/diagnose"]({ role: "ceo", round: 3, fixed, deep: [], history });
  assert.match(sent[0].content, /- 2回目（2026-11-05）振り返りの回（点数なし）／一歩「一歩2」→ やれなかった（時間がとれなかった）\n　気づき：気づきX/);
  await assert.rejects(handlers["/api/diagnose"]({ role: "ceo", round: 3, fixed, deep: [], history: [{ ...history[1], kind: undefined }] }), InputError);
  await assert.rejects(handlers["/api/diagnose"]({ role: "ceo", round: 3, fixed, deep: [], history: [{ ...history[1], insight: "x".repeat(81) }] }), InputError);
});

test("今日の学び：確かめは正解の無い問い。選択肢3つと、それぞれの続けて考える問い3つがそろわなければ通さない（正解は持たない）", async () => {
  const lesson = (check) => ({ ...OUT.diagnose, lesson: { ...OUT.diagnose.lesson, check } });
  const ok = await setup(lesson({ question: "q", choices: ["a", "b", "c"], follow_ups: ["x", "y", "z"] })).handlers["/api/diagnose"]({ role: "ceo", round: 1, fixed, deep: [] });
  assert.equal(ok.lesson.check.answer_index, undefined);
  for (const check of [
    { question: "q", choices: ["a", "b", "c"], answer_index: 0, explanation: "e" }, // 前の正解つきの形
    { question: "q", choices: ["a", "b", "c"], follow_ups: ["x", "y"] },
    { question: "q", choices: ["a", "b", "c"], follow_ups: ["x", "", "z"] },
    { question: "", choices: ["a", "b", "c"], follow_ups: ["x", "y", "z"] },
  ]) {
    await assert.rejects(setup(lesson(check)).handlers["/api/diagnose"]({ role: "ceo", round: 1, fixed, deep: [] }), OutputError);
  }
  const schema = DIAGNOSE_SCHEMA.properties.lesson.properties.check;
  assert.deepEqual(schema.required, ["question", "choices", "follow_ups"]);
  assert.ok(!("answer_index" in schema.properties));
});

test("指示：学びは言い切らず、確かめは正解の無い問い。一歩の候補は提案として出す", () => {
  for (const role of ["ceo", "leader"]) {
    const d = diagnoseSystem(role);
    assert.match(d, /正解の無い問い/);
    assert.match(d, /follow_ups/);
    assert.doesNotMatch(d, /answer_index|理解を確かめる/);
    for (const s of [coachSystem(role), reflectSystem(role)]) assert.match(s, /あくまで提案/);
  }
});
