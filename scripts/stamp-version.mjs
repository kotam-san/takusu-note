#!/usr/bin/env node
// docs/*.js を変えたら実行する：docs/index.html の読み込みの版（?v=…）を、今の JS の中身の版に書き換える。
// 使い方：node scripts/stamp-version.mjs
import fs from "node:fs";
import path from "node:path";
import { DOCS, assetVersion } from "./asset-version.mjs";

const file = path.join(DOCS, "index.html");
const version = assetVersion();
const before = fs.readFileSync(file, "utf8");
const after = before.replace(/(\.js\?v=)[0-9a-f]{8}/g, `$1${version}`);
if (after === before) console.log(`版は ${version} のままです（変更なし）`);
else {
  fs.writeFileSync(file, after);
  console.log(`index.html の版を ${version} にしました`);
}
