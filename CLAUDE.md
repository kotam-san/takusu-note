# 託すノート

社長と幹部が、答えるたびに問いが変わる診断・短い学び・3分コーチングで、任せる力を育てる道具。作者の自作。**このリポジトリは GitHub で公開している（MIT）**。

- 2つのバージョン：公開バージョン（`docs/` を GitHub Pages で配信・AI は `worker/` の中継が API で呼ぶ・1日30回まで）／手元モード（`local/server.mjs`・自分の `claude -p` で動く・API の鍵は要らない）
- 起動：画面だけなら `python3 -m http.server 8768 --directory docs`／手元モードは `node local/server.mjs --data <記録のフォルダ> --port 8769`
- 試験：`node --test tests/*.mjs`（AI は呼ばない。中継の試験は先に `worker` で `npm install`）
- 構成：`docs/`＝画面／`worker/`＝中継（`src/handlers.js` は手元モードと共有・`src/prompts.js` は AI への指示）／`local/`＝手元モードの入口／`tests/`

## 罠

- **公開リポジトリ**：実名・取引先・家族の話・私的なやり取りなど私的な内容を、コード・コミット・README に書かない。それらは `notes/`（Git に入れない）へ
- 作者が自分で使うときの記録は、このフォルダではなく 作者の管理フォルダ の `memory/takusu-ui/`（`--data` で渡す）。中身を公開バージョンに持ち込まない
- push と中継の deploy（`cd worker && npx wrangler deploy`）は、作者に確かめてから

## 読むもの（必要なときだけ）

- `notes/開発の経緯.md` — これまで何を決め、何を作ったか。作業を再開するとき
- `notes/アイデア.md` — 思いついたこと。新しく足すときもここへ
- 作者の管理フォルダ の `memory/takusu/improvements.md` — 作者が使って出た感想と「公開バージョンに戻す」欄。直す候補を探すとき
- 作者の管理フォルダ の `knowledge/40_evergreen/decisions/` のうち名前に「託すノート」が入るもの — 方針を変えるとき
