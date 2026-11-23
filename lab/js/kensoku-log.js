// kensoku-log.js: ケンソク！の記録(日ごとのまとめ・週ごと・続けた日数・目標・バックアップ)。仕様 claude/specs/kensoku-log-spec.md
// 1本ごとの記録は lab/speedometer.html が localStorage の LOG_KEY に残す(上限5,000本)。ここは読むだけで、日ごとのまとめを DAYS_KEY に別に残す。
// 記録は端末の外に出さない(バックアップは、本人が書き出すファイルだけ)。計測の出来事は送らない。

export const LOG_KEY = 'mitori.speedo.log';
export const DAYS_KEY = 'mitori.kensoku.days';
export const GOAL_KEY = 'mitori.kensoku.goal';
// 速さを「打つ瞬間(前60度)」で測るようにした時刻(8b764aa)。これより前で、測り方の印 m がない記録は「最速」で測った古い記録
export const HIT60_SINCE = Date.parse('2026-11-23T15:07:05+09:00');

const pad = (n) => String(n).padStart(2, '0');
// 端末の時計の日付(0時で区切る)
export const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const isOld = (r) => !r.m && Date.parse(r.at) < HIT60_SINCE;
const keyOf = (day, tool, old) => `${day}|${tool}${old ? '|old' : ''}`;

// 1本ごとの記録 → 日ごとのまとめ { 'YYYY-MM-DD|道具[|old]': { d, tool, old, n, sum, best } }
export function summarize(log) {
  const out = {};
  for (const r of log) {
    const v = Number(r.tip); if (!(v > 0) || !r.at) continue;
    const d = dayOf(r.at); const old = isOld(r); const tool = r.tool || '道具なし';
    const k = keyOf(d, tool, old);
    const s = out[k] || (out[k] = { d, tool, old, n: 0, sum: 0, best: 0 });
    s.n += 1; s.sum += v; s.best = Math.max(s.best, v);
  }
  for (const s of Object.values(out)) { s.sum = +s.sum.toFixed(2); s.best = +s.best.toFixed(2); }
  return out;
}

// 残してあるまとめと、今の記録から作ったまとめを合わせる。1本ごとの記録は古いものから消えるので、本数の多いほうを残す
export function mergeDays(stored, fresh) {
  const out = { ...(stored || {}) };
  for (const [k, s] of Object.entries(fresh)) if (!out[k] || s.n >= out[k].n) out[k] = s;
  return out;
}

// 道具ごとの日の並び(古い測り方は除く)。新しい順
export function daysFor(days, tool) {
  return Object.values(days).filter((s) => !s.old && s.tool === tool).sort((a, b) => (a.d < b.d ? 1 : -1));
}
// 記録にある道具(古い測り方を除く)。多く振った順
export function tools(days) {
  const c = {};
  for (const s of Object.values(days)) if (!s.old) c[s.tool] = (c[s.tool] || 0) + s.n;
  return Object.keys(c).sort((a, b) => c[b] - c[a]);
}
// その日の、すべての道具・測り方を合わせた本数
export function countOn(days, d) { return Object.values(days).reduce((n, s) => n + (s.d === d ? s.n : 0), 0); }

// 続けた日数: 今日(まだ振っていなければ昨日)から、1本以上振った日が続いた数
export function streak(days, today) {
  const on = new Set(Object.values(days).filter((s) => s.n > 0).map((s) => s.d));
  const t = new Date(`${today}T12:00:00`);
  if (!on.has(today)) t.setDate(t.getDate() - 1);
  let n = 0;
  while (on.has(dayOf(t))) { n += 1; t.setDate(t.getDate() - 1); }
  return n;
}

// その日より前の最高(同じ道具・今の測り方)
export function bestBefore(days, tool, d) {
  return daysFor(days, tool).filter((s) => s.d < d).reduce((m, s) => Math.max(m, s.best), 0);
}

// 日ごと: 今日から n 日ぶん(古い順)。振らなかった日は null
export function lastDays(days, tool, today, n = 14) {
  const by = Object.fromEntries(daysFor(days, tool).map((s) => [s.d, s]));
  const t = new Date(`${today}T12:00:00`); const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(t); x.setDate(t.getDate() - i); const d = dayOf(x); const s = by[d];
    out.push({ label: `${x.getMonth() + 1}/${x.getDate()}`, d, n: s ? s.n : 0, avg: s ? s.sum / s.n : null, best: s ? s.best : null });
  }
  return out;
}
// 週ごと(月曜はじまり): 今週から n 週ぶん(古い順)
export function lastWeeks(days, tool, today, n = 12) {
  const t = new Date(`${today}T12:00:00`); const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const list = daysFor(days, tool); const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const a = new Date(mon); a.setDate(mon.getDate() - i * 7); const b = new Date(a); b.setDate(a.getDate() + 6);
    const da = dayOf(a); const db = dayOf(b);
    const ss = list.filter((s) => s.d >= da && s.d <= db);
    const cnt = ss.reduce((m, s) => m + s.n, 0); const sum = ss.reduce((m, s) => m + s.sum, 0);
    out.push({ label: `${a.getMonth() + 1}/${a.getDate()}〜`, d: da, n: cnt, avg: cnt ? sum / cnt : null, best: cnt ? Math.max(...ss.map((s) => s.best)) : null });
  }
  return out;
}

// 目標 { count: 本数 or null, avg: m/秒 or null }
export const AVG_MIN_N = 10; // 平均の目標は10本から(少ない本数の平均はぶれるため)

// ---- バックアップ(本人が書き出す JSON。機種変更・ブラウザのデータ消去への備え) ----
export function makeBackup(log, days, goal) {
  return { app: 'kensoku', v: 1, at: new Date().toISOString(), log, days, goal };
}
// 読み込み: 同じ時刻・同じ速さの1本は重ねない。日ごとのまとめは本数の多いほう
export function mergeBackup(cur, b) {
  if (!b || b.app !== 'kensoku' || !Array.isArray(b.log)) throw new Error('ケンソク！のバックアップではありません');
  const seen = new Set(cur.log.map((r) => `${r.at}|${r.tip}`));
  const add = b.log.filter((r) => r && r.at && !seen.has(`${r.at}|${r.tip}`));
  const log = cur.log.concat(add).sort((x, y) => (x.at < y.at ? -1 : 1));
  const days = mergeDays(mergeDays(cur.days, b.days || {}), summarize(log));
  const goal = cur.goal && (cur.goal.count || cur.goal.avg) ? cur.goal : (b.goal || cur.goal);
  return { log, days, goal, added: add.length };
}
