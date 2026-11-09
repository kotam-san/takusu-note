// 画面の JS の「版」。docs/*.js の中身から作る（中身が変わると版も変わる）。
// index.html の読み込みの URL（?v=版）と突き合わせる。更新は scripts/stamp-version.mjs、見張りは tests/version.test.mjs。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DOCS = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "docs");

export const jsFiles = (docs = DOCS) => fs.readdirSync(docs).filter((f) => f.endsWith(".js")).sort();

export function assetVersion(docs = DOCS) {
  const hash = crypto.createHash("sha256");
  for (const f of jsFiles(docs)) hash.update(f).update("\0").update(fs.readFileSync(path.join(docs, f))).update("\0");
  return hash.digest("hex").slice(0, 8);
}
