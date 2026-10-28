// 託すノート：画面の動き。
// 表示はすべて textContent で入れる（AIの出力や自由記述をHTMLとして解釈しない）。

import {
  AXIS_KEYS, changeSinceFirst, emptyStore, localDate, seriesByAxis, stepDoneRate, validateStore,
} from "./core.js";
import { INDUSTRY_OTHER_MAX, PROFILE_FIELDS, ROLE_FIELDS, TITLE_MAX, validateProfile } from "./profile.js";
import { AXIS_NAMES, CONCERN_KINDS, QUESTIONS, SAMPLE, SCALE, firstRound, fixedFor } from "./questions.js";

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
// 手元モード（local/server.mjs から開いたとき）は、入口が index.html に合い鍵を差し込む。
// あるときだけ、AI は手元の Claude Code、記録はその Mac のフォルダ、各画面に感想の一言欄、になる。公開版には無い。
const HAND_TOKEN = document.querySelector('meta[name="tn-hand"]')?.content || null;
const HAND = Boolean(HAND_TOKEN);
const API_BASE = HAND ? "" : LOCAL ? "http://localhost:8787" : "https://takusu-note.kota-m.workers.dev";
const ROLE_NAME = { ceo: "社長", leader: "幹部" };

// 1回目の深掘りと例は、プロフィールと引っかかりを AI に渡して作る（A）。
// AI が使えないときだけ、用意した問いの出し分け（B・firstRound）で始める。2026-10-25 に A・B を見比べて決めた。

const app = document.getElementById("app");
let state = { role: null, store: null, current: null };
let here = { name: "", questions: [] }; // 手元モードの感想欄に添える、今の画面の名前と問い

// ---------------------------------------------------------------- 小さな部品

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// 次に出す画面の名前と、そこに出ている問い（手元モードの感想欄で使う）
function where(name, questions = []) {
  here = { name, questions: questions.filter(Boolean) };
}

function screen(...nodes) {
  app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false), ...(HAND ? [feedbackBox()] : []), footer());
  window.scrollTo({ top: 0 });
}

function footer() {
  if (HAND) {
    return h("footer", {},
      "手元モードです。答えはこの Mac の Claude Code に渡し、記録と感想はこの Mac のフォルダに残ります。",
      h("br"), "掲載の回答例はすべて架空です。");
  }
  return h("footer", {},
    "試作版です。答えは診断のために AI（Claude）へ送られますが、サーバーには保存しません。記録はこのブラウザの中だけに残ります。",
    h("br"), "掲載の回答例はすべて架空です。");
}

function errorBox(msg) {
  return h("p", { class: "error", role: "alert" }, msg);
}

// ---------------------------------------------------------------- 記録（公開版はこのブラウザの中だけ・手元モードはその Mac のフォルダ）

const key = (role) => `tn.v1.${role}`;
let storeVersion = 0; // 手元モード：古い画面からの上書きを入口が断るための番号
let saveError = "";

async function load(role) {
  if (HAND) {
    const data = await local("GET", `/api/store/${role}`);
    storeVersion = data.version;
    if (data.broken) return { store: emptyStore(), broken: true };
    return { store: data.store ?? emptyStore(), broken: false };
  }
  try {
    const raw = localStorage.getItem(key(role));
    if (!raw) return { store: emptyStore(), broken: false };
    const data = validateStore(JSON.parse(raw));
    return data ? { store: data, broken: false } : { store: emptyStore(), broken: true };
  } catch {
    return { store: emptyStore(), broken: true };
  }
}

async function save() {
  saveError = "";
  if (HAND) {
    try {
      const out = await local("PUT", `/api/store/${state.role}`, { version: storeVersion, store: state.store });
      storeVersion = out.version;
      return true;
    } catch (e) {
      saveError = e.message;
      return false;
    }
  }
  try {
    localStorage.setItem(key(state.role), JSON.stringify(state.store));
    return true;
  } catch {
    return false;
  }
}

const saveFailed = () => errorBox(saveError || "記録を保存できませんでした。");

// ---------------------------------------------------------------- AI を呼ぶ

function api(path, body) {
  return request("POST", path, body);
}

// 手元モードの入口だけに送る（記録・感想）
async function local(method, path, body) {
  if (!HAND) throw new Error("hand mode only");
  return request(method, path, body);
}

async function request(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HAND ? 150_000 : 90_000); // 手元の入口は AI を 120 秒で打ち切る
  const headers = { "Content-Type": "application/json" };
  if (HAND) headers["X-Takusu-Token"] = HAND_TOKEN;
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "うまく届きませんでした。もう一度お試しください。");
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("時間がかかりすぎました。もう一度お試しください。");
    if (e instanceof TypeError) throw new Error("通信できませんでした。接続を確かめて、もう一度お試しください。");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ボタンを押している間は二重に送らない
async function busy(button, label, fn) {
  if (button.disabled) return;
  const before = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = before;
  }
}

// ---------------------------------------------------------------- 1. はじめ

function showStart() {
  state = { role: null, store: null, current: null };
  where("はじめ");
  const roleButton = (role, desc) =>
    h("button", { onclick: () => chooseRole(role) }, h("b", {}, ROLE_NAME[role]), desc);

  screen(
    h("h1", {}, "託すノート"),
    h("p", { class: "lead" },
      h("span", { style: "display:inline-block" }, "答えるたびに問いが変わる、"),
      h("span", { style: "display:inline-block" }, "社長と幹部のための毎週10分のノートです。")),
    h("div", { class: "role" },
      roleButton("ceo", "任せ方・育て方を見直す"),
      roleButton("leader", "任され方・動き方を見直す"),
    ),
  );
}

async function chooseRole(role) {
  let loaded;
  try {
    loaded = await load(role);
  } catch (e) {
    where("記録の読み込み");
    screen(errorBox(e.message), h("button", { onclick: () => location.reload() }, "読み込み直す"));
    return;
  }
  const { store, broken } = loaded;
  state = { role, store, current: null };
  if (broken) {
    const err = h("div");
    const again = h("button", { class: "primary" }, "新しく始める");
    again.addEventListener("click", () => busy(again, "保存しています…", async () => {
      if ((await save()) || !HAND) showHome(); // 公開版は保存できなくても続ける（今まで通り）
      else err.replaceChildren(saveFailed());
    }));
    where("記録が読めない");
    screen(errorBox(HAND ? "記録のファイルが読めませんでした。新しく始めます。" : "このブラウザの記録が読めませんでした。新しく始めます。"), again, err);
    return;
  }
  showHome();
}

// ---------------------------------------------------------------- 2. 立場ごとのホーム

// 今の立場の形になっているプロフィール。項目を変える前の記録や、別の立場の形なら null（聞き直す）
const myProfile = () => validateProfile(state.store.profile, state.role);

function showHome() {
  const { rounds } = state.store;
  if (!rounds.length) return myProfile() ? startRound() : showProfile();
  where("ホーム");
  screen(
    h("h1", {}, `${ROLE_NAME[state.role]}の託すノート`),
    h("p", { class: "lead" }, `これまで ${rounds.length} 回。次は ${rounds.length + 1} 回目です。`),
    growthCard(),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: startRound }, `${rounds.length + 1} 回目を始める`),
      h("button", { onclick: showStart }, "立場を選び直す"),
      h("button", { onclick: showProfile }, "プロフィールを直す"),
    ),
    h("p", {}, h("a", { href: "./how.html" }, "記録がどう積み上がり、何を手がかりに問いが変わるのかを図で見る")),
  );
}

// ---------------------------------------------------------------- 2.5 プロフィール（はじめての1回・あとから直せる）

function showProfile() {
  const role = state.role;
  const p = myProfile();
  const first = !state.store.rounds.length;
  const choiceGroup = (key) => {
    const f = PROFILE_FIELDS[key];
    const label = typeof f.label === "string" ? f.label : f.label[role];
    return h("div", { class: "q" }, label,
      h("div", { class: "scale", role: "radiogroup" },
        f.options.map((o) => h("label", {},
          h("input", { type: "radio", name: `p-${key}`, value: o.value, checked: p?.[key] === o.value }),
          h("span", {}, o.label)))));
  };
  // 社長には役職を聞かない（社長だと分かっているため）
  const title = role === "leader"
    ? h("input", { class: "text-in", maxlength: String(TITLE_MAX), value: p?.title ?? "", placeholder: "例：工場長", "aria-label": "役職" })
    : null;
  // 業種で「その他」を選んだときだけ、自分で書く欄を出す
  const industryOther = h("input", { class: "text-in", maxlength: String(INDUSTRY_OTHER_MAX), value: p?.industry_other ?? "", placeholder: "例：印刷", "aria-label": "業種（その他）" });
  const otherRow = h("div", { style: "margin-top:8px" }, "業種を書いてください：", industryOther);
  const syncOther = () => (otherRow.hidden = app.querySelector("input[name=p-industry]:checked")?.value !== "other");
  const concern = first
    ? h("textarea", { maxlength: "400", placeholder: role === "ceo" ? "例：任せたいのに、結局自分が決めてしまう" : "例：社長が何を目指しているのか分からないまま動いている" })
    : null;
  if (concern) concern.value = state.store.first_concern ?? "";
  const err = h("div");
  const submit = h("button", { class: "primary" }, first ? "1回目の問いを作る" : "保存する");

  submit.addEventListener("click", () => busy(submit, first ? "AIが1回目の問いを作っています…" : "保存しています…", async () => {
    err.replaceChildren();
    const pick = (key) => app.querySelector(`input[name=p-${key}]:checked`)?.value;
    const picked = Object.fromEntries(ROLE_FIELDS[role].map((k) => [k, pick(k)]));
    const profile = validateProfile({ ...picked, title: title?.value ?? "", industry_other: industryOther.value }, role);
    if (!profile) {
      err.append(errorBox(role === "leader" ? "役職のほかは、すべて選んでください。" : "すべて選んでください。"));
      return;
    }
    state.store.profile = profile;
    if (!first) {
      if (!(await save()) && HAND) return err.append(saveFailed()); // 公開版は保存できなくても続ける（今まで通り）
      return showHome();
    }
    state.store.first_concern = concern.value.trim() || null;
    const made = await makeFirstRound(role, profile, state.store.first_concern);
    state.store.next_deep = made.deep;
    state.store.next_examples = made.examples;
    if (!(await save()) && HAND) return err.append(saveFailed());
    showQuiz();
  }));

  where(first ? "はじめに（プロフィール）" : "プロフィールを直す");
  screen(
    h("h1", {}, first ? "はじめに、あなたのことを" : "プロフィールを直す"),
    h("p", { class: "lead" }, first
      ? "1回目の問いを、あなたの立場と職場に合わせて作ります。会社名や人の名前は聞きません。"
      : "直した内容は、次の回から AI の見立てに使います。"),
    h("section", { class: "card", onchange: syncOther },
      title ? h("div", { class: "q" }, "役職（任意）", h("div", {}, title)) : null,
      ROLE_FIELDS[role].map(choiceGroup),
      otherRow),
    concern ? h("section", { class: "card" },
      h("h2", {}, "いま、いちばん引っかかっていること（任意）"),
      h("p", { class: "notice" }, "書いてもらうと、1回目の問いをそこに寄せて作ります。実名や取引先の名前は書かないでください。"),
      concern) : null,
    h("div", { class: "row" }, submit, first ? null : h("button", { onclick: showHome }, "やめる")),
    err,
  );
  syncOther();
}

// 1回目の深掘り6問と例。A は AI に作らせ、失敗したら B（出し分け）で続ける
async function makeFirstRound(role, profile, concern) {
  try {
    const out = await api("/api/start", { role, profile, concern: concern ?? "" });
    return {
      deep: out.next_questions.map(({ axis, text, because }) => ({ axis, text, because })),
      examples: Object.fromEntries(AXIS_KEYS.map((k) => [k, out.fixed_examples[k].slice(0, 120)])),
    };
  } catch {
    return firstRound(role, profile);
  }
}

// ---------------------------------------------------------------- 3. 問い

function startRound() {
  const last = state.store.rounds.at(-1);
  if (last && last.step && last.step_done == null) return askPrevStep(last);
  showQuiz();
}

function askPrevStep(last) {
  const err = h("div");
  const answer = (done) => (ev) => busy(ev.currentTarget, "保存しています…", async () => {
    last.step_done = done;
    if (!(await save()) && HAND) {
      last.step_done = null;
      return err.replaceChildren(saveFailed());
    }
    showQuiz();
  });
  where("前回の一歩", [last.step]);
  screen(
    h("section", { class: "card" },
      h("h2", {}, "前回の一歩、やれましたか"),
      h("p", { class: "lesson" }, last.step),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: answer(true) }, "やれた"),
        h("button", { onclick: answer(false) }, "やれなかった"),
      ),
      h("p", { class: "notice", style: "margin-top:12px" }, "やれなかったことも、次の問いを作る材料になります。"),
      err,
    ),
  );
}

function showQuiz() {
  const role = state.role;
  const round = state.store.rounds.length + 1;
  const q = QUESTIONS[role];
  const fixedText = fixedFor(role, myProfile()); // 表示・送信・感想欄で同じ文を使う
  const deepList = state.store.next_deep ?? q.deep;
  const examples = state.store.next_examples ?? q.examples;
  const adaptive = Boolean(state.store.next_deep);

  const scaleFor = (name) =>
    h("div", { class: "scale", role: "radiogroup" },
      SCALE.map((s) =>
        h("label", {}, h("input", { type: "radio", name, value: s.value }), h("span", {}, s.label))));

  const fixedBlocks = AXIS_KEYS.map((k) =>
    h("div", { class: "q" },
      h("div", { class: "axis" }, `推移を見る問い・${AXIS_NAMES[k]}`),
      fixedText[k],
      h("div", { class: "example" }, examples[k]),
      scaleFor(`f-${k}`)));

  const deepBlocks = deepList.map((d, i) =>
    h("div", { class: "q" },
      h("div", { class: "axis" }, `深掘り・${AXIS_NAMES[d.axis]}`),
      d.because ? h("div", { class: "because" }, `この問いにした理由：${d.because}`) : null,
      d.text,
      scaleFor(`d-${i}`)));

  const concern = h("textarea", { id: "concern", maxlength: "400", placeholder: "例：任せたいのに、結局自分が決めてしまう" });
  if (round === 1) concern.value = state.store.first_concern ?? ""; // はじめに書いたものを入れておき、直せるようにする
  // 引っかかりの中身（任意）。選ばなければ空のまま送り、AI には「まだ分からない」として渡る
  const kinds = h("div", { class: "steps" }, Object.entries(CONCERN_KINDS).map(([value, label]) =>
    h("label", {}, h("input", { type: "radio", name: "concern-kind", value }), h("span", {}, label))));
  const err = h("div");
  const submit = h("button", { class: "primary" }, "AIの見立てを見る");

  const fillSample = () => {
    const s = SAMPLE[role];
    AXIS_KEYS.forEach((k) => (app.querySelector(`input[name=f-${k}][value="${s.fixed[k]}"]`).checked = true));
    deepList.forEach((_, i) => (app.querySelector(`input[name=d-${i}][value="${s.deep[i] ?? 2}"]`).checked = true));
    concern.value = s.concern;
    app.querySelector(`input[name=concern-kind][value="${s.concern_kind}"]`).checked = true;
    err.replaceChildren(h("p", { class: "notice" }, "回答例（架空）を入れました。そのまま「AIの見立てを見る」を押してください。"));
  };

  submit.addEventListener("click", () => busy(submit, "AIが読んでいます…（20秒ほど）", async () => {
    err.replaceChildren();
    const pick = (name) => Number(app.querySelector(`input[name=${name}]:checked`)?.value);
    const fixed = Object.fromEntries(AXIS_KEYS.map((k) => [k, { text: fixedText[k], score: pick(`f-${k}`) }]));
    const deep = deepList.map((d, i) => ({ axis: d.axis, text: d.text, score: pick(`d-${i}`) }));
    if ([...Object.values(fixed), ...deep].some((x) => !x.score)) {
      err.append(errorBox("すべての問いに答えてください。"));
      return;
    }
    const last = state.store.rounds.at(-1);
    const body = {
      role, round, fixed, deep, concern: concern.value.trim(), profile: myProfile(),
      concern_kind: concern.value.trim() ? app.querySelector("input[name=concern-kind]:checked")?.value ?? "" : "",
      history: state.store.rounds.slice(-12).map(({ round, date, scores, step, step_done }) => ({ round, date, scores, step: step || "", step_done: step_done ?? null })),
      prev_step: last?.step ? { text: last.step, done: last.step_done ?? null } : null,
    };
    try {
      const diagnosis = await api("/api/diagnose", body);
      state.current = { round, fixed, deep, concern: body.concern, concern_kind: body.concern_kind, diagnosis, history: body.history, prev_step: body.prev_step, id: roundId() };
      showDiagnosis();
    } catch (e) {
      err.append(errorBox(e.message));
    }
  }));

  where("問い", [...AXIS_KEYS.map((k) => fixedText[k]), ...deepList.map((d) => d.text)]);
  screen(
    h("h1", {}, `${ROLE_NAME[role]}・${round} 回目`),
    adaptive ? h("p", { class: "lead" }, round === 1
      ? "深掘りの問いは、はじめに選んでもらった内容を受けて作っています。"
      : "深掘りの問いは、前回のあなたの答えを受けて変わっています。") : null,
    h("section", { class: "card" }, h("h2", {}, "毎回同じ4つの問い"), h("p", { class: "notice" }, "この4問の点数で、回ごとの変化を見ます。"), fixedBlocks),
    h("section", { class: "card" }, h("h2", {}, adaptive ? "今回の深掘り" : "深掘りの問い"), deepBlocks),
    h("section", { class: "card" },
      h("h2", {}, "いま、いちばん引っかかっていること"),
      h("p", { class: "notice" }, "実名や取引先の名前は書かないでください。"),
      concern,
      h("div", { class: "q" }, "その難しさは、どれにいちばん近いですか（任意）", kinds)),
    h("div", { class: "row" }, submit, h("button", { onclick: fillSample }, "回答例で試す")),
    err,
  );
}

// ---------------------------------------------------------------- 4. 見立てと学び、3分コーチング

function showDiagnosis() {
  const { diagnosis: d, round } = state.current;
  const notes = AXIS_KEYS.map((k) => {
    const n = d.axis_notes.find((x) => x.axis === k);
    return h("div", { class: "note" }, h("b", {}, AXIS_NAMES[k]), n ? n.note : "");
  });

  const result = h("p", { role: "status" });
  const choices = d.lesson.check.choices.map((c, i) =>
    h("button", {
      onclick: (ev) => {
        const ok = i === d.lesson.check.answer_index;
        ev.currentTarget.classList.add(ok ? "right" : "wrong");
        result.textContent = (ok ? "その通りです。" : "もう一度、上の教材を読んでみてください。") + d.lesson.check.explanation;
      },
    }, c));

  // 候補から1つ選び、補足は自由に書く（広い問いにいきなり答えるのは難しいため）
  const picks = d.coaching_choices.map((c, i) =>
    h("label", {}, h("input", { type: "radio", name: "pick", value: String(i) }), h("span", {}, c)));
  const reply = h("textarea", { maxlength: "700", placeholder: "補足があれば自由に（候補になければ、ここに書いてください）" });
  const err = h("div");
  const send = h("button", { class: "primary" }, "答えを送る");
  const fillSample = h("button", { onclick: () => { app.querySelector("input[name=pick]").checked = true; reply.value = SAMPLE[state.role].reply; err.replaceChildren(h("p", { class: "notice" }, "回答例（架空）を入れました。")); } }, "回答例で試す");

  send.addEventListener("click", () => busy(send, "受け止めています…", async () => {
    err.replaceChildren();
    const picked = d.coaching_choices[Number(app.querySelector("input[name=pick]:checked")?.value)];
    const note = reply.value.trim();
    if (!picked && !note) {
      err.append(errorBox("候補を1つ選ぶか、ひとことでも書いてみてください。"));
      return;
    }
    const answer = [picked ? `選んだ候補：${picked.slice(0, 80)}` : "", note ? `補足：${note}` : ""].filter(Boolean).join("\n");
    const c = state.current;
    try {
      const out = await api("/api/coach", {
        role: state.role, question: d.coaching_question, reply: answer, profile: myProfile(),
        summary: d.summary, concern: c.concern, concern_kind: c.concern_kind, fixed: c.fixed,
        history: c.history, prev_step: c.prev_step,
      });
      c.coaching = { question: d.coaching_question, reply: answer, ...out };
      showSteps();
    } catch (e) {
      err.append(errorBox(e.message));
    }
  }));

  where("見立てと3分コーチング", [d.lesson.check.question, d.coaching_question]);
  screen(
    h("h1", {}, `${round} 回目の見立て`),
    h("section", { class: "card" }, h("h2", {}, "今の状態"), h("p", {}, d.summary), notes),
    h("section", { class: "card" },
      h("h2", {}, "今日の学び"),
      h("div", { class: "lesson" }, h("h3", { style: "margin-top:0" }, d.lesson.title), h("p", {}, d.lesson.body)),
      h("h3", {}, "確かめの問い"),
      h("p", {}, d.lesson.check.question),
      h("div", { class: "choices" }, choices),
      result),
    h("section", { class: "card" },
      h("h2", {}, "3分コーチング"),
      h("p", { class: "lesson" }, d.coaching_question),
      h("div", { class: "steps" }, picks),
      reply,
      h("div", { class: "row" }, send, fillSample),
      err),
  );
}

function showSteps() {
  const c = state.current;
  const own = h("input", { type: "text", maxlength: "60", placeholder: "自分で書く" });
  const options = [...c.coaching.step_options.map((s, i) =>
    h("label", {}, h("input", { type: "radio", name: "step", value: String(i) }), h("span", {}, s))),
    h("label", {}, h("input", { type: "radio", name: "step", value: "own" }), own)];
  const err = h("div");

  const decide = h("button", { class: "primary" }, "これに決める");
  decide.addEventListener("click", () => busy(decide, "保存しています…", async () => {
    const v = app.querySelector("input[name=step]:checked")?.value;
    const step = v === "own" ? own.value.trim() : c.coaching.step_options[Number(v)];
    if (!step) {
      err.replaceChildren(errorBox("今週の一歩を1つ選んでください。"));
      return;
    }
    const before = { rounds: state.store.rounds.slice(), next_deep: state.store.next_deep, next_examples: state.store.next_examples };
    const scores = Object.fromEntries(AXIS_KEYS.map((k) => [k, c.fixed[k].score]));
    c.date = localDate();
    c.step = step.slice(0, 80);
    state.store.rounds.push({ round: c.round, date: c.date, scores, step: c.step, step_done: null });
    state.store.next_deep = c.coaching.next_questions.map(({ axis, text, because }) => ({ axis, text, because }));
    state.store.next_examples = Object.fromEntries(AXIS_KEYS.map((k) => [k, c.coaching.fixed_examples[k].slice(0, 120)]));
    const ok = await save();
    if (!ok && HAND) {
      Object.assign(state.store, before); // 保存できなかった回は積まない（もう一度押せる）
      return err.replaceChildren(saveFailed());
    }
    showDone(ok);
  }));

  where("今週の一歩", c.coaching.step_options);
  screen(
    h("h1", {}, "今週の一歩を決める"),
    h("section", { class: "card" }, h("h2", {}, "コーチから"), h("p", {}, c.coaching.reflection)),
    h("section", { class: "card steps" }, h("h2", {}, "どれをやりますか"), options,
      h("div", { class: "row" }, decide), err),
  );
}

function showDone(saved) {
  const c = state.current;
  where("おつかれさま", c.coaching.next_questions.map((q) => q.text));
  screen(
    h("h1", {}, `${c.round} 回目、おつかれさまでした`),
    saved ? null : errorBox("このブラウザに記録を保存できませんでした（プライベートブラウズでは残りません）。"),
    HAND ? recordBox(c) : null,
    h("section", { class: "card" },
      h("h2", {}, "次の回の深掘りは、こう変わります"),
      h("p", { class: "notice" }, "今回の答えとコーチングを受けて、AIが作りました。"),
      c.coaching.next_questions.map((q) =>
        h("div", { class: "q" }, h("div", { class: "axis" }, AXIS_NAMES[q.axis]), h("div", { class: "because" }, `この問いにした理由：${q.because}`), q.text))),
    growthCard(),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: showHome }, "記録を見る"), h("button", { onclick: showStart }, "はじめに戻る")),
  );
}

// ---------------------------------------------------------------- 5. 育ちの記録

function growthCard() {
  const rounds = state.store.rounds;
  if (!rounds.length) return null;
  const change = changeSinceFirst(rounds);
  const rate = stepDoneRate(rounds);

  const reset = () => {
    if (!confirm(`${ROLE_NAME[state.role]}の記録をすべて消します。元に戻せません。よろしいですか？`)) return;
    try { localStorage.removeItem(key(state.role)); } catch {}
    showStart();
  };

  return h("section", { class: "card" },
    h("h2", {}, "育ちの記録"),
    chart(rounds),
    change ? h("p", { class: "notice" }, "1回目からの変化：" + AXIS_KEYS.map((k) => `${AXIS_NAMES[k]} ${change[k] > 0 ? "+" : ""}${change[k]}`).join("／")) : null,
    h("details", {}, h("summary", {}, "点数を表で見る"),
      h("table", {},
        h("tr", {}, h("th", {}, "回"), AXIS_KEYS.map((k) => h("th", {}, k))),
        rounds.map((r) => h("tr", {}, h("td", {}, `${r.round}回目（${r.date}）`), AXIS_KEYS.map((k) => h("td", {}, r.scores[k])))))),
    h("h3", {}, "これまでの一歩" + (rate == null ? "" : `（やれた率 ${rate}%）`)),
    h("ul", {}, rounds.slice().reverse().map((r) =>
      h("li", {}, `${r.round}回目：${r.step}`, r.step_done === true ? "（やれた）" : r.step_done === false ? "（やれなかった）" : "（次の回で確認）"))),
    // 手元モードの記録はファイルなので、画面からは消さない
    HAND ? null : h("div", { class: "row", style: "margin-top:20px" }, h("button", { onclick: reset }, "記録をすべて消す")),
  );
}

// 推移の折れ線（点数1〜4・回ごと）。凡例＋線の端に軸の記号を添える。
function chart(rounds) {
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs = {}, text) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    return el;
  };
  const W = 340, H = 180, L = 28, R = 24, T = 12, B = 26;
  const n = rounds.length;
  const x = (i) => (n === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v) => T + ((4 - v) * (H - T - B)) / 3;

  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "4つの軸の点数の推移" });
  for (let v = 1; v <= 4; v++) {
    svg.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 }));
    svg.append(s("text", { x: L - 8, y: y(v) + 3, "text-anchor": "end" }, v));
  }
  rounds.forEach((r, i) => svg.append(s("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, `${r.round}回`)));

  const series = seriesByAxis(rounds);
  AXIS_KEYS.forEach((k, idx) => {
    const pts = series[k];
    const color = `var(--series-${k})`;
    const off = (idx - 1.5) * 1.5; // 同じ点数で線が重なりすぎないよう、わずかにずらす
    if (pts.length > 1) {
      svg.append(s("polyline", {
        points: pts.map((p, i) => `${x(i)},${y(p.value) + off}`).join(" "),
        fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    }
    pts.forEach((p, i) => {
      const c = s("circle", { cx: x(i), cy: y(p.value) + off, r: 4, fill: color, stroke: "var(--surface-1)", "stroke-width": 2 });
      c.append(s("title", {}, `${p.round}回目・${AXIS_NAMES[k]}：${p.value}`));
      svg.append(c);
    });
    const lastPt = pts.at(-1);
    svg.append(s("text", { x: x(pts.length - 1) + 8, y: y(lastPt.value) + off + 3, style: "fill:var(--sub)" }, k));
  });

  const legend = h("div", { class: "legend" }, AXIS_KEYS.map((k) =>
    h("span", {}, h("i", { style: `background:var(--series-${k})` }), `${k} ${AXIS_NAMES[k]}`)));
  return h("div", {}, legend, svg);
}

// ---------------------------------------------------------------- 6. 手元モードだけの部品

function roundId() {
  return Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36).padStart(7, "0")).join("");
}

// 1回分を人が読める記録として入口に渡す。失敗したら送り直せる
function recordBox(c) {
  const status = h("p", { class: "notice", role: "status" }, "この回の記録を残しています…");
  const retry = h("button", { hidden: true }, "記録を送り直す");
  const sendRecord = async () => {
    retry.hidden = true;
    try {
      const out = await local("POST", "/api/record", {
        role: state.role, round_id: c.id,
        record: {
          round: c.round, date: c.date, profile: myProfile(), fixed: c.fixed, deep: c.deep, concern: c.concern, concern_kind: c.concern_kind,
          diagnosis: c.diagnosis, coaching: c.coaching, step: c.step,
        },
      });
      status.textContent = `この回の記録を残しました（rounds/${out.file}）。`;
    } catch (e) {
      status.textContent = `この回の記録を残せませんでした：${e.message}`;
      retry.hidden = false;
    }
  };
  retry.addEventListener("click", () => busy(retry, "送っています…", sendRecord));
  sendRecord();
  return h("div", {}, status, retry);
}

// 各画面の下の「気になったこと」。AI には送らず、入口が feedback.md に1行ずつ足す
function feedbackBox() {
  const { name, questions } = here;
  const text = h("textarea", { maxlength: "1000", rows: "2", placeholder: "この画面で気になったこと（任意）" });
  const pick = questions.length > 1
    ? h("select", { "aria-label": "どの問いについてか" },
      h("option", { value: "" }, "（画面全体について）"),
      questions.map((q, i) => h("option", { value: String(i) }, q.length > 40 ? q.slice(0, 40) + "…" : q)))
    : null;
  const status = h("p", { class: "notice", role: "status" });
  const sendButton = h("button", {}, "書き残す");
  sendButton.addEventListener("click", () => busy(sendButton, "書いています…", async () => {
    if (!text.value.trim()) return;
    const question = pick ? (pick.value === "" ? "" : questions[Number(pick.value)]) : questions[0] ?? "";
    try {
      await local("POST", "/api/feedback", {
        role: state.role, round: state.current?.round ?? (state.store ? state.store.rounds.length + 1 : null),
        screen: name, question: question.slice(0, 300), text: text.value.trim(),
      });
      text.value = "";
      status.textContent = "書き残しました。";
    } catch (e) {
      status.textContent = `書き残せませんでした：${e.message}`;
    }
  }));
  return h("section", { class: "card feedback" },
    h("h2", {}, "気になったこと（手元モード）"),
    pick, text, h("div", { class: "row" }, sendButton), status);
}

showStart();
