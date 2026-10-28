// 実行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  changeSinceFirst, clipLesson, draftMatches, emptyStore, seriesByAxis, stepDoneRate, validateStore,
} from "../docs/core.js";
import { QUESTIONS } from "../docs/questions.js";

const round = (n, scores, extra = {}) => ({ round: n, date: "2026-10-15", scores, step: "一歩", step_done: null, ...extra });

test("記録の検証：正しい形は通り、壊れた形は null", () => {
  const ok = { ...emptyStore(), rounds: [round(1, { A: 1, B: 2, C: 3, D: 4 })] };
  assert.equal(validateStore(ok), ok);
  assert.equal(validateStore(null), null);
  assert.equal(validateStore({ version: 2, rounds: [] }), null);
  assert.equal(validateStore({ version: 1, rounds: [round(1, { A: 0, B: 2, C: 3, D: 4 })] }), null);
  assert.equal(validateStore({ version: 1, rounds: [round(1, { A: 1, B: 2, C: 3, D: 4 }, { step: "x".repeat(81) })] }), null);
  assert.equal(validateStore({ version: 1, rounds: [], next_deep: [{ axis: "Z", text: "a" }] }), null);
});

test("記録の検証：次回の例（next_examples）は4軸そろった短い文だけ通す", () => {
  const ex = { A: "例：a", B: "例：b", C: "例：c", D: "例：d" };
  const ok = { ...emptyStore(), next_examples: ex };
  assert.equal(validateStore(ok), ok);
  const old = { version: 1, rounds: [], next_deep: null }; // 例を持たない前からの記録も通る
  assert.equal(validateStore(old), old);
  assert.equal(validateStore({ ...ok, next_examples: { A: "例" } }), null);
  assert.equal(validateStore({ ...ok, next_examples: { ...ex, D: "x".repeat(121) } }), null);
  assert.equal(validateStore({ ...ok, next_examples: "例" }), null);
});

test("問い：推移を見る4問には、立場ごとに1回目用の例がそろっている", () => {
  for (const role of ["ceo", "leader"]) {
    for (const k of ["A", "B", "C", "D"]) {
      assert.match(QUESTIONS[role].examples[k], /^例：/, `${role}.${k}`);
      assert.ok(QUESTIONS[role].examples[k].length <= 120);
    }
  }
});

test("推移：系列・1回目からの変化・一歩をやれた率", () => {
  const rounds = [
    round(1, { A: 1, B: 2, C: 2, D: 3 }, { step_done: true }),
    round(2, { A: 2, B: 2, C: 3, D: 3 }, { step_done: false }),
    round(3, { A: 3, B: 1, C: 3, D: 4 }),
  ];
  assert.deepEqual(seriesByAxis(rounds).A.map((p) => p.value), [1, 2, 3]);
  assert.deepEqual(changeSinceFirst(rounds), { A: 2, B: -1, C: 1, D: 1 });
  assert.equal(stepDoneRate(rounds), 50);
  assert.equal(changeSinceFirst(rounds.slice(0, 1)), null);
  assert.equal(stepDoneRate([round(1, { A: 1, B: 1, C: 1, D: 1 })]), null);
});

test("日付：手元の時計で切る（日本の朝・月末・年末に前日にならない）", () => {
  // 試験は TZ=Asia/Tokyo で回す（下の child で確かめる）
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { localDate } from ${JSON.stringify(new URL("../docs/core.js", import.meta.url).href)};
    console.log([
      localDate(new Date("2026-10-27T23:50:00Z")),
      localDate(new Date("2026-10-31T15:30:00Z")),
      localDate(new Date("2026-12-31T15:00:00Z")),
      localDate(new Date("2026-10-28T14:59:00Z")),
    ].join(","));
  `], { env: { ...process.env, TZ: "Asia/Tokyo" } }).toString().trim();
  assert.equal(out, "2026-10-28,2026-11-01,2027-01-01,2026-10-28");
});

test("学び：形を確かめ、長すぎる題と本文は切ってから記録に入れる（読み込み直しても壊れない）", () => {
  assert.equal(clipLesson(null), null);
  assert.equal(clipLesson({ title: 1, body: "b" }), null);
  const long = clipLesson({ title: "題".repeat(80), body: "本".repeat(2000), check: {} });
  assert.deepEqual(Object.keys(long), ["title", "body"]);
  assert.equal(long.title.length, 40);
  assert.equal(long.body.length, 600);
  const store = { ...emptyStore(), rounds: [round(1, { A: 1, B: 2, C: 3, D: 4 }, { lesson: long })] };
  assert.ok(validateStore(JSON.parse(JSON.stringify(store))));
  assert.ok(validateStore({ ...emptyStore(), rounds: [round(1, { A: 1, B: 2, C: 3, D: 4 })] })); // 学びのない古い記録
  for (const bad of [{ title: "あ".repeat(41), body: "b" }, { title: "t", body: "あ".repeat(601) }, { title: "t" }, "学び"]) {
    assert.equal(validateStore({ ...emptyStore(), rounds: [round(1, { A: 1, B: 2, C: 3, D: 4 }, { lesson: bad })] }), null, JSON.stringify(bad));
  }
});

test("途中の回：次の回で同じ深掘りのときだけ開き直す（保存済みの回・問いが変わった回・壊れた下書きは開かない）", () => {
  const deep = ["問い1", "問い2"];
  const rounds = [round(1, { A: 1, B: 2, C: 3, D: 4 })];
  const quiz = { round: 2, stage: "quiz", deep_texts: deep, quiz: {} };
  assert.equal(draftMatches(quiz, rounds, deep), true);
  assert.equal(draftMatches(quiz, [...rounds, round(2, { A: 1, B: 1, C: 1, D: 1 })], deep), false); // 保存した後
  assert.equal(draftMatches(quiz, [], deep), false);
  assert.equal(draftMatches(quiz, rounds, ["問い1", "別の問い"]), false);
  assert.equal(draftMatches({ ...quiz, stage: "other" }, rounds, deep), false);
  assert.equal(draftMatches(null, rounds, deep), false);
  assert.equal(draftMatches("x", rounds, deep), false);
  assert.equal(draftMatches({ ...quiz, stage: "diagnosis" }, rounds, deep), false); // 見立てがない
  assert.equal(draftMatches({ ...quiz, stage: "diagnosis", current: { diagnosis: {} } }, rounds, deep), true);
  assert.equal(draftMatches({ ...quiz, stage: "steps", current: { diagnosis: {} } }, rounds, deep), false);
  assert.equal(draftMatches({ ...quiz, stage: "steps", current: { diagnosis: {}, coaching: { step_options: [] } } }, rounds, deep), true);
});
