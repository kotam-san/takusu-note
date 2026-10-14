// リーダーの育ち帳：画面の動き。
// 表示はすべて textContent で入れる（AIの出力や自由記述をHTMLとして解釈しない）。

import {
  AXIS_KEYS, changeSinceFirst, compareScores, decodePairCode, emptyStore,
  encodePairCode, seriesByAxis, stepDoneRate, validateStore,
} from "./core.js";
import { AXIS_NAMES, QUESTIONS, SAMPLE, SCALE } from "./questions.js";

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API_BASE = LOCAL ? "http://localhost:8787" : "https://leader-growth.kota-m.workers.dev";
const ROLE_NAME = { ceo: "社長", leader: "幹部" };

const app = document.getElementById("app");
let state = { role: null, store: null, current: null };

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

function screen(...nodes) {
  app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false), footer());
  window.scrollTo({ top: 0 });
}

function footer() {
  return h("footer", {},
    "試作版です。答えは診断のために AI（Claude）へ送られますが、サーバーには保存しません。記録はこのブラウザの中だけに残ります。",
    h("br"), "掲載の回答例はすべて架空です。");
}

function errorBox(msg) {
  return h("p", { class: "error", role: "alert" }, msg);
}

// ---------------------------------------------------------------- 記録（このブラウザの中だけ）

const key = (role) => `lg.v1.${role}`;

function load(role) {
  try {
    const raw = localStorage.getItem(key(role));
    if (!raw) return { store: emptyStore(), broken: false };
    const data = validateStore(JSON.parse(raw));
    return data ? { store: data, broken: false } : { store: emptyStore(), broken: true };
  } catch {
    return { store: emptyStore(), broken: true };
  }
}

function save() {
  try {
    localStorage.setItem(key(state.role), JSON.stringify(state.store));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- AI を呼ぶ

async function api(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  const roleButton = (role, desc) =>
    h("button", { onclick: () => chooseRole(role) }, h("b", {}, ROLE_NAME[role]), desc);

  screen(
    h("h1", {}, "リーダーの育ち帳"),
    h("p", { class: "lead" }, "社長の期待に、成果で応える幹部を育てるための試作です。診断で終わらず、答えるたびに問いが変わり、回を重ねるほど自分の状態が見えてきます。"),
    h("ol", { class: "flow" },
      h("li", {}, h("b", {}, "1"), "10の問いに答える"),
      h("li", {}, h("b", {}, "2"), "AIの見立てと今日の学び"),
      h("li", {}, h("b", {}, "3"), "3分コーチングで今週の一歩"),
      h("li", {}, h("b", {}, "4"), "次の回は、答えに合わせて問いが変わる"),
    ),
    h("section", { class: "card" },
      h("h2", {}, "あなたの立場を選んでください"),
      h("div", { class: "role" },
        roleButton("ceo", "任せ方・育て方を見直す"),
        roleButton("leader", "任され方・動き方を見直す"),
      ),
      h("p", { class: "notice", style: "margin-top:16px" },
        "答えと自由記述は、診断のために AI（Claude）へ送られます。サーバーには保存しません。実名や取引先の名前は書かないでください。"),
    ),
  );
}

function chooseRole(role) {
  const { store, broken } = load(role);
  state = { role, store, current: null };
  if (broken) {
    screen(
      errorBox("このブラウザの記録が読めませんでした。新しく始めます。"),
      h("button", { class: "primary", onclick: () => { save(); showHome(); } }, "新しく始める"),
    );
    return;
  }
  showHome();
}

// ---------------------------------------------------------------- 2. 立場ごとのホーム

function showHome() {
  const { rounds } = state.store;
  if (!rounds.length) return startRound();
  screen(
    h("h1", {}, `${ROLE_NAME[state.role]}の育ち帳`),
    h("p", { class: "lead" }, `これまで ${rounds.length} 回。次は ${rounds.length + 1} 回目です。`),
    growthCard(),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: startRound }, `${rounds.length + 1} 回目を始める`),
      h("button", { onclick: showStart }, "立場を選び直す"),
    ),
  );
}

// ---------------------------------------------------------------- 3. 問い

function startRound() {
  const last = state.store.rounds.at(-1);
  if (last && last.step && last.step_done == null) return askPrevStep(last);
  showQuiz();
}

function askPrevStep(last) {
  const answer = (done) => {
    last.step_done = done;
    save();
    showQuiz();
  };
  screen(
    h("section", { class: "card" },
      h("h2", {}, "前回の一歩、やれましたか"),
      h("p", { class: "lesson" }, last.step),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: () => answer(true) }, "やれた"),
        h("button", { onclick: () => answer(false) }, "やれなかった"),
      ),
      h("p", { class: "notice", style: "margin-top:12px" }, "やれなかったことも、次の問いを作る材料になります。"),
    ),
  );
}

function showQuiz() {
  const role = state.role;
  const round = state.store.rounds.length + 1;
  const q = QUESTIONS[role];
  const deepList = state.store.next_deep ?? q.deep;
  const adaptive = Boolean(state.store.next_deep);

  const scaleFor = (name) =>
    h("div", { class: "scale", role: "radiogroup" },
      SCALE.map((s) =>
        h("label", {}, h("input", { type: "radio", name, value: s.value }), h("span", {}, s.label))));

  const fixedBlocks = AXIS_KEYS.map((k) =>
    h("div", { class: "q" }, h("div", { class: "axis" }, `推移を見る問い・${AXIS_NAMES[k]}`), q.fixed[k], scaleFor(`f-${k}`)));

  const deepBlocks = deepList.map((d, i) =>
    h("div", { class: "q" },
      h("div", { class: "axis" }, `深掘り・${AXIS_NAMES[d.axis]}`),
      d.because ? h("div", { class: "because" }, `この問いにした理由：${d.because}`) : null,
      d.text,
      scaleFor(`d-${i}`)));

  const concern = h("textarea", { id: "concern", maxlength: "400", placeholder: "例：任せたいのに、結局自分が決めてしまう" });
  const err = h("div");
  const submit = h("button", { class: "primary" }, "AIの見立てを見る");

  const fillSample = () => {
    const s = SAMPLE[role];
    AXIS_KEYS.forEach((k) => (app.querySelector(`input[name=f-${k}][value="${s.fixed[k]}"]`).checked = true));
    deepList.forEach((_, i) => (app.querySelector(`input[name=d-${i}][value="${s.deep[i] ?? 2}"]`).checked = true));
    concern.value = s.concern;
  };

  submit.addEventListener("click", () => busy(submit, "AIが読んでいます…（20秒ほど）", async () => {
    err.replaceChildren();
    const pick = (name) => Number(app.querySelector(`input[name=${name}]:checked`)?.value);
    const fixed = Object.fromEntries(AXIS_KEYS.map((k) => [k, { text: q.fixed[k], score: pick(`f-${k}`) }]));
    const deep = deepList.map((d, i) => ({ axis: d.axis, text: d.text, score: pick(`d-${i}`) }));
    if ([...Object.values(fixed), ...deep].some((x) => !x.score)) {
      err.append(errorBox("すべての問いに答えてください。"));
      return;
    }
    const last = state.store.rounds.at(-1);
    const body = {
      role, round, fixed, deep, concern: concern.value.trim(),
      history: state.store.rounds.map(({ round, date, scores, step, step_done }) => ({ round, date, scores, step: step || "", step_done: step_done ?? null })),
      prev_step: last?.step ? { text: last.step, done: last.step_done ?? null } : null,
    };
    try {
      const diagnosis = await api("/api/diagnose", body);
      state.current = { round, fixed, deep, concern: body.concern, diagnosis };
      showDiagnosis();
    } catch (e) {
      err.append(errorBox(e.message));
    }
  }));

  screen(
    h("h1", {}, `${ROLE_NAME[role]}・${round} 回目`),
    adaptive ? h("p", { class: "lead" }, "深掘りの問いは、前回のあなたの答えを受けて変わっています。") : null,
    h("section", { class: "card" }, h("h2", {}, "毎回同じ4つの問い"), h("p", { class: "notice" }, "この4問の点数で、回ごとの変化を見ます。"), fixedBlocks),
    h("section", { class: "card" }, h("h2", {}, adaptive ? "今回の深掘り" : "深掘りの問い"), deepBlocks),
    h("section", { class: "card" },
      h("h2", {}, "いま、いちばん引っかかっていること"),
      h("p", { class: "notice" }, "実名や取引先の名前は書かないでください。"),
      concern),
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

  const reply = h("textarea", { maxlength: "800", placeholder: "思いつくままで大丈夫です" });
  const err = h("div");
  const send = h("button", { class: "primary" }, "答えを送る");
  const fillSample = h("button", { onclick: () => (reply.value = SAMPLE[state.role].reply) }, "回答例で試す");

  send.addEventListener("click", () => busy(send, "受け止めています…", async () => {
    err.replaceChildren();
    if (!reply.value.trim()) {
      err.append(errorBox("ひとことでも書いてみてください。"));
      return;
    }
    const c = state.current;
    try {
      const out = await api("/api/coach", {
        role: state.role, question: d.coaching_question, reply: reply.value.trim(),
        summary: d.summary, concern: c.concern, fixed: c.fixed,
      });
      c.coaching = { question: d.coaching_question, reply: reply.value.trim(), ...out };
      showSteps();
    } catch (e) {
      err.append(errorBox(e.message));
    }
  }));

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

  const decide = () => {
    const v = app.querySelector("input[name=step]:checked")?.value;
    const step = v === "own" ? own.value.trim() : c.coaching.step_options[Number(v)];
    if (!step) {
      err.replaceChildren(errorBox("今週の一歩を1つ選んでください。"));
      return;
    }
    const scores = Object.fromEntries(AXIS_KEYS.map((k) => [k, c.fixed[k].score]));
    state.store.rounds.push({ round: c.round, date: new Date().toISOString().slice(0, 10), scores, step: step.slice(0, 80), step_done: null });
    state.store.next_deep = c.coaching.next_questions.map(({ axis, text, because }) => ({ axis, text, because }));
    const ok = save();
    showDone(ok);
  };

  screen(
    h("h1", {}, "今週の一歩を決める"),
    h("section", { class: "card" }, h("h2", {}, "コーチから"), h("p", {}, c.coaching.reflection)),
    h("section", { class: "card steps" }, h("h2", {}, "どれをやりますか"), options,
      h("div", { class: "row" }, h("button", { class: "primary", onclick: decide }, "これに決める")), err),
  );
}

function showDone(saved) {
  const c = state.current;
  screen(
    h("h1", {}, `${c.round} 回目、おつかれさまでした`),
    saved ? null : errorBox("このブラウザに記録を保存できませんでした（プライベートブラウズでは残りません）。"),
    h("section", { class: "card" },
      h("h2", {}, "次の回の深掘りは、こう変わります"),
      h("p", { class: "notice" }, "今回の答えとコーチングを受けて、AIが作りました。"),
      c.coaching.next_questions.map((q) =>
        h("div", { class: "q" }, h("div", { class: "axis" }, AXIS_NAMES[q.axis]), h("div", { class: "because" }, q.because), q.text))),
    growthCard(),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: showHome }, "記録を見る"), h("button", { onclick: showStart }, "はじめに戻る")),
  );
}

// ---------------------------------------------------------------- 5. 育ちの記録・照合

function growthCard() {
  const rounds = state.store.rounds;
  if (!rounds.length) return null;
  const last = rounds.at(-1);
  const change = changeSinceFirst(rounds);
  const rate = stepDoneRate(rounds);
  const code = encodePairCode(state.role, last.scores);

  const other = h("input", { class: "code-in", placeholder: "LG1-L-2314", "aria-label": "相手の照合コード" });
  const compareOut = h("div");
  const compare = () => {
    const decoded = decodePairCode(other.value);
    if (!decoded) return compareOut.replaceChildren(errorBox("照合コードの形が違います（例：LG1-L-2314）。"));
    const rows = compareScores(last.scores, decoded.scores);
    compareOut.replaceChildren(
      h("table", {},
        h("tr", {}, h("th", {}, "軸"), h("th", {}, `あなた（${ROLE_NAME[state.role]}）`), h("th", {}, `相手（${ROLE_NAME[decoded.role]}）`), h("th", {}, "ずれ")),
        rows.map((r) => h("tr", {},
          h("td", {}, AXIS_NAMES[r.axis]), h("td", {}, r.mine), h("td", {}, r.theirs),
          h("td", { class: Math.abs(r.gap) >= 2 ? "gap-big" : "" }, r.gap > 0 ? `+${r.gap}` : r.gap)))),
      h("p", { class: "notice", style: "margin-top:8px" }, "ずれが2以上の軸は、同じ場面を違って見ている可能性があります。どちらが正しいかではなく、話すきっかけに使ってください。"));
  };

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
    h("h3", {}, "社長と幹部で見比べる"),
    h("p", { class: "notice" }, "あなたの照合コードを相手に渡し、相手のコードを入れると、4つの軸の見え方のずれが並びます。コードに入っているのは最新の4軸の点数だけです（自由記述は入りません）。改ざん防止や本人確認はしません。"),
    h("p", {}, "あなたのコード：", h("span", { class: "code" }, code)),
    h("div", { class: "row" }, other, h("button", { onclick: compare }, "見比べる")),
    compareOut,
    h("div", { class: "row", style: "margin-top:20px" }, h("button", { onclick: reset }, "記録をすべて消す")),
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

showStart();
