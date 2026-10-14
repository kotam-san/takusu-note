// 画面に依存しない計算（テスト対象）：記録の検証、照合コード、推移。

export const AXIS_KEYS = ["A", "B", "C", "D"];
export const STORE_VERSION = 1;

// ---------------------------------------------------------------- 照合コード
// 形式：LG1-<立場 C|L>-<A><B><C><D>  例：LG1-C-3241
// 中身は4軸の点数だけ。改ざん防止や本人確認はしない（画面にもそう書く）。

export function encodePairCode(role, scores) {
  const r = role === "ceo" ? "C" : role === "leader" ? "L" : null;
  if (!r) throw new Error("role");
  const digits = AXIS_KEYS.map((k) => {
    const v = scores?.[k];
    if (!Number.isInteger(v) || v < 1 || v > 4) throw new Error("score");
    return String(v);
  });
  return `LG1-${r}-${digits.join("")}`;
}

export function decodePairCode(code) {
  const m = /^LG1-([CL])-([1-4]{4})$/.exec(String(code ?? "").trim().toUpperCase());
  if (!m) return null;
  const scores = Object.fromEntries(AXIS_KEYS.map((k, i) => [k, Number(m[2][i])]));
  return { role: m[1] === "C" ? "ceo" : "leader", scores };
}

// 自分と相手の点数を並べ、ずれ（自分−相手）を出す
export function compareScores(mine, theirs) {
  return AXIS_KEYS.map((k) => ({ axis: k, mine: mine[k], theirs: theirs[k], gap: mine[k] - theirs[k] }));
}

// ---------------------------------------------------------------- 記録の形の検証
// localStorage は利用者も書き換えられるので、読み込むたびに形と範囲を確かめる。
// 壊れていれば null を返し、画面は「記録が読めませんでした」と出して新しく始める。

const isScore = (v) => Number.isInteger(v) && v >= 1 && v <= 4;
const isStr = (v, max) => typeof v === "string" && v.length <= max;

export function validateStore(data) {
  if (!data || typeof data !== "object" || data.version !== STORE_VERSION) return null;
  if (!Array.isArray(data.rounds) || data.rounds.length > 100) return null;
  for (const r of data.rounds) {
    if (!r || typeof r !== "object") return null;
    if (!Number.isInteger(r.round) || !isStr(r.date, 10)) return null;
    if (!AXIS_KEYS.every((k) => isScore(r.scores?.[k]))) return null;
    if (!isStr(r.step ?? "", 80)) return null;
    if (![true, false, null, undefined].includes(r.step_done)) return null;
  }
  if (data.next_deep != null) {
    if (!Array.isArray(data.next_deep) || data.next_deep.length > 8) return null;
    for (const q of data.next_deep) {
      if (!AXIS_KEYS.includes(q?.axis) || !isStr(q?.text, 120) || !isStr(q?.because ?? "", 120)) return null;
    }
  }
  return data;
}

export function emptyStore() {
  return { version: STORE_VERSION, rounds: [], next_deep: null };
}

// ---------------------------------------------------------------- 推移

// 回ごとの点数を軸別の系列にする（グラフ用）
export function seriesByAxis(rounds) {
  return Object.fromEntries(AXIS_KEYS.map((k) => [k, rounds.map((r) => ({ round: r.round, value: r.scores[k] }))]));
}

// 最初の回から最新の回への変化
export function changeSinceFirst(rounds) {
  if (rounds.length < 2) return null;
  const first = rounds[0].scores;
  const last = rounds[rounds.length - 1].scores;
  return Object.fromEntries(AXIS_KEYS.map((k) => [k, last[k] - first[k]]));
}

// 一歩をやれた割合（確認済みの回だけで数える）
export function stepDoneRate(rounds) {
  const checked = rounds.filter((r) => r.step_done === true || r.step_done === false);
  if (!checked.length) return null;
  return Math.round((checked.filter((r) => r.step_done === true).length / checked.length) * 100);
}
