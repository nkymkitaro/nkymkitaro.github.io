// pose-worker.js: 骨格(MoveNet multipose lightning)を、画面の処理とは別に動かす(lab/speedometer.html 用の試作)
// 受け取る: { bitmap: ImageBitmap, t, crop:[x,y,w,h]|null }  返す: { t, kp:[[x,y,score]×17]|null, box, others:[box…] }(元の映像の座標)
/* global ort */
importScripts('../../js/vendor/ort/ort.wasm.min.js');
ort.env.wasm.wasmPaths = new URL('../../js/vendor/ort/', self.location.href).href;
ort.env.wasm.numThreads = 1;
let sess = null;
const ready = ort.InferenceSession.create(new URL('../models/movenet_multipose_lightning_1.onnx', self.location.href).href, { executionProviders: ['wasm'] })
  .then((s) => { sess = s; postMessage({ ready: true }); })
  .catch((e) => postMessage({ error: String(e) }));
let cv = null, cx = null;
onmessage = async (ev) => {
  const { bitmap, t, crop } = ev.data;
  await ready; if (!sess) { bitmap.close(); postMessage({ t, kp: null }); return; }
  const VW = bitmap.width, VH = bitmap.height, r = crop ? { x: crop[0], y: crop[1], w: crop[2], h: crop[3] } : { x: 0, y: 0, w: VW, h: VH };
  let W = 256, sc = W / r.w, ch = Math.round(r.h * sc), H = Math.ceil(ch / 32) * 32;
  if (H > 512) { W = Math.floor(W * 512 / H / 32) * 32 || 128; sc = W / r.w; ch = Math.round(r.h * sc); H = Math.ceil(ch / 32) * 32; }
  if (!cv) { cv = new OffscreenCanvas(W, H); cx = cv.getContext('2d', { willReadFrequently: true }); }
  cv.width = W; cv.height = H; cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
  cx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, W, ch); bitmap.close();
  const px = cx.getImageData(0, 0, W, H).data, d = new Int32Array(W * H * 3);
  for (let i = 0, j = 0; i < px.length; i += 4) { d[j++] = px[i]; d[j++] = px[i + 1]; d[j++] = px[i + 2]; }
  const o = (await sess.run({ input: new ort.Tensor('int32', d, [1, H, W, 3]) })).output_0.data;
  let best = null, area = 0, bbox = null; const boxes = [];
  for (let p = 0; p < 6; p++) {
    const q = o.subarray(p * 56, p * 56 + 56); if (q[55] < 0.15) continue;
    const b = [q[52] * W / sc + r.x, q[51] * H / sc + r.y, q[54] * W / sc + r.x, q[53] * H / sc + r.y]; boxes.push(b);
    const a = (q[54] - q[52]) * (q[53] - q[51]); if (a <= area) continue; area = a; bbox = b;
    best = []; for (let k = 0; k < 17; k++) best.push([q[k * 3 + 1] * W / sc + r.x, q[k * 3] * H / sc + r.y, q[k * 3 + 2]]);
  }
  postMessage({ t, kp: best, box: bbox, others: boxes.filter((b) => b !== bbox) });
};
