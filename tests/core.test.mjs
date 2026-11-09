// 実行：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  BACKUP_MAX_CHARS, answersFromQuiz, answersToQuiz, changeSinceFirst, clipLesson, deepForRound, diagnosisNotes, draftMatches, emptyAnswers, emptyStore, firstOpenStep, gapDays, homeNotes, lastMemo, makeBackup, memoEntries, memoOf,
  nudgeLines, nudgeToShow, outsideTalkSignals, quizOrder, readBackup, roundMemos, roundStartNotes, roundSummary, sampleAnswers, scoreOf, seriesByAxis, setMemo, setScore, stepDoneRate, stepMiss, trailingDone, validateStore,
} from "../docs/core.js";
import { CHEERS, CHEER_GAP_DAYS, DEEP_BY_ROUND, MEMO_FROM_ROUND, MEMO_MAX, QUESTIONS, SAMPLE } from "../docs/questions.js";

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

test("記録の検証：はじめに選んだ引っかかりの中身（first_concern_kind）は候補のキーだけ通す", () => {
  const ok = { ...emptyStore(), first_concern_kind: "scope" };
  assert.equal(validateStore(ok), ok);
  const old = { ...emptyStore() };
  delete old.first_concern_kind; // この項目を持たない前からの記録も通る
  assert.equal(validateStore(old), old);
  for (const bad of ["money", 3, { toString: null }, ["scope"]]) {
    assert.equal(validateStore({ ...emptyStore(), first_concern_kind: bad }), null, JSON.stringify(bad));
  }
});

test("まとめ：文章を書かず中身だけ選んだときは、中身だけ1行出す（「まだ分からない」は出さない）", () => {
  const rounds = [round(1, { A: 1, B: 2, C: 3, D: 4 }, { step: "朝会を任せる" })];
  assert.match(roundSummary("社長", rounds, 0, { concern: true }, { concern: "", concern_kind: "relation" }), /\n引っかかりの中身：関係・気持ちの行き違い$/);
  assert.doesNotMatch(roundSummary("社長", rounds, 0, { concern: true }, { concern: "", concern_kind: "unknown" }), /引っかかり/);
  assert.doesNotMatch(roundSummary("社長", rounds, 0, { concern: true }, { concern: "", concern_kind: { toString: null } }), /引っかかり/);
});

// ---------------------------------------------------------------- 一人で回りにくくなった合図（Issue #44）

const S = { A: 2, B: 2, C: 2, D: 2 };
const r = (n, extra) => round(n, S, extra);

test("合図：直近3回やれなかったで miss、途中に未確認があれば出ない", () => {
  const miss = [1, 2, 3].map((n) => r(n, { step_done: false }));
  assert.deepEqual(outsideTalkSignals(miss, "2026-10-16"), [{ kind: "miss" }]);
  const gapped = [r(1, { step_done: false }), r(2, { step_done: null }), r(3, { step_done: false })];
  assert.deepEqual(outsideTalkSignals(gapped, "2026-10-16"), []);
  assert.deepEqual(outsideTalkSignals(miss.slice(0, 2), "2026-10-16"), []);
});

test("合図：同じ種類が3回で same_kind、unknown と無い回は数えない", () => {
  const same = [1, 2, 3].map((n) => r(n, { concern_kind: "scope" }));
  assert.deepEqual(outsideTalkSignals(same, "2026-10-16"), [{ kind: "same_kind", concern_kind: "scope" }]);
  const unk = [1, 2, 3].map((n) => r(n, { concern_kind: "unknown" }));
  assert.deepEqual(outsideTalkSignals(unk, "2026-10-16"), []);
  const holes = [r(1, { concern_kind: "scope" }), r(2), r(3, { concern_kind: "scope" })];
  assert.deepEqual(outsideTalkSignals(holes, "2026-10-16"), []);
});

test("合図：21日以上空いたら gap、20日・壊れた日付・未来の日付では出ない", () => {
  const one = [r(1, { date: "2026-10-01" })];
  assert.deepEqual(outsideTalkSignals(one, "2026-10-22"), [{ kind: "gap", days: 21 }]);
  assert.deepEqual(outsideTalkSignals(one, "2026-10-21"), []);
  assert.deepEqual(outsideTalkSignals([r(1, { date: "2026-13-99" })], "2026-10-22"), []);
  assert.deepEqual(outsideTalkSignals(one, "2026-09-01"), []);
  assert.deepEqual(outsideTalkSignals([], "2026-10-22"), []);
});

test("合図：今までの記録（新しい欄なし）では出ず、記録も読める", () => {
  const old = { ...emptyStore(), rounds: [1, 2, 3].map((n) => r(n)) };
  delete old.outside_nudge;
  assert.equal(validateStore(old), old);
  assert.deepEqual(outsideTalkSignals(old.rounds, "2026-10-16"), []);
});

test("記録の検証：concern_kind と outside_nudge", () => {
  const ok = { ...emptyStore(), rounds: [r(1, { concern_kind: "way" })], outside_nudge: { round: 4, kinds: ["miss", "gap"] } };
  assert.equal(validateStore(ok), ok);
  assert.equal(validateStore({ ...ok, rounds: [r(1, { concern_kind: "" })] }), null);
  assert.equal(validateStore({ ...ok, rounds: [r(1, { concern_kind: "zzz" })] }), null);
  assert.equal(validateStore({ ...ok, outside_nudge: { round: 0, kinds: [] } }), null);
  assert.equal(validateStore({ ...ok, outside_nudge: { round: 2, kinds: ["boss"] } }), null);
  assert.equal(validateStore({ ...ok, outside_nudge: null }).outside_nudge, null);
});

test("案内：同じ合図は3回たつまで出さず、gap は毎回出す", () => {
  const sig = [{ kind: "miss" }, { kind: "gap", days: 30 }];
  assert.deepEqual(nudgeToShow(sig, null, 5), sig);
  assert.deepEqual(nudgeToShow(sig, { round: 4, kinds: ["miss"] }, 5), [{ kind: "gap", days: 30 }]);
  assert.deepEqual(nudgeToShow(sig, { round: 2, kinds: ["miss"] }, 5), sig);
});

test("案内の文面：合図ごとの1行", () => {
  assert.deepEqual(nudgeLines([{ kind: "same_kind", concern_kind: "scope" }, { kind: "gap", days: 23 }]), [
    "ここ3回、『どこまで任せるかの線引き』が引っかかりに挙がっています。",
    "前回から23日空きました。間が空くのは、一人で回すのが難しくなっている合図のこともあります。",
  ]);
  assert.match(nudgeLines([{ kind: "miss" }])[0], /^ここ3回、決めた一歩が形になりにくい状態が続いています。/);
});

test("案内：間が空いた合図も、同じ回の中では一度だけ", () => {
  const sig = [{ kind: "gap", days: 30 }];
  assert.deepEqual(nudgeToShow(sig, { round: 5, kinds: ["gap"] }, 5), []);
  assert.deepEqual(nudgeToShow(sig, { round: 4, kinds: ["gap"] }, 5), sig);
});

test("記録の検証：concern_kind が null の回は、無いのと同じに通す", () => {
  const s = { ...emptyStore(), rounds: [r(1, { concern_kind: null })] };
  assert.equal(validateStore(s), s);
  assert.deepEqual(outsideTalkSignals(s.rounds, "2026-10-16"), []);
});

// ---------------------------------------------------------------- 問いの答え（1問ずつ答える画面）

test("問いの順番：推移の4問 → 深掘り（最後の画面は含めない）", () => {
  const order = quizOrder(3);
  assert.equal(order.length, 7);
  assert.deepEqual(order.slice(0, 4), ["A", "B", "C", "D"].map((k) => ({ type: "fixed", k })));
  assert.deepEqual(order.slice(4), [0, 1, 2].map((i) => ({ type: "deep", i })));
  assert.equal(quizOrder(6).length, 10);
});

test("最初の未回答の問い：途中の問いから再開し、全部答えてあれば最後の画面", () => {
  const a = emptyAnswers();
  assert.equal(firstOpenStep(a, 3), 0);
  for (const [n, step] of quizOrder(3).entries()) {
    assert.equal(firstOpenStep(a, 3), n);
    setScore(a, step, 3);
    assert.equal(scoreOf(a, step), 3);
  }
  assert.equal(firstOpenStep(a, 3), 7); // 最後の画面
  a.deep[1] = undefined; // 飛ばした問いが先に開く（先へ進んでいても）
  assert.equal(firstOpenStep(a, 3), 5);
  assert.equal(firstOpenStep(emptyAnswers(), 6), 0);
});

test("下書きの形：fixed・deep・concern・kind は変えず、未回答は null", () => {
  const a = emptyAnswers();
  setScore(a, { type: "fixed", k: "B" }, 2);
  setScore(a, { type: "deep", i: 1 }, 4);
  a.concern = "ひとこと";
  assert.deepEqual(answersToQuiz(a, 3, "scope"), {
    fixed: { A: null, B: 2, C: null, D: null }, deep: [null, 4, null], concern: "ひとこと", kind: "scope",
  });
  assert.equal(answersToQuiz(a, 3, null).kind, ""); // 1回目で種類を選んでいなければ空
  a.kind = "info";
  assert.equal(answersToQuiz(a, 3).kind, "info");
});

test("下書きを読み戻す：書き出した形はそのまま戻り、壊れた値は捨てる", () => {
  const a = sampleAnswers(SAMPLE.ceo, 6, 2);
  const back = answersFromQuiz(answersToQuiz(a, 6), 6, 2);
  assert.deepEqual(back, a);

  const bad = { fixed: { A: 0, B: 5, C: "3", D: 2.5, X: 3 }, deep: [true, null, "x", 4], concern: 123, kind: "toString" };
  const got = answersFromQuiz(bad, 4, 2);
  assert.deepEqual(got.fixed, {}); // 範囲外・文字・小数は捨てる
  assert.deepEqual([0, 1, 2, 3].map((i) => got.deep[i] ?? null), [null, null, null, 4]); // 範囲内の4だけ残る
  assert.equal(got.concern, ""); // 文字でない文は捨てる
  assert.equal(got.kind, ""); // 知らない種類（継承された名前も）は捨てる
  for (const broken of [null, undefined, "x", 3, [], { fixed: "abc", deep: "xyz" }]) {
    assert.deepEqual(answersFromQuiz(broken, 3, 2), emptyAnswers(), String(broken));
  }
});

test("下書きを読み戻す：1回目は種類を読まず、前の版の文は下書きに無ければ残る", () => {
  const quiz = { fixed: { A: 1, B: 2, C: 3, D: 4 }, deep: [1, 2, 3], concern: "", kind: "scope" };
  assert.equal(answersFromQuiz(quiz, 3, 1).kind, ""); // 1回目の種類は、はじめの画面で記録に入っている
  assert.equal(answersFromQuiz(quiz, 3, 2).kind, "scope");
  const base = { ...emptyAnswers(), concern: "前の版で書いた文" };
  assert.equal(answersFromQuiz({ fixed: {}, deep: [] }, 3, 1, base).concern, "前の版で書いた文");
  assert.equal(answersFromQuiz({ concern: "書き直した" }, 3, 1, base).concern, "書き直した");
  assert.equal(base.concern, "前の版で書いた文"); // base は変えない
  assert.deepEqual(base.fixed, {});
});

test("回答例：全問の答えが入り、最後の画面へ進める。種類は2回目以降だけ入れる", () => {
  for (const role of ["ceo", "leader"]) {
    const s = SAMPLE[role];
    for (const n of [3, 6]) {
      const a = sampleAnswers(s, n, 2);
      assert.equal(firstOpenStep(a, n), 4 + n, `${role} ${n}`);
      assert.equal(a.concern, s.concern);
      assert.equal(a.kind, s.concern_kind);
    }
    assert.equal(sampleAnswers(s, 3, 1, { ...emptyAnswers(), kind: "info" }).kind, "info"); // 1回目は種類を触らない
  }
  const short = sampleAnswers({ ...SAMPLE.ceo, deep: [4] }, 3, 2);
  assert.deepEqual(short.deep, [4, 2, 2]); // 例が足りない問いは2
});

// ---------------------------------------------------------------- 回ごとの深掘りの数

test("深掘りの数：回を重ねるごとに1問ずつ増え、全体は5問から10問になる（推移の4問は毎回）", () => {
  const list = ["A", "A", "B", "B", "C", "D"].map((axis, i) => ({ axis, text: `問い${i}` }));
  const counts = [1, 2, 3, 4, 5, 6, 7, 20].map((r) => deepForRound(list, r).length);
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 6, 6]);
  assert.deepEqual(DEEP_BY_ROUND, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(counts.map((n) => 4 + n).slice(0, 6), [5, 6, 7, 8, 9, 10]);
});

test("深掘りの選び方：軸が偏らないよう、まだ出ていない軸を先に選び、list の並びのまま返す", () => {
  const list = ["A", "A", "B", "B", "C", "D"].map((axis, i) => ({ axis, text: `問い${i}` }));
  const texts = (r) => deepForRound(list, r).map((q) => q.text);
  assert.deepEqual(texts(1), ["問い0"]);
  assert.deepEqual(texts(2), ["問い0", "問い2"]); // A・B
  assert.deepEqual(texts(3), ["問い0", "問い2", "問い4"]); // A・B・C
  assert.deepEqual(texts(4), ["問い0", "問い2", "問い4", "問い5"]); // A〜D
  assert.deepEqual(texts(5), ["問い0", "問い1", "問い2", "問い4", "問い5"]); // 残りの A を足す
  assert.deepEqual(texts(6), list.map((q) => q.text));
  // 同じ軸ばかりでも、必要な数まで残りから足す
  const same = Array.from({ length: 6 }, (_, i) => ({ axis: "A", text: `同${i}` }));
  assert.deepEqual(deepForRound(same, 3).map((q) => q.text), ["同0", "同1", "同2"]);
  // 1回目に使う AI の3問（A・B・C）や、問いが足りないとき
  const three = ["A", "B", "C"].map((axis, i) => ({ axis, text: `初${i}` }));
  assert.deepEqual(deepForRound(three, 1).map((q) => q.text), ["初0"]);
  assert.equal(deepForRound(three, 5).length, 3);
  assert.deepEqual(deepForRound([], 3), []);
});

test("深掘りの数：回の値が壊れていても、1回目として扱う", () => {
  const list = ["A", "B", "C"].map((axis, i) => ({ axis, text: `問い${i}` }));
  for (const r of [0, -3, NaN, undefined, "x", 1.9]) assert.equal(deepForRound(list, r).length, 1, String(r));
});

// ---------------------------------------------------------------- 各問いのメモ（3回目から）

test("メモ：3回目から。書いたときだけ下書きと記録に入り、空の欄は持たない", () => {
  assert.equal(MEMO_FROM_ROUND, 3);
  const a = emptyAnswers();
  const fixedB = { type: "fixed", k: "B" };
  const deep1 = { type: "deep", i: 1 };
  assert.equal(memoOf(a, fixedB), "");
  assert.equal(answersToQuiz(a, 3).memos, undefined); // 書いていなければ、下書きの形は今まで通り
  assert.equal(roundMemos(a, [{ text: "q0" }, { text: "q1" }, { text: "q2" }]), null);
  setMemo(a, fixedB, "  口を出さずに待てた  ");
  setMemo(a, deep1, "朝会で伝えた");
  setMemo(a, { type: "deep", i: 2 }, "   "); // 空白だけは持たない
  assert.equal(memoOf(a, fixedB), "  口を出さずに待てた  ");
  assert.deepEqual(answersToQuiz(a, 3).memos, { fixed: { B: "  口を出さずに待てた  " }, deep: [null, "朝会で伝えた", null] });
  assert.deepEqual(roundMemos(a, [{ text: "q0" }, { text: "q1" }, { text: "q2" }]), {
    fixed: { B: "口を出さずに待てた" }, deep: [{ text: "q1", memo: "朝会で伝えた" }],
  });
  assert.equal(roundMemos({ ...a, memos: { fixed: { A: "あ".repeat(MEMO_MAX + 50) }, deep: [] } }, []).fixed.A.length, MEMO_MAX);
});

test("メモ：下書きから読み戻す（壊れた値は捨てる）。書き出した形はそのまま戻る", () => {
  const a = emptyAnswers();
  setMemo(a, { type: "fixed", k: "A" }, "メモA");
  setMemo(a, { type: "deep", i: 0 }, "メモd0");
  assert.deepEqual(answersFromQuiz(answersToQuiz(a, 2), 2, 3).memos, a.memos);
  const got = answersFromQuiz({ memos: { fixed: { A: 5, B: "ok", X: "軸なし", C: "あ".repeat(MEMO_MAX + 9) }, deep: [null, "d1", 7, "範囲外"] } }, 2, 3);
  assert.deepEqual(Object.keys(got.memos.fixed).sort(), ["B", "C"]);
  assert.equal(got.memos.fixed.C.length, MEMO_MAX);
  assert.equal(got.memos.deep[1], "d1");
  assert.equal(got.memos.deep[3], undefined); // 問いの数の外は読まない
  for (const broken of [null, undefined, "x", { memos: null }, { memos: "x" }, { memos: { fixed: "a", deep: "b" } }]) {
    assert.deepEqual(answersFromQuiz(broken, 3, 3).memos, { fixed: {}, deep: [] }, String(broken));
  }
});

test("メモ：記録に持てる形か確かめる（壊れていれば記録ごと読み込まない）", () => {
  const withMemos = (memos) => ({ ...emptyStore(), rounds: [round(1, { A: 1, B: 2, C: 3, D: 4 }, { memos })] });
  assert.ok(validateStore(withMemos(undefined))); // メモの無い古い記録
  assert.ok(validateStore(withMemos({ fixed: { A: "メモ", D: "あ".repeat(MEMO_MAX) }, deep: [{ text: "問い", memo: "メモ" }] })));
  assert.ok(validateStore(withMemos({ fixed: {}, deep: [] })));
  for (const bad of [
    null, "メモ", [], { fixed: {}, deep: "x" }, { fixed: "x", deep: [] }, { fixed: { A: 3 }, deep: [] }, { fixed: { X: "軸なし" }, deep: [] },
    { fixed: { A: "あ".repeat(MEMO_MAX + 1) }, deep: [] }, { fixed: {}, deep: [{ text: "問い" }] }, { fixed: {}, deep: [null] },
    { fixed: {}, deep: Array.from({ length: 9 }, () => ({ text: "q", memo: "m" })) }, { fixed: {}, deep: [{ text: "あ".repeat(121), memo: "m" }] },
  ]) assert.equal(validateStore(withMemos(bad)), null, JSON.stringify(bad)?.slice(0, 60));
});

test("前に書いたメモ：同じ軸のいちばん最近のもの（無ければ null）", () => {
  const rounds = [
    round(1, { A: 1, B: 1, C: 1, D: 1 }),
    round(3, { A: 1, B: 1, C: 1, D: 1 }, { memos: { fixed: { A: "3回目のA", B: "3回目のB" }, deep: [] } }),
    round(4, { A: 1, B: 1, C: 1, D: 1 }, { memos: { fixed: { A: "4回目のA" }, deep: [] } }),
    round(5, { A: 1, B: 1, C: 1, D: 1 }),
  ];
  assert.deepEqual(lastMemo(rounds, "A"), { round: 4, memo: "4回目のA" });
  assert.deepEqual(lastMemo(rounds, "B"), { round: 3, memo: "3回目のB" });
  assert.equal(lastMemo(rounds, "C"), null);
  assert.equal(lastMemo([], "A"), null);
});

test("これまでのメモ：新しい回が先。1つの回の中は、推移の4問（A〜D）→ 深掘り。メモの無い回は含めない", () => {
  const rounds = [
    round(1, { A: 1, B: 1, C: 1, D: 1 }),
    round(2, { A: 1, B: 1, C: 1, D: 1 }, { memos: { fixed: { D: "Dのメモ", A: "Aのメモ" }, deep: [{ text: "深掘りの問い", memo: "深掘りのメモ" }] } }),
    round(3, { A: 1, B: 1, C: 1, D: 1 }, { memos: { fixed: {}, deep: [] } }),
    round(4, { A: 1, B: 1, C: 1, D: 1 }, { memos: { fixed: { B: "Bのメモ" }, deep: [] } }),
  ];
  const got = memoEntries(rounds);
  assert.deepEqual(got.map((e) => e.round), [4, 2]);
  assert.deepEqual(got[0].items, [{ label: "社長がいなくても決まるか", memo: "Bのメモ" }]);
  assert.deepEqual(got[1].items.map((i) => i.memo), ["Aのメモ", "Dのメモ", "深掘りのメモ"]);
  assert.equal(got[1].items[2].label, "深掘りの問い");
  assert.equal(got[1].date, "2026-10-15");
  assert.deepEqual(memoEntries([]), []);
  assert.deepEqual(memoEntries([round(1, { A: 1, B: 1, C: 1, D: 1 })]), []);
});

// ---------------------------------------------------------------- 記録のバックアップ

test("バックアップ：書き出して読み込むと、記録（点数・一歩・メモ・学び・プロフィール）がそのまま戻る", () => {
  const store = {
    ...emptyStore(),
    rounds: [
      round(1, { A: 1, B: 2, C: 3, D: 4 }, { lesson: { title: "学び", body: "本文" } }),
      round(2, { A: 2, B: 2, C: 2, D: 2 }, { step_done: false, step_reason: "time", step_note: "忙しかった", memos: { fixed: { A: "メモ" }, deep: [{ text: "問い", memo: "深掘りのメモ" }] } }),
    ],
    next_deep: [{ axis: "A", text: "次の問い", because: "理由" }],
    profile: { employees: "1-5", years: "<1", industry: "mfg" },
  };
  const backup = makeBackup("ceo", store, new Date(2026, 10, 5, 9, 0));
  assert.deepEqual({ app: backup.app, version: backup.version, role: backup.role, exported_on: backup.exported_on }, { app: "takusu-note", version: 1, role: "ceo", exported_on: "2026-11-05" });
  const back = readBackup(JSON.stringify(backup, null, 1), "ceo");
  assert.deepEqual(back.store, store);
  assert.equal(back.error, undefined);
});

test("バックアップ：読み込めないファイルは、理由を分けて断る（託すノートのものでない・壊れた・別の立場・形が違う・大きすぎる）", () => {
  const good = makeBackup("ceo", { ...emptyStore(), rounds: [round(1, { A: 1, B: 1, C: 1, D: 1 })] });
  const err = (text, role = "ceo") => readBackup(text, role);
  assert.deepEqual(err("{壊れた"), { error: "format" });
  assert.deepEqual(err(""), { error: "format" });
  assert.deepEqual(err("[]"), { error: "format" });
  assert.deepEqual(err("null"), { error: "format" });
  assert.deepEqual(err(JSON.stringify({ ...good, app: "other" })), { error: "format" });
  assert.deepEqual(err(JSON.stringify({ ...good, role: "admin" })), { error: "format" });
  assert.deepEqual(err(JSON.stringify(good), "leader"), { error: "role", fileRole: "ceo" }); // 別の立場には入れない
  assert.deepEqual(err(JSON.stringify({ ...good, store: null })), { error: "shape" });
  assert.deepEqual(err(JSON.stringify({ ...good, store: { ...good.store, version: 99 } })), { error: "shape" });
  assert.deepEqual(err(JSON.stringify({ ...good, store: { ...good.store, rounds: [{ round: 1 }] } })), { error: "shape" });
  assert.deepEqual(err(JSON.stringify({ ...good, store: { ...good.store, rounds: [round(1, { A: 9, B: 1, C: 1, D: 1 })] } })), { error: "shape" }); // 点が範囲の外
  assert.deepEqual(err("x".repeat(BACKUP_MAX_CHARS + 1)), { error: "size" });
  assert.deepEqual(err(undefined), { error: "size" });
  assert.ok(err(JSON.stringify(good)).store); // 元のファイルは読める
});

test("バックアップ：読み込んだ記録に、余計な項目は入らない（形を確かめた記録だけを返す）", () => {
  const good = makeBackup("leader", { ...emptyStore(), rounds: [round(1, { A: 1, B: 1, C: 1, D: 1 })] });
  const got = readBackup(JSON.stringify({ ...good, extra: "x", __proto__: { admin: true } }), "leader");
  assert.equal(got.store.rounds.length, 1);
  assert.equal(got.extra, undefined);
  assert.equal(Object.hasOwn(got, "admin"), false);
});

// ---------------------------------------------------------------- 節目のはげまし

const done = (n, extra = {}) => ({ ...round(n, { A: 2, B: 2, C: 2, D: 2 }), step_done: true, ...extra });

test("はげましの言葉：差し込みは決めた名前だけで、空でなく、長すぎない", () => {
  const known = new Set(["rate", "axis", "from", "to", "n", "round", "total"]);
  for (const [name, text] of Object.entries(CHEERS)) {
    assert.ok(text.length >= 10 && text.length <= 70, `${name}: ${text.length}字`);
    for (const m of text.matchAll(/\{(\w+)\}/g)) assert.ok(known.has(m[1]), `${name}: {${m[1]}}`);
  }
});

test("一歩が続いた回数と、日付のあき", () => {
  assert.equal(trailingDone([]), 0);
  assert.equal(trailingDone([done(1), done(2, { step_done: false }), done(3), done(4)]), 2);
  assert.equal(trailingDone([done(1), done(2), done(3, { step_done: null })]), 0);
  assert.equal(gapDays("2026-10-01", "2026-10-22"), 21);
  assert.equal(gapDays("2026-10-31", "2026-11-01"), 1);
  assert.equal(gapDays("2026-12-31", "2027-01-02"), 2);
  assert.equal(gapDays("x", "2026-10-22"), 0);
  assert.equal(gapDays(undefined, undefined), 0);
});

test("回の最初の一言：前回の一歩の結果と、節目の回（2・3・6回目）", () => {
  assert.deepEqual(roundStartNotes([]), []); // 1回目は出さない（見立ての先頭に出す）
  assert.deepEqual(roundStartNotes([done(1)]), [CHEERS.stepDone.replace("{rate}", "100"), CHEERS.second]);
  assert.deepEqual(roundStartNotes([done(1, { step_done: false })]), [CHEERS.stepMissed, CHEERS.second]);
  assert.deepEqual(roundStartNotes([done(1), done(2, { step_done: false })]), [CHEERS.stepMissed, CHEERS.memoOpen]); // 3回目
  assert.deepEqual(roundStartNotes([done(1), done(2), done(3)]), [CHEERS.streak3]); // 3回続けてやれた（4回目）
  assert.deepEqual(roundStartNotes([done(1), done(2), done(3), done(4)]), [CHEERS.stepDone.replace("{rate}", "100")]); // 4回続けたら通常の言葉
  const six = roundStartNotes([1, 2, 3, 4, 5].map((n) => done(n, n === 5 ? { step_done: false } : {})));
  assert.equal(six.length, 2);
  assert.equal(six[1], CHEERS.full.replace("{round}", "6").replace("{total}", "10")); // 6回目：10問そろう
  assert.deepEqual(roundStartNotes([done(1), done(2, { step_done: null })]), [CHEERS.memoOpen]); // 一歩を聞いていない（記録の前の版）
  assert.equal(roundStartNotes([done(1), done(2), done(3, { step_done: false })]).length, 1);
  assert.ok(roundStartNotes([done(1, { step_done: false }), done(2), done(3)])[0].includes("67%")); // 3回のうち、やれたのは2回
});

test("見立ての先頭の一言：1回目は最後まで答えたこと、2回目以降はいちばん上がった軸（下がったときは出さない）", () => {
  const cur = (r, A, B, C, D) => ({ round: r, fixed: { A: { score: A }, B: { score: B }, C: { score: C }, D: { score: D } } });
  assert.deepEqual(diagnosisNotes([], cur(1, 1, 1, 1, 1)), [CHEERS.firstDiagnosis]);
  const prev = [round(1, { A: 2, B: 2, C: 2, D: 2 })];
  assert.deepEqual(diagnosisNotes(prev, cur(2, 3, 2, 2, 2)), ["最も変化が大きかったのは「任せる・任される」（2→3）です。確かな手応えの証左です。"]);
  assert.match(diagnosisNotes(prev, cur(2, 3, 4, 2, 3))[0], /「社長がいなくても決まるか」（2→4）/); // いちばん大きい軸
  assert.match(diagnosisNotes(prev, cur(2, 3, 3, 2, 2))[0], /「任せる・任される」（2→3）/); // 同じ上がり幅は、先の軸
  assert.deepEqual(diagnosisNotes(prev, cur(2, 1, 2, 1, 2)), []); // 下がった・変わらない
  assert.deepEqual(diagnosisNotes(prev, { round: 2, fixed: {} }), []);
  assert.deepEqual(diagnosisNotes([], cur(2, 4, 4, 4, 4)), []); // 前の記録が無い
});

test("ホームの一言：間が空いたときはその言葉、次の回に問いが増えるときはその数（6回目以降は出さない）", () => {
  const r = (n, date) => round(n, { A: 2, B: 2, C: 2, D: 2 }, { date });
  assert.deepEqual(homeNotes([], "2026-11-05"), []);
  assert.deepEqual(homeNotes([r(1, "2026-11-01")], "2026-11-05"), [CHEERS.nextCount.replace("{n}", "6")]); // 次は2回目で6問
  assert.deepEqual(homeNotes([r(1, "2026-11-01"), r(2, "2026-11-04")], "2026-11-05"), [CHEERS.nextCount.replace("{n}", "7")]);
  assert.deepEqual(homeNotes([1, 2, 3, 4, 5].map((n) => r(n, "2026-11-04")), "2026-11-05"), [CHEERS.nextCount.replace("{n}", "10")]); // 次は6回目で10問
  assert.deepEqual(homeNotes([1, 2, 3, 4, 5, 6].map((n) => r(n, "2026-11-04")), "2026-11-05"), []); // これ以上増えない
  assert.deepEqual(homeNotes([r(1, "2026-10-01")], "2026-10-22"), [CHEERS.gapReturn]); // 間が空いたら、問いが増える言葉より戻ってきた言葉を
  assert.deepEqual(homeNotes([r(1, "2026-10-01")], "2026-10-21"), [CHEERS.nextCount.replace("{n}", "6")]); // 20日はまだ
  assert.equal(CHEER_GAP_DAYS, 21);
  assert.equal(MEMO_FROM_ROUND, 3);
  assert.equal(DEEP_BY_ROUND.length, 6);
});
