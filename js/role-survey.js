// role-survey.js: 「あなたは？」(立場の1問)。使い方の改善のため、答えてもらえる範囲で聞く。
// - 親機は、見返して「LIVEに戻る」を押した直後に、子機は「接続を切る」の後に、下から小さなシートで出す(画面全体はふさがない)
// - 押したら即答え。「ありがとうございます」を見せて、少ししたら自動で閉じる
// - 答えてもらえなかったら、間を空けて同じタイミングでもう一度(合計3回まで、1日1回まで)。答えたら二度と出さない
// - 答えは端末に覚え、GA4のユーザーの属性 user_role として以後の出来事に付ける(送信は analytics.js)
// - ヘルプの「立場を答える・変える」から、いつでも答え直せる(回数には数えない)
import { track, setUserRole } from './analytics.js';
import { attachPress } from './press-feedback.js';

// ---- 設定(選択肢の文言と値、再表示の条件は、ここだけ) ----
export const ROLE_OPTIONS = [
  { value: 'player', label: '選手' },
  { value: 'coach', label: '指導者・先生' },
  { value: 'referee', label: '審判' },
  { value: 'parent', label: '保護者' },
  { value: 'organizer', label: '大会の運営' },
  { value: 'other', label: 'その他' },
];
export const REASK_AFTER_DAYS = 7; // 前に出してから、この日数以上たって別の日に使ったときに、もう一度出す
export const MAX_ASKS = 3; // 出すのは合計この回数まで。答えてもらえなくても、これ以上は出さない
const SHOW_DELAY_MS = 700; // 「LIVEに戻る」の動きが落ち着いてから出す
const THANKS_MS = 1500; // 「ありがとうございます」を見せておく時間

const STORAGE_KEY = 'kendo-var-role';

// ---- 端末に覚えるもの: 答え、表示した回数、最後に出した日 ----
// 保存できない環境(プライベートブラウズなど)では、覚えられず何度も出てしまうので、聞かない
let storageOk = null;
function canPersist() {
  if (storageOk !== null) return storageOk;
  try {
    localStorage.setItem(`${STORAGE_KEY}-test`, '1');
    localStorage.removeItem(`${STORAGE_KEY}-test`);
    storageOk = true;
  } catch (err) {
    storageOk = false;
  }
  return storageOk;
}

function loadState() {
  const empty = { answer: null, asks: 0, lastAsked: null };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return empty;
    const answer = ROLE_OPTIONS.some((o) => o.value === raw.answer) ? raw.answer : null;
    const asks = Number.isInteger(raw.asks) && raw.asks > 0 ? raw.asks : 0;
    const lastAsked = typeof raw.lastAsked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastAsked) ? raw.lastAsked : null;
    return { answer, asks, lastAsked };
  } catch (err) {
    return empty;
  }
}
function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* 保存できなくても使える */ }
}

// 端末の暦で「今日」(YYYY-MM-DD)。日付をまたいだかどうかを見るのに使う
function toDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function daysBetween(fromDay, toDay_) {
  const [y1, m1, d1] = fromDay.split('-').map(Number);
  const [y2, m2, d2] = toDay_.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// 今、聞いてよいか(純粋な判定。テストしやすいよう日付を渡せる)
export function shouldAsk(state, now = new Date()) {
  if (state.answer) return false; // 答えたら二度と出さない
  if (state.asks >= MAX_ASKS) return false; // 3回とも答えがなければ、それ以降は出さない
  if (state.asks === 0 || !state.lastAsked) return true;
  const today = toDay(now);
  if (state.lastAsked === today) return false; // 1日に2回以上は出さない
  return daysBetween(state.lastAsked, today) >= REASK_AFTER_DAYS;
}

export function getSavedRole() {
  return loadState().answer;
}

// ---- シート ----
let sheet; let askView; let thanksView; let thanksText; let optionsEl;
let isOpen = false;
let thanksTimer = null;
let showTimer = null;
let currentAskCount = 0; // 今のシートが「何回目の表示か」。ヘルプから開いたときは、これまでの回数

function labelOf(value) {
  const found = ROLE_OPTIONS.find((o) => o.value === value);
  return found ? found.label : '';
}

function renderOptions(selectedValue) {
  optionsEl.innerHTML = '';
  ROLE_OPTIONS.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'role-option';
    btn.textContent = opt.label;
    btn.dataset.value = opt.value;
    if (opt.value === selectedValue) btn.setAttribute('aria-pressed', 'true');
    attachPress(btn, { vibrate: 12 });
    btn.addEventListener('click', () => answer(opt.value));
    optionsEl.appendChild(btn);
  });
}

function openSheet() {
  askView.hidden = false;
  thanksView.hidden = true;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  isOpen = true;
}

function closeSheet() {
  clearTimeout(thanksTimer);
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  isOpen = false;
}

function answer(value) {
  if (!isOpen || !thanksView.hidden) return; // 二度押しでも記録は1回
  const state = loadState();
  saveState({ ...state, answer: value });
  setUserRole(value);
  track('role_answer', { user_role: value, ask_count: currentAskCount });
  thanksText.textContent = `「${labelOf(value)}」で記録しました。ヘルプから変えられます`;
  askView.hidden = true;
  thanksView.hidden = false;
  clearTimeout(thanksTimer);
  thanksTimer = setTimeout(closeSheet, THANKS_MS);
}

// 「閉じる」を押した、または別の操作に移るために閉じる。答えは記録しない
export function dismissRoleSurvey() {
  clearTimeout(showTimer);
  if (!isOpen) return;
  const wasAnswered = !thanksView.hidden;
  closeSheet();
  if (!wasAnswered) track('role_answer', { user_role: 'dismiss', ask_count: currentAskCount });
}

// 聞いてよい場面になったとき(親機は「LIVEに戻る」の直後、子機は「接続を切る」の後)に呼ぶ。
// 条件を満たさなければ何もしない
export function maybeAskRole() {
  if (!sheet || isOpen || !canPersist()) return;
  const state = loadState();
  if (!shouldAsk(state)) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    if (isOpen) return;
    const latest = loadState(); // 待っている間に答えた・別の場所で出した場合に備えて、もう一度確かめる
    if (!shouldAsk(latest)) return;
    const asks = latest.asks + 1;
    saveState({ ...latest, asks, lastAsked: toDay(new Date()) }); // 出した時点で数える(答えずに閉じても1回)
    currentAskCount = asks;
    renderOptions(null);
    openSheet();
  }, SHOW_DELAY_MS);
}

// ヘルプの「立場を答える・変える」から。今の答えに印を付けて出す。出した回数には数えない
export function openRoleSurveyFromHelp() {
  if (!sheet) return;
  clearTimeout(showTimer);
  const state = loadState();
  currentAskCount = state.asks;
  renderOptions(state.answer);
  openSheet();
}

export function initRoleSurvey() {
  sheet = document.getElementById('roleSheet');
  if (!sheet) return;
  askView = document.getElementById('roleAsk');
  thanksView = document.getElementById('roleThanks');
  thanksText = document.getElementById('roleThanksText');
  optionsEl = document.getElementById('roleOptions');
  const closeBtn = document.getElementById('btnRoleClose');
  attachPress(closeBtn, { vibrate: 0 });
  closeBtn.addEventListener('click', dismissRoleSurvey);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismissRoleSurvey();
  });
}
