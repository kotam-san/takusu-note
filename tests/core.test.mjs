// 実行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeSinceFirst, compareScores, decodePairCode, emptyStore, encodePairCode,
  seriesByAxis, stepDoneRate, validateStore,
} from "../docs/core.js";
import { QUESTIONS } from "../docs/questions.js";

const round = (n, scores, extra = {}) => ({ round: n, date: "2026-10-15", scores, step: "一歩", step_done: null, ...extra });

test("照合コードは往復できる", () => {
  const code = encodePairCode("ceo", { A: 3, B: 2, C: 4, D: 1 });
  assert.equal(code, "TN1-C-3241");
  assert.deepEqual(decodePairCode(code), { role: "ceo", scores: { A: 3, B: 2, C: 4, D: 1 } });
  assert.deepEqual(decodePairCode(" tn1-l-1111 "), { role: "leader", scores: { A: 1, B: 1, C: 1, D: 1 } });
});

test("照合コードの形が違えば null", () => {
  for (const bad of ["", "TN1-C-325", "TN1-C-3250", "TN2-C-3241", "TN1-X-3241", null, "<script>"]) {
    assert.equal(decodePairCode(bad), null, String(bad));
  }
  assert.throws(() => encodePairCode("ceo", { A: 5, B: 2, C: 4, D: 1 }));
  assert.throws(() => encodePairCode("boss", { A: 1, B: 2, C: 4, D: 1 }));
});

test("ずれは自分−相手", () => {
  const rows = compareScores({ A: 3, B: 1, C: 2, D: 4 }, { A: 1, B: 1, C: 4, D: 4 });
  assert.deepEqual(rows.map((r) => r.gap), [2, 0, -2, 0]);
});

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
