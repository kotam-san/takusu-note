// 託すノート：画面の動き。
// 表示はすべて textContent で入れる（AIの出力や自由記述をHTMLとして解釈しない）。

import {
  AXIS_KEYS, answersFromQuiz, answersToQuiz, clipLesson, draftMatches, emptyAnswers, emptyStore, firstOpenStep, localDate, quizOrder,
  roundSummary, sampleAnswers, scoreOf, seriesByAxis, setScore, stepDoneRate, stepMiss, validateStore,
} from "./core.js";
import { INDUSTRY_OTHER_MAX, PROFILE_FIELDS, ROLE_FIELDS, TITLE_MAX, validateProfile } from "./profile.js";
import {
  AXIS_NAMES, CONCERN_KINDS, QUESTIONS, SAMPLE, SCALE, STEP_MISS_REASONS, STEP_NOTE_MAX, FIRST_DEEP_PICK, firstRound, fixedFor,
} from "./questions.js";

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
  place(nodes, HAND ? feedbackBox() : null);
}

// 画面を入れ替える。box（手元モードの感想欄）を渡すと、それをそのまま残す
function place(nodes, box = null) {
  app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false), ...(box ? [box] : []), footer());
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

// ---------------------------------------------------------------- 途中の回（下書き）
// ページを離れて戻っても続きから開けるよう、途中の回をこのタブ（sessionStorage）に残す。
// 回を保存したら消す。開くのは draftMatches が通るときだけ（保存済みの回・問いが変わった回は開かない）

const draftKey = (role) => `tn.draft.${role}`;
let draft = null;

function readDraft(role) {
  try { return JSON.parse(sessionStorage.getItem(draftKey(role)) ?? "null"); } catch { return null; }
}
function writeDraft() {
  if (!draft || !state.role) return;
  try { sessionStorage.setItem(draftKey(state.role), JSON.stringify(draft)); } catch {}
}
function clearDraft(role = state.role) {
  draft = null;
  try { sessionStorage.removeItem(draftKey(role)); } catch {}
}

// 今の回の深掘りの問い（回答画面と、下書きが合うかの判定で同じものを使う）
const quizDeep = () => state.store.next_deep ?? QUESTIONS[state.role].deep;

// 下書きのいちばん先まで進んだ画面を開き直す。開けなければ捨ててホームへ
function resumeDraft(saved) {
  try {
    draft = saved;
    if (saved.stage === "quiz") showQuiz(true);
    else {
      state.current = saved.current;
      if (saved.stage === "steps") showSteps(true);
      else showDiagnosis(true);
    }
    return true;
  } catch {
    clearDraft();
    state.current = null;
    return false;
  }
}

function resumedNote() {
  return h("section", { class: "card" },
    h("p", { class: "notice", style: "margin:0 0 10px" }, "途中から再開しました。入力していた内容を戻しています。"),
    h("button", { onclick: () => { clearDraft(); state.current = null; showHome(); } }, "最初からやり直す"));
}

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
  draft = null;
  where("はじめ");
  // 途中の回がある立場には印をつける（押すと続きから開く）
  const roleButton = (role, desc) =>
    h("button", { onclick: () => chooseRole(role) }, h("b", {}, ROLE_NAME[role]), desc,
      readDraft(role) ? h("span", { class: "resume" }, "途中の回があります") : null);

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
  const saved = readDraft(role);
  if (draftMatches(saved, store.rounds, quizDeep().map((d) => d.text)) && resumeDraft(saved)) return;
  clearDraft(role);
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
      h("div", { class: "scale", role: "radiogroup", "aria-label": label },
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
  // 1回目だけ、引っかかりの「種類」を選ぶ（任意）。文章で書くのは、問いに答えたあとの「ひとこと」でよい
  const concernKinds = first
    ? h("div", { class: "steps kinds", role: "radiogroup", "aria-label": "いま引っかかっていることの種類（任意）" }, Object.entries(CONCERN_KINDS).map(([value, label]) =>
      h("label", {}, h("input", { type: "radio", name: "p-concern-kind", value, checked: state.store.first_concern_kind === value }), h("span", {}, label))))
    : null;
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
    state.store.first_concern_kind = app.querySelector("input[name=p-concern-kind]:checked")?.value ?? null;
    const made = await makeFirstRound(role, profile, state.store.first_concern ?? "", state.store.first_concern_kind ?? "");
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
    concernKinds ? h("section", { class: "card" },
      h("h2", {}, "いま引っかかっていることは、どれに近いですか（任意）"),
      h("p", { class: "notice" }, "選ぶと、1回目の問いをそこに寄せて作ります。文章は、問いに答えたあとに書けます。"),
      concernKinds) : null,
    h("div", { class: "row" }, submit, first ? null : h("button", { onclick: showHome }, "やめる")),
    err,
  );
  syncOther();
}

// 1回目の深掘り3問と例。A は AI に作らせ、失敗したら B（出し分け）で続ける
async function makeFirstRound(role, profile, concern, kind) {
  try {
    const out = await api("/api/start", { role, profile, concern: concern ?? "", concern_kind: kind ?? "" });
    return {
      deep: out.next_questions.map(({ axis, text, because }) => ({ axis, text, because })),
      examples: Object.fromEntries(AXIS_KEYS.map((k) => [k, out.fixed_examples[k].slice(0, 120)])),
    };
  } catch {
    const fallback = firstRound(role, profile);
    return { ...fallback, deep: FIRST_DEEP_PICK.map((i) => fallback.deep[i]) };
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
  let saving = false; // 「やれた」と「次へ」を続けて押しても、保存を重ねない
  // 結果・理由・一言はまとめて保存し、保存できなければ3つとも戻す。「やれた」なら理由と一言は持たない
  const saveResult = async (done, reason, note) => {
    if (saving) return;
    saving = true;
    err.replaceChildren();
    const before = { step_done: last.step_done, step_reason: last.step_reason, step_note: last.step_note };
    delete last.step_reason;
    delete last.step_note;
    const miss = stepMiss(done, reason, note);
    Object.assign(last, { step_done: done },
      miss.reason ? { step_reason: miss.reason } : {}, miss.note ? { step_note: miss.note } : {});
    if (!(await save()) && HAND) {
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete last[k]; else last[k] = v;
      saving = false;
      return err.replaceChildren(saveFailed());
    }
    showQuiz();
  };

  // 「やれなかった」を押したら、理由（任意）と一言（任意）を聞いてから進む
  const reasons = h("div", { class: "steps" }, Object.entries(STEP_MISS_REASONS).map(([value, label]) =>
    h("label", {}, h("input", { type: "radio", name: "miss-reason", value }), h("span", {}, label))));
  const note = h("input", { type: "text", maxlength: String(STEP_NOTE_MAX), placeholder: "ひとこと（任意）", "aria-label": "やれなかったことへのひとこと（任意）" });
  const next = h("button", { class: "primary" }, "次へ");
  next.addEventListener("click", () => busy(next, "保存しています…", () =>
    saveResult(false, app.querySelector("input[name=miss-reason]:checked")?.value ?? "", note.value)));
  const miss = h("div", { hidden: true },
    h("h3", {}, "どれがいちばん近いですか（任意）"),
    h("p", { class: "notice" }, "責めるためではなく、次の一歩の大きさや場面を合わせるために聞きます。"),
    reasons, h("div", { class: "steps" }, h("label", {}, note)),
    h("div", { class: "row" }, next));

  const done = h("button", { class: "primary" }, "やれた");
  done.addEventListener("click", () => busy(done, "保存しています…", () => saveResult(true)));
  const notDone = h("button", { onclick: () => { miss.hidden = false; notDone.setAttribute("aria-pressed", "true"); } }, "やれなかった");

  where("前回の一歩", [last.step]);
  screen(
    h("section", { class: "card" },
      h("h2", {}, "前回の一歩、やれましたか"),
      h("p", { class: "lesson" }, last.step),
      h("div", { class: "row" }, done, notDone),
      h("p", { class: "notice", style: "margin-top:12px" }, "やれなかったことも、次の問いを作る材料になります。"),
      miss,
      err,
    ),
  );
}

// 問いは1画面に1問ずつ。推移を見る4問 → 深掘り → 最後の画面（ひとこと／引っかかり）。
// 答えは answers に持ち、画面を替えても残す。下書き（draft.quiz）の形は変えない。
function showQuiz(resumed = false) {
  const role = state.role;
  const round = state.store.rounds.length + 1;
  const q = QUESTIONS[role];
  const fixedText = fixedFor(role, myProfile()); // 表示・送信・感想欄で同じ文を使う
  const deepList = quizDeep();
  if (!resumed) {
    draft = { round, deep_texts: deepList.map((d) => d.text), stage: "quiz", quiz: {} };
    writeDraft();
  }
  const examples = state.store.next_examples ?? q.examples;
  const adaptive = Boolean(state.store.next_deep);

  // 1問ずつの順番。最後に「ひとこと／引っかかり」の画面が付く
  const steps = quizOrder(deepList.length).map((step) => step.type === "fixed"
    ? { ...step, name: `f-${step.k}`, text: fixedText[step.k] }
    : { ...step, d: deepList[step.i], name: `d-${step.i}`, text: deepList[step.i].text });
  const total = steps.length;

  // 答えの持ち方と下書きへの出し入れは core.js（試験あり）
  let answers = emptyAnswers();

  // 1回目は、引っかかりの種類をはじめに選んであるので、最後の画面は文章だけ（ひとこと・任意）
  const concernLabel = round === 1 ? "ひとこと（任意）" : "いま、いちばん引っかかっていること";
  if (round === 1) answers.concern = state.store.first_concern ?? ""; // 前の版で書いたものがあれば入れておき、直せるようにする
  const score = (step) => scoreOf(answers, step);
  const kindPicked = () => (round === 1 ? state.store.first_concern_kind : answers.kind) ?? "";

  // 入力のたびに下書きへ（ページを離れても戻せるように）
  const capture = () => {
    draft.quiz = answersToQuiz(answers, deepList.length, kindPicked());
    writeDraft();
  };

  const fillSample = () => {
    answers = sampleAnswers(SAMPLE[role], deepList.length, round, answers);
    capture();
    render(total, h("p", { class: "notice" }, "回答例（架空）を入れました。そのまま「AIの見立てを見る」を押してください。"));
  };
  const sampleButton = () => h("button", { onclick: fillSample }, "回答例で試す");

  const send = (submit, err) => busy(submit, "AIが読んでいます…（20秒ほど）", async () => {
    err.replaceChildren();
    const fixed = Object.fromEntries(AXIS_KEYS.map((k) => [k, { text: fixedText[k], score: answers.fixed[k] || NaN }]));
    const deep = deepList.map((d, i) => ({ axis: d.axis, text: d.text, score: answers.deep[i] || NaN }));
    if ([...Object.values(fixed), ...deep].some((x) => !x.score)) {
      err.append(errorBox("すべての問いに答えてください。"));
      return;
    }
    const last = state.store.rounds.at(-1);
    const body = {
      role, round, fixed, deep, concern: answers.concern.trim(), profile: myProfile(),
      concern_kind: kindPicked(),
      history: state.store.rounds.slice(-12).map(({ round, date, scores, step, step_done, step_reason }) =>
        ({ round, date, scores, step: step || "", step_done: step_done ?? null, ...(step_done === false && step_reason ? { step_reason } : {}) })),
      prev_step: last?.step ? { text: last.step, done: last.step_done ?? null, ...stepMiss(last.step_done, last.step_reason, last.step_note) } : null,
    };
    try {
      const diagnosis = await api("/api/diagnose", body);
      state.current = { round, fixed, deep, concern: body.concern, concern_kind: body.concern_kind, diagnosis, history: body.history, prev_step: body.prev_step, id: roundId() };
      draft = { ...draft, stage: "diagnosis", current: state.current, pick: null, reply: "" };
      writeDraft();
      showDiagnosis();
    } catch (e) {
      err.append(errorBox(e.message));
    }
  });

  // i 番目の問い（total なら最後の画面）を出す
  const render = (i, notice = null, note = null) => {
    const head = (title) => [
      note,
      h("h1", {}, `${ROLE_NAME[role]}・${round} 回目`),
      h("div", { class: "progress" },
        h("span", {}, title),
        h("progress", { max: String(total + 1), value: String(i + 1), "aria-label": "進み具合" })),
    ];
    const heading = (text) => h("h2", { tabindex: "-1" }, text);
    let nodes;
    if (i >= total) {
      const concern = h("textarea", { id: "concern", maxlength: "400", placeholder: "例：任せたいのに、結局自分が決めてしまう", "aria-label": concernLabel });
      concern.value = answers.concern;
      concern.addEventListener("input", () => { answers.concern = concern.value; capture(); });
      // 引っかかりの中身（任意）。選ばなければ空のまま送り、AI には「まだ分からない」として渡る
      const kinds = h("div", { class: "steps kinds", role: "radiogroup", "aria-label": "その難しさにいちばん近いもの（任意）" },
        Object.entries(CONCERN_KINDS).map(([value, label]) =>
          h("label", {}, h("input", { type: "radio", name: "concern-kind", value, checked: answers.kind === value }), h("span", {}, label))));
      kinds.addEventListener("change", (ev) => { answers.kind = ev.target.value; capture(); });
      const err = h("div");
      const submit = h("button", { class: "primary" }, "AIの見立てを見る");
      submit.addEventListener("click", () => send(submit, err));
      nodes = [
        ...head(`最後の画面（${total}問に答えました）`),
        h("section", { class: "card" },
          heading(concernLabel),
          h("p", { class: "notice" }, round === 1 ? "ここまでの問いで言い足したいことがあれば。実名や取引先の名前は書かないでください。" : "実名や取引先の名前は書かないでください。"),
          concern,
          round === 1 ? null : h("div", { class: "q" }, "その難しさは、どれにいちばん近いですか（任意）", kinds)),
        h("div", { class: "row" }, h("button", { onclick: () => render(total - 1) }, "戻る"), submit, sampleButton()),
        notice,
        err,
      ];
    } else {
      const step = steps[i];
      const err = h("div");
      const go = (to) => { capture(); render(to); };
      const advance = () => {
        if (!score(step)) return err.replaceChildren(errorBox("ひとつ選んでください。"));
        go(i + 1);
      };
      const group = h("div", { class: "scale", role: "radiogroup", "aria-label": step.text },
        SCALE.map((s) =>
          h("label", {}, h("input", { type: "radio", name: step.name, value: s.value, checked: score(step) === s.value }), h("span", {}, s.label))));
      // 選んだ点は、矢印キーで選択が変わっただけでも残す（進まない）
      group.addEventListener("change", (ev) => { setScore(answers, step, Number(ev.target.value)); err.replaceChildren(); capture(); });
      // 進むのは、マウス・タッチのクリック（detail > 0）のときだけ。矢印キーやスペースの選択では進めない
      group.addEventListener("click", (ev) => {
        if (ev.detail === 0 || !group.isConnected) return;
        const input = ev.target.closest("label")?.querySelector("input") ?? (ev.target.matches("input") ? ev.target : null);
        if (!input) return;
        setScore(answers, step, Number(input.value));
        go(i + 1);
      });
      const fixed = step.type === "fixed";
      nodes = [
        ...head(`${i + 1} / ${total}`),
        adaptive && !fixed ? h("p", { class: "lead" }, round === 1
          ? "深掘りの問いは、はじめに選んでもらった内容を受けて作っています。"
          : "深掘りの問いは、前回のあなたの答えを受けて変わっています。") : null,
        fixed ? h("p", { class: "notice" }, "この4問の点数で、回ごとの変化を見ます。") : null,
        h("section", { class: "card" },
          h("div", { class: "q" },
            h("div", { class: "axis" }, fixed ? `推移を見る問い・${AXIS_NAMES[step.k]}` : `深掘り・${AXIS_NAMES[step.d.axis]}`),
            !fixed && step.d.because ? h("div", { class: "because" }, `この問いにした理由：${step.d.because}`) : null,
            heading(step.text),
            fixed ? h("div", { class: "example" }, examples[step.k]) : null,
            group)),
        h("div", { class: "row" },
          i > 0 ? h("button", { onclick: () => go(i - 1) }, "戻る") : null,
          h("button", { class: "primary", onclick: advance }, "次へ"),
          i === 0 ? sampleButton() : null),
        notice,
        err,
      ];
    }
    where("問い", [...AXIS_KEYS.map((k) => fixedText[k]), ...deepList.map((d) => d.text)]);
    // 手元モードの感想欄は、問いを進めても作り直さない（書きかけを消さないため）
    const box = HAND ? app.querySelector(':scope > .feedback[data-screen="問い"]') : null;
    if (box) place(nodes, box);
    else screen(...nodes);
    app.querySelector("h2[tabindex]")?.focus({ preventScroll: true });
  };

  if (resumed) answers = answersFromQuiz(draft.quiz, deepList.length, round, answers);
  else capture();
  render(firstOpenStep(answers, deepList.length), null, resumed ? resumedNote() : null);
}

// ---------------------------------------------------------------- 4. 見立てと学び、3分コーチング

function showDiagnosis(resumed = false) {
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
  const reply = h("textarea", { maxlength: "700", placeholder: "補足があれば自由に（候補になければ、ここに書いてください）", "aria-label": "コーチングへの答えの補足" });
  const err = h("div");
  const send = h("button", { class: "primary" }, "答えを送る");
  const capture = () => {
    draft.pick = app.querySelector("input[name=pick]:checked")?.value ?? null;
    draft.reply = reply.value;
    writeDraft();
  };
  const fillSample = h("button", { onclick: () => { app.querySelector("input[name=pick]").checked = true; reply.value = SAMPLE[state.role].reply; err.replaceChildren(h("p", { class: "notice" }, "回答例（架空）を入れました。")); capture(); } }, "回答例で試す");

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
      draft = { ...draft, stage: "steps", current: c, step: null, own: "" };
      writeDraft();
      showSteps();
    } catch (e) {
      err.append(errorBox(e.message));
    }
  }));

  where("見立てと3分コーチング", [d.lesson.check.question, d.coaching_question]);
  screen(
    resumed ? resumedNote() : null,
    h("h1", {}, `${round} 回目の見立て`),
    h("section", { class: "card" }, h("h2", {}, "今の状態"), h("p", {}, d.summary), notes),
    h("section", { class: "card" },
      h("h2", {}, "今日の学び"),
      h("div", { class: "lesson" }, h("h3", { style: "margin-top:0" }, d.lesson.title), h("p", {}, d.lesson.body)),
      h("h3", {}, "確かめの問い"),
      h("p", {}, d.lesson.check.question),
      h("div", { class: "choices" }, choices),
      result),
    h("section", { class: "card", onchange: capture, oninput: capture },
      h("h2", {}, "3分コーチング"),
      h("p", { class: "lesson" }, d.coaching_question),
      h("div", { class: "steps" }, picks),
      reply,
      h("div", { class: "row" }, send, fillSample),
      err),
  );
  if (resumed) {
    if (draft.pick != null) { const el = app.querySelector(`input[name=pick][value="${draft.pick}"]`); if (el) el.checked = true; }
    if (typeof draft.reply === "string") reply.value = draft.reply;
  }
}

function showSteps(resumed = false) {
  const c = state.current;
  const own = h("input", { type: "text", maxlength: "60", placeholder: "自分で書く", "aria-label": "今週の一歩を自分で書く" });
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
    const lesson = clipLesson(c.diagnosis?.lesson);
    state.store.rounds.push({ round: c.round, date: c.date, scores, step: c.step, step_done: null, ...(lesson ? { lesson } : {}) });
    state.store.next_deep = c.coaching.next_questions.map(({ axis, text, because }) => ({ axis, text, because }));
    state.store.next_examples = Object.fromEntries(AXIS_KEYS.map((k) => [k, c.coaching.fixed_examples[k].slice(0, 120)]));
    const ok = await save();
    if (!ok && HAND) {
      Object.assign(state.store, before); // 保存できなかった回は積まない（もう一度押せる）
      return err.replaceChildren(saveFailed());
    }
    clearDraft(); // 保存した回はもう開き直さない
    showDone(ok);
  }));

  const capture = () => {
    draft.step = app.querySelector("input[name=step]:checked")?.value ?? null;
    draft.own = own.value;
    writeDraft();
  };
  where("今週の一歩", c.coaching.step_options);
  screen(
    resumed ? resumedNote() : null,
    h("h1", {}, "今週の一歩を決める"),
    h("section", { class: "card" }, h("h2", {}, "コーチから"), h("p", {}, c.coaching.reflection)),
    h("section", { class: "card steps", onchange: capture, oninput: capture }, h("h2", {}, "どれをやりますか"), options,
      h("div", { class: "row" }, decide), err),
  );
  if (resumed) {
    if (draft.step != null) { const el = app.querySelector(`input[name=step][value="${draft.step}"]`); if (el) el.checked = true; }
    if (typeof draft.own === "string") own.value = draft.own;
  }
}

function showDone(saved) {
  const c = state.current;
  where("おつかれさま", c.coaching.next_questions.map((q) => q.text));
  screen(
    h("h1", {}, `${c.round} 回目、おつかれさまでした`),
    saved ? null : errorBox("このブラウザに記録を保存できませんでした（プライベートブラウズでは残りません）。"),
    HAND ? recordBox(c) : null,
    h("section", { class: "card" },
      h("h2", {}, "コーチに送るまとめ"),
      h("p", { class: "notice" }, "送りたい項目を選んで、コピーか共有で送れます。"),
      summaryBox(state.store.rounds.length - 1, { concern: c.concern, concern_kind: c.concern_kind, reply: c.coaching.reply }, true)),
    h("section", { class: "card" },
      h("h2", {}, "次の回の深掘りは、こう変わります"),
      h("p", { class: "notice" }, "今回の答えとコーチングを受けて、AIが作りました。"),
      c.coaching.next_questions.map((q) =>
        h("div", { class: "q" }, h("div", { class: "axis" }, AXIS_NAMES[q.axis]), h("div", { class: "because" }, `この問いにした理由：${q.because}`), q.text))),
    growthCard(false), // 過去の回のまとめは、この回のまとめと重なるので出さない
    h("div", { class: "row" }, h("button", { onclick: showHome }, "ホームへ"), h("button", { onclick: showStart }, "はじめに戻る")),
  );
}

// ---------------------------------------------------------------- 5. 育ちの記録

function growthCard(withPast = true) {
  const rounds = state.store.rounds;
  if (!rounds.length) return null;
  const rate = stepDoneRate(rounds);
  const lessons = rounds.filter((r) => r.lesson).reverse();

  const reset = () => {
    if (!confirm(`${ROLE_NAME[state.role]}の記録をすべて消します。元に戻せません。消すには「OK」、やめるには「キャンセル」を押してください。`)) return;
    try { localStorage.removeItem(key(state.role)); } catch {}
    clearDraft();
    showStart();
  };

  return h("section", { class: "card" },
    h("h2", {}, "育ちの記録"),
    chart(rounds),
    h("details", {}, h("summary", {}, "点数を表で見る"),
      h("table", {},
        h("tr", {}, h("th", {}, "回"), AXIS_KEYS.map((k) => h("th", {}, k))),
        rounds.map((r) => h("tr", {}, h("td", {}, `${r.round}回目（${r.date}）`), AXIS_KEYS.map((k) => h("td", {}, r.scores[k])))))),
    lessons.length ? h("h3", {}, "これまでの学び") : null,
    lessons.map((r) => h("details", { class: "learned" }, h("summary", {}, `${r.round}回目：${r.lesson.title}`), h("p", {}, r.lesson.body))),
    h("h3", {}, "これまでの一歩" + (rate == null ? "" : `（やれた率 ${rate}%）`)),
    h("ul", {}, rounds.slice().reverse().map((r) =>
      h("li", {}, `${r.round}回目：${r.step}`, r.step_done === true ? "（やれた）"
        : r.step_done === false ? `（やれなかった${r.step_reason ? `・${STEP_MISS_REASONS[r.step_reason]}` : ""}）` : "（次の回で確認）"))),
    withPast ? pastSummaries(rounds) : null,
    // 手元モードの記録はファイルなので、画面からは消さない
    HAND ? null : h("div", { class: "row", style: "margin-top:20px" }, h("button", { onclick: reset }, "記録をすべて消す")),
  );
}

// 過去の回のまとめ。回を選ぶと、その回の記録に残っているもの（一歩・結果・理由・点数・学び）でまとめを作る
function pastSummaries(rounds) {
  const slot = h("div");
  const sel = h("select", { "aria-label": "どの回のまとめか" },
    rounds.map((r, i) => h("option", { value: String(i) }, `${r.round}回目（${r.date}）`)).reverse());
  sel.value = String(rounds.length - 1);
  const show = () => slot.replaceChildren(summaryBox(Number(sel.value))); // 回を替えたら選んだ項目も最初に戻す
  sel.addEventListener("change", show);
  show();
  return h("details", { class: "learned" }, h("summary", {}, "過去の回のまとめを送る"), h("div", { class: "summary" }, sel, slot));
}

// ---------------------------------------------------------------- コーチに送るまとめ
// 本人が項目を選び、コピーか共有で送る。託すノートからはどこにも送らない。
// 最初から入れるのは一歩だけ（ひとこと・点数・引っかかりなど、人に見せたくないものもあるため）

const SUMMARY_ITEMS = [
  ["step", "一歩（前回の一歩とやれたか・今週の一歩）", true],
  ["note", "やれなかったときの、ひとこと（一歩と一緒に入ります）", false],
  ["scores", "4つの軸の点数", false],
  ["lesson", "今日の学びの題", false],
  ["concern", "いちばん引っかかっていること", false],
  ["reply", "3分コーチングでの答え", false],
];

function summaryBox(index, extra = {}, mainAction = false) {
  const rounds = state.store.rounds;
  const r = rounds[index];
  const prev = rounds[index - 1];
  const has = {
    step: Boolean(r.step || prev?.step),
    note: Boolean(prev?.step && stepMiss(prev.step_done, prev.step_reason, prev.step_note).note),
    scores: true,
    lesson: Boolean(r.lesson?.title),
    concern: Boolean(extra.concern?.trim()),
    reply: Boolean(extra.reply?.trim()),
  };
  const pick = Object.fromEntries(SUMMARY_ITEMS.map(([k, , on]) => [k, on && has[k]]));
  const text = h("textarea", { readonly: true, rows: "6", "aria-label": "まとめの文" });
  const status = h("p", { class: "notice", role: "status" });
  const copy = h("button", { class: mainAction ? "primary" : "" }, "コピー"); // 主ボタンは1画面に1つ（完了画面ではここ、ホームでは「次の回を始める」）
  const share = typeof navigator.share === "function" ? h("button", {}, "共有") : null;

  const update = () => {
    const summary = roundSummary(ROLE_NAME[state.role], rounds, index, pick, extra);
    const empty = !summary.includes("\n"); // 見出しの1行だけなら、送るものがない
    text.value = empty ? "" : summary;
    copy.disabled = empty;
    if (share) share.disabled = empty;
    status.textContent = empty ? "入れる項目を1つ以上選んでください。" : "";
  };
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text.value);
      status.textContent = "コピーしました。LINE やメールに貼り付けて送ってください。";
    } catch {
      text.focus();
      text.select();
      status.textContent = "自動ではコピーできませんでした。選んである文を、長押しやメニューからコピーしてください。";
    }
  });
  share?.addEventListener("click", async () => {
    try {
      await navigator.share({ text: text.value });
    } catch (e) {
      if (e?.name !== "AbortError") status.textContent = "共有できませんでした。「コピー」を使ってください。"; // 取り消しは何も出さない
    }
  });

  const checks = SUMMARY_ITEMS.filter(([k]) => has[k]).map(([k, label]) => {
    const box = h("input", { type: "checkbox" });
    box.checked = pick[k];
    box.addEventListener("change", () => { pick[k] = box.checked; update(); });
    return h("label", {}, box, h("span", {}, label));
  });
  update();
  return h("div", { class: "summary" },
    h("div", { class: "steps" }, checks),
    text,
    h("div", { class: "row" }, copy, share),
    status,
    h("p", { class: "notice" }, "このまとめを作るときは、どこにも送りません。「共有」を押すと、選んだアプリに渡ります。"));
}

// 推移は軸ごとに1行ずつ（4本を1枚に重ねると、同じ点が続いたとき線と記号がぶつかって読めないため）。
// 左に軸の名前、中に小さな折れ線、右に今の点と1回目からの変化。回の文字は最初と最後だけ（回が増えても重ならない）
function chart(rounds) {
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs = {}, text) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    return el;
  };
  const W = 240, H = 44, P = 8;
  const n = rounds.length;
  const x = (i) => (n === 1 ? W / 2 : P + (i * (W - 2 * P)) / (n - 1));
  const y = (v) => 6 + ((4 - v) * (H - 12)) / 3;
  const series = seriesByAxis(rounds);

  const rows = AXIS_KEYS.map((k) => {
    const pts = series[k];
    const color = `var(--series-${k})`;
    const svg = s("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${AXIS_NAMES[k]}の点数の推移：${pts.map((p) => p.value).join("、")}` });
    for (let v = 1; v <= 4; v++) svg.append(s("line", { x1: P, x2: W - P, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 }));
    if (pts.length > 1) {
      svg.append(s("polyline", {
        points: pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" "),
        fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    }
    pts.forEach((p, i) => {
      const last = i === pts.length - 1;
      if (!last && n > 12) return; // 回が多いと点が並んで線が点線に見えるので、途中の点は省く（細かくは表で見る）
      const c = s("circle", { cx: x(i), cy: y(p.value), r: last ? 4.5 : 3, fill: color, stroke: "var(--surface-1)", "stroke-width": 2 });
      c.append(s("title", {}, `${p.round}回目・${AXIS_NAMES[k]}：${p.value}`));
      svg.append(c);
    });
    const now = pts.at(-1).value;
    const diff = now - pts[0].value;
    return h("div", { class: "axrow" },
      h("div", { class: "nm" }, h("i", { style: `background:${color}` }), AXIS_NAMES[k]),
      h("div", {}, svg),
      h("div", { class: "val" }, `今 ${now}`, n > 1 ? h("small", {}, `（${diff > 0 ? "+" : ""}${diff}）`) : null));
  });
  const foot = h("div", { class: "axrow axfoot" }, h("div", { class: "nm" }),
    h("div", { class: "ends" }, h("span", {}, `${rounds[0].round}回目`), n > 1 ? h("span", {}, `${rounds.at(-1).round}回目`) : null),
    h("div", { class: "val" }, n > 1 ? "（1回目から）" : ""));
  return h("div", { class: "axes" }, rows, foot);
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
          diagnosis: c.diagnosis, coaching: c.coaching, step: c.step, prev_step: c.prev_step,
        },
      });
      status.textContent = `この回の記録を残しました（rounds/${out.file}）。答えたことは「わたしのこと.md」にも足しました。`;
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
  const text = h("textarea", { maxlength: "1000", rows: "2", placeholder: "この画面で気になったこと（任意）", "aria-label": "この画面で気になったこと（任意）" });
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
  return h("section", { class: "card feedback", "data-screen": name },
    h("h2", {}, "気になったこと（手元モード）"),
    pick, text, h("div", { class: "row" }, sendButton), status);
}

showStart();
