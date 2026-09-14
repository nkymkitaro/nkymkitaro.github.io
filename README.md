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

Below are general usage instructions for kendovar. These describe the typical workflow and recommended settings; adapt them to your environment and to the concrete scripts/tools provided in this repository.

### 1) Requirements / 前提条件

- Hardware: high-speed camera (recommended 240 FPS or higher), stable mounting (tripod), good lighting
- Software dependencies: tools for video processing (e.g., ffmpeg), and typical analysis libraries (e.g., Python 3.8+, OpenCV, NumPy). Adjust according to the implementation in this repo.

### 2) Prepare and record / 録画の準備

- Use a high frame-rate camera and set consistent lighting to capture clear motion
- Record from one or more cameras covering the match area; ensure timestamps or synchronized frames if using multiple angles
- Recommended settings (example): 240–480 fps, resolution 720p or 1080p depending on camera capability

### 3) Import and convert videos / 動画の取り込み・変換

- Transfer recordings to your analysis machine
- If needed, transcode to a consistent format and frame rate with ffmpeg. Example (adjust as necessary):

```bash
# convert to mp4 with target frame rate
ffmpeg -i input_raw.mov -r 240 -c:v libx264 -crf 18 output_240fps.mp4
```

### 4) Run analysis / 解析の実行

- Use the repository's analysis scripts or tools to process the prepared videos. Typical steps:
  1. Run automated detection to locate candidate strikes and key frames
  2. Extract short clips or frames around candidate events
  3. Apply pose/motion analysis to verify target, technique, and timing
- Example (conceptual):

```bash
# conceptual example — replace with the actual script/CLI used by this repo
python analyze.py --input ./videos/output_240fps.mp4 --out ./results/
```

### 5) Review and assist judgment / 判定の補助とレビュー

- Review extracted frames/clips and annotated output using the viewer/UI (if provided)
- Use slow-motion replay and frame-by-frame navigation to confirm which competitor landed the strike, whether it hit a valid target, and the precise timing order

### 6) Export and report / レポート出力

- Export final annotated videos, still images, and a CSV/JSON report summarizing candidate events and confidence scores
- Share exported results with referees or competition officials for final decision support

### Notes and troubleshooting / 注意事項・トラブルシューティング

- Video quality and frame rate are critical — poor lighting or low FPS will reduce detection accuracy
- If processing is slow, verify hardware acceleration (GPU) and adjust analysis parameters (e.g., frame sampling rate)
- For multi-camera setups, ensure correct synchronization between streams

### Contributing / 貢献

Contributions, issue reports, and pull requests are welcome. Please follow standard GitHub contribution practices and include reproducible steps for bugs or feature requests.

---
