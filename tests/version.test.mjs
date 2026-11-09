// 画面の JS の読み込みの版（?v=…）：JS を変えたのに版を更新し忘れたり、新しいファイルを足し忘れたりしたら落とす。
// 直し方：node scripts/stamp-version.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DOCS, assetVersion, jsFiles } from "../scripts/asset-version.mjs";

const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const importMap = JSON.parse(html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? "null");

test("index.html の読み込みの版が、今の docs/*.js の中身の版と同じ", () => {
  const version = assetVersion();
  const entry = html.match(/<script type="module" src="\.\/app\.js\?v=([0-9a-f]{8})"><\/script>/);
  assert.ok(entry, "app.js の読み込みに ?v=版 がありません");
  assert.equal(entry[1], version, "app.js の版が古い。node scripts/stamp-version.mjs を実行してください");
  assert.ok(importMap?.imports, "import map がありません");
  for (const [spec, url] of Object.entries(importMap.imports)) {
    assert.equal(url, `${spec}?v=${version}`, `${spec} の版が古い。node scripts/stamp-version.mjs を実行してください`);
  }
});

test("docs/*.js が import するファイルは、すべて import map にある（app.js 以外）", () => {
  const imported = new Set();
  for (const f of jsFiles()) {
    for (const m of fs.readFileSync(path.join(DOCS, f), "utf8").matchAll(/from\s+"(\.\/[^"]+\.js)"/g)) imported.add(m[1]);
  }
  assert.ok(imported.size >= 3);
  for (const spec of imported) assert.ok(importMap.imports[spec], `${spec} が import map にありません（index.html に足して、版を更新してください）`);
  for (const spec of Object.keys(importMap.imports)) assert.ok(imported.has(spec), `${spec} は import されていません（import map から外してください）`);
});

test("手元モードの入口が、docs/*.js をすべて配る", () => {
  const server = fs.readFileSync(new URL("../local/server.mjs", import.meta.url), "utf8");
  for (const f of jsFiles()) assert.ok(server.includes(`"/${f}"`), `local/server.mjs の STATIC に /${f} がありません`);
});
