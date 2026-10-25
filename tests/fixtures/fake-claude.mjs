#!/usr/bin/env node
// 試験用の偽の claude。受け取った引数と標準入力を記録し、FAKE_MODE_FILE の指示どおりに返す。
import fs from "node:fs";

const mode = fs.readFileSync(process.env.FAKE_MODE_FILE, "utf8").trim();
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (b) => (stdin += b));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin, pid: process.pid }) + "\n");
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  const qs = ["A", "A", "B", "B", "C", "D"].map((axis) => ({ axis, text: `問い${axis}`, because: "理由" }));
  const ex = { A: "例a", B: "例b", C: "例c", D: "例d" };
  const out = schema.required.includes("coaching_choices")
    ? {
      summary: "見立て", axis_notes: ["A", "B", "C", "D"].map((axis) => ({ axis, note: "メモ" })),
      lesson: { axis: "A", title: "学び", body: "本文", check: { question: "確かめ", choices: ["1", "2", "3"], answer_index: 0, explanation: "説明" } },
      coaching_question: "コーチの問い", coaching_choices: ["候補1", "候補2"],
    }
    : schema.required.includes("step_options")
      ? { reflection: "受け止め", step_options: ["一歩1", "一歩2", "一歩3"], next_questions: qs, fixed_examples: ex }
      : { next_questions: qs, fixed_examples: ex };
  const ok = (structured_output) => JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output });
  switch (mode) {
    case "ok": return process.stdout.write(ok(out));
    case "badshape": return process.stdout.write(ok({ next_questions: [] }));
    case "exit1": process.stdout.write(ok(out)); return process.exit(1);
    case "is_error": return process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
    case "badjson": return process.stdout.write("{not json");
    case "hang": return setTimeout(() => {}, 60_000);
  }
});
