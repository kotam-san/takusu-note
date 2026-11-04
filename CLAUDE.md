# 託すノート

社長と幹部が、答えるたびに問いが変わる診断・短い学び・3分コーチングで、任せる力を育てる道具。**このリポジトリは GitHub で公開している（MIT）**。

- 2つのバージョン：公開バージョン（`docs/` を GitHub Pages で配信・AI は `worker/` の中継が API で呼ぶ・1日30回まで）／手元モード（`local/server.mjs`・自分の `claude -p` で動く・API の鍵は要らない）
- 起動：画面だけなら `python3 -m http.server 8768 --directory docs`／手元モードは `node local/server.mjs --data <記録のフォルダ> --port 8769`
- 試験：`node --test tests/*.mjs`（AI は呼ばない。中継の試験は先に `worker` で `npm install`）
- 構成：`docs/`＝画面／`worker/`＝中継（`src/handlers.js` は手元モードと共有・`src/prompts.js` は AI への指示）／`local/`＝手元モードの入口／`tests/`

## 罠

- **公開リポジトリ**：実名・会社名・メールアドレス・取引先・家族の話・私的なやり取りを、コード・試験の例・コミットの説明文・README に書かない。それらは `notes/` と `CLAUDE.local.md`（どちらも Git に入れない）へ。コミットの前に `git diff --cached` で確かめる
- 手元モードで実際に使うときの記録は、このフォルダの外に置く（`--data` で渡す）。中身を公開バージョンに持ち込まない
- push と中継の deploy（`cd worker && npx wrangler deploy`）は、作者に確かめてから

## 作業の管理（GitHub の Issue）

- 1つの作業＝1つの Issue＝1つの PR。PR の本文に `Closes #番号` を書く
- Issue には「やること」と「終わったと言える状態」だけを書く。**Issue も公開**なので、感想の原文・参加者の話・実名は書かない（`notes/` へ）
- 着手・判断・完了のとき、Issue に1〜2行で記録する。進行中の作業は Issue 一覧で見る
- 同じファイルを触る作業は並行しない。先の PR を取り込んでから、次を始める
- Issue の作成・push・中継の deploy・PR の取り込みは、作者に確かめてから

## 読むもの（必要なときだけ）

- `CLAUDE.local.md` — 作者の環境・記録の置き場・判断の置き場（手元にだけある）
- `notes/開発の経緯.md` — これまで何を決め、何を作ったか。作業を再開するとき
- `notes/アイデア.md` — 思いついたこと。新しく足すときもここへ
