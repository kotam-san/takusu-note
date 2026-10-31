// 実行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  changeSinceFirst, clipLesson, draftMatches, emptyStore, roundSummary, seriesByAxis, stepDoneRate, stepMiss, validateStore,
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

test("やれなかった理由：やれなかったときだけ、候補の理由と1行の一言を持つ", () => {
  assert.deepEqual(stepMiss(false, "time", "  忙しくて\n後回し  "), { reason: "time", note: "忙しくて 後回し" });
  assert.deepEqual(stepMiss(false, "", ""), {});
  assert.deepEqual(stepMiss(false, "no_scene"), { reason: "no_scene" });
  assert.deepEqual(stepMiss(false, null, "一言だけ"), { note: "一言だけ" });
  assert.deepEqual(stepMiss(false, "money", "x"), { note: "x" }); // 候補にない理由は持たない
  assert.equal(stepMiss(false, null, "あ".repeat(100)).note.length, 80);
  assert.deepEqual(stepMiss(true, "time", "x"), {}); // やれた・未確認なら捨てる
  assert.deepEqual(stepMiss(null, "time", "x"), {});
});

test("記録の検証：理由と一言は、やれなかった回にだけ・候補と長さの内で通す", () => {
  const r = (extra) => ({ ...emptyStore(), rounds: [round(1, { A: 1, B: 2, C: 3, D: 4 }, extra)] });
  for (const ok of [
    { step_done: false, step_reason: "time", step_note: "後回し" },
    { step_done: false, step_reason: "other" },
    { step_done: false, step_note: "一言だけ" },
    { step_done: false },
    { step_done: true },
  ]) assert.ok(validateStore(r(ok)), JSON.stringify(ok));
  for (const bad of [
    { step_done: true, step_reason: "time" },
    { step_done: null, step_note: "x" },
    { step_done: false, step_reason: "money" },
    { step_done: false, step_note: "あ".repeat(81) },
    { step_done: false, step_note: "改行\nあり" },
    { step_done: false, step_note: 3 },
    { step_done: false, step_reason: ["time"] }, // 配列はキーの文字に化けるので断る
    { step_done: false, step_reason: { toString: null } },
  ]) assert.equal(validateStore(r(bad)), null, JSON.stringify(bad));
});

test("まとめ：前回の一歩と結果は前の回から、今週の一歩はその回から取り、選んだ項目だけ入れる", () => {
  const rounds = [
    round(1, { A: 1, B: 2, C: 3, D: 4 }, { step: "朝会を任せる", step_done: false, step_reason: "no_scene", step_note: "出張が続いた" }),
    round(2, { A: 2, B: 2, C: 3, D: 1 }, { date: "2026-11-09", step: "見積りを任せる", lesson: { title: "任せる範囲の線引き", body: "本文" } }),
  ];
  const extra = { concern: "会議で\n決めきれない", concern_kind: "scope", reply: "選んだ候補：a\n補足：b" };
  const base = roundSummary("社長", rounds, 1, { step: true }, extra);
  assert.equal(base, [
    "託すノート｜社長・2回目（2026-11-09）",
    "前回の一歩：朝会を任せる → やれなかった（その場面が来なかった）",
    "今週の一歩：見積りを任せる",
  ].join("\n"));
  const all = roundSummary("社長", rounds, 1, { step: true, note: true, scores: true, lesson: true, concern: true, reply: true }, extra);
  assert.match(all, /\n　ひとこと：出張が続いた\n/);
  assert.match(all, /4つの軸（1〜4）：任せる・任される 2／社長がいなくても決まるか 2／言われる前に動くか 3／数字と方向の共有 1/);
  assert.match(all, /今日の学び：任せる範囲の線引き/);
  assert.match(all, /いちばん引っかかっていること：会議で \/ 決めきれない（中身：どこまで任せるかの線引き）/);
  assert.match(all, /3分コーチングでの答え：選んだ候補：a \/ 補足：b/);
  assert.doesNotMatch(all, /本文/);
  // 一言だけ選んでも、一歩を外せば前回の行ごと出さない
  assert.doesNotMatch(roundSummary("社長", rounds, 1, { note: true }, extra), /ひとこと|前回/);
});

test("まとめ：1回目・結果が未確認・学びや引っかかりのない回でも欠けずに作る", () => {
  const first = [round(1, { A: 1, B: 2, C: 3, D: 4 }, { step: "朝会を任せる" })];
  assert.equal(roundSummary("幹部", first, 0, { step: true, lesson: true, concern: true }, {}),
    "託すノート｜幹部・1回目（2026-10-15）\n今週の一歩：朝会を任せる");
  const unchecked = [round(1, { A: 1, B: 1, C: 1, D: 1 }, { step: "x" }), round(2, { A: 1, B: 1, C: 1, D: 1 }, { step: "y" })];
  assert.match(roundSummary("幹部", unchecked, 1, { step: true }), /前回の一歩：x → まだ確かめていない/);
  const done = [round(1, { A: 1, B: 1, C: 1, D: 1 }, { step: "x", step_done: true }), round(2, { A: 1, B: 1, C: 1, D: 1 }, { step: "y" })];
  assert.match(roundSummary("幹部", done, 1, { step: true, note: true }), /前回の一歩：x → やれた\n今週の一歩：y$/);
});
