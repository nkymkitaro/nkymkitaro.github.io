// codeInput.js: 4桁の番号を、1桁ずつの大きな枠で入れる部品(デザインポリシー 2-3・3章)。
// - 本物の入力欄(.code-field)は枠の上に透明で重ねてあり、どの枠を押しても数字キーボードが開く
// - 1桁入るたびにその枠が小さく弾み、そろった瞬間に短く振動する
// - そろったら onComplete(番号) を呼ぶ(確定ボタンは置かない)。つないでいる間は setBusy(true) で入力を止める
import { tapFeedback } from './haptics.js';

export function createCodeInput({ root, length = 4, onComplete }) {
  const field = root.querySelector('.code-field');
  const boxes = Array.from(root.querySelectorAll('.code-box'));
  let previous = '';

  function render() {
    const value = field.value;
    boxes.forEach((box, i) => {
      box.textContent = value[i] || '';
      box.classList.toggle('active', i === Math.min(value.length, length - 1) && value.length < length && !root.classList.contains('busy'));
    });
    // 増えた桁の枠だけ弾ませる(消したときは動かさない)
    if (value.length > previous.length) {
      const box = boxes[value.length - 1];
      if (box) {
        box.classList.remove('pop');
        void box.offsetWidth; // 一度レイアウトさせてから付け直さないと、アニメーションが再生されない
        box.classList.add('pop');
      }
    }
    previous = value;
  }

  field.addEventListener('input', () => {
    const digits = field.value.replace(/\D/g, '').slice(0, length); // 数字以外(全角など)は受け付けない
    if (field.value !== digits) field.value = digits;
    render();
    if (digits.length === length) {
      tapFeedback(30); // 4桁そろった瞬間に短く振動
      onComplete(digits);
    }
  });
  field.addEventListener('focus', render);
  field.addEventListener('blur', () => boxes.forEach((b) => b.classList.remove('active')));

  render();
  return {
    focus() { field.focus(); },
    value() { return field.value; },
    // つないでいる間は入力を止める(二重に呼ばないため)。止まっている間は番号を消さない
    setBusy(busy) {
      root.classList.toggle('busy', busy);
      field.readOnly = busy;
      render();
    },
    // 番号を埋める(QRから開いたとき用)。自動でつなぐのは呼ぶ側の仕事なので、onComplete は呼ばない
    fill(digits) {
      field.value = String(digits).replace(/\D/g, '').slice(0, length);
      previous = field.value;
      render();
    },
    clear() {
      field.value = '';
      previous = '';
      render();
    },
  };
}
