# kendovar

## Overview (English)

**kendovar** is a video-assisted judgment support application for **Kendo** (剣道), Japan's traditional martial art. 

By applying VAR (Video Assistant Referee) technology to Kendo, this project aims to enhance the transparency and accuracy of match judgments.

### Purpose

In Kendo matches, the strikes (打突 - datotsu) executed by practitioners are extremely fast, making certain judgments difficult through visual observation alone:

- **Accurate strike judgment**: Determining which competitor executed the strike
- **Validity verification**: Confirming whether the strike was executed on the correct target with proper technique
- **Timing validation**: Determining the sequence when multiple strikes occur simultaneously

kendovar supports these judgments through **high-speed video analysis**, ensuring the fairness and integrity of Kendo matches.

### Features

- 🎯 Kendo-specialized video judgment support system
- 📹 Capture and analysis of high-speed striking motions
- 🎬 Fusion of traditional martial arts and cutting-edge technology

---

## 概要 (日本語)

**kendovar** は、日本の伝統武道である**剣道（けんどう）**の試合における判定を支援する映像解析アプリケーションです。

VAR（Video Assistant Referee）技術を剣道に応用し、審判の判定の透明性と正確性を向上させることを目的としています。

### プロジェクトの目的

剣道の試合では、選手の打突（だとつ）は非常に高速であり、目視だけでは以下の判定が困難な場合があります：

- **正確な打突の判定**：どちらの選手が打ったのか
- **有効性の確認**：正しい箇所に正しい方法で打ったか
- **タイミングの検証**：複数の打突が起こった場合の順序判定

kendovarは、**高速映像解析**を通じて、これらの判定をサポートし、試合の公正性を保証します。

### 特徴

- 🎯 剣道専用の映像判定支援システム
- 📹 高速な打突動作の捕捉と解析
- 🎬 伝統武道と最新テクノロジーの融合

## 詳細 / Details

剣道についての詳しい情報は、以下をご参照ください：
- [全日本剣道連盟 (All Japan Kendo Association)](https://www.all-japan-kendo.or.jp/)

## Usage / 使い方

このリポジトリには、ブラウザで動くシンプルな2カメラVARデモが含まれています（index.html）。以下は最小限で分かりやすい手順です。

English (short)

1. Open index.html in a browser (recommended: serve it on localhost with a simple server, e.g. `python -m http.server`, because camera access often requires secure/origin context).
2. On the monitor device (large screen): click the 📺 【親機】 button. Allow camera access when prompted. A 4-digit ID will appear.
3. On the second device (phone / child camera): open the same index.html, click 📷 【子機】, enter the 4-digit ID shown on the monitor, then press the send/connect button to stream video to the monitor.
4. On the monitor, choose camera source: 親機カメラ (local) or 子機カメラ (remote). Use the controls:
   - ⏪ 5秒前VAR: rewind and start replay from ~5 seconds earlier
   - 🔴 LIVEに戻る: return to live capture
   - 0.25x / 0.5x: slow-motion playback speed
   - ◀ 1コマ戻る / 1コマ進む ▶: step one frame backward/forward
5. Use the viewer (canvas) for frame-by-frame confirmation. Exporting results is not implemented in the demo — capture the screen or extend the code if needed.

日本語（簡潔）

1. index.html をブラウザで開きます（推奨：ローカルサーバーで配信、例 `python -m http.server`。カメラの許可/制限のため）。
2. 親機（モニター）側で「📺 【親機】」を押し、カメラの許可を与えます。画面に4桁の接続IDが表示されます。
3. 子機側（スマホ等）で同じ index.html を開き、「📷 【子機】」を押して4桁IDを入力し、親機へ送信します。
4. 親機画面で表示ソースを切り替え、以下の操作でVAR（リプレイ）を使います：
   - 「⏪ 5秒前VAR」：直近のバッファを巻き戻してリプレイを開始
   - 「🔴 LIVEに戻る」：ライブ表示に戻す
   - 「0.25x / 0.5x」：再生速度（スローモーション）
   - 「◀ 1コマ戻る / 1コマ進む ▶」：フレーム単位で進める/戻す
5. リプレイは画面上で確認し、必要なら画面録画やスクリーンショットで結果を保存してください。

Tips / 注意点

- 高フレームレート（例：240FPS 以上）のカメラがベストですが、まずは手元の機材で動作確認してください。
- 同一ネットワークでの接続や、ブラウザのカメラ許可を確認してください。Peer接続が失敗する場合はネットワーク設定（ファイアウォール、プライベートネットワーク）を確認してください。
- このREADMEでは操作手順に絞っています。内部実装や詳細なコード修正は index.html を参照してください。

### Contributing / 貢献

Contributions, issue reports, and pull requests are welcome. Please follow standard GitHub contribution practices and include reproducible steps for bugs or feature requests.

---
