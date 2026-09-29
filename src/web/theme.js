'use strict';
// 在页面画出来之前定好浅色 / 深色（跟随系统时什么都不设）。
try {
  const t = localStorage.getItem('relay.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* 浏览器不让用本地存储：跟随系统 */
}

// 三栏也在画出来之前定好：栏宽、左栏收没收（记在本机）、窗口窄到放不下右栏（右栏自己收）。
// 不然刷新时先按三栏都开画出来，脚本跑到才收回去，右栏会先露出来再滑走。
// 右栏启动时总是开着（窗口放得下时），收起只管这一次，不记。
(() => {
  const root = document.documentElement;
  root.classList.add('booting');
  try {
    const px = (k, d, lo, hi) => `${Math.min(hi, Math.max(lo, Number(localStorage.getItem(`relay.${k}`)) || d))}px`;
    root.style.setProperty('--left', px('left', 264, 200, 420));
    root.style.setProperty('--right', px('right', 296, 220, 560));
    if (localStorage.getItem('relay.noLeft') === '1') root.classList.add('boot-no-left');
  } catch {
    /* 浏览器不让用本地存储：按默认的宽度、两栏都开 */
  }
  if (matchMedia('(max-width: 1180px)').matches) root.classList.add('boot-no-right');
})();
