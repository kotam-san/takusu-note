// 手元モードの入口（local/server.mjs）の試験。本物の claude は呼ばず、偽の claude で確かめる。
// 実行：node --test tests/local.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18769;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "takusu-local-"));
const DATA = path.join(tmp, "data");
const MODE = path.join(tmp, "mode");
const LOG = path.join(tmp, "log");
let server;
let token;

const setMode = (m) => fs.writeFileSync(MODE, m);
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function req(p, { method = "GET", body, headers = {}, withToken = true, origin = BASE } = {}) {
  const h = { ...headers };
  if (withToken) h["X-Takusu-Token"] = token;
  if (method !== "GET") {
    h["Content-Type"] ??= "application/json";
    if (origin) h.Origin = origin;
  }
  return fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

before(async () => {
  setMode("ok");
  server = spawn(process.execPath, [path.join(ROOT, "local/server.mjs"), "--data", DATA, "--port", String(PORT)], {
    env: { ...process.env, TAKUSU_CLAUDE_BIN: path.join(ROOT, "tests/fixtures/fake-claude.mjs"), FAKE_MODE_FILE: MODE, FAKE_LOG: LOG, TAKUSU_AI_TIMEOUT_MS: "1500" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (b) => String(b).includes("起動しました") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const html = await (await fetch(BASE + "/")).text();
  token = html.match(/<meta name="tn-hand" content="([0-9a-f]+)">/)[1];
});

after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fixed = Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, { text: "問い", score: 2 }]));
const profile = { employees: "6-20", years: "1-3", industry: "mfg" };

// ---------------------------------------------------------------- 合い鍵・Host・Origin

test("index.html にだけ合い鍵が入り、公開の docs/index.html には無い", async () => {
  assert.equal(token.length, 48);
  assert.ok(!fs.readFileSync(path.join(ROOT, "docs/index.html"), "utf8").includes("tn-hand\" content"));
  const js = await (await fetch(BASE + "/app.js")).text();
  assert.ok(!js.includes(token));
  const res = await fetch(BASE + "/");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("決まったファイルのほかは配らない", async () => {
  for (const p of ["/../local/server.mjs", "/%2e%2e/local/server.mjs", "/README.md", "/worker/src/index.js"]) {
    assert.equal((await fetch(BASE + p)).status, 404, p);
  }
});

test("合い鍵がない・違うと 401（GET も）", async () => {
  assert.equal((await req("/api/store/ceo", { withToken: false })).status, 401);
  assert.equal((await req("/api/store/ceo", { headers: { "X-Takusu-Token": "x".repeat(48) }, withToken: false })).status, 401);
  assert.equal((await req("/api/feedback", { method: "POST", body: { text: "a" }, withToken: false })).status, 401);
});

test("Host が違うと 421", async () => {
  const res = await new Promise((resolve) => {
    import("node:http").then(({ default: http }) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/", headers: { Host: "evil.example" } }, resolve);
    });
  });
  assert.equal(res.statusCode, 421);
});

test("書き込みは Origin が完全一致・JSON のときだけ", async () => {
  assert.equal((await req("/api/feedback", { method: "POST", body: { text: "a" }, origin: "http://evil.example" })).status, 403);
  assert.equal((await req("/api/feedback", { method: "POST", body: { text: "a" }, origin: null })).status, 403);
  assert.equal((await req("/api/feedback", { method: "POST", body: { text: "a" }, headers: { "Content-Type": "text/plain" } })).status, 415);
});

// ---------------------------------------------------------------- AI の3つの道

test("3つの道が通り、claude には何も読み書きさせない引数で渡す", async () => {
  setMode("ok");
  fs.rmSync(LOG, { force: true });
  const s = await req("/api/start", { method: "POST", body: { role: "ceo", profile, concern: "固有の悩みQ7" } });
  assert.equal(s.status, 200);
  assert.equal((await s.json()).next_questions.length, 6);
  const d = await req("/api/diagnose", { method: "POST", body: { role: "ceo", round: 1, fixed, deep: [], profile } });
  assert.equal(d.status, 200);
  const c = await req("/api/coach", { method: "POST", body: { role: "ceo", question: "q", reply: "r", fixed } });
  assert.equal(c.status, 200);
  assert.equal((await c.json()).step_options.length, 3);

  const log = calls();
  assert.equal(log.length, 3);
  for (const { args } of log) {
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at("--model"), "claude-sonnet-5-5");
    assert.equal(at("--tools"), "");
    assert.equal(at("--setting-sources"), "");
    assert.equal(at("--permission-mode"), "dontAsk");
    for (const flag of ["-p", "--strict-mcp-config", "--safe-mode", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
    assert.deepEqual(JSON.parse(fs.readFileSync(at("--mcp-config"), "utf8")), { mcpServers: {} });
  }
  assert.match(log[0].stdin, /固有の悩みQ7/); // 本文は標準入力で渡す（引数に載せない）
  assert.ok(!log[0].args.some((a) => a.includes("固有の悩みQ7")));
});

test("入力が違えば 400 で、AI は呼ばない", async () => {
  fs.rmSync(LOG, { force: true });
  const res = await req("/api/diagnose", { method: "POST", body: { role: "admin" } });
  assert.equal(res.status, 400);
  assert.equal((await req("/api/start", { method: "POST", body: "{bad" })).status, 400);
  assert.equal(calls().length, 0);
});

test("AI の答えがおかしいときは 502", async () => {
  for (const mode of ["badshape", "exit1", "is_error", "badjson"]) {
    setMode(mode);
    const res = await req("/api/start", { method: "POST", body: { role: "ceo", profile } });
    assert.equal(res.status, 502, mode);
    assert.equal((await res.json()).error, "ai_failed");
  }
  setMode("ok");
});

test("時間切れは 502 で、claude は残らない", async () => {
  setMode("hang");
  fs.rmSync(LOG, { force: true });
  const res = await req("/api/start", { method: "POST", body: { role: "ceo", profile } });
  assert.equal(res.status, 502);
  const [{ pid }] = calls();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pid), false);
  setMode("ok");
});

test("画面が途中で切れたら claude を止める", async () => {
  setMode("hang");
  fs.rmSync(LOG, { force: true });
  const ctrl = new AbortController();
  const p = fetch(BASE + "/api/start", {
    method: "POST", signal: ctrl.signal,
    headers: { "X-Takusu-Token": token, "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ role: "ceo", profile }),
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 400));
  const [{ pid }] = calls();
  ctrl.abort();
  await p;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pid), false);
  setMode("ok");
});

// ---------------------------------------------------------------- 記録

const store = (rounds = []) => ({ version: 1, rounds, next_deep: null, next_examples: null, profile, first_concern: null });

test("記録の読み書き：はじめは空、保存すると版が進み、ファイルは 600", async () => {
  const first = await (await req("/api/store/leader")).json();
  assert.deepEqual(first, { version: 0, store: null, broken: false });
  const put = await req("/api/store/leader", { method: "PUT", body: { version: 0, store: store() } });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { version: 1 });
  const again = await (await req("/api/store/leader")).json();
  assert.equal(again.version, 1);
  assert.deepEqual(again.store, store());
  assert.equal(fs.statSync(path.join(DATA, "leader.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(DATA).mode & 0o777, 0o700);
});

test("記録の保存だけは学びが積み上がっても受け取る（512KB まで）。ほかの道は 64KB のまま", async () => {
  const sc = { A: 2, B: 2, C: 3, D: 1 };
  const rounds = Array.from({ length: 100 }, (_, i) => ({
    round: i + 1, date: "2026-10-28", scores: sc, step: "一歩".repeat(20), step_done: true,
    lesson: { title: "題".repeat(40), body: "本".repeat(600) },
  }));
  const big = store(rounds);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 64_000);
  const cur = await (await req("/api/store/ceo")).json();
  assert.equal((await req("/api/store/ceo", { method: "PUT", body: { version: cur.version, store: big } })).status, 200);
  const again = await (await req("/api/store/ceo")).json();
  assert.equal(again.store.rounds[99].lesson.body.length, 600);
  const huge = await req("/api/store/ceo", { method: "PUT", body: { version: again.version, store: big, pad: "あ".repeat(180_000) } });
  assert.equal(huge.status, 413);
  const fb = await req("/api/feedback", { method: "POST", body: { role: "ceo", screen: "x", text: "あ".repeat(30_000) } });
  assert.equal(fb.status, 413);
});

test("古い版からの上書きは 409", async () => {
  const cur = await (await req("/api/store/ceo")).json();
  assert.equal((await req("/api/store/ceo", { method: "PUT", body: { version: cur.version, store: store() } })).status, 200);
  const stale = await req("/api/store/ceo", { method: "PUT", body: { version: cur.version, store: store() } });
  assert.equal(stale.status, 409);
});

test("形の違う記録は保存しない・壊れたファイルは broken と返す", async () => {
  const bad = await req("/api/store/ceo", { method: "PUT", body: { version: 0, store: { version: 9 } } });
  assert.equal(bad.status, 400);
  fs.writeFileSync(path.join(DATA, "leader.json"), "{broken");
  assert.equal((await (await req("/api/store/leader")).json()).broken, true);
});

test("立場の名前でフォルダの外に書けない", async () => {
  for (const p of ["/api/store/admin", "/api/store/..%2fceo", "/api/store/ceo/x"]) {
    const res = await req(p, { method: "PUT", body: { version: 0, store: store() } });
    assert.ok([404, 405].includes(res.status), p);
  }
  assert.deepEqual(fs.readdirSync(tmp).sort(), ["data", "log", "mode"].filter((f) => fs.existsSync(path.join(tmp, f))).sort());
});

const record = {
  round: 1, date: "2026-10-25", profile, fixed, deep: [{ axis: "A", text: "深掘り", score: 3 }], concern: "引っかかり",
  diagnosis: { summary: "見立て", axis_notes: [{ axis: "A", note: "メモ" }], lesson: { title: "学び", body: "本文" } },
  coaching: { question: "コーチの問い", reply: "選んだ候補：x\n補足：y", reflection: "受け止め", next_questions: [{ axis: "B", text: "次の問い" }] },
  step: "部下に1つ任せる",
};

test("1回の記録を Markdown で残し、送り直しても重複しない", async () => {
  const body = { role: "ceo", round_id: "abc12345", record };
  const one = await (await req("/api/record", { method: "POST", body })).json();
  assert.deepEqual(one, { file: "2026-10-25_ceo_1回目.md", duplicate: false });
  const two = await (await req("/api/record", { method: "POST", body })).json();
  assert.equal(two.duplicate, true);
  const other = await (await req("/api/record", { method: "POST", body: { ...body, round_id: "zzz99999" } })).json();
  assert.equal(other.file, "2026-10-25_ceo_1回目_2.md");

  const md = fs.readFileSync(path.join(DATA, "rounds", one.file), "utf8");
  assert.match(md, /round_id: abc12345/);
  assert.match(md, /# 社長・1 回目/);
  assert.match(md, /部下に1つ任せる/);
  assert.match(md, /答え：選んだ候補：x \/ 補足：y/);
  assert.equal(fs.statSync(path.join(DATA, "rounds", one.file)).mode & 0o777, 0o600);
  assert.doesNotMatch(md, /中身：/); // 選んでいないときは出さない
});

test("記録：引っかかりの中身は、本人が選んだときだけ1行出す", async () => {
  const one = await (await req("/api/record", { method: "POST", body: { role: "leader", round_id: "kind1234", record: { ...record, concern_kind: "relation" } } })).json();
  assert.match(fs.readFileSync(path.join(DATA, "rounds", one.file), "utf8"), /引っかかり\n中身：関係・気持ちの行き違い\n/);
  const two = await (await req("/api/record", { method: "POST", body: { role: "leader", round_id: "kind5678", record: { ...record, concern: "", concern_kind: "relation" } } })).json();
  assert.doesNotMatch(fs.readFileSync(path.join(DATA, "rounds", two.file), "utf8"), /中身：/);
});

test("記録の id・日付・回が違えば 400", async () => {
  for (const body of [
    { role: "ceo", round_id: "../x", record },
    { role: "ceo", round_id: "abc12345", record: { ...record, date: "../../x" } },
    { role: "ceo", round_id: "abc12345", record: { ...record, round: 0 } },
    { role: "admin", round_id: "abc12345", record },
  ]) {
    assert.equal((await req("/api/record", { method: "POST", body })).status, 400, JSON.stringify(body).slice(0, 50));
  }
});

test("感想は画面と問いと一緒に feedback.md に1行ずつ足す（AI は呼ばない）", async () => {
  fs.rmSync(LOG, { force: true });
  await req("/api/feedback", { method: "POST", body: { role: "ceo", round: 2, screen: "問い", question: "任せた仕事を\n見に行く", text: "例が\n分かりにくい" } });
  await req("/api/feedback", { method: "POST", body: { screen: "はじめ", text: "立場の説明がほしい" } });
  assert.equal((await req("/api/feedback", { method: "POST", body: { text: "  " } })).status, 400);
  const lines = fs.readFileSync(path.join(DATA, "feedback.md"), "utf8").trim().split("\n");
  assert.equal(lines[0], "# 託すノート（手元モード）気になったこと");
  assert.match(lines.at(-2), /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}｜社長・2回目｜問い｜問い：任せた仕事を \/ 見に行く｜例が \/ 分かりにくい$/);
  assert.match(lines.at(-1), /｜立場未選択｜はじめ｜立場の説明がほしい$/);
  assert.equal(calls().length, 0);
});
