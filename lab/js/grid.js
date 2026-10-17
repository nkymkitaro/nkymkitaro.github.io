// grid.js: 全カメラを並べるときの並べ方。本番のVAR「並べて見る」(js/replay-player.js)と同じ決め方:
// 映像1つあたりが一番大きく見える並びを選ぶ(2台は左右か上下、3〜4台は2×2か、縦・横の1列)。
// 見る画面と、まとめ動画(第2段階)で同じものを使う。
export function chooseGrid(count, tileW, tileH, boxW, boxH) {
  if (count <= 1) return { cols: 1, rows: 1, scale: Math.min(boxW / tileW, boxH / tileH) };
  const candidates = count <= 2 ? [[2, 1], [1, 2]] : [[2, 2], [1, count], [count, 1]];
  let best = null;
  for (const [cols, rows] of candidates) {
    const scale = Math.min(boxW / (cols * tileW), boxH / (rows * tileH));
    if (!best || scale > best.scale + 1e-6) best = { cols, rows, scale };
  }
  return best;
}
