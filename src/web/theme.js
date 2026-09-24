'use strict';
// 在页面画出来之前定好浅色 / 深色（跟随系统时什么都不设）。
try {
  const t = localStorage.getItem('relay.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* 浏览器不让用本地存储：跟随系统 */
}
