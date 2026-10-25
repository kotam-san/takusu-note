// プロフィールと1回目の出し分け（AI は呼ばない）。実行：node --test tests/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILE_FIELDS, profileText, validateProfile } from "../docs/profile.js";
import { QUESTIONS, firstRound } from "../docs/questions.js";
import { emptyStore, validateStore } from "../docs/core.js";
import worker, { validQuestions } from "../worker/src/index.js";
import { START_SCHEMA, startContent, startSystem } from "../worker/src/prompts.js";

const ok = { title: "工場長", reports: "4-10", years: "1-3", industry: "mfg", industry_other: "" }; // 幹部
const okCeo = { employees: "21-50", years: "1-3", industry: "mfg", industry_other: "" }; // 社長
const profileOf = (role) => (role === "ceo" ? okCeo : ok);
const values = (k) => PROFILE_FIELDS[k].options.map((o) => o.value);

test("プロフィール：立場ごとの項目だけを通し、選択肢の外と長すぎる記入は通さない", () => {
  assert.deepEqual(validateProfile({ ...ok, title: "  工場長 " }, "leader"), ok);
  assert.deepEqual(validateProfile({ ...okCeo, title: "代表" }, "ceo"), okCeo); // 社長の役職は捨てる
  assert.deepEqual(validateProfile({ ...okCeo, industry: "other", industry_other: " 印刷 " }, "ceo"), { ...okCeo, industry: "other", industry_other: "印刷" });
  assert.equal(validateProfile({ ...okCeo, industry_other: "印刷" }, "ceo").industry_other, ""); // 「その他」以外では使わない
  assert.equal(validateProfile(ok, "ceo"), null); // 社長に部下の数だけでは足りない
  assert.equal(validateProfile(okCeo, "leader"), null);
  assert.ok(validateProfile(ok) && validateProfile(okCeo)); // 立場なし（記録の読み込み）はどちらかの形なら通す
  for (const bad of [null, "x", { ...ok, reports: "5" }, { ...ok, years: undefined }, { ...ok, industry: "it" }, { ...ok, title: "あ".repeat(21) }, { ...ok, title: 3 }, { ...ok, industry: "other", industry_other: "あ".repeat(21) }]) {
    assert.equal(validateProfile(bad, "leader"), null, JSON.stringify(bad));
  }
  assert.equal(validateProfile({ ...okCeo, employees: "7" }, "ceo"), null);
});

test("プロフィール：AI に渡す1行に、立場と選んだ内容が入る", () => {
  assert.equal(profileText(ok, "leader"), "幹部・工場長・直属の部下4〜10人・リーダー以上の立場の経験年数1〜3年・業種は製造");
  assert.equal(profileText(okCeo, "ceo"), "社長・従業員21〜50人・社長になってからの年数1〜3年・業種は製造");
  assert.equal(profileText({ ...okCeo, industry: "other", industry_other: "印刷" }, "ceo"), "社長・従業員21〜50人・社長になってからの年数1〜3年・業種はその他（印刷）");
  assert.equal(profileText({ ...okCeo, industry: "other" }, "ceo"), "社長・従業員21〜50人・社長になってからの年数1〜3年・業種はその他");
});

test("1回目の出し分け：全部の組み合わせで6問・軸の並び・推移4問の例がそろう", () => {
  const sizes = { ceo: ["employees", values("employees")], leader: ["reports", values("reports")] };
  for (const role of ["ceo", "leader"]) {
    const [key, sizeValues] = sizes[role];
    for (const size of sizeValues) for (const years of values("years")) for (const industry of values("industry")) {
      const p = { [key]: size, years, industry, title: "", industry_other: "" };
      const { deep, examples } = firstRound(role, p);
      const small = size === "0" || size === "1-5";
      assert.deepEqual(deep.map((d) => d.axis), ["A", "A", "B", "B", "C", "D"]);
      assert.ok(deep.every((d) => d.text && d.text.length <= 120));
      assert.ok(["A", "B", "C", "D"].every((k) => examples[k]?.startsWith("例：") && examples[k].length <= 120));
      if (small) assert.ok(!deep.some((d) => /部下|幹部/.test(d.text)), `${role} ${size} ${years} ${industry}`);
      if (role === "ceo" && small) assert.ok(!Object.values(examples).some((e) => e.includes("幹部")));
      if (years === "<1") assert.ok(!deep.some((d) => d.text.includes("直近半年")));
    }
  }
  assert.match(firstRound("ceo", { ...okCeo, employees: "101+" }).deep[3].text, /幹部を通して現場まで/);
});

test("1回目の出し分けは、元の問いと推移4問の文を書き換えない", () => {
  const before = JSON.stringify(QUESTIONS);
  firstRound("ceo", { employees: "1-5", years: "<1", industry: "mfg" });
  firstRound("leader", { title: "", reports: "11+", years: "<1", industry: "other" });
  assert.equal(JSON.stringify(QUESTIONS), before);
  assert.deepEqual(firstRound("leader", { title: "", reports: "1-3", years: "3-10", industry: "other" }).examples, QUESTIONS.leader.examples);
});

test("記録：プロフィールなしの古い記録も、ありの記録も読める。壊れたプロフィールは通さない", () => {
  const old = emptyStore();
  delete old.profile;
  assert.ok(validateStore(old));
  assert.ok(validateStore({ ...emptyStore(), profile: ok }));
  assert.equal(validateStore({ ...emptyStore(), profile: { ...ok, reports: "999" } }), null);
  assert.ok(validateStore({ ...emptyStore(), profile: ok, first_concern: "任せきれない" }));
  assert.equal(validateStore({ ...emptyStore(), first_concern: "あ".repeat(401) }), null);
});

test("中継 /api/start：立場とプロフィールが範囲外なら 400（AI は呼ばれない）", async () => {
  const env = { ALLOWED_ORIGINS: "https://kotam-san.github.io" };
  for (const body of [{ role: "x", profile: ok }, { role: "ceo" }, { role: "ceo", profile: okCeo, concern: "あ".repeat(401) }, { role: "ceo", profile: ok }, { role: "ceo", profile: { ...okCeo, industry: "it" } }, { role: "leader", profile: { ...ok, title: "あ".repeat(21) } }]) {
    const res = await worker.fetch(new Request("https://w.example/api/start", {
      method: "POST", headers: { Origin: "https://kotam-san.github.io" }, body: JSON.stringify(body),
    }), env);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("1回目の指示：プロフィールだけを手がかりに、場面を1つに絞り、推移4問の文を変えない", () => {
  for (const role of ["ceo", "leader"]) {
    const sys = startSystem(role);
    assert.match(sys, /<profile>/);
    assert.match(sys, /場面を1つに絞る/);
    assert.match(sys, /文そのものは変えない/);
    assert.match(sys, /とうかがったので/);
    assert.match(sys, /<concern>/);
    const content = startContent(profileText(profileOf(role), role), QUESTIONS[role].fixed, "任せたいのに口を出してしまう");
    assert.match(content, /<concern>\n任せたいのに口を出してしまう\n<\/concern>/);
    assert.match(startContent(profileText(profileOf(role), role), QUESTIONS[role].fixed), /（記入なし）/);
    for (const k of ["A", "B", "C", "D"]) assert.ok(content.includes(QUESTIONS[role].fixed[k]));
  }
  assert.deepEqual(START_SCHEMA.required, ["next_questions", "fixed_examples"]);
  const good = { next_questions: ["A", "A", "B", "B", "C", "D"].map((axis) => ({ axis, text: "q", because: "b" })), fixed_examples: { A: "a", B: "b", C: "c", D: "d" } };
  assert.equal(validQuestions(good), true);
  assert.equal(validQuestions({ ...good, next_questions: good.next_questions.slice(1) }), false);
  assert.equal(validQuestions({ ...good, next_questions: [...good.next_questions.slice(1), { axis: "Z", text: "q" }] }), false);
});
