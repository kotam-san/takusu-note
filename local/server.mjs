// 託すノートの手元モード（自分の Mac で使う入口）。
// 画面（docs/）を配り、AI は API の鍵ではなく手元の Claude Code（claude -p）で動かす。
// 記録と感想は --data で渡したフォルダに残す。Node の標準機能だけで動き、npm は使わない。
//
// 起動：node local/server.mjs --data <記録を置くフォルダ> [--port 8769]
// このファイルに個人のパスは書かない（公開リポジトリのため）。

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InputError, OutputError, makeHandlers } from "../worker/src/handlers.js";
import { validateStore } from "../docs/core.js";
import { profileText, validateProfile } from "../docs/profile.js";
import { AXIS_NAMES, CONCERN_KINDS } from "../docs/questions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, "..", "docs");

const MODEL = "claude-sonnet-5-5"; // 公開の中継と同じ
const AI_TIMEOUT_MS = Number(process.env.TAKUSU_AI_TIMEOUT_MS || 120_000); // 画面の待ち時間（150秒）より短く。試験では縮める
const MAX_BODY = 64_000; // バイト
const MAX_AI_OUT = 1_000_000; // claude -p の出力の上限（バイト）
const ROLES = new Set(["ceo", "leader"]);
const ROLE_NAME = { ceo: "社長", leader: "幹部" };

// ---------------------------------------------------------------- 設定（引数と環境変数）

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DATA = arg("--data", process.env.TAKUSU_DATA);
const PORT = Number(arg("--port", process.env.TAKUSU_PORT || 8769));
const CLAUDE_BIN = process.env.TAKUSU_CLAUDE_BIN || "claude"; // 試験では偽の claude に差し替える
if (!DATA) {
  console.error("記録を置くフォルダを --data で渡してください。");
  process.exit(1);
}

const HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const TOKEN = crypto.randomBytes(24).toString("hex"); // 起動ごとに作り直す。ログには出さない

// 配るのは docs/ の決まったファイルだけ
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/how.html": ["how.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/core.js": ["core.js", "text/javascript; charset=utf-8"],
  "/profile.js": ["profile.js", "text/javascript; charset=utf-8"],
  "/questions.js": ["questions.js", "text/javascript; charset=utf-8"],
};

// ---------------------------------------------------------------- 記録の置き場

const file = {
  store: (role) => path.join(DATA, `${role}.json`),
  rounds: () => path.join(DATA, "rounds"),
  feedback: () => path.join(DATA, "feedback.md"),
};

await fsp.mkdir(file.rounds(), { recursive: true, mode: 0o700 });
await fsp.chmod(DATA, 0o700);
await fsp.chmod(file.rounds(), 0o700);

// 書き込みは1本ずつ
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function writeAtomic(target, text) {
  const tmp = `${target}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmp, text, { mode: 0o600 });
  await fsp.rename(tmp, target);
}

// 記録は { version, store } で持つ。version は古いタブからの上書きを断るための番号
async function readStore(role) {
  try {
    const raw = JSON.parse(await fsp.readFile(file.store(role), "utf8"));
    const store = validateStore(raw.store);
    return { version: Number.isInteger(raw.version) ? raw.version : 0, store, broken: !store };
  } catch (e) {
    if (e.code === "ENOENT") return { version: 0, store: null, broken: false };
    return { version: 0, store: null, broken: true };
  }
}

// ---------------------------------------------------------------- AI（claude -p）

const EMPTY_MCP = path.join(os.tmpdir(), "takusu-note-empty-mcp.json");
fs.writeFileSync(EMPTY_MCP, '{"mcpServers":{}}\n', { mode: 0o600 });

// AI には何も読ませず、書かせない。手元の CLAUDE.md・スキル・hook も読ませない（公開版と同じ問いにするため）
export function claudeArgs(system, schema) {
  return [
    "-p", "--output-format", "json",
    "--model", MODEL,
    "--system-prompt", system,
    "--json-schema", JSON.stringify(schema),
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--mcp-config", EMPTY_MCP,
    "--setting-sources", "",
    "--safe-mode",
    "--no-session-persistence",
  ];
}

// AI の呼び出しは1本ずつ。画面が切れたら signal で止める
let aiQueue = Promise.resolve();
function callClaude(system, content, schema, signal) {
  const run = aiQueue.then(() => runClaude(system, content, schema, signal));
  aiQueue = run.catch(() => {});
  return run;
}

function runClaude(system, content, schema, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new OutputError("aborted"));
    const child = spawn(CLAUDE_BIN, claudeArgs(system, schema), {
      cwd: os.tmpdir(), shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let size = 0;
    let done = false;
    const stop = (why) => {
      if (done) return;
      done = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      reject(new OutputError(why));
    };
    const timer = setTimeout(() => stop("timeout"), AI_TIMEOUT_MS);
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!done) { done = true; fn(); }
    };

    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > MAX_AI_OUT) return stop("too_large");
      out += b;
    });
    child.stderr.on("data", () => {}); // 本文が混ざりうるので残さない
    child.on("error", () => finish(() => reject(new OutputError("spawn"))));
    child.on("close", (code) => finish(() => {
      if (code !== 0) return reject(new OutputError(`exit ${code}`));
      let data;
      try { data = JSON.parse(out); } catch { return reject(new OutputError("bad json")); }
      if (data.is_error || data.subtype !== "success" || data.structured_output == null) {
        return reject(new OutputError("no structured_output"));
      }
      resolve(data.structured_output);
    }));
    child.stdin.end(content);
  });
}

// ---------------------------------------------------------------- 1回の記録（人が読む Markdown）

const ROUND_ID = /^[a-z0-9]{8,32}$/;
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const oneLine = (v) => v.replace(/\s*\n\s*/g, " / ");

function roundMarkdown(r, role, roundId) {
  const p = validateProfile(r.profile, role);
  const d = r.diagnosis ?? {};
  const c = r.coaching ?? {};
  const lines = [
    "---",
    `round_id: ${roundId}`,
    `role: ${role}`,
    `round: ${r.round}`,
    `date: ${r.date}`,
    "---",
    "",
    `# ${ROLE_NAME[role]}・${r.round} 回目（${r.date}）`,
    "",
    p ? `プロフィール：${profileText(p, role)}` : "",
    "",
    "## 推移を見る4問",
    ...["A", "B", "C", "D"].map((k) => `- ${AXIS_NAMES[k]}：${str(r.fixed?.[k]?.text, 120)} → ${r.fixed?.[k]?.score ?? "?"}`),
    "",
    "## 深掘り",
    ...(Array.isArray(r.deep) ? r.deep.slice(0, 8) : []).map((q) => `- [${AXIS_NAMES[q?.axis] ?? "?"}] ${str(q?.text, 120)} → ${q?.score ?? "?"}`),
    "",
    "## いちばん引っかかっていること",
    str(r.concern, 400) || "（記入なし）",
    // 中身は本人が選んだときだけ（選ばなかったことと「まだ分からない」を分けて残す）
    ...(str(r.concern, 400) && Object.hasOwn(CONCERN_KINDS, r.concern_kind ?? "") ? [`中身：${CONCERN_KINDS[r.concern_kind]}`] : []),
    "",
    "## 見立て",
    str(d.summary, 1000),
    ...(Array.isArray(d.axis_notes) ? d.axis_notes.slice(0, 4) : []).map((n) => `- ${AXIS_NAMES[n?.axis] ?? "?"}：${str(n?.note, 400)}`),
    "",
    `## 今日の学び：${str(d.lesson?.title, 120)}`,
    str(d.lesson?.body, 2000),
    "",
    "## 3分コーチング",
    `- 問い：${str(c.question, 300)}`,
    `- 答え：${oneLine(str(c.reply, 800))}`,
    `- コーチから：${str(c.reflection, 1000)}`,
    "",
    "## 今週の一歩",
    str(r.step, 80),
    "",
    "## 次の回の深掘り",
    ...(Array.isArray(c.next_questions) ? c.next_questions.slice(0, 6) : []).map((q) => `- [${AXIS_NAMES[q?.axis] ?? "?"}] ${str(q?.text, 120)}`),
    "",
  ];
  return lines.join("\n");
}

async function writeRound(body) {
  const role = body.role;
  if (!ROLES.has(role)) throw new InputError("role は ceo か leader です");
  if (!ROUND_ID.test(body.round_id ?? "")) throw new InputError("round_id が違います");
  const r = body.record;
  if (!r || !Number.isInteger(r.round) || r.round < 1 || r.round > 100 || !/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "")) {
    throw new InputError("record の形が違います");
  }
  return serial(async () => {
    const dir = file.rounds();
    const base = `${r.date}_${role}_${r.round}回目`;
    // 同じ round_id がもうあれば書かない（送り直しで重複させない）
    for (const name of await fsp.readdir(dir)) {
      if (!name.startsWith(base)) continue;
      const head = (await fsp.readFile(path.join(dir, name), "utf8")).slice(0, 200);
      if (head.includes(`round_id: ${body.round_id}\n`)) return { file: name, duplicate: true };
    }
    let name = `${base}.md`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}_${i}.md`;
    await writeAtomic(path.join(dir, name), roundMarkdown(r, role, body.round_id));
    return { file: name, duplicate: false };
  });
}

// ---------------------------------------------------------------- 感想の一言（AI には送らない）

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function appendFeedback(body) {
  const text = oneLine(str(body.text, 1000).trim());
  if (!text) throw new InputError("text が空です");
  const role = ROLES.has(body.role) ? ROLE_NAME[body.role] : "立場未選択";
  const round = Number.isInteger(body.round) ? `${body.round}回目` : "";
  const where = oneLine(str(body.screen, 40)) || "不明";
  const question = oneLine(str(body.question, 300));
  const line = `- ${stamp()}｜${[role, round].filter(Boolean).join("・")}｜${where}${question ? `｜問い：${question}` : ""}｜${text}\n`;
  return serial(async () => {
    const f = file.feedback();
    if (!fs.existsSync(f)) await fsp.writeFile(f, "# 託すノート（手元モード）気になったこと\n\n", { mode: 0o600 });
    await fsp.appendFile(f, line, { mode: 0o600 });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 入口

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("too_large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("JSON が壊れています");
  }
}

// index.html にだけ合い鍵を差し込む（画面はこれがあるときだけ手元モードになる）
async function indexHtml() {
  const html = await fsp.readFile(path.join(DOCS, "index.html"), "utf8");
  return html.replace("<head>", `<head>\n<meta name="tn-hand" content="${TOKEN}">`);
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = p.match(/^\/api\/store\/([a-z]+)$/);
  if (m) {
    const role = m[1];
    if (!ROLES.has(role)) return send(res, 404, { error: "not_found" });
    if (req.method === "GET") return send(res, 200, await readStore(role));
    if (req.method === "PUT") {
      const body = await readBody(req);
      const store = validateStore(body.store);
      if (!store || !Number.isInteger(body.version)) throw new InputError("記録の形が違います");
      return serial(async () => {
        const cur = await readStore(role);
        if (cur.version !== body.version) return send(res, 409, { error: "conflict", message: "別の画面で記録が更新されています。読み込み直してください。" });
        const next = cur.version + 1;
        await writeAtomic(file.store(role), JSON.stringify({ version: next, store }, null, 1));
        return send(res, 200, { version: next });
      });
    }
    return send(res, 405, { error: "method" });
  }
  if (req.method !== "POST") return send(res, 404, { error: "not_found" });
  if (p === "/api/record") return send(res, 200, await writeRound(await readBody(req)));
  if (p === "/api/feedback") return send(res, 200, await appendFeedback(await readBody(req)));

  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); }); // 画面が切れたら AI を止める
  const handlers = makeHandlers({
    ai: (system, content, schema) => callClaude(system, content, schema, ctrl.signal),
  });
  if (!Object.hasOwn(handlers, p)) return send(res, 404, { error: "not_found" });
  return send(res, 200, await handlers[p](await readBody(req)));
}

export const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || "")) return send(res, 421, { error: "Host が違います" });
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (!url.pathname.startsWith("/api/")) {
      const f = STATIC[url.pathname];
      if (req.method !== "GET" || !f) return send(res, 404, "not found", "text/plain; charset=utf-8");
      const body = f[0] === "index.html" ? await indexHtml() : await fsp.readFile(path.join(DOCS, f[0]));
      return send(res, 200, body, f[1]);
    }
    if (!safeEqual(req.headers["x-takusu-token"], TOKEN)) return send(res, 401, { error: "token", message: "画面を読み込み直してください。" });
    if (req.method !== "GET") {
      if (!ALLOWED_ORIGINS.has(req.headers.origin ?? "")) return send(res, 403, { error: "Origin が違います" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "JSON で送ってください" });
    }
    await route(req, res, url);
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof InputError) return send(res, 400, { error: "bad_input", message: e.message });
    if (e instanceof OutputError) return send(res, 502, { error: "ai_failed", message: "AI の答えを受け取れませんでした。もう一度お試しください。" });
    if (e.status) return send(res, e.status, { error: e.message });
    console.error("error", e?.name, e?.code ?? ""); // 本文は出さない
    send(res, 500, { error: "internal" });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`ポート ${PORT} はもう使われています。手元モードがすでに動いているかもしれません。`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`託すノート（手元モード）を起動しました：http://${HOST}:${PORT}`);
});
