'use strict';
/* 接力台网页：左边项目和对话（一个任务一段对话），中间对话，右边项目文件。
   没有构建步骤、不连外网：由 relay ui 直接提供，数据都来自本机的 /api/…。
   只重画变了的地方：输入框里的字、展开的卡片、滚动位置，都不会被定时刷新打断。 */

// ---------- 小工具 ----------

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ICONS = {
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  search: '<circle cx="7.25" cy="7.25" r="4.5"/><path d="m10.6 10.6 3.15 3.15"/>',
  chev: '<path d="m6.25 3.75 4.25 4.25-4.25 4.25"/>',
  down: '<path d="m4 6.25 4 4 4-4"/>',
  x: '<path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5"/>',
  more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/>',
  sliders: '<path d="M2.75 5h5.5m3 0h2M2.75 11h2m3 0h5.5"/><circle cx="9.75" cy="5" r="1.5"/><circle cx="6.25" cy="11" r="1.5"/>',
  play: '<path d="M5.25 3.6v8.8a.5.5 0 0 0 .76.43l7.1-4.4a.5.5 0 0 0 0-.86l-7.1-4.4a.5.5 0 0 0-.76.43z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.75" fill="currentColor" stroke="none"/>',
  check: '<path d="m3.5 8.4 2.9 2.9 6.1-6.6"/>',
  up: '<path d="M8 12.75v-9.5M3.75 7.5 8 3.25l4.25 4.25"/>',
  sideL: '<rect x="2" y="2.75" width="12" height="10.5" rx="2.25"/><path d="M6.25 2.75v10.5"/>',
  sideR: '<rect x="2" y="2.75" width="12" height="10.5" rx="2.25"/><path d="M9.75 2.75v10.5"/>',
  diff: '<path d="M8 2.75v6M5 5.75h6M5 12.75h6"/>',
  log: '<rect x="2" y="2.75" width="12" height="10.5" rx="2.25"/><path d="m5 6.25 1.75 1.75L5 9.75M8.5 9.75h2.5"/>',
  undo: '<path d="M5.75 3.25 2.75 6.25l3 3"/><path d="M2.75 6.25h7a3.25 3.25 0 0 1 0 6.5h-2.5"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75"/><path d="M10.75 5.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1.5"/>',
  folder: '<path d="M2.25 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.5h4.4a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  file: '<path d="M4 1.75h4.75L12 5v9.25H4z"/><path d="M8.5 1.75V5.25H12"/>',
  bolt: '<path d="M9 1.75 3.75 9h4l-.75 5.25L12.25 7h-4z"/>',
  sync: '<path d="M13.25 6.5A5.25 5.25 0 0 0 3.6 5M2.75 9.5a5.25 5.25 0 0 0 9.65 1.5"/><path d="M13.25 2.75V6.5H9.5M2.75 13.25V9.5H6.5"/>',
  insert: '<path d="M12.75 3v4.25a2.5 2.5 0 0 1-2.5 2.5h-7"/><path d="m5.75 7-2.5 2.75 2.5 2.75"/>',
  trash: '<path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.7 9h6.1l.7-9"/>',
  grip: '<path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" stroke-width="2.2"/>',
  fold: '<path d="m5 3.25 3 3 3-3M5 12.75l3-3 3 3"/>',
  unfold: '<path d="m5 5.75 3-3 3 3M5 10.25l3 3 3-3"/>',
  review: '<path d="M8 1.75 13 3.6v3.9c0 3.1-2.1 5.3-5 6.75-2.9-1.45-5-3.65-5-6.75V3.6z"/><path d="m5.75 7.9 1.6 1.6 3-3.2"/>',
  warn: '<path d="M8 2.25 14.25 13H1.75z"/><path d="M8 6.5v3M8 11.25v.01"/>',
  power: '<path d="M8 1.75v5.5"/><path d="M4.5 4a5.25 5.25 0 1 0 7 0"/>',
  user: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 14c.6-2.85 2.65-4.5 5.25-4.5s4.65 1.65 5.25 4.5"/>',
  chat: '<path d="M2.75 3.75h10.5v7.5H8l-3.25 2.5v-2.5h-2z"/>',
  book: '<path d="M2.75 3.25h3.5A1.75 1.75 0 0 1 8 5v8.25a1.5 1.5 0 0 0-1.5-1.5H2.75zM13.25 3.25h-3.5A1.75 1.75 0 0 0 8 5v8.25a1.5 1.5 0 0 1 1.5-1.5h3.75z"/>',
  pencil: '<path d="M10.25 2.75 13.25 5.75 5.5 13.5H2.5v-3z"/>',
  minus: '<path d="M3.25 8h9.5"/>',
  arrow: '<path d="M3 8h10M9.25 4.25 13 8l-3.75 3.75"/>',
  ballot: '<path d="M2.75 8h10.5v5.25H2.75zM5.5 8V3h5v5M6.75 5.5h2.5"/>',
  list: '<path d="M6.25 4h7M6.25 8h7M6.25 12h7"/><path d="M3 4h.01M3 8h.01M3 12h.01" stroke-width="2.2"/>',
  route: '<circle cx="8" cy="3.5" r="1.75"/><circle cx="8" cy="12.5" r="1.75" fill="currentColor"/><path d="M8 5.25v5.5"/>',
};

function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('class', `i${cls ? ` ${cls}` : ''}`);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

/** 只有图标的按钮：悬停写出它是做什么的。 */
function iconBtn(label, name, onclick, kbd, cls = '') {
  return h('button', { class: `icon-btn ${cls}`.trim(), 'aria-label': label, 'data-tip': label, 'data-kbd': kbd || null, onclick }, icon(name));
}

/** 苹果电脑上写 ⌘ ⌥、叫「访达」；Windows、Linux 上写 Ctrl、Alt，叫「文件夹」（快捷键两边都认 ⌘ 和 Ctrl）。 */
const MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const keys = (k) => (MAC || !k ? k : k.replace('⌥⌘', 'Ctrl+Alt+').replace('⌘', 'Ctrl+'));
const REVEAL = MAC ? T`在访达中显示` : T`在文件夹中显示`;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 格点的伪随机数（0～999）：同一个格子每次都一样，边缘毛毛的但不闪。 */
const hash = (i, j) => (((i * 73856093) ^ (j * 19349663)) >>> 0) % 1000;
/** 缓动，和 app.css 的 --ease / --snap / --exit / --spring 同一套（弹簧是 CSS 的 linear()，不支持的浏览器退回贝塞尔）。 */
const EASE = (() => {
  const css = getComputedStyle(document.documentElement);
  const v = (k, d) => css.getPropertyValue(k).trim() || d;
  return { ease: v('--ease', 'cubic-bezier(.2,.7,.2,1)'), snap: v('--snap', 'cubic-bezier(.16,1,.3,1)'), exit: v('--exit', 'cubic-bezier(.4,0,1,1)'), spring: v('--spring', 'cubic-bezier(.2,.7,.2,1)') };
})();
/** 一批一起进场的第 i 个晚多少毫秒：前几个拉开，后面的挤在一起到（不像节拍器一样等距），最多 110。 */
const stagger = (i) => Math.round(110 * (1 - 0.82 ** i));

/** 退场：先放完淡出的动画再拿掉，不是一下子消失。 */
function leave(el) {
  if (!el || !el.isConnected || el.classList.contains('leave')) return;
  if (still()) return el.remove();
  el.classList.add('leave');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 200);
}

/** 显示 / 藏起一个元素：出来时由样式里的进场动画接上，藏起时先淡出再藏（中途又要显示就停下淡出）。 */
function show(el, on) {
  if (!el) return;
  if (on) {
    el.getAnimations().forEach((a) => a.id === 'hide' && a.cancel());
    el.hidden = false;
    return;
  }
  if (el.hidden || el.getAnimations().some((a) => a.id === 'hide')) return;
  if (still()) return (el.hidden = true);
  const a = el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(4px) scale(0.98)' }], { id: 'hide', duration: 140, easing: EASE.exit, fill: 'forwards' });
  a.onfinish = () => {
    el.hidden = true;
    a.cancel();
  };
}

/**
 * 整块重画、看着却是接上的：重画前记下每一项（有 data-k 按它，没有按标签和样式）在哪、写的什么；
 * 重画后还在的从原来的位置滑过去，字变了的淡一下换上，新来的晚一点淡进来。顶栏、空白页顶上都用它。
 */
function morph(box, render, pick = (b) => b.querySelectorAll(':scope > * > *')) {
  if (still() || !box.isConnected || box.hidden || !box.offsetWidth) return render();
  const id = (el) => el.dataset.k || `${el.tagName}.${el.className}`;
  const was = new Map();
  for (const el of pick(box)) was.set(id(el), { x: el.getBoundingClientRect().left, text: el.textContent });
  render();
  for (const el of pick(box)) {
    const o = was.get(id(el));
    if (!o) {
      el.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 60, easing: EASE.snap, fill: 'backwards' });
      continue;
    }
    const dx = o.x - el.getBoundingClientRect().left;
    if (Math.abs(dx) > 0.5) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 420, easing: EASE.spring });
    if (o.text !== el.textContent && !el.querySelector('.roll')) el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 260, easing: EASE.ease });
  }
}

/** 一组元素重排（删掉一行、换了顺序）：还在的从原来的位置滑过去，不是一下子跳过去。 */
function flip(box, mutate) {
  if (!box || still()) return mutate();
  const before = new Map([...box.children].map((el) => [el, el.getBoundingClientRect().top]));
  mutate();
  for (const el of box.children) {
    const was = before.get(el);
    const d = was === undefined ? 0 : was - el.getBoundingClientRect().top;
    if (Math.abs(d) > 0.5) el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 490, easing: EASE.spring });
  }
}

/** 分段按钮：选中的那一块滑到按下的按钮下面；换了一块，身后留一串点（segWake）。 */
function syncSegs(root = document) {
  for (const seg of root.querySelectorAll('.seg')) {
    const btns = [...seg.querySelectorAll(':scope > button')];
    const on = btns.find((b) => b.getAttribute('aria-pressed') === 'true');
    if (!on || !on.offsetWidth) continue;
    seg.style.setProperty('--tx', `${on.offsetLeft - 2}px`);
    seg.style.setProperty('--tw', `${on.offsetWidth}px`);
    const i = btns.indexOf(on);
    const was = Number(seg.dataset.on);
    seg.dataset.on = String(i);
    if (!seg.classList.contains('ready')) requestAnimationFrame(() => seg.classList.add('ready'));
    else if (i !== was) segWake(seg, i > was ? 1 : -1);
  }
}

/** 临时画布逐帧画：每帧调 draw(ctx, 毫秒, 宽, 高)，返回 false 就把画布拿掉（按钮里的细点、侧栏扫过的点都用它）。 */
function specks(cv, W, H, draw) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  let t0 = 0;
  const frame = (now) => {
    if (!cv.isConnected) return;
    t0 ||= now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = PAPER.ink;
    if (draw(ctx, now - t0, W, H)) requestAnimationFrame(frame);
    else cv.remove();
  };
  requestAnimationFrame(frame);
}

/** 在 host 里临时垫一层画布（底色之上、滑块和字之下，见 .specks）；同一处连着切，上一层直接换掉。 */
function underlay(host, draw) {
  host.querySelector(':scope > .specks')?.remove();
  const W = host.clientWidth;
  const H = host.clientHeight;
  if (still() || !W || !H) return;
  const cv = h('canvas', { class: 'specks', 'aria-hidden': 'true' });
  host.prepend(cv);
  specks(cv, W, H, draw);
}

/**
 * 收起 / 打开侧栏：这一栏挨着对话的那条边化成一道点，跟着边走（画布贴着内沿、放在这一栏里面，栏收窄就一起被裁掉，
 * 点不会落到对话上）。越靠边越密越大，分三档；收起时点一出来就跟着边收走，打开时边停稳前分三档散掉。
 */
const SIDE_BAND = 42;
function sideSweep(side, open) {
  const host = side === 'left' ? $('#left') : $('#right');
  host.querySelector(':scope > .specks.side')?.remove();
  const w = side === 'left' ? UI.left : UI.right;
  const H = host.clientHeight;
  if (still() || narrow() || !w || !H) return;
  const cv = h('canvas', { class: 'specks side', 'aria-hidden': 'true', style: `${side === 'left' ? 'right' : 'left'}: 0; width: ${SIDE_BAND}px; height: ${H}px` });
  host.append(cv);
  // 离内沿多远（0 贴着边）：左栏的内沿在画布右边，右栏在左边
  const dots = [];
  for (let y = 6; y < H; y += 10) {
    for (let d = 3; d < SIDE_BAND; d += 10) {
      const r = hash(d, y);
      // 越靠边越密：贴边一列留七成，最外一列留两成
      if (r > 300 + (d / SIDE_BAND) * 500) dots.push(side === 'left' ? SIDE_BAND - d : d, y, d, r);
    }
  }
  const T = 420;
  specks(cv, SIDE_BAND, H, (ctx, t) => {
    const lv = [new Path2D(), new Path2D(), new Path2D()];
    // 整道点的份量：收起时 60 毫秒长满、跟着边走完；打开时长满后在边停稳前退掉
    const grow = clamp(t / 60, 0, 1);
    const env = open ? grow * (1 - smooth(T * 0.35, T, t)) : grow;
    for (let n = 0; n < dots.length; n += 4) {
      const d = dots[n + 2];
      const r = dots[n + 3];
      const k = Math.ceil(env * 3 * (1 - d / SIDE_BAND) - (r % 3) * 0.25) - 1;
      if (k < 0) continue;
      const x = dots[n];
      const y = dots[n + 1];
      const rad = 0.7 + 0.45 * Math.min(k, 2);
      lv[Math.min(k, 2)].moveTo(x + rad, y);
      lv[Math.min(k, 2)].arc(x, y, rad, 0, 6.2832);
    }
    lv.forEach((p, k) => {
      ctx.globalAlpha = 0.16 + 0.1 * k;
      ctx.fill(p);
    });
    return t < T + 40;
  });
}

/**
 * 分段按钮换了一块：滑块身后留一串 4px 一格的细点（滑动的拖影拆成一格一格的点）。
 * 滑块的后沿经过哪儿，哪儿的点就亮，再分三档变小；滑得快拖得长，停下来就散完。
 */
function segWake(seg, dir) {
  const pill = getComputedStyle(seg, '::before');
  const edge = () => new DOMMatrixReadOnly(pill.transform).m41 + (dir > 0 ? 0 : parseFloat(pill.width));
  const from = edge();
  const tx = parseFloat(seg.style.getPropertyValue('--tx'));
  const to = dir > 0 ? tx : tx + parseFloat(seg.style.getPropertyValue('--tw'));
  const dots = [];
  let last = from;
  underlay(seg, (ctx, t, W, H) => {
    if (!dots.length) {
      for (let x = 2; x < W; x += 4) {
        if ((x - from) * dir < 0 || (x - to) * dir > 0) continue;
        for (let y = 6; y <= H - 6; y += 4) {
          const r = hash(x, y);
          if (r > 180) dots.push({ x, y, s: 0.6 + r / 2500, thr: (r % 5) - 2, on: -1 });
        }
      }
    }
    const e = edge();
    let live = t < 80 || Math.abs(e - last) > 0.1;
    last = e;
    for (const d of dots) {
      if (d.on < 0) {
        if ((e - d.x - d.thr) * dir <= 0) continue;
        d.on = t;
      }
      const k = Math.ceil(3 - (t - d.on) / 70) / 3;
      if (k <= 0) continue;
      live = true;
      ctx.globalAlpha = 0.18 + 0.3 * k;
      ctx.beginPath();
      ctx.arc(d.x, d.y, 1.3 * d.s * k, 0, 6.2832);
      ctx.fill();
    }
    return live && t < 1000;
  });
}

/** 开关拨过去的那一下：打开时墨点跟着圆钮一颗颗铺满（随后 CSS 的底色接上），关上时从圆钮离开的那头一颗颗散掉。 */
function switchSpecks(sw) {
  const on = sw.getAttribute('aria-checked') === 'true';
  const dots = [];
  underlay(sw.querySelector('.track'), (ctx, t, W, H) => {
    if (!dots.length) for (let x = 1.5; x < W; x += 3) for (let y = 1.5; y < H; y += 3) dots.push([x, y, 20 + 150 * (on ? x / W : 1 - x / W) + hash(x * 2, y * 2) / 25]);
    let live = on && t < 320;
    for (const [x, y, at] of dots) {
      const p = clamp((t - at) / 60, 0, 1);
      const k = Math.ceil((on ? p : 1 - p) * 3) / 3;
      if (p < 1) live = true;
      if (!k) continue;
      ctx.beginPath();
      ctx.arc(x, y, 2.2 * k, 0, 6.2832);
      ctx.fill();
    }
    return live;
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 行内格式：先转义，再加 code / strong，所以不会注入。 */
function inline(escaped) {
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function diffHtml(text) {
  return String(text)
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => {
      let cls = 'l';
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary|old mode|new mode)/.test(l)) cls += ' meta';
      else if (l.startsWith('@@')) cls += ' hunk';
      else if (l.startsWith('+')) cls += ' add';
      else if (l.startsWith('-')) cls += ' del';
      return `<div class="${cls}">${esc(l) || ' '}</div>`;
    })
    .join('');
}

/** 一整份 diff 按文件切开。 */
function splitDiff(text) {
  const out = [];
  let cur = null;
  for (const l of String(text || '').split('\n')) {
    if (l.startsWith('diff --git ')) {
      const m = l.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : l.slice(11), lines: [], add: 0, del: 0 };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    if (l.startsWith('+')) cur.add++;
    else if (l.startsWith('-')) cur.del++;
    cur.lines.push(l);
  }
  return out;
}

/** 很小的 Markdown：标题、列表、引用、代码块、行内代码、粗体。 */
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = false;
  const flush = () => {
    if (list) out.push('</ul>');
    list = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const lang = l.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      out.push(lang === 'diff' ? `<div class="pre diff">${diffHtml(buf.join('\n'))}</div>` : `<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    const hm = l.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      flush();
      const n = Math.min(hm[1].length + 1, 4);
      out.push(`<h${n}>${inline(esc(hm[2]))}</h${n}>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      flush();
      out.push(`<blockquote>${inline(esc(l.replace(/^>\s?/, '')))}</blockquote>`);
      continue;
    }
    const lm = l.match(/^\s*[-*]\s+(.*)$/) || l.match(/^\s*\d+[.、]\s+(.*)$/);
    if (lm) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(esc(lm[1]))}</li>`);
      continue;
    }
    if (!l.trim()) {
      flush();
      continue;
    }
    flush();
    out.push(`<p>${inline(esc(l))}</p>`);
  }
  flush();
  return out.join('');
}

const pad = (n) => String(n).padStart(2, '0');
const msOf = (ts) => (ts ? Date.parse(ts) : NaN);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function clock(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

/** 列表里的时间：今天写几点，昨天写「昨天」，一周内写星期，再早写日期。 */
function when(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (sameDay(d, now)) return clock(ts);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return T`昨天`;
  if (now - d < 6 * 86400000) return [T`周日`, T`周一`, T`周二`, T`周三`, T`周四`, T`周五`, T`周六`][d.getDay()];
  return T`${d.getMonth() + 1}月${d.getDate()}日`;
}

function elapsed(ts) {
  const s = Math.max(0, Math.floor((Date.now() - msOf(ts)) / 1000));
  if (!Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const hh = Math.floor(m / 60);
  return hh ? `${hh}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function lasted(a, b) {
  const s = Math.max(0, Math.round((msOf(b) - msOf(a)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return T`${s} 秒`;
  if (s < 3600) return T`${Math.round(s / 60)} 分钟`;
  return T`${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
}

function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const store = {
  get(k) {
    try {
      return localStorage.getItem(`relay.${k}`);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null || v === undefined || v === '') localStorage.removeItem(`relay.${k}`);
      else localStorage.setItem(`relay.${k}`, String(v));
    } catch {
      /* 存不了就算了：只是记住窗口的样子 */
    }
  },
  json(k, d) {
    try {
      const v = JSON.parse(this.get(k) ?? 'null');
      return v ?? d;
    } catch {
      return d;
    }
  },
};

function tildify(p) {
  const home = S.st && S.st.home;
  return home && p && p.startsWith(home) ? `~${p.slice(home.length)}` : p || '';
}

const basename = (p) => String(p).split(/[\\/]/).pop();

/** 太长的路径只留后面几层。 */
function shortPath(p) {
  const t = tildify(p);
  if (t.length <= 42) return t;
  const parts = t.split('/');
  let out = parts.pop();
  while (parts.length && out.length + parts[parts.length - 1].length < 38) out = `${parts.pop()}/${out}`;
  return `…/${out}`;
}

/** 「Codex · gpt-6」→ ['Codex', 'gpt-6']。 */
function splitLabel(label) {
  const [a, ...b] = String(label || '').split(' · ');
  return [a, b.join(' · ')];
}

/* 给人看的名字一律是模型的名字（GPT-6 Sol、Claude Opus 5.5、Grok 4.7），工具只是它在哪儿跑。
   和 src/core/names.ts 的 llmName 是同一套规则（测试拿同一张表对照两边）。 */
const LLM_WORD = { gpt: 'GPT', glm: 'GLM', mimo: 'MiMo', deepseek: 'DeepSeek', qwq: 'QwQ' };
const LLM_VARIANT = /^(low|medium|high|xhigh|max|ultra|minimal|fast|thinking|preview|latest|\d{8})$/i;

function llmName(model) {
  const w = String(model || '')
    .trim()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/^.*\//, '')
    .replace(/^cursor-/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean);
  while (w.length > 1 && LLM_VARIANT.test(w[w.length - 1])) w.pop();
  if (!w.length) return '';
  if (/^(opus|sonnet|haiku|fable)$/i.test(w[0])) w.unshift('claude');
  if (/^claude$/i.test(w[0])) for (let i = w.length - 1; i >= 2; i--) if (/^\d+$/.test(w[i]) && /^\d+$/.test(w[i - 1])) w.splice(i - 1, 2, `${w[i - 1]}.${w[i]}`);
  const word = (x) => LLM_WORD[x.toLowerCase()] || (/^[vk]\d/i.test(x) ? x.toUpperCase() : /^\d/.test(x) ? x : x[0].toUpperCase() + x.slice(1));
  let head = word(w[0]);
  let i = 1;
  if (/^(gpt|glm)$/i.test(w[0]) && /^\d/.test(w[1] || '')) {
    head += `-${w[1]}`;
    i = 2;
  }
  return [head, ...w.slice(i).map(word)].join(' ');
}

/** 记录里的「工具 · 模型」（一棒是谁做的、旧的群聊）按模型叫；新的群聊记录里写的就是名字。 */
function nameOf(label, model) {
  const text = String(label || '');
  if (!text.includes(' · ')) return tr(text) || llmName(model);
  const [tool, m] = splitLabel(text);
  return llmName(m || model) || tr(tool);
}

function memberName(m) {
  return m.llm || nameOf(m.label, m.model);
}

function hashStr(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- 状态 ----------

const S = {
  dir: new URLSearchParams(location.search).get('dir') || '',
  st: null,
  talk: { rows: [], votes: [], status: { speaking: [], queue: [] }, sessions: [] },
  tree: null,
  treeRev: 0,
  /** 选中的对话（任务）；null = 最新的那个。 */
  thread: null,
  /** 正在写新任务（还没发出去）。 */
  draft: false,
  fold: false,
  open: new Set(),
  detail: new Map(),
  /** 中间的页签：0 = 对话，其余是打开的文件、改动。 */
  tabs: [],
  tab: 0,
  docs: new Map(),
  ask: null,
  atUsed: false,
  mode: 'turn',
  files: [],
  /** 正在传的文件：传完换成它在项目里的路径，放进 files。 */
  uploading: [],
  options: [],
  slash: null,
  autoAfter: false,
  treeOpen: new Set(),
  treeFilter: '',
  onlyChanged: false,
  treeSel: '',
  offline: false,
  /** 打开网页时接力台跑的是哪一份编译结果；变了（换了新版重启过）就刷新网页。 */
  build: '',
  newBuild: false,
  /** 切换项目一次加一；请求回来时代数不对就丢掉（不然 A 项目的东西会显示在 B 项目里）。 */
  gen: 0,
  /** 每类请求发到第几次了：回来的不是最新那次就丢掉。 */
  seq: {},
  /** 定时刷新时上次拿到的原文（没变就不解析、不重画）；换项目时清空。 */
  raw: {},
  editingTitle: false,
  dismissed: store.get('dismissed') || '',
  /** 哪一页：relay 接力（任务、一棒一棒），chat 群聊（讨论、投票）。 */
  view: ['relay', 'dispatch', 'chat'].includes(store.get('view')) ? store.get('view') : 'relay',
  /** 看的是哪一段群聊：null = 正在用的，其余是存档的 id。 */
  chat: null,
  /** 存档的群聊（按 id 取回来的记录）。 */
  archive: null,
  /** 刚切了页：1 从右边滑进来（去群聊），-1 从左边（回接力）。 */
  swap: 0,
};

const UI = {
  left: clamp(Number(store.get('left')) || 264, 200, 420),
  right: clamp(Number(store.get('right')) || 296, 220, 560),
  noLeft: store.get('noLeft') === '1',
  /** 右栏现在收着没有（下面 fitRight 算）；userNoRight 是你自己收的（记在本机），peek 是窗口窄时你临时打开的。 */
  noRight: store.get('noRight') === '1',
  userNoRight: store.get('noRight') === '1',
  peek: false,
};

const app = $('#app');
const layer = $('#layer');
const mqNarrow = matchMedia('(max-width: 860px)');
const narrow = () => mqNarrow.matches;
/** 放不下三栏（窄于 1180px）：右栏自己收起来，宽回来再自己打开；这时候点开右栏只是临时的，不改你记下的。 */
const mqMid = matchMedia('(max-width: 1180px)');
function fitRight() {
  const v = UI.userNoRight || (mqMid.matches && !UI.peek);
  if (v === UI.noRight) return false;
  UI.noRight = v;
  return true;
}
fitRight();

/** same：定时刷新用。和上次拿到的一字不差就返回 null，省掉解析和重画。 */
async function api(path, body, same) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: S.dir || undefined, ...body }) };
  const res = await fetch(path, init);
  const text = await res.text();
  if (same) {
    if (S.raw[same] === text) return null;
    S.raw[same] = text;
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(T`接力台返回了看不懂的内容（${res.status}）`);
  }
  if (!j.ok) throw Object.assign(new Error(j.error || T`出错`), { code: j.code });
  return j;
}

/** 发请求前领一张凭据：记下是哪个项目、这类请求的第几次。 */
function ticket(kind) {
  S.seq[kind] = (S.seq[kind] || 0) + 1;
  return { gen: S.gen, dir: S.dir, kind, n: S.seq[kind] };
}

/** 回来时对一下：项目换了、或者后面又发了同一类的新请求，这次的结果就不要了。 */
function stale(t) {
  return t.gen !== S.gen || t.dir !== S.dir || S.seq[t.kind] !== t.n;
}

/** GET 地址带上当前项目。 */
function q(path) {
  return S.dir ? `${path}${path.includes('?') ? '&' : '?'}dir=${encodeURIComponent(S.dir)}` : path;
}

/** 失败的提示：「没能 X：原因」（原因去掉句末的句号）。说法见 docs/设计说明.md「结果怎么说」。 */
function fail(what, e) {
  const why = tr(String((e && e.message) || e || '').trim().replace(/[。.]+$/, ''));
  toast(what ? T`没能${what}：${why || T`出错`}` : why || T`出错`, { bad: true });
}

/** 按钮点下去：请求期间转圈，出错弹提示，做完刷新。 */
async function act(btn, fn, okText) {
  if (btn) {
    btn.classList.add('busy');
    btn.disabled = true;
  }
  try {
    const r = await fn();
    if (okText) {
      const t = typeof okText === 'function' ? okText(r) : okText;
      if (t) toast(t);
    }
    await refresh(true);
    schedule();
    return r;
  } catch (e) {
    // 「已保存」失败了说「没能保存」；英文里只说原因
    if (e.code !== 'cancelled') fail(LANG.zh && typeof okText === 'string' && okText.startsWith('已') ? okText.slice(1) : '', e);
    return null;
  } finally {
    if (btn && btn.isConnected) {
      btn.classList.remove('busy');
      btn.disabled = false;
    }
  }
}

// ---------- 成员：每家 AI 一个图标 ----------

function members() {
  return (S.st && S.st.members) || [];
}

function ready() {
  return members().filter((m) => m.canWork && !m.cooling);
}

function talkers() {
  return members().filter((m) => m.canTalk);
}

function memberByName(n) {
  return members().find((m) => m.name === n) || null;
}

/*
 * 每家 AI 一个单色小图形（24×24），照各家标志的样子简化画的，只用黑白灰。
 * 图标跟着在干活的那家模型走：Claude Code 接的是 DeepSeek，就画鲸鱼；Cursor、OpenCode 这类能换模型的工具画它自己的。
 * 认不出来的给一个几何图形，同一份名单里不重样。强弱看底色：强模型实心，弱模型浅灰，身份不明是虚线框。
 */
const line = (d, w = 2.2) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const solid = (d) => `<path d="${d}" fill="currentColor" fill-rule="evenodd"/>`;

function knot() {
  let rings = '';
  for (let a = 0; a < 360; a += 60) rings += `<rect x="12.3" y="3.8" width="5" height="10.4" rx="2.5" transform="rotate(${a} 12 12)"/>`;
  return `<g fill="none" stroke="currentColor" stroke-width="1.9">${rings}</g>`;
}

const GLYPHS = {
  // 做模型的几家
  anthropic: line('M12 10.8V2.4M12.67 11.01l3.47-5.14M13.11 11.55l7.42-3M13.18 12.23l5.69 1.11M12.82 12.88l5.73 6.14M12.19 13.19l1 6.32M11.49 13.09l-3.29 7.07M10.97 12.62l-5.14 3.09M10.8 11.92l-8.38-.59M11.05 11.26 6.17 7.44', 2.3),
  openai: knot(),
  deepseek: solid('M3 11.6C3 8.9 5.4 7.4 8.6 7.6c3.2.2 5.2 1.6 6.8 3 1.2 1 2.2.2 2.8-1.2.4-1.1 1.1-2.8 3-3.5 0 1.9-.6 3.7-1.6 5.3-1 1.7-2.4 3-4.2 3.9-2.4 1.3-5.1 1.8-7.5 1.5C5.1 16.2 3 14.6 3 11.6zM5.95 11a.95.95 0 1 0 1.9 0 .95.95 0 1 0-1.9 0z'),
  google: solid('M12 2.5c.55 5.1 4.4 8.95 9.5 9.5-5.1.55-8.95 4.4-9.5 9.5-.55-5.1-4.4-8.95-9.5-9.5 5.1-.55 8.95-4.4 9.5-9.5z'),
  xai: line('M16.8 5.9A7.5 7.5 0 0 0 5.9 16.8M8.3 18.6A7.5 7.5 0 0 0 18.6 8.3M3.8 20.2 20.2 3.8'),
  zhipu: `${line('M5 6.5h11L5.5 17.5H16', 2.6)}<circle cx="19.4" cy="17.5" r="1.6" fill="currentColor"/>`,
  xiaomi: line('M5 17.5V8h7.2a3.3 3.3 0 0 1 3.3 3.3v6.2M9.4 12v5.5M19.2 8v9.5', 2.3),
  qwen: line('M12 3.8 19 7.9v4.3M19.1 16.1 12 20.2l-3.7-2.1M4.9 16.1V7.9l3.7-2.2', 2.4),
  moonshot: solid('M15.2 3.9a8.6 8.6 0 1 0 4.9 12.4A7.1 7.1 0 0 1 15.2 3.9z'),
  meta: line('M12 12c-2-3-3.6-4.5-5.5-4.5a4.5 4.5 0 0 0 0 9c1.9 0 3.5-1.5 5.5-4.5s3.6-4.5 5.5-4.5a4.5 4.5 0 0 1 0 9c-1.9 0-3.5-1.5-5.5-4.5z'),
  // 能换模型的工具
  cursor: '<path d="M12 3 19.79 7.5 12 12 4.21 7.5z" fill="currentColor"/><path d="M4.21 7.5 12 12v9l-7.79-4.5z" fill="currentColor" opacity=".55"/><path d="M19.79 7.5v9L12 21v-9z" fill="currentColor" opacity=".28"/>',
  opencode: `<rect x="3.5" y="4.5" width="17" height="15" rx="3.2" fill="none" stroke="currentColor" stroke-width="2"/>${line('m7.6 9.8 2.6 2.3-2.6 2.3M12.6 14.6h3.8', 2)}`,
  antigravity: line('M4.5 19.5C5 12.2 8 5.5 12 5.5s7 6.7 7.5 14', 3.2),
  copilot: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3.8 11.8c0-3.6 2.4-6.3 8.2-6.3s8.2 2.7 8.2 6.3v3.3c0 2-3.7 4.1-8.2 4.1s-8.2-2.1-8.2-4.1z"/><rect x="6.2" y="9.3" width="4.9" height="4.1" rx="2.05"/><rect x="12.9" y="9.3" width="4.9" height="4.1" rx="2.05"/></g>',
  kiro: solid('M5.5 20.2V11a6.5 6.5 0 0 1 13 0v9.2l-2.2-1.5-2.1 1.5-2.2-1.5-2.2 1.5-2.1-1.5zM9 10.6a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0zM12.6 10.6a1.2 1.2 0 1 0 2.4 0 1.2 1.2 0 1 0-2.4 0z'),
  unknown: line('M9.3 9.3a2.8 2.8 0 1 1 4.1 2.5c-.9.5-1.4 1.1-1.4 2.1v.6M12 17.5v.1', 2.1),
  // 认不出来的：几何图形
  ring: '<circle cx="12" cy="12" r="6.6" fill="none" stroke="currentColor" stroke-width="2.6"/>',
  tri: line('M12 5.2 19.2 18H4.8z', 2.3),
  diamond: solid('M12 4.2 19.8 12 12 19.8 4.2 12z'),
  hex: line('M12 4.5 18.5 8.25v7.5L12 19.5l-6.5-3.75v-7.5z'),
  plus: line('M12 5.2v13.6M5.2 12h13.6', 3),
  dots: '<g fill="currentColor"><circle cx="8.3" cy="8.3" r="2.6"/><circle cx="15.7" cy="8.3" r="2.6"/><circle cx="8.3" cy="15.7" r="2.6"/><circle cx="15.7" cy="15.7" r="2.6"/></g>',
  half: '<path d="M5 12a7 7 0 0 1 14 0z" fill="currentColor"/><path d="M5 12a7 7 0 0 0 14 0" fill="none" stroke="currentColor" stroke-width="2"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2.3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor"/>',
};
const SHAPES = ['ring', 'tri', 'diamond', 'hex', 'plus', 'dots', 'half', 'square'];

/** 能换模型的工具：画工具自己的。 */
const TOOL_OWN = [
  [/cursor/i, 'cursor'],
  [/opencode/i, 'opencode'],
  [/antigravity|\bagy\b/i, 'antigravity'],
  [/copilot/i, 'copilot'],
  [/kiro/i, 'kiro'],
];
/** 模型名是哪一家的。 */
const MODEL_MAKER = [
  [/claude|opus|sonnet|haiku/i, 'anthropic'],
  [/deepseek/i, 'deepseek'],
  [/gpt|codex|\bo[1-9](?:-|$)/i, 'openai'],
  [/gemini|gemma/i, 'google'],
  [/grok/i, 'xai'],
  [/glm/i, 'zhipu'],
  [/mimo/i, 'xiaomi'],
  [/qwen|qwq/i, 'qwen'],
  [/kimi|moonshot/i, 'moonshot'],
  [/llama/i, 'meta'],
];
/** 不知道模型时：工具是哪一家的。 */
const TOOL_MAKER = [
  [/claude/i, 'anthropic'],
  [/codex|chatgpt|openai|\bgpt\b/i, 'openai'],
  [/deepseek|\bdsh\b/i, 'deepseek'],
  [/gemini/i, 'google'],
  [/grok/i, 'xai'],
  [/zcode|glm|zhipu|智谱/i, 'zhipu'],
  [/mimo|xiaomi|小米/i, 'xiaomi'],
  [/qwen|通义/i, 'qwen'],
  [/kimi|moonshot/i, 'moonshot'],
];

function brandOf(tool, model) {
  const pick = (rules, text) => (text && (rules.find(([re]) => re.test(text)) || [])[1]) || null;
  return pick(TOOL_OWN, tool) || pick(MODEL_MAKER, model) || pick(TOOL_MAKER, tool);
}

function toolText(name, label, agent) {
  return [agent && agent.harness, name, splitLabel(label)[0]].filter(Boolean).join(' ');
}

let looks = { key: '', shape: new Map() };

/**
 * 认不出来的模型（别人加了这里没画过的）：写它名字的头一个字母（Mistral 写 M，豆包写「豆」）；
 * 两位头一个字母撞了，后来的那位写两个字母（Mi、Mn）。名字里一个字母、一个字都没有，才用几何图形。
 */
function monoOf(text, taken = new Set()) {
  const letters = [...String(text || '').replace(/^(the|my|我的)\s*/i, '')].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (!letters.length) return null;
  const one = letters[0].toUpperCase();
  if (!taken.has(one)) return one;
  const two = letters.slice(1).find((c) => !taken.has(one + c.toLowerCase()));
  return two ? one + two.toLowerCase() : one;
}

/** 名单变了才重算：认不出来的成员各给一个头一个字母（或几何图形），不重样、不跳来跳去。 */
function refreshLooks() {
  const ms = members();
  const key = ms.map((m) => `${m.name}=${m.label}=${m.model || ''}=${m.tier}`).join('|');
  if (key === looks.key) return;
  const shape = new Map();
  const used = new Set();
  for (const m of [...ms].sort((a, b) => a.name.localeCompare(b.name))) {
    if (brandOf(toolText(m.name, m.label, m.agent), m.model)) continue;
    const mono = monoOf(m.llm || llmName(m.model) || splitLabel(m.label)[0] || m.name, used);
    if (mono) {
      used.add(mono);
      shape.set(m.name, `mono:${mono}`);
      continue;
    }
    let k = hashStr(m.name) % SHAPES.length;
    for (let i = 0; i < SHAPES.length && used.has(SHAPES[k]); i++) k = (k + 1) % SHAPES.length;
    used.add(SHAPES[k]);
    shape.set(m.name, SHAPES[k]);
  }
  looks = { key, shape };
}

/** who 可以是成员、一棒的 who、群聊的一行（agent + label）。模型以这一棒自己记下的为准。 */
function lookOf(who) {
  const name = who.name || who.member || (typeof who.agent === 'string' ? who.agent : null) || null;
  const label = who.label || who.who || '';
  const m = name ? memberByName(name) : null;
  const tier = who.tier || (m && m.tier) || 'unknown';
  if (!name && (!label || label === '不知道是谁')) return { brand: 'unknown', tier: 'unknown' };
  const model = who.model || splitLabel(label)[1] || (m && m.model) || '';
  const brand = brandOf([who.tool, toolText(name, label, m && m.agent)].filter(Boolean).join(' '), model);
  // 不在名单里的（旧记录、群聊里别处来的）：按记下的模型名现取一个字母
  const mono = !brand && !(name && looks.shape.get(name)) ? monoOf(llmName(model) || splitLabel(label)[0] || name) : null;
  return { brand: brand || (name && looks.shape.get(name)) || (mono ? `mono:${mono}` : SHAPES[hashStr(name || label) % SHAPES.length]), tier };
}

function glyph(key) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'g');
  s.setAttribute('aria-hidden', 'true');
  if (key.startsWith('mono:')) {
    const t = key.slice(5);
    s.innerHTML = `<text x="12" y="12.6" class="mono-g${t.length > 1 ? ' two' : ''}" text-anchor="middle" dominant-baseline="central" fill="currentColor">${esc(t)}</text>`;
  } else s.innerHTML = GLYPHS[key] || GLYPHS.unknown;
  return s;
}

function tile(who, sz = '', extra = '') {
  const l = lookOf(who);
  return h('span', { class: `tile ${l.tier} ${sz} ${extra}`.trim(), 'data-brand': l.brand, 'aria-hidden': 'true' }, glyph(l.brand));
}

/** 一叠图标：平时叠在一起占的地方小，悬停时散开。extra：每一位额外的样子（在干活、额度用完）。 */
function stack(list, extra = () => '', max = 7) {
  return h(
    'span',
    { class: 'stack' },
    list.slice(0, max).map((m, i) => {
      const t = tile(m, '', extra(m));
      t.style.setProperty('--k', String(i));
      return t;
    }),
    list.length > max ? h('span', { class: 'more-n', style: `--k:${max}` }, `+${list.length - max}`) : null
  );
}

const TIER_WORD = { strong: T`强模型`, weak: T`弱模型` };

function memberTip(m) {
  return [memberName(m), [tr(m.tool), TIER_WORD[m.tier]].filter(Boolean).join(' · '), m.cooling ? T`额度用完 · ${tr(m.coolingText)}` : ''].filter(Boolean).join('\n');
}

/** 一棒是谁做的：模型的名字，下面一行在哪个工具里、强弱。 */
function whoTip(who) {
  if (!who.label || who.label === '不知道是谁') return T`身份不明`;
  const name = nameOf(who.label, who.model);
  const tool = tr(splitLabel(who.label)[0]);
  return [name, [tool !== name ? tool : '', TIER_WORD[who.tier]].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
}

function busyMember() {
  const g = S.st && S.st.project.go;
  return g && (g.status === 'running' || g.status === 'waiting') && g.current ? g.current.member : null;
}

/** 默认派谁：有待复核就挑强的（它会先复核），否则按顺序第一个有额度的。 */
function defaultWorker() {
  const r = ready();
  if (!r.length) return null;
  if (S.st.project.pending.length) return r.find((m) => m.tier === 'strong') || r[0];
  return r[0];
}

function reviewer() {
  return ready().find((m) => m.tier === 'strong') || null;
}

// ---------- 浮层：提示、菜单、面板、弹窗、通知 ----------

let tipTimer = null;
let tipEl = null;
let tipFor = null;

function hideTip() {
  clearTimeout(tipTimer);
  leave(tipEl);
  tipEl = null;
  tipFor = null;
}

function showTip(t) {
  if (!t.isConnected || !t.dataset.tip) return;
  tipEl = h('div', { class: 'tip', role: 'tooltip' }, t.dataset.tip, t.dataset.kbd ? h('kbd', null, keys(t.dataset.kbd)) : null);
  layer.append(tipEl);
  const r = t.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const hh = tipEl.offsetHeight;
  let y = r.bottom + 6;
  if (y + hh > innerHeight - 6) y = r.top - hh - 6;
  tipEl.style.left = `${clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6)}px`;
  tipEl.style.top = `${y}px`;
}

document.addEventListener('pointerover', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t === tipFor) return;
  hideTip();
  if (!t || e.pointerType === 'touch') return;
  tipFor = t;
  tipTimer = setTimeout(() => showTip(t), 420);
});
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('scroll', hideTip, true);

function place(el, anchor, opts = {}) {
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = el.offsetWidth;
  const hh = el.offsetHeight;
  let x = opts.align === 'end' ? r.right - w : r.left;
  let y = opts.side === 'top' ? r.top - hh - 6 : r.bottom + (anchor.getBoundingClientRect ? 6 : 2);
  if (y + hh > innerHeight - 8) y = Math.max(8, r.top - hh - 6);
  if (y < 8) y = 8;
  x = clamp(x, 8, innerWidth - w - 8);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  // 从按钮那一边长出来
  el.style.setProperty('--ox', opts.align === 'end' ? '100%' : '0');
  el.style.setProperty('--oy', y < r.top ? '100%' : '0');
}

function closeMenus() {
  for (const m of layer.querySelectorAll('.menu:not(.leave)')) leave(m);
  SUG.menu = null;
  SUG.items = [];
}

/**
 * 菜单：items 里是 {label, sub, icon, tile, right, disabled, run} / '-' / {head}。
 * on：可以打勾的一项（返回现在勾没勾）；keep：点了菜单不收起（连着勾好几项）。
 */
function openMenu(anchor, items, opts = {}) {
  closeMenus();
  hideTip();
  const m = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
  const checks = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      if (m.lastChild && m.lastChild.tagName !== 'HR') m.append(h('hr'));
      continue;
    }
    if (it.head) {
      m.append(h('div', { class: 'mh' }, it.head));
      continue;
    }
    const b = h(
      'button',
      {
        class: 'mi',
        role: it.on ? 'menuitemcheckbox' : 'menuitem',
        disabled: !!it.disabled,
        onclick: () => {
          if (!it.keep) closeMenus();
          it.run && it.run();
          for (const [el, x] of checks) el.setAttribute('aria-checked', String(!!x.on()));
        },
      },
      it.tile || (it.icon ? icon(it.icon) : null),
      h('span', { class: 'grow' }, h('span', null, it.label), it.sub ? h('span', { class: 'sub' }, it.sub) : null),
      it.right ? h('span', { class: 'r' }, it.right) : null,
      it.on ? icon('check', 'ck') : null
    );
    if (it.on) {
      b.setAttribute('aria-checked', String(!!it.on()));
      checks.push([b, it]);
    }
    m.append(b);
  }
  if (m.lastChild && m.lastChild.tagName === 'HR') m.lastChild.remove();
  // 什么都没有就不弹（以前会弹出一条空白的长条）
  if (!m.querySelector('.mi')) return null;
  m.addEventListener('keydown', (e) => menuKeys(e, m));
  layer.append(m);
  place(m, anchor, opts);
  m.focus({ preventScroll: true });
  return m;
}

function menuKeys(e, m) {
  const items = [...m.querySelectorAll('.mi:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const j = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1;
    items[j] && items[j].focus();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    closeMenus();
  } else if (e.key === 'Tab') {
    closeMenus();
  }
}

document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target.closest('.menu')) return;
    if (layer.querySelector('.menu:not(.leave)')) closeMenus();
  },
  true
);

function ctx(e, items) {
  e.preventDefault();
  openMenu({ x: e.clientX, y: e.clientY }, items);
}

let sheetStack = [];

/** 弹窗。返回 close()；不管怎么关的（按钮、点外面、Esc），都会调 onClose。 */
/** 把框 box 收到 r 那里的变换：中心对中心，等比缩到 r 的大小（最小 .2）。弹窗从按下的按钮长出来、缩回去都用它。 */
function toward(box, r) {
  const b = box.getBoundingClientRect();
  const s = Math.max(0.2, Math.min(1, Math.max(r.width / b.width, r.height / b.height)));
  return `translate(${r.left + r.width / 2 - (b.left + b.width / 2)}px, ${r.top + r.height / 2 - (b.top + b.height / 2)}px) scale(${s})`;
}

// 最近一次按下的按钮：Safari 点按钮不给焦点，弹窗靠它知道从哪长出来（一秒内的才算）
let pressed = { el: null, at: 0 };
document.addEventListener('pointerdown', (e) => (pressed = { el: e.target.closest?.('button, a, [role="button"]') ?? null, at: Date.now() }), true);

function sheet({ title, body, foot, wide, bare, onClose }) {
  const focused = document.activeElement;
  const prev = focused && focused !== document.body ? focused : Date.now() - pressed.at < 1000 ? pressed.el : null;
  // 按下的东西变成结果：弹窗从那个按钮（或菜单里那一项）长出来，所以在收起菜单之前记下它在哪
  const from = prev ? prev.getBoundingClientRect() : null;
  closeMenus();
  const scrim = h('div', { class: 'scrim' });
  const box = h('div', { class: `sheet${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    leave(scrim);
    const to = prev && prev.isConnected ? prev.getBoundingClientRect() : null;
    if (to && to.width && !still()) {
      box.style.pointerEvents = 'none';
      box.animate([{ transform: 'none', opacity: 1 }, { transform: toward(box, to), opacity: 0 }], { duration: 180, easing: EASE.exit, fill: 'forwards' }).finished.then(() => box.remove(), () => box.remove());
    } else leave(box);
    sheetStack = sheetStack.filter((x) => x !== close);
    if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    onClose && onClose();
  };
  if (!bare) {
    box.append(h('div', { class: 'sheet-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': T`关闭`, onclick: close }, icon('x'))));
    if (body) box.append(h('div', { class: 'sheet-body' }, body));
    if (foot) box.append(h('div', { class: 'sheet-foot' }, foot));
  } else box.append(body);
  scrim.addEventListener('click', close);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !layer.querySelector('.menu')) {
      e.stopPropagation();
      close();
    }
  });
  layer.append(scrim, box);
  if (!still()) {
    const r = from && from.width ? from : null;
    box.animate([{ transform: r ? toward(box, r) : 'scale(0.96)', opacity: 0 }, { opacity: 1, offset: 0.3 }, { transform: 'none', opacity: 1 }], { duration: r ? 340 : 220, easing: EASE.snap });
  }
  sheetStack.push(close);
  const f = box.querySelector('[autofocus], textarea, input:not([type=checkbox]), .sheet-foot .primary');
  (f || box.querySelector('button'))?.focus();
  return close;
}

function confirmSheet(title, text, okLabel) {
  return new Promise((resolve) => {
    let answer = false;
    const close = sheet({
      title,
      body: text ? h('p', null, text) : null,
      foot: [
        h('button', { class: 'btn ghost', onclick: () => close() }, T`取消`),
        h(
          'button',
          {
            class: 'btn primary',
            autofocus: true,
            onclick: () => {
              answer = true;
              close();
            },
          },
          okLabel
        ),
      ],
      onClose: () => resolve(answer),
    });
  });
}

let toastTimer = null;

function toast(text, opts = {}) {
  leave($('.toast:not(.leave)'));
  clearTimeout(toastTimer);
  const t = h(
    'div',
    { class: `toast${opts.action ? '' : ' plain'}`, role: 'status' },
    opts.bad ? h('span', { class: 'rd' }) : null,
    h('span', null, text),
    opts.action
      ? h(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              leave(t);
              opts.action.run();
            },
          },
          opts.action.label
        )
      : null
  );
  document.body.append(t);
  toastTimer = setTimeout(() => leave(t), opts.bad || opts.action ? 6000 : 2400);
}

/** 复制，然后说一声。 */
function copyToast(text) {
  return copyText(text).then((ok) => toast(ok ? T`已复制` : T`没能复制`, { bad: !ok }));
}

// ---------- 布局：三栏、拖动改宽度、收起 ----------

function applyLayout() {
  app.style.setProperty('--left', `${UI.left}px`);
  app.style.setProperty('--right', `${UI.right}px`);
  app.classList.toggle('no-left', UI.noLeft);
  app.classList.toggle('no-right', UI.noRight);
  // 栏宽变了，页签底下的滑块按新的宽度量一次
  syncSegs();
}

function closeDrawers() {
  app.classList.remove('drawer-left', 'drawer-right');
  leave($('.drawer-scrim:not(.leave)'));
}

function drawer(side) {
  const on = !app.classList.contains(`drawer-${side}`);
  closeDrawers();
  if (!on) return;
  app.classList.add(`drawer-${side}`);
  document.body.append(h('div', { class: 'drawer-scrim', onclick: closeDrawers }));
}

/** 收起 / 打开一边的栏：栏收放、内容滑走或滑回、内沿扫一道点；顶栏上替它留的那颗按钮淡进淡出，旁边的字滑过去让位。 */
function toggleSide(side) {
  if (narrow()) return drawer(side);
  hideTip();
  const k = side === 'left' ? 'noLeft' : 'noRight';
  if (side === 'right' && mqMid.matches) UI.peek = UI.noRight;
  else if (side === 'right') {
    UI.userNoRight = !UI.userNoRight;
    UI.peek = false;
    store.set(k, UI.userNoRight ? '1' : '');
  } else store.set(k, !UI[k] ? '1' : '');
  if (side === 'right') fitRight();
  else UI.noLeft = !UI.noLeft;
  applyLayout();
  sideSweep(side, !UI[k]);
  if (side === 'right') wireTo(null);
  renderAll();
}
const toggleLeft = () => toggleSide('left');
const toggleRight = () => toggleSide('right');

for (const g of document.querySelectorAll('.grip')) {
  const side = g.dataset.grip;
  g.addEventListener('pointerdown', (e) => {
    if (narrow() || e.button !== 0) return;
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    g.classList.add('on');
    app.classList.add('resizing');
    const x0 = e.clientX;
    const w0 = side === 'left' ? UI.left : UI.right;
    const move = (ev) => {
      if (side === 'left') UI.left = clamp(w0 + ev.clientX - x0, 200, 420);
      else UI.right = clamp(w0 - (ev.clientX - x0), 220, 560);
      applyLayout();
    };
    const up = () => {
      g.classList.remove('on');
      app.classList.remove('resizing');
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      store.set(side, side === 'left' ? UI.left : UI.right);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
  g.addEventListener('dblclick', () => {
    if (side === 'left') UI.left = 264;
    else UI.right = 296;
    store.set(side, null);
    applyLayout();
  });
}

function sideBtn(side) {
  const b = side === 'left' ? iconBtn(T`项目和对话`, 'sideL', toggleLeft, '⌘B') : iconBtn(T`文件`, 'sideR', toggleRight, '⌥⌘B');
  b.dataset.k = `side-${side}`;
  return b;
}

// ---------- 数据 ----------

/** 连不上接力台：刚在设置里点了关闭，就写「已关闭接力台」（不是出了问题，不标红点、不给重试）。 */
function setOffline(v) {
  if (!v) S.closed = false;
  const closed = v && !!S.closed;
  if (S.offline === v && S.shownClosed === closed) return;
  S.offline = v;
  S.shownClosed = closed;
  if (!CE.offline) return;
  show(CE.offline, v);
  CE.offlineText.textContent = closed ? T`已关闭接力台` : T`连不上接力台`;
  CE.offlineDot.hidden = CE.offlineRetry.hidden = closed;
}

/** force：刚做完一个操作，一定要按接力台的最新状态重画（定时刷新时没变就什么都不做）。 */
async function refresh(force) {
  const t = ticket('state');
  try {
    const st = await api(q('/api/state'), undefined, force || !S.st ? '' : 'state');
    if (stale(t)) return;
    if (!st) return setOffline(false);
    S.st = st;
    if (!S.dir) S.dir = st.project.root;
    setOffline(false);
    // 接力台换了新版重启过：网页也换成新版。你正在打字、开着弹窗或菜单时先不刷，等空下来再刷。
    if (!S.build) S.build = st.build || '';
    else if (st.build && st.build !== S.build) S.newBuild = true;
    if (S.newBuild && !sheetStack.length && !layer.querySelector('.menu') && !(C.ta && C.ta.value.trim())) {
      location.reload();
      return;
    }
    renderAll();
  } catch (e) {
    if (stale(t)) return;
    if (e instanceof TypeError) setOffline(true);
    else fail(T`刷新`, e);
  }
}

async function loadTalk() {
  if (!S.dir) return;
  const t = ticket('talk');
  try {
    const talk = await api(q('/api/talk'), undefined, 'talk');
    if (stale(t) || !talk) return;
    S.talk = talk;
    if (!S.st) return;
    renderLeft();
    renderCenter();
  } catch (e) {
    if (!stale(t) && !(e instanceof TypeError)) fail(T`读取群聊`, e);
  }
}

let treeKey = '';

async function loadTree() {
  if (!S.dir) return;
  const tk = ticket('tree');
  try {
    const t = await api(q('/api/tree'), undefined, 'tree');
    if (stale(tk) || !t) return;
    const k = t.files.join('\0');
    if (k !== treeKey) {
      treeKey = k;
      S.treeRev++;
    }
    S.tree = t;
    renderRight();
  } catch (e) {
    if (stale(tk)) return;
    if (!(e instanceof TypeError)) S.tree = { files: [], truncated: false, error: e.message };
    renderRight();
  }
}

let pollTimer = null;
let ticks = 0;
let stintsKey = '';

function schedule() {
  clearTimeout(pollTimer);
  const p = S.st && S.st.project;
  const g = p && p.go;
  const live = p && (p.now.kind !== 'idle' || (g && (g.status === 'running' || g.status === 'waiting')));
  const t = S.talk.status;
  const talking = t.speaking.length || t.queue.length || S.talk.votes.some((v) => v.status !== 'done') || archiveLive();
  const ms = document.hidden ? 15000 : talking ? 1200 : live ? 1500 : 3000;
  pollTimer = setTimeout(tick, ms);
}

async function tick() {
  await Promise.all([refresh(), loadTalk(), archiveLive() && loadArchive(S.chat)]);
  const p = S.st && S.st.project;
  const k = p ? p.stints.map((s) => `${s.id}${s.status}${s.endedAt || ''}`).join() : '';
  if (k !== stintsKey || ++ticks % 5 === 0) {
    stintsKey = k;
    await loadTree();
  }
  schedule();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

// ---------- 对话（一个任务一段） ----------

function threads() {
  return (S.st && S.st.project.threads) || [];
}

/** 这一页的任务：派活页只列在派活页写的，接力页列别的（线路还是按全部任务切，见 rangeOf）。 */
function pageThreads() {
  const dispatch = S.view === 'dispatch';
  return threads().filter((t) => (t.mode === 'dispatch') === dispatch);
}

/** 这个任务在哪一页。 */
function pageOf(t) {
  return t && t.mode === 'dispatch' ? 'dispatch' : 'relay';
}

/** 「3.2 万」「860」：token 数。 */
function tokenText(n) {
  return n >= 10000 ? T`${(n / 10000).toFixed(1)} 万` : String(n);
}

/** 这几棒强模型、弱模型各用了多少 token（工具自己报的）；有没报用量的写出几棒。 */
function tokenSplit(ids) {
  const sum = { strong: 0, weak: 0 };
  let missing = 0;
  for (const s of ids.map(stintById).filter(Boolean)) {
    if (!s.tokens) missing++;
    else sum[s.who.tier === 'weak' ? 'weak' : 'strong'] += s.tokens.input + s.tokens.output;
  }
  const bits = [sum.strong ? T`强模型 ${tokenText(sum.strong)}` : '', sum.weak ? T`弱模型 ${tokenText(sum.weak)}` : ''].filter(Boolean);
  return bits.length ? `${bits.join(T`，`)} ${L('token')}${missing ? T`（${missing} 棒没报用量）` : ''}` : '';
}

function voteBorn(v) {
  const n = parseInt(String(v.id).split('-')[1], 36);
  return Number.isFinite(n) ? n : msOf(v.ts);
}

function rangeOf(t) {
  const ts = threads();
  return [ts[0] === t ? -Infinity : msOf(t.from), t.to ? msOf(t.to) : Infinity];
}

const inRange = (r, x) => x >= r[0] && x < r[1];

function threadStints(t) {
  const ids = new Set(t.stints);
  return ((S.st && S.st.project.stints) || []).filter((s) => ids.has(s.id)).sort((a, b) => a.id - b.id);
}

function blank(t) {
  return !!t && !t.title && !t.stints.length;
}

function selectedThread() {
  const ts = pageThreads();
  return ts.find((t) => t.id === S.thread) || ts[ts.length - 1] || null;
}

function lastActive(t) {
  let at = msOf(t.from);
  for (const s of threadStints(t)) at = Math.max(at, msOf(s.endedAt || s.startedAt));
  return at;
}

function centerMode() {
  const p = S.st.project;
  if (p.pick) return 'pick';
  if (!p.init) return 'setup';
  if (S.draft) return 'new';
  const t = selectedThread();
  if (!t || blank(t)) return 'new';
  return 'thread';
}

/** after：画好之后再做的（跳到某一棒）。 */
function selectThread(t, after) {
  showView(pageOf(t));
  S.draft = false;
  S.thread = t.current ? null : t.id;
  S.tab = 0;
  closeDrawers();
  turnPage(() => {
    renderAll();
    scrollBottom();
    after && after();
  });
}

function newThread() {
  showView(S.view === 'dispatch' ? 'dispatch' : 'relay');
  S.draft = true;
  S.thread = null;
  S.tab = 0;
  closeDrawers();
  turnPage(() => {
    renderAll();
    C.ta.focus();
  });
}

/**
 * 中间换一段内容（换对话、新任务、换一段群聊）：左边的选中马上跟过去，中间旧的先淡出一点点（0.1 秒）再画新的，
 * 新的一项项升上来（renderStream 的 enterAnim）。换页（接力 / 派活 / 群聊）是整页滑进来，不走这里。
 */
let turning = null;
function turnPage(render) {
  const box = [CE.chat, CE.hero, CE.doc].find((el) => !el.hidden);
  turning?.cancel();
  turning = null;
  if (still() || S.swap || !box || !S.st) return render();
  renderLeft();
  const a = box.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 100, easing: EASE.exit });
  turning = a;
  a.onfinish = () => {
    if (turning !== a) return;
    turning = null;
    render();
  };
}

// ---------- 三页：接力、派活、群聊 ----------

const VIEWS = ['relay', 'dispatch', 'chat'];

/** 换一页（还没画）：记下往哪边切（1 往右、-1 往左），画完后新内容顺着这个方向滑进来、纸上扫一道（renderAll 里的 swapIn、paperSweep）。 */
function showView(v) {
  if (S.view === v) return false;
  S.swap = VIEWS.indexOf(v) > VIEWS.indexOf(S.view) ? 1 : -1;
  S.view = v;
  store.set('view', v);
  S.tab = 0;
  S.draft = false;
  return true;
}

function swapIn(dir) {
  if (still()) return;
  for (const el of [CE.bar, CE.chat, CE.hero, CE.doc]) {
    if (!el.hidden) el.animate([{ opacity: 0, transform: `translateX(${-dir * 22}px)` }, { opacity: 1, transform: 'none' }], { duration: 490, easing: EASE.spring });
  }
}

function setView(v) {
  if (!showView(v)) return;
  closeDrawers();
  renderAll();
  scrollBottom();
}

function runState() {
  const p = S.st.project;
  const g = p.go;
  const running = p.now.kind === 'relay' || (!!g && g.status === 'running');
  const waiting = !running && (p.now.kind === 'waiting' || (!!g && g.status === 'waiting'));
  const native = !running && !waiting && p.now.kind === 'native';
  return { running, waiting, native, g, cur: g && g.current };
}

/** 当前任务已经验收通过（再点全自动没有要做的）。 */
function accepted() {
  const a = S.st.project.acceptance;
  return !!a && a.state === 'accepted';
}

// ---------- 左栏 ----------

let leftSig = '';
let projOrder = [];
/** 左栏最上面一行（接力、群聊的开关）一直是同一个：滑块才滑得过去。下面的内容按需重画。 */
const LE = {};

/** 项目按第一次看到的顺序排，切换时不跳来跳去。 */
function orderedProjects() {
  const list = S.st.projects;
  for (const pr of list) if (!projOrder.includes(pr.root)) projOrder.push(pr.root);
  return [...list].sort((a, b) => projOrder.indexOf(a.root) - projOrder.indexOf(b.root));
}

/** 结构变了（项目、对话、群聊、成员）才重画左栏；只是换了选中的那一段，原地改标记，让过渡动画接得上。 */
function renderLeft() {
  const st = S.st;
  const p = st.project;
  const chat = S.view === 'chat';
  const ts = pageThreads();
  const sig = JSON.stringify([
    S.view,
    st.projects,
    p.root,
    p.init,
    chat
      ? [talkTitle(S.talk), talkAt(S.talk), S.talk.sessions, talkLive()]
      : [ts.map((t) => [t.id, t.title, t.stints, t.pending, lastActive(t), blank(t)]), p.stints.filter((s) => s.status === 'working').map((s) => s.id), S.draft || blank(ts[ts.length - 1])],
    members().map((m) => [m.name, m.llm, m.cooling, m.canWork, m.tier, limitsText(m)]),
    busyMember(),
    looks.key,
  ]);
  if (sig !== leftSig) {
    leftSig = sig;
    drawLeft();
  }
  for (const b of LE.seg.querySelectorAll(':scope > button')) {
    const on = b.dataset.view === S.view;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-selected', String(on));
  }
  LE.news.hidden = !talkNews();
  if (LE.segView !== S.view) {
    LE.segView = S.view;
    syncSegs(LE.brand);
  }
  const mode = chat ? '' : centerMode();
  const on = chat ? `chat:${S.chat || ''}` : mode === 'new' ? 'draft' : mode === 'thread' ? String((selectedThread() || {}).id) : '';
  for (const el of LE.body.querySelectorAll('.thread')) el.setAttribute('aria-current', String(el.dataset.id === on));
}

function drawLeft() {
  const st = S.st;
  const p = st.project;
  const chat = S.view === 'chat';
  const ts = pageThreads();
  const box = $('#left-in');
  if (!LE.brand) {
    LE.news = h('span', { class: 'news', hidden: true });
    LE.seg = h(
      'div',
      { class: 'seg view', role: 'tablist', 'aria-label': T`页面` },
      [
        ['relay', T`接力`],
        ['dispatch', T`派活`],
        ['chat', T`群聊`],
      ].map(([k, label]) => h('button', { role: 'tab', 'data-view': k, onclick: () => setView(k) }, label, k === 'chat' ? LE.news : null))
    );
    LE.brand = h('div', { class: 'brand' }, LE.seg, iconBtn(T`收起`, 'sideL', toggleLeft, '⌘B'));
    LE.body = h('div', { class: 'left-body' });
    box.replaceChildren(LE.brand, LE.body);
  }
  const keep = LE.body.querySelector('.nav')?.scrollTop || 0;
  // 重画前记下每一行右边写的什么：重画后新来的一行淡进来，右边的字变了的淡一下（不是整列一闪）
  const was = new Map([...LE.body.querySelectorAll('.thread')].map((el) => [el.dataset.id, el.querySelector('.when')?.textContent]));
  // 刚切了页：这一列新换上的对话一行接一行浮上来
  const swap = !!S.swap;
  const projects = [];
  for (const pr of orderedProjects()) {
    const cur = pr.current;
    const list = [];
    if (cur && chat && p.init) {
      list.push(sessionEl({ id: '', title: talkTitle(S.talk) || T`新群聊`, at: talkAt(S.talk) }));
      for (const x of S.talk.sessions || []) list.push(sessionEl(x));
    } else if (cur && p.init) {
      if (S.draft || !ts.length || blank(ts[ts.length - 1])) list.push(h('button', { class: 'thread draft', 'data-id': 'draft', onclick: newThread }, h('span', { class: 't' }, T`新任务`), h('span', { class: 'when' }, T`现在`)));
      for (const t of [...ts].reverse()) if (!blank(t)) list.push(threadEl(t));
    }
    if (swap) list.forEach((el, i) => enterAnim(el, i));
    const row = h(
      'div',
      { class: 'proj-row', oncontextmenu: (e) => ctx(e, projMenuItems(pr)) },
      h(
        'button',
        {
          class: 'pmain',
          'aria-expanded': cur ? String(!S.fold) : null,
          onclick: (e) => {
            if (!cur) return switchProject(pr.root);
            S.fold = !S.fold;
            e.currentTarget.setAttribute('aria-expanded', String(!S.fold));
            e.currentTarget.closest('.proj').classList.toggle('open', !S.fold);
          },
        },
        icon('chev', 'caret'),
        h('span', { class: 'name' }, pr.name),
        pr.live ? h('span', { class: 'dot live' }) : pr.pending ? h('span', { class: 'rd', 'data-tip': T`${pr.pending} 棒待复核` }) : null
      ),
      iconBtn(T`${pr.name} 更多`, 'more', (e) => openMenu(e.currentTarget, projMenuItems(pr)), '', 'more')
    );
    projects.push(h('div', { class: `proj${cur ? ' current' : ''}${cur && !S.fold ? ' open' : ''}` }, row, cur ? h('div', { class: 'threads' }, h('div', null, list)) : null));
  }
  if (!st.projects.length) projects.push(h('div', { class: 'proj' }, h('div', { class: 'proj-row' }, h('button', { class: 'pmain', onclick: chooseFolder }, icon('folder'), h('span', { class: 'name' }, T`打开文件夹`)))));
  // 成员收成一小叠（在干活的那位放最上面），点开是名单
  const busy = busyMember();
  const team = [...members()].sort((a, b) => Number(b.name === busy) - Number(a.name === busy));
  const look = (m) => (m.name === busy ? 'busy' : m.cooling ? 'cooling' : '');
  LE.body.replaceChildren(
    h(
      'div',
      { class: 'acts' },
      chat
        ? h('button', { class: 'btn line', onclick: newChat, disabled: !!p.pick }, icon('plus'), T`新群聊`)
        : h('button', { class: 'btn line', onclick: newThread, disabled: !!p.pick || (!p.init && !st.projects.length) }, icon('plus'), T`新任务`),
      h('button', { class: 'find', 'aria-label': T`搜索`, onclick: () => openPalette() }, icon('search'), h('span', { class: 'fl' }, T`搜索`), h('kbd', null, keys('⌘K')))
    ),
    h('nav', { class: 'nav', 'aria-label': T`项目` }, h('div', { class: 'nav-label' }, h('span', { class: 'cap' }, T`项目`), iconBtn(T`打开文件夹`, 'plus', chooseFolder)), projects),
    h(
      'div',
      { class: 'dock' },
      h(
        'button',
        {
          class: 'team',
          'aria-label': T`成员`,
          'aria-haspopup': 'menu',
          onclick: (e) =>
            openMenu(
              e.currentTarget,
              [
                ...team.map((m) => ({
                  label: memberName(m),
                  sub: [tr(m.tool), m.name === busy ? T`干活中` : m.cooling ? T`额度用完 · ${tr(m.coolingText)}` : !m.canWork && m.kind !== 'app' ? T`不可调度` : limitsText(m)].filter(Boolean).join(' · '),
                  tile: tile(m, 's20', look(m)),
                  right: m.tier === 'strong' ? T`强` : T`弱`,
                  run: () => openSettings('members'),
                })),
              ],
              { side: 'top' }
            ),
        },
        team.length ? stack(team, look, 3) : h('span', { class: 'more-n' }, T`成员`)
      ),
      langBtn(),
      iconBtn(T`设置`, 'sliders', () => openSettings())
    )
  );
  LE.body.querySelector('.nav').scrollTop = keep;
  if (swap || !was.size || still()) return;
  for (const el of LE.body.querySelectorAll('.thread')) {
    if (!was.has(el.dataset.id)) el.animate([{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE.ease });
    else if (was.get(el.dataset.id) !== el.querySelector('.when')?.textContent) el.querySelector('.when')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: EASE.ease });
  }
}

/** 哪天几点：今天只写几点，昨天写「昨天 21:43」，更早写「9月25日 21:43」。 */
function dayClock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const w = when(ts);
  return sameDay(d, new Date()) ? w : `${w} ${clock(ts)}`;
}

function threadEl(t) {
  const live = threadStints(t).some((s) => s.status === 'working');
  return h(
    'button',
    { class: 'thread', 'data-id': String(t.id), onclick: () => selectThread(t) },
    h('span', { class: 't' }, t.title || T`未命名`),
    h('span', { class: 'when' }, live ? h('span', { class: 'dot live' }) : t.pending ? [h('span', { class: 'rd' }), T`待复核 ${t.pending}`] : when(lastActive(t)))
  );
}

function projMenuItems(pr) {
  return [
    { label: REVEAL, icon: 'folder', run: () => reveal('', pr.root) },
    { label: T`复制路径`, icon: 'copy', run: () => copyToast(pr.root) },
    '-',
    { label: T`移出列表`, icon: 'x', run: () => forget(pr) },
  ];
}

async function forget(pr) {
  try {
    await api('/api/forget', { dir: pr.root });
    if (pr.current) {
      const next = S.st.projects.find((x) => !x.current);
      if (next) return switchProject(next.root);
    }
    toast(T`已移出`);
    await refresh();
  } catch (e) {
    fail(T`移出`, e);
  }
}

function switchProject(root) {
  S.gen++;
  S.dir = root;
  S.st = null;
  S.thread = null;
  S.draft = false;
  S.fold = false;
  S.open.clear();
  S.detail.clear();
  S.tabs = [];
  S.tab = 0;
  S.docs.clear();
  S.tree = null;
  S.files = [];
  S.ask = null;
  S.treeSel = '';
  S.treeFilter = '';
  S.onlyChanged = false;
  S.talk = { rows: [], votes: [], status: { speaking: [], queue: [] }, sessions: [] };
  S.chat = null;
  S.archive = null;
  S.raw = {};
  treeKey = '';
  stintsKey = '';
  streamThread = null;
  barSig = '';
  heroSig = '';
  tabsSig = '';
  docSig = '';
  // 上一个项目的卡片、顶栏先清掉：新项目的状态回来之前，不能再点到旧项目的按钮。
  CE.bar.replaceChildren();
  CE.stream.replaceChildren();
  CE.hero.replaceChildren();
  S.treeOpen = new Set(store.json(`open:${root}`, []));
  closeDrawers();
  history.replaceState(null, '', `/?dir=${encodeURIComponent(root)}`);
  restoreDraft();
  refresh().then(() => Promise.all([loadTalk(), loadTree()]).then(() => scrollBottom()));
}

async function chooseFolder() {
  closeMenus();
  try {
    const r = await api('/api/choose-folder', { lang: LANG.now });
    switchProject(r.dir);
  } catch (e) {
    if (e.code === 'no-picker') typeFolder();
    else if (e.code !== 'cancelled') fail(L('打开文件夹', '设置'), e);
  }
}

/** 这台电脑弹不出选文件夹的对话框（比如没装 zenity 的 Linux）：把文件夹的完整路径贴进来。 */
function typeFolder() {
  const win = /Windows/i.test(navigator.userAgent);
  const input = h('input', { class: 'input mono', placeholder: MAC ? '/Users/me/project' : win ? 'C:\\Users\\me\\project' : '/home/me/project', 'aria-label': T`文件夹路径` });
  const go = () => {
    const v = input.value.trim().replace(/^["']|["']$/g, '');
    if (!v) return input.focus();
    close();
    switchProject(v);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && go());
  const close = sheet({
    title: T`打开文件夹`,
    body: h('div', null, field(T`文件夹路径`, input)),
    foot: [h('button', { class: 'btn ghost', onclick: () => close() }, T`取消`), h('button', { class: 'btn primary', onclick: go }, T`打开`)],
  });
  setTimeout(() => input.focus(), 50);
}

async function reveal(path, root) {
  try {
    const r = await api('/api/reveal', { path: path || undefined, ...(root ? { dir: root } : {}) });
    if (!r.revealed) toast(MAC ? T`没能打开访达` : T`没能打开文件夹`, { bad: true });
  } catch (e) {
    fail(MAC ? T`打开访达` : L('打开文件夹', '设置'), e);
  }
}

// ---------- 中间 ----------

const CE = {};
let barSig = '';
let heroSig = '';
let tabsSig = '';
let docSig = '';
let streamThread = null;
let stick = true;

function buildCenter() {
  CE.offlineDot = h('span', { class: 'rd' });
  CE.offlineText = h('span', null, T`连不上接力台`);
  CE.offlineRetry = h('button', { class: 'btn small', onclick: () => refresh(true) }, T`重试`);
  CE.offline = h('div', { class: 'offline', hidden: true }, CE.offlineDot, CE.offlineText, CE.offlineRetry);
  CE.cfgBad = h('div', { class: 'offline cfg-bad', hidden: true });
  CE.bar = h('header', { class: 'bar' });
  CE.tabs = h('div', { class: 'tabs', role: 'tablist', hidden: true });
  CE.stream = h('div', { class: 'stream' });
  CE.scroll = h('div', { class: 'scroll', onscroll: onScroll }, CE.stream);
  CE.toBottom = h('button', { class: 'to-bottom', hidden: true, onclick: () => scrollBottom(true) }, icon('down'), T`新消息`);
  CE.chat = h('section', { class: 'pane', 'aria-label': T`对话` }, CE.scroll, CE.toBottom);
  CE.doc = h('section', { class: 'pane', hidden: true });
  CE.hero = h('section', { class: 'hero', hidden: true });
  CE.paper = h('canvas', { class: 'paper', 'aria-hidden': 'true' });
  $('#center').addEventListener('pointermove', paperPointer, { passive: true });
  $('#center').append(CE.paper, CE.offline, CE.cfgBad, CE.bar, CE.tabs, CE.chat, CE.doc, CE.hero);
}

function onScroll() {
  const s = CE.scroll;
  stick = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  if (stick) show(CE.toBottom, false);
  if (WIRE.from) drawWires();
  if (PAPER.kind === 'chat') paperHolesSoon();
}

function scrollBottom(smooth) {
  CE.scroll.scrollTo({ top: CE.scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  stick = true;
  show(CE.toBottom, false);
}

function renderCenter() {
  if (!S.st) return;
  show(CE.offline, S.offline);
  const cfgErr = S.st.project.config && S.st.project.config.error;
  show(CE.cfgBad, !!cfgErr);
  if (cfgErr && CE.cfgBad.dataset.err !== cfgErr) {
    CE.cfgBad.dataset.err = cfgErr;
    CE.cfgBad.replaceChildren(h('span', { class: 'rd' }), h('span', { class: 'ell', 'data-tip': cfgErr }, T`配置文件坏了`), h('button', { class: 'btn small', onclick: () => openFile('.relay/config.json') }, T`打开`));
  }
  const chat = S.view === 'chat';
  const mode = chat ? chatMode() : centerMode();
  const hero = mode !== 'thread' && mode !== 'chat';
  const t = chat || hero ? null : selectedThread();
  const docTab = S.tab > 0 ? S.tabs[S.tab - 1] : null;
  if (S.tab > 0 && !docTab) S.tab = 0;
  CE.bar.hidden = hero;
  CE.tabs.hidden = !S.tabs.length;
  CE.hero.hidden = !hero || !!docTab;
  CE.chat.hidden = hero || !!docTab;
  CE.doc.hidden = !docTab;
  if (S.tabs.length) renderTabs();
  if (hero) renderHero(mode);
  else if (chat) renderChatBar();
  else renderBar(t);
  if (docTab) renderDoc(docTab);
  else if (chat && !hero) {
    // 群聊：输入框浮在对话底下（先放好、量好高度，再滚到底）
    if (C.wrap.parentNode !== CE.chat) {
      CE.chat.append(C.wrap);
      CE.chat.style.setProperty('--compose-h', `${C.wrap.offsetHeight}px`);
    }
    setComposerKind('talk');
    renderTalk();
  } else if (!hero) {
    // 一个任务：只有线路，要说话去群聊
    renderStream(t);
    C.wrap.remove();
    CE.chat.style.setProperty('--compose-h', '0px');
  }
  document.title = S.st.project.name && !S.st.project.pick ? T`${S.st.project.name} · 接力台` : T`接力台`;
  // 这一页的纸（切页时扫过去才换）、空白页输入框周围深一圈
  paperSet(S.view, mode === 'pick' ? 'pick' : S.view);
  paperAura();
  paperHoles();
}

// ----- 空闲：小标题、要人看的一行、输入框 -----

function renderHero(mode) {
  const p = S.st.project;
  // 还没有项目（停在家目录这种大文件夹）：只请你选一个项目文件夹
  if (mode === 'pick') {
    const sig = JSON.stringify([mode, members().length, !!S.st.detecting]);
    if (sig !== heroSig) {
      heroSig = sig;
      C.wrap.remove();
      CE.hero.replaceChildren(
        heroBar(),
        h(
          'div',
          { class: 'hero-in' },
          h(
            'div',
            { class: 'hero-head' },
            h('div', null, h('h1', null, T`接力台`), h('span', { class: 'cap' }, S.st.detecting && !members().length ? T`识别中` : T`${members().length} 位 AI`)),
            h('button', { class: 'btn primary', onclick: chooseFolder }, icon('folder'), T`打开文件夹`)
          )
        )
      );
    }
    return syncHeroBar();
  }
  const setup = mode === 'setup' || mode === 'chat-setup';
  const chat = mode === 'chat-new' || mode === 'chat-setup';
  const pend = setup || chat ? [] : p.pending;
  const canCancel = mode === 'new' && S.draft && pageThreads().some((t) => !blank(t));
  const sig = JSON.stringify([mode, S.view, p.root, p.name, pend.map((s) => [s.id, s.summary]), canCancel]);
  if (sig !== heroSig) {
    heroSig = sig;
    const s = pend[0];
    const head = h(
      'div',
      { class: 'hero-head' },
      h('div', null, h('h1', null, setup ? p.name : chat ? T`新群聊` : T`新任务`), h('span', { class: 'cap', 'data-tip': setup ? p.root : null }, setup ? T`未接入 · ${shortPath(p.root)}` : !chat && S.view === 'dispatch' ? T`${p.name} · 派活` : p.name)),
      setup ? h('button', { class: 'btn line', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), T`已接入`).then(() => loadTree()) }, T`接入`) : null
    );
    const notice = s ? h('button', { class: 'notice', onclick: () => jumpTo(s.id) }, h('span', { class: 'rd' }), h('b', null, T`第 ${s.id} 棒待复核${pend.length > 1 ? T`（共 ${pend.length} 棒）` : ''}`), h('span', { class: 'ell' }, s.summary || '')) : null;
    const under = canCancel
      ? h(
          'div',
          { class: 'under' },
          h(
            'button',
            {
              class: 'link',
              onclick: () => {
                S.draft = false;
                renderAll();
              },
            },
            T`取消`
          )
        )
      : h('div', { class: 'under', hidden: true });
    CE.hero.replaceChildren(heroBar(), h('div', { class: 'hero-in' }, head, notice, C.wrap, under));
  } else if (C.wrap.parentNode !== CE.hero.querySelector('.hero-in')) {
    const inner = CE.hero.querySelector('.hero-in');
    inner.insertBefore(C.wrap, inner.querySelector('.under'));
  }
  syncHeroBar();
  setComposerKind(chat ? 'talk' : 'task');
}

/** 空白页顶上：收起了的侧栏在这里留一颗按钮。和下面的内容分开画，收放侧栏时只有按钮淡进淡出。 */
function heroBar() {
  const bar = h('div', { class: 'hero-bar' });
  bar.dataset.sig = '';
  return bar;
}

function syncHeroBar() {
  const bar = CE.hero.querySelector('.hero-bar');
  const sig = JSON.stringify([UI.noLeft, UI.noRight, narrow()]);
  if (!bar || bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  morph(bar, () => bar.replaceChildren(...[UI.noLeft || narrow() ? sideBtn('left') : null, h('span', { class: 'sp' }), UI.noRight || narrow() ? sideBtn('right') : null].filter(Boolean)), (b) => b.children);
}

// ----- 纸：中间这一栏的底，一张画布画完 -----
//
// 三页三种纸，同一套 20px 的格子（格点在 x = 20i、y = 2 + 20j），每格一个小记号：接力是点，派活是一竖，群聊是一横。
// 空白页上输入框周围的记号深一点、往外淡回去（接力四周匀开，派活往上下伸，群聊往左右伸）。
// 指针划过时附近的记号变大变深，身后一截很快褪掉；切页时从切过去的那一边扫一道，扫到哪儿纸换到哪儿。
// 都画在这一张画布上：每个记号是一个椭圆，按颜色和深浅分组，一组一条路径一起画，叠几样开销都一样。
// 平时不画；只有指针在纸上划、切页那一下才逐帧画，停了就不再排下一帧。

/**
 * 切页时扫过去的那一道的走向（在中间这一栏里的归一化坐标，三次贝塞尔，可以有几条）：
 * 接力：一笔从左边起、在左上拐弯、向右散开成几股；派活：拐过弯分成三股；群聊：三股从左边来、汇成一股往右走。
 * knee：拐弯处（最紧最密）在线上的位置；w：起笔、拐弯、末尾各有多宽；ribbons：散开时分不分股。
 */
const FLOW_LINES = {
  relay: { knee: 0.34, w: [22, 12, 86], ribbons: true, lines: [[[-0.04, 0.5], [0.03, 0.24], [0.12, 0.1], [1.08, 0.08]]] },
  pick: { knee: 0.34, w: [24, 13, 100], ribbons: true, lines: [[[-0.04, 0.52], [0.03, 0.24], [0.12, 0.08], [1.08, 0.06]]] },
  dispatch: {
    knee: 0.3,
    w: [20, 11, 18],
    ribbons: false,
    lines: [
      [[-0.04, 0.5], [0.03, 0.24], [0.14, 0.12], [1.08, 0.0]],
      [[-0.04, 0.5], [0.03, 0.24], [0.16, 0.14], [1.08, 0.15]],
      [[-0.04, 0.5], [0.03, 0.24], [0.18, 0.16], [1.08, 0.3]],
    ],
  },
  chat: {
    knee: 0.56,
    w: [16, 12, 70],
    ribbons: true,
    lines: [
      [[-0.04, 0.04], [0.26, 0.04], [0.4, 0.15], [1.08, 0.13]],
      [[-0.04, 0.17], [0.24, 0.17], [0.4, 0.15], [1.08, 0.13]],
      [[-0.04, 0.3], [0.26, 0.3], [0.4, 0.15], [1.08, 0.13]],
    ],
  },
};
/**
 * 扫过去的节奏：前沿先快后慢走完这一栏（t80 约 0.5，和新内容滑进来一样落得住）；每个点分三档变大、停一下、再分三档变小。
 * 点亮得短，看到的是一道往前走的点。
 */
const SWEEP = { front: 600, grow: 45, hold: 40, fade: 150, ease: 2.3 };
/** 先快后慢的前沿：走到 u（0～1）处要用掉几成时间；ahead 反过来，第 p 成时间走到哪。n 越大越「一下就到」。 */
const reachAt = (u, n) => 1 - (1 - clamp(u, 0, 1)) ** (1 / n);
const ahead = (p, n) => 1 - (1 - clamp(p, 0, 1)) ** n;
/** 输入框周围往外淡多远（横、竖）：接力四周匀开，派活往上下伸（一列列），群聊往左右伸（一行行）。 */
const REACH = { relay: [96, 72], dispatch: [36, 150], chat: [220, 36] };
/** 每种纸的格子：接力 20px；派活、群聊 18px（比点阵纸密一点，记号大小不变）。 */
const PITCH = { relay: 20, dispatch: 18, chat: 18 };
/** 每种记号多大：接力点的半径，派活竖、群聊横的半长；AURA 是输入框周围深一圈时的大小。 */
const BASE = { relay: 1.09, dispatch: 2.5, chat: 2.75 };
const AURA = { relay: 1.2, dispatch: 3, chat: 3 };
const TRAIL_R = 84;
const TRAIL_T = 260;
const PAPER = { kind: 'relay', from: '', curve: 'relay', w: 0, h: 0, dpr: 1, ink: '#151515', dot: 'rgba(21, 21, 21, 0.09)', dot2: 'rgba(21, 21, 21, 0.2)', lift: 1, aura: null, keep: null, holes: [], holeSig: '', trail: [], sweep: null, last: null, raf: 0 };

const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 往路径里加一个记号：接力是圆点（s 是半径），派活是竖的、群聊是横的（s 是半长，w 是粗细）。 */
function mark(p, kind, x, y, s, w) {
  const [rx, ry] = kind === 'dispatch' ? [w / 2, s] : kind === 'chat' ? [s, w / 2] : [s, s];
  p.moveTo(x + rx, y);
  p.ellipse(x, y, rx, ry, 0, 0, 6.2832);
}

/** 输入框周围深多少（0～1）。 */
function auraAt(kind, x, y) {
  const a = PAPER.aura;
  if (!a) return 0;
  const [ex, ey] = REACH[kind] || REACH.relay;
  const dx = x < a[0] ? a[0] - x : x > a[2] ? x - a[2] : 0;
  const dy = y < a[1] ? a[1] - y : y > a[3] ? y - a[3] : 0;
  return dx >= ex || dy >= ey ? 0 : (1 - dx / ex) * (1 - dy / ey);
}

/** 指针划过的地方深多少（0～1）：离得越近、划过得越晚越深。 */
function trailAt(x, y, now) {
  let e = 0;
  for (const [px, py, pt] of PAPER.trail) {
    const d = Math.hypot(x - px, y - py);
    if (d < TRAIL_R) e = Math.max(e, (1 - d / TRAIL_R) ** 2 * (1 - (now - pt) / TRAIL_T));
  }
  return e;
}

/** 一个点亮起后第 age 毫秒有多大（0～1，三档）；-1：已经散完。 */
function sweepK(age, hold) {
  const { grow, fade } = SWEEP;
  if (age < grow) return Math.ceil((age / grow) * 3) / 3;
  if (age < grow + hold) return 1;
  const f = (age - grow - hold) / fade;
  return f < 1 ? Math.ceil((1 - f) * 3) / 3 : -1;
}

/** 一条三次贝塞尔取 n 段折线：[x0, y0, x1, y1, t0, t1, 方向角]。 */
function bezierSegs(P, n) {
  const segs = [];
  let prev = null;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const r = 1 - t;
    const x = r * r * r * P[0][0] + 3 * r * r * t * P[1][0] + 3 * r * t * t * P[2][0] + t * t * t * P[3][0];
    const y = r * r * r * P[0][1] + 3 * r * r * t * P[1][1] + 3 * r * t * t * P[2][1] + t * t * t * P[3][1];
    if (prev) segs.push([prev[0], prev[1], x, y, prev[2], t, Math.atan2(y - prev[1], x - prev[0])]);
    prev = [x, y, t];
  }
  return segs;
}

/** 点到折线第 a～b 段的最近处：[距离², t, 方向角, 在线的哪一边（+1 / -1）, 第几段]。 */
function nearSeg(segs, a, b, x, y, out) {
  for (let k = Math.max(0, a); k <= Math.min(segs.length - 1, b); k++) {
    const [x0, y0, x1, y1, t0, t1, ang] = segs[k];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const u = clamp(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const px = x - x0 - u * dx;
    const py = y - y0 - u * dy;
    const d2 = px * px + py * py;
    if (d2 < out[0]) {
      out[0] = d2;
      out[1] = t0 + (t1 - t0) * u;
      out[2] = ang;
      out[3] = dx * py - dy * px < 0 ? -1 : 1;
      out[4] = k;
    }
  }
}

/**
 * 扫过去的那一道有哪些点、各多大：纸上的点（20px 一个）离弯线近就变大变深，线的正中间再加密成 10px 一个。
 * 拐弯处最密；往后越散越宽、分成几股；起笔零零散散。空白页的字和输入框那一块（keep）留白，离它越近越淡。
 */
function sweepMarks(curve, dir) {
  const { w: W, h: H, keep } = PAPER;
  const g = (PITCH[PAPER.kind] || 20) / 2;
  const cols = Math.floor(W / g) + 1;
  const rows = Math.floor((H - 2) / g) + 1;
  const spec = FLOW_LINES[curve] || FLOW_LINES.relay;
  const lines = spec.lines.map((pts) => {
    const P = pts.map(([u, v]) => [u * W, v * H]);
    return { coarse: bezierSegs(P, 12), fine: bezierSegs(P, 48) };
  });
  const [w0, w1, w2] = spec.w;
  const knee = spec.knee;
  const far = (3.4 * w2) ** 2;
  const best = [0, 0, 0, 0, 0];
  const marks = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * g;
      const y = 2 + j * g;
      const r = hash(i, j);
      let I = 0;
      let ang = 0;
      let at = 0;
      for (const L of lines) {
        best[0] = Infinity;
        nearSeg(L.coarse, 0, L.coarse.length - 1, x, y, best);
        if (best[0] > far) continue;
        const k = best[4] * 4;
        best[0] = Infinity;
        nearSeg(L.fine, k - 5, k + 8, x, y, best);
        const [d2, t, a, side] = best;
        const sg = t < knee ? w0 + (w1 - w0) * smooth(0, knee, t) : w1 + (w2 - w1) * smooth(knee, 1, t);
        const lam = 18 + 24 * smooth(knee, 1, t);
        const split = spec.ribbons ? 0.9 * smooth(knee, knee + 0.25, t) : 0;
        const scatter = t < knee && r < 500 ? 1 - 0.7 * (1 - smooth(0, knee, t)) : 1;
        const n = Math.sqrt(d2) * side;
        const v = smooth(0, knee * 0.8, t) * (1 - 0.45 * smooth(knee, 1, t)) * scatter * Math.exp(-d2 / (2 * sg * sg)) * (1 - split + split * (0.5 + 0.5 * Math.cos((2 * Math.PI * n) / lam)));
        if (v > I) {
          I = v;
          ang = a;
          at = t;
        }
      }
      if (keep) I *= smooth(0, 56, Math.hypot(Math.max(keep[0] - x, 0, x - keep[2]), Math.max(keep[1] - y, 0, y - keep[3])));
      const paper = i % 2 === 0 && j % 2 === 0;
      if (paper ? I < 0.04 : I < 0.24) continue;
      const q = paper ? I : (I - 0.24) / 0.76;
      marks.push({
        x,
        y,
        a: ang,
        rx: paper ? 1.05 + 2.4 * q : 0.8 + 2.2 * q,
        ry: paper ? 1.05 + 0.75 * q : 0.8 + 0.6 * q,
        al: paper ? 0.09 + 0.26 * q : 0.07 + 0.26 * q,
        ring: I > 0.55 && r < 240 && at > knee,
        on: SWEEP.front * reachAt(dir > 0 ? x / W : 1 - x / W, SWEEP.ease) + r * 0.07,
        hold: SWEEP.hold * (0.5 + r / 1000),
      });
    }
  }
  return marks;
}

/**
 * 画一块（null：整张）。每个记号按「颜色 + 深浅」分组放进同一条路径，最后一组画一次。
 * 切页时前沿后面是新的纸，前沿前面还是旧的，中间 60px 两种叠着渐变；输入框周围深一圈只在新纸上。
 * 指针划过的地方，原有的记号深一点、大一点（不另补点）。
 */
function paperDraw(box, now) {
  const { sweep: sw, trail } = PAPER;
  const ctx = CE.paper.getContext('2d');
  const [x0, y0, x1, y1] = box || [0, 0, PAPER.w, PAPER.h];
  ctx.setTransform(PAPER.dpr, 0, 0, PAPER.dpr, 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
  const fills = new Map();
  const rings = new Map();
  const path = (m, style, a) => {
    const key = `${style}|${Math.round(a * 20) / 20}`;
    return m.get(key) || m.set(key, new Path2D()).get(key);
  };
  let tb = null;
  for (const [x, y] of trail) tb = tb ? [Math.min(tb[0], x), Math.min(tb[1], y), Math.max(tb[2], x), Math.max(tb[3], y)] : [x, y, x, y];
  const t = sw ? now - sw.t0 : 0;
  const wipe = sw ? -60 + (PAPER.w + 60) * ahead(t / SWEEP.front, SWEEP.ease) : 0;
  // 新纸的份量：切页时前沿后面 1、前面 0，中间 60px 渐变
  const share = (x) => (sw ? clamp(1 - ((sw.dir > 0 ? x : PAPER.w - x) - wipe) / 60, 0, 1) : 1);
  // 一种纸在这一块里的每个格点：平时的记号（份量 s），指针划过的深一点、大一点
  // 群聊页的大段回答底下不画（字不叠在横纹上）
  const holes = PAPER.holes.filter((b) => b[2] > x0 && b[0] < x1 && b[3] > y0 && b[1] < y1);
  const each = (kind, fresh) => {
    const P = PITCH[kind] || 20;
    const cut = kind === 'chat' && holes.length ? holes : null;
    for (let y = 2 + P * Math.max(0, Math.floor((y0 - 14) / P)); y <= y1 + 12; y += P) {
      for (let x = P * Math.max(0, Math.floor((x0 - 12) / P)); x <= x1 + 12; x += P) {
        const s = fresh ? share(x) : 1 - share(x);
        if (s <= 0 || (cut && cut.some((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3]))) continue;
        mark(path(fills, 'dot', s), kind, x, y, BASE[kind], 1.1);
        const au = fresh ? auraAt(kind, x, y) * s : 0;
        if (au > 0.02) mark(path(fills, 'dot2', au), kind, x, y, AURA[kind], 1.3);
        if (!tb || x < tb[0] - TRAIL_R || x > tb[2] + TRAIL_R || y < tb[1] - TRAIL_R || y > tb[3] + TRAIL_R) continue;
        const e = (Math.ceil(trailAt(x, y, now) * 5) / 5) * s;
        if (e >= 0.2) mark(path(fills, 'ink', 0.06 + 0.28 * e), kind, x, y, BASE[kind] * (1 + 0.5 * e), 1.1 + 0.6 * e);
      }
    }
  };
  each(PAPER.kind, true);
  if (sw) each(sw.from, false);
  // 扫过去的那一道：接力是顺着线的椭圆点（有几颗空心），派活一竖竖，群聊一横横
  if (sw) {
    for (const m of sw.marks) {
      if (t < m.on) continue;
      const k = sweepK(t - m.on, m.hold);
      if (k <= 0 || m.x < x0 - 12 || m.x > x1 + 12 || m.y < y0 - 12 || m.y > y1 + 12) continue;
      const al = Math.min(0.6, m.al * PAPER.lift);
      if (PAPER.kind !== 'relay') mark(path(fills, 'ink', al), PAPER.kind, m.x, m.y, 1.2 * m.rx * k, 0.6 + 0.6 * m.ry * k);
      else {
        const [rx, ry] = m.ring ? [m.rx * 1.3 * k, m.ry * 1.3 * k] : [m.rx * k, m.ry * k];
        const p = path(m.ring ? rings : fills, 'ink', al);
        p.moveTo(m.x + rx * Math.cos(m.a), m.y + rx * Math.sin(m.a));
        p.ellipse(m.x, m.y, rx, ry, m.a, 0, 6.2832);
      }
    }
  }
  for (const [key, p] of fills) {
    const [style, a] = key.split('|');
    ctx.globalAlpha = Number(a);
    ctx.fillStyle = PAPER[style];
    ctx.fill(p);
  }
  ctx.lineWidth = 0.9;
  for (const [key, p] of rings) {
    ctx.globalAlpha = Number(key.split('|')[1]);
    ctx.strokeStyle = PAPER.ink;
    ctx.stroke(p);
  }
  ctx.restore();
}

/** 下一帧：切页时整张画，只有指针划过时只画它经过的一块；都停了就不再排。 */
function paperTick(now) {
  PAPER.raf = 0;
  const tr = PAPER.trail;
  while (tr.length && now - tr[0][2] > TRAIL_T) tr.shift();
  if (PAPER.sweep && now - PAPER.sweep.t0 > PAPER.sweep.end) {
    PAPER.sweep = null;
    PAPER.last = null;
    paperDraw(null, now);
    // 切进来的内容滑到位了：回答的方框按停好的位置再量一次
    paperHoles();
  } else if (PAPER.sweep) paperDraw(null, now);
  else {
    let box = null;
    for (const [x, y] of tr) box = box ? [Math.min(box[0], x - TRAIL_R), Math.min(box[1], y - TRAIL_R), Math.max(box[2], x + TRAIL_R), Math.max(box[3], y + TRAIL_R)] : [x - TRAIL_R, y - TRAIL_R, x + TRAIL_R, y + TRAIL_R];
    const a = PAPER.last;
    if (box || a) paperDraw(a && box ? [Math.min(a[0], box[0]), Math.min(a[1], box[1]), Math.max(a[2], box[2]), Math.max(a[3], box[3])] : box || a, now);
    PAPER.last = box;
  }
  if (PAPER.sweep || tr.length || PAPER.last) PAPER.raf = requestAnimationFrame(paperTick);
}

/** 整张重画（大小、颜色、这一页的纸、输入框的位置变了）；正在逐帧画时交给下一帧。 */
function paperAll() {
  if (!PAPER.w) return;
  if (PAPER.raf) PAPER.last = [0, 0, PAPER.w, PAPER.h];
  else paperDraw(null, performance.now());
}

/** 量一下这一栏：大小变了就换画布，整张重画。 */
function paperSize() {
  const box = CE.paper.parentNode.getBoundingClientRect();
  const W = Math.round(box.width);
  const H = Math.round(box.height);
  if (!W || !H || (W === PAPER.w && H === PAPER.h)) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  Object.assign(PAPER, { w: W, h: H, dpr });
  CE.paper.width = W * dpr;
  CE.paper.height = H * dpr;
  CE.paper.style.width = `${W}px`;
  CE.paper.style.height = `${H}px`;
  paperAura();
  paperAll();
}

/** 换了浅色 / 深色：重新取墨色、纸上记号的两种颜色、扫过去那一道的深浅倍数。 */
function paperInk() {
  const css = getComputedStyle(document.documentElement);
  const v = (k, d) => css.getPropertyValue(k).trim() || d;
  Object.assign(PAPER, { ink: v('--ink', '#151515'), dot: v('--dot', 'rgba(21, 21, 21, 0.09)'), dot2: v('--dot-2', 'rgba(21, 21, 21, 0.2)'), lift: Number(v('--sweep', '1')) || 1 });
  paperAll();
}

/** 这一页的纸（renderCenter 里调）：换了页就记下旧的，切页时扫过去才换；不是切页（刚打开、换项目）直接画好。 */
function paperSet(kind, curve) {
  PAPER.curve = curve;
  if (kind === PAPER.kind) return;
  PAPER.from = PAPER.kind;
  PAPER.kind = kind;
  if (!S.swap) paperAll();
}

/** 空白页里一个元素在这一栏里的方框 [左, 上, 右, 下]：顺着定位的上一级一路加上去（不算动画里的位移），减去空白页滚动过的。 */
function boxIn(el) {
  let x = 0;
  let y = -CE.hero.scrollTop;
  for (let e = el; e && e !== CE.paper.parentNode; e = e.offsetParent) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return [x, y, x + el.offsetWidth, y + el.offsetHeight];
}

/** 空白页：记下输入框的四条边（深一圈的地方）和字、输入框那一块（扫过去时留白）。 */
function paperAura() {
  const b = C.box;
  const inner = CE.hero.querySelector('.hero-in');
  const on = !CE.hero.hidden && b && CE.hero.contains(b) && b.offsetWidth > 0;
  const aura = on ? boxIn(b) : null;
  const k = on && inner ? boxIn(inner) : null;
  PAPER.keep = k && [k[0] - 24, k[1] - 20, k[2] + 24, k[3] + 20];
  if (String(aura) === String(PAPER.aura)) return;
  PAPER.aura = aura;
  paperAll();
}

/** 群聊页：记下每段回答、每张投票在这一栏里的方框（四周多留一点），那里不画横纹；别的页没有。 */
function paperHoles() {
  const holes = [];
  if (PAPER.kind === 'chat' && PAPER.w && !CE.chat.hidden) {
    const c = CE.paper.getBoundingClientRect();
    for (const el of CE.stream.querySelectorAll('.ai .text, .vote')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > c.top && r.top < c.bottom) holes.push([r.left - c.left - 10, r.top - c.top - 8, r.right - c.left + 10, r.bottom - c.top + 8]);
    }
  }
  const sig = holes.map((b) => b.map(Math.round).join(',')).join(';');
  if (sig === PAPER.holeSig) return;
  PAPER.holes = holes;
  PAPER.holeSig = sig;
  paperAll();
}

let holesRaf = 0;
function paperHolesSoon() {
  if (!holesRaf) holesRaf = requestAnimationFrame(() => ((holesRaf = 0), paperHoles()));
}

/** 切了页（新的一页已经放好）：从切过去的那一边扫一道，扫到哪儿纸换到哪儿。减少动态效果时直接换好。 */
function paperSweep(dir) {
  const from = PAPER.from || PAPER.kind;
  PAPER.from = '';
  if (still() || !PAPER.w) return paperAll();
  PAPER.sweep = { t0: performance.now(), dir, from, marks: sweepMarks(PAPER.curve, dir), end: SWEEP.front + 70 + SWEEP.grow + SWEEP.hold * 1.5 + SWEEP.fade };
  if (!PAPER.raf) PAPER.raf = requestAnimationFrame(paperTick);
}

/** 指针在纸上划过（空白页、对话、文件页的空白处；停在卡片、输入框、按钮上不算）：记下经过的点，划痕很快褪掉。 */
function paperPointer(e) {
  if (e.pointerType === 'touch' || still() || !e.target.matches('.center, .hero, .hero-in, .hero-bar, .pane, .scroll, .stream, .under, .doc-pane, .doc-body')) return;
  const r = CE.paper.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const now = performance.now();
  const tr = PAPER.trail;
  const last = tr[tr.length - 1];
  if (last && Math.hypot(x - last[0], y - last[1]) < 6) last[2] = now;
  else tr.push([x, y, now]);
  if (tr.length > 48) tr.shift();
  if (!PAPER.raf) PAPER.raf = requestAnimationFrame(paperTick);
}

// ----- 顶栏：项目 / 任务几，现在谁在做，待复核，清单，控制 -----

const KIND_WORD = { work: T`干活中`, review: T`复核中`, final: T`终审中`, plan: T`拆解中` };
let barNums = null;

function renderBar(t) {
  const p = S.st.project;
  const run = runState();
  const g = run.g;
  const latest = !!t.current;
  const n = pageThreads().indexOf(t) + 1;
  const sig = JSON.stringify([
    t.id,
    n,
    latest,
    p.name,
    p.task.done,
    p.task.total,
    p.task.empty,
    p.now.kind,
    p.now.stint,
    g && [g.id, g.status, g.mode, g.current && g.current.stint, g.current && g.current.kind, g.current && g.current.label, g.waitingUntil],
    p.pending.map((s) => s.id),
    p.acceptance && p.acceptance.state,
    members().map((m) => [m.name, m.cooling, m.canWork]),
    UI.noLeft,
    UI.noRight,
    narrow(),
    looks.key,
  ]);
  if (sig === barSig) return;
  barSig = sig;
  // 同一个任务里数字变了（打了勾、多了待复核）：新的数翻上来
  const was = barNums;
  barNums = { t: t.id, done: p.task.done, pend: p.pending.length };
  const num = (k, text) => h('span', { class: was && was.t === t.id && was[k] !== barNums[k] ? 'roll' : null }, text);
  const meta = [];
  const ctl = [];
  if (latest) {
    meta.push(statusEl(run));
    if (p.pending.length)
      meta.push(
        h(
          'button',
          { class: 'meta-btn', 'data-k': 'pending', 'aria-haspopup': 'menu', onclick: (e) => pendingMenu(e.currentTarget), onmouseenter: () => lightStints(p.pending.map((s) => s.id)), onmouseleave: unlightCards },
          h('span', { class: 'rd' }),
          h('span', null, T`待复核 `, num('pend', p.pending.length))
        )
      );
    if (p.task.total) meta.push(h('button', { class: 'meta-btn', 'data-k': 'checks', 'data-tip': T`清单`, onclick: () => CE.stream.querySelector('.head')?.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'start' }) }, h('span', null, T`清单 `, num('done', p.task.done), `/${p.task.total}`)));
    if (run.running || run.waiting) {
      ctl.push(h('button', { class: 'btn primary', 'data-k': 'go', 'data-tip': T`停止`, 'data-kbd': '⌘.', onclick: (e) => act(e.currentTarget, () => api('/api/stop', {}), T`已停止`) }, icon('stop'), h('span', { class: 'lbl' }, T`停止`)));
    } else {
      const why = p.task.empty ? T`还没有任务` : accepted() ? T`验收通过` : !ready().length ? T`没有可用的成员` : '';
      const word = pageOf(t) === 'dispatch' ? T`派活` : T`全自动`;
      ctl.push(
        h(
          'span',
          { class: 'split', 'data-k': 'go' },
          h(
            'button',
            { class: 'btn primary', disabled: !!why, 'data-tip': why || null, onclick: (e) => act(e.currentTarget, () => startWork('/api/auto', {}), T`已开始${word}`) },
            icon('play'),
            h('span', { class: 'lbl' }, word)
          ),
          h('button', { class: 'btn primary', 'aria-label': T`只做一棒`, 'data-tip': T`只做一棒`, 'aria-haspopup': 'menu', onclick: (e) => whoMenu(e.currentTarget) }, icon('down'))
        )
      );
    }
    ctl.push(iconBtn(T`更多`, 'more', (e) => barMenu(e.currentTarget)));
  }
  if (UI.noRight || narrow()) ctl.push(sideBtn('right'));
  morph(CE.bar, () =>
    CE.bar.replaceChildren(
      h('div', { class: 'bar-l' }, UI.noLeft || narrow() ? sideBtn('left') : null, h('span', { class: 'crumb cap', 'data-k': 'crumb' }, p.name, h('i', null, '/'), T`任务 ${n}`)),
      h('div', { class: 'bar-m' }, meta),
      h('div', { class: 'bar-ctl' }, ctl)
    )
  );
}

/** 顶栏上一句现在在干什么：谁用小图标表示（全名悬停看），空闲时不写。 */
function statusEl(run) {
  if (run.running) {
    const c = run.cur;
    const auto = run.g && run.g.mode === 'auto' ? (run.g.dispatch ? T`派活` : T`全自动`) : '';
    return h(
      'span',
      { class: 'status live', 'data-k': 'status', 'data-tip': c ? `${auto ? `${auto} · ` : ''}${nameOf(c.label)}` : null },
      h('span', { class: 'dot' }),
      auto ? h('span', { class: 'w' }, auto) : null,
      c ? tile({ name: c.member, label: c.label }, 's16') : null,
      h('span', { class: 'w' }, c ? KIND_WORD[c.kind] || T`干活中` : T`进行中`),
      c ? h('span', { class: 'num', 'data-since': c.since }, elapsed(c.since)) : null
    );
  }
  if (run.waiting) {
    const g = run.g;
    return h('span', { class: 'status wait', 'data-k': 'status', 'data-tip': g && tr(g.phase) }, h('span', { class: 'dot' }), h('span', { class: 'w' }, T`等额度${g && g.waitingUntil ? ` · ${clock(g.waitingUntil)}` : ''}`));
  }
  if (run.native) {
    const s = S.st.project.stints.find((x) => x.status === 'working');
    const known = s && s.who.label !== '不知道是谁';
    return h('span', { class: 'status live', 'data-k': 'status', 'data-tip': known ? nameOf(s.who.label, s.who.model) : null }, h('span', { class: 'dot' }), known ? tile(s.who, 's16') : null, h('span', { class: 'w' }, T`进行中`));
  }
  return null;
}

function acceptPanel() {
  if (!S.st) return;
  const a = S.st.project.acceptance;
  let close = () => {};
  const list = (items) =>
    h(
      'ul',
      null,
      items.map((i) =>
        h(
          'li',
          null,
          i.stint
            ? h(
                'button',
                {
                  class: 'link',
                  onclick: () => {
                    close();
                    jumpTo(i.stint);
                  },
                },
                tr(i.text)
              )
            : tr(i.text)
        )
      )
    );
  // 读不到的（配置文件坏了、改动读不到）和还差的（没复核、没终审、检查没过）分开说。
  const unread = a.items.filter((i) => i.kind === 'config' || i.kind === 'evidence');
  const missing = a.items.filter((i) => i.kind !== 'config' && i.kind !== 'evidence');
  const p = S.st.project;
  const cmd = p.init && p.config && p.config.gate;
  close = sheet({
    title: { accepted: T`验收通过`, blocked: T`验收没过`, unknown: T`没法验收` }[a.state] || T`验收`,
    body: h(
      'div',
      { class: 'accept-list' },
      a.state === 'accepted' ? h('p', null, tr(a.headline)) : null,
      unread.length ? h('p', null, T`读不到：`) : null,
      unread.length ? list(unread) : null,
      missing.length ? h('p', null, T`还差：`) : null,
      missing.length ? list(missing) : null,
      cmd ? h('div', { class: 'gate-line' }, h('span', { class: 'cap' }, T`检查命令`), h('code', null, cmd), gateResult(p)) : null
    ),
    foot: [h('button', { class: 'btn primary', autofocus: true, onclick: () => close() }, T`知道了`)],
  });
}

/** 点任务标题就地改：回车存，Esc 放弃。改的时候定时刷新不动它。 */
function editTitle() {
  const p = S.st.project;
  const ttl = CE.stream.querySelector('.head .ttl');
  if (!ttl) return;
  S.editingTitle = true;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    S.editingTitle = false;
    const head = input.closest('.head');
    if (head) head.dataset.sig = '';
    renderCenter();
  };
  const input = h('input', {
    class: 'title-input',
    value: p.task.title,
    'aria-label': T`任务`,
    onkeydown: (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish();
      }
    },
    onblur: () => commit(),
  });
  async function commit() {
    if (done) return;
    const v = input.value.trim();
    if (!v || v === p.task.title) return finish();
    await act(null, () => api('/api/task/edit', { op: 'title', text: v }), T`已保存`);
    finish();
  }
  ttl.replaceWith(input);
  input.focus();
  input.select();
}

/** 先在页面上改好（勾一下马上看到），再存；存失败就以接力台为准刷新回来。 */
async function editStep(body, local) {
  const t = S.st.project.task;
  const typing = body.op === 'add';
  local();
  t.done = t.items.filter((i) => i.done).length;
  t.total = t.items.length;
  const again = () => typing && CE.stream.querySelector('.head .add input')?.focus();
  if (body.op === 'toggle') keepHead();
  renderCenter();
  again();
  try {
    await api('/api/task/edit', body);
  } catch (e) {
    fail(T`改清单`, e);
  }
  await refresh(true);
  again();
}

/** 打勾时不重画整个标题：原地改掉勾和刻度，让打勾的动画放完。 */
function keepHead() {
  const head = CE.stream.querySelector('.head');
  const it = head && streamItems(selectedThread()).find((x) => x.key === head.dataset.key);
  if (!it) return;
  const fresh = it.make();
  const was = head.querySelectorAll('.checks li');
  const now = fresh.querySelectorAll('.checks li');
  if (was.length !== now.length) return;
  was.forEach((li, k) => {
    const ticked = !li.classList.contains('done') && now[k].classList.contains('done');
    li.className = now[k].className;
    if (ticked) li.classList.add('ticked');
    li.querySelector('.box')?.setAttribute('aria-checked', now[k].querySelector('.box')?.getAttribute('aria-checked'));
  });
  head.querySelector('.cap').textContent = fresh.querySelector('.cap').textContent;
  head.dataset.sig = it.sig;
}

// ----- 菜单：派谁、待复核、更多 -----

function whoMenu(anchor) {
  const drive = members().filter((m) => m.canWork);
  // 自己接着做：只列桌面程序。命令行工具由接力台在后台派活（上面「只做一棒」），不弹终端窗口。
  const self = members().filter((m) => m.app);
  const items = [];
  if (drive.length) {
    items.push({ head: T`只做一棒` });
    for (const m of drive) {
      items.push({ label: memberName(m), sub: m.cooling ? T`额度用完 · ${tr(m.coolingText)}` : tr(m.tool) || '', tile: tile(m, 's20'), right: m.tier === 'strong' ? T`强` : m.tier === 'weak' ? T`弱` : '', disabled: !!m.cooling, run: () => goWith(null, m) });
    }
  }
  if (self.length) {
    items.push('-', { head: T`打开` });
    for (const m of self) items.push({ label: memberName(m), sub: m.app, tile: tile(m, 's20'), run: () => openIn(m) });
  }
  if (!items.length) items.push({ label: T`没有成员`, disabled: true });
  items.push('-', { label: T`复制开场白`, sub: SUB.hint, icon: 'copy', run: copyHint });
  openMenu(anchor, items, { align: 'end' });
}

/** 菜单里名字看不出是做什么的几项：底下一行灰字写它是什么（只写事实）。 */
const SUB = {
  brief: T`每位 AI 开工先读的：进度、规矩、上一棒的交接`,
  snap: T`把在接力台之外改的文件记进账本`,
  hint: T`在别的 AI 工具里接着做时，对它说的第一句`,
  protocol: T`AGENTS.md、CLAUDE.md 里写给各家 AI 的那一段`,
};

function pendingMenu(anchor) {
  const p = S.st.project;
  const rv = reviewer();
  const items = p.pending.map((s) => ({ label: T`第 ${s.id} 棒 · ${nameOf(s.who.label, s.who.model)}`, sub: s.summary || '', tile: tile(s.who, 's20'), run: () => jumpTo(s.id) }));
  items.push('-', { label: T`复核`, sub: rv ? memberName(rv) : T`没有可用的强模型`, icon: 'review', disabled: !rv || runState().running, run: () => goWith(null, rv, 'review') });
  openMenu(anchor, items, { align: 'end' });
}

function barMenu(anchor) {
  const p = S.st.project;
  openMenu(
    anchor,
    [
      { label: T`编辑任务`, icon: 'pencil', run: editTaskRaw },
      { label: T`接力本`, sub: SUB.brief, icon: 'book', run: openBrief },
      { label: T`对账`, sub: SUB.snap, icon: 'sync', run: snapNow },
      { label: T`复制开场白`, sub: SUB.hint, icon: 'copy', run: copyHint },
      { label: REVEAL, icon: 'folder', run: () => reveal('') },
      p.protocol !== 'ok' ? { label: T`更新接力规矩`, sub: SUB.protocol, icon: 'warn', run: updateProtocol } : null,
    ],
    { align: 'end' }
  );
}

/**
 * 派人 / 开全自动。有 AI 在别的工具里干到一半、刚才还在改文件时，接力台会先问：确认它停了再换人
 * （不然两个 AI 同时改一个文件夹）。你确认了就带上 force 再发一次。
 */
async function startWork(path, body) {
  try {
    return await api(path, body);
  } catch (e) {
    if (e.code !== 'native-active') throw e;
    if (!(await confirmSheet(T`文件夹刚才还在改`, tr(e.message), T`换人`))) throw Object.assign(new Error(T`没有换人。`), { code: 'cancelled' });
    return api(path, { ...body, force: true });
  }
}

function goWith(btn, m, kind) {
  if (!m) return;
  return act(btn, () => startWork('/api/go', { who: m.name, ...(kind ? { kind } : {}) }), T`${memberName(m)} 已开始${kind === 'review' ? T`复核` : ''}`);
}

function goDefault() {
  const w = defaultWorker();
  if (!w) return toast(T`没有可用的成员`, { bad: true });
  goWith(null, w);
}

function reviewNow() {
  const rv = reviewer();
  if (!rv) return toast(T`没有可用的强模型`, { bad: true });
  goWith(null, rv, 'review');
}

function stopNow() {
  const run = runState();
  if (run.running || run.waiting) act(null, () => api('/api/stop', {}), T`已停止`);
}

function snapNow() {
  act(null, () => api('/api/snap', {}), (r) => (r.changed ? T`已对账` : T`没有新改动`)).then(() => loadTree());
}

function updateProtocol() {
  act(null, () => api('/api/init', {}), T`已更新`);
}

async function copyHint() {
  const ok = await copyText(S.st.hint);
  if (!ok) await api('/api/copy-hint', {}).catch(() => null);
  toast(T`已复制开场白`);
}

async function openIn(m) {
  const r = await act(null, () => api('/api/open', { who: m.name }));
  if (!r) return;
  if (!r.copied) await copyText(r.hint);
  toast(r.opened ? T`已打开 ${m.app} · 开场白已复制` : T`开场白已复制`);
}

async function editTaskRaw() {
  let raw = '';
  const t = ticket('task-raw');
  try {
    raw = (await api(q('/api/task'))).raw;
  } catch (e) {
    return stale(t) ? undefined : fail(T`读取任务`, e);
  }
  if (stale(t)) return;
  const ta = h('textarea', { class: 'raw', spellcheck: 'false', value: raw, 'aria-label': T`任务` });
  const close = sheet({
    title: T`编辑任务`,
    wide: true,
    body: ta,
    foot: [
      h('button', { class: 'btn ghost', onclick: () => close() }, T`取消`),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: (e) =>
            act(e.currentTarget, () => api('/api/task/save', { raw: ta.value }), T`已保存`).then((r) => {
              if (r) close();
            }),
        },
        T`保存`
      ),
    ],
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) layer.querySelector('.sheet-foot .primary')?.click();
  });
}

// ----- 对话流 -----

function stintById(id) {
  return S.st.project.stints.find((s) => s.id === id) || null;
}

function stintSig(s) {
  const targets = s.kind !== 'work' && s.targets ? s.targets.map((id) => (stintById(id) || {}).reviews) : null;
  return JSON.stringify([s.status, s.summary, s.review, s.reviews, s.facts, s.gate, s.protectedHits, s.rolledBack, s.note, s.endedAt, s.who, s.kind, s.targets, s.log, s.quotaUntil, s.handoff, s.ghost, targets, looks.key]);
}

function streamItems(t) {
  const p = S.st.project;
  const latest = !!t.current;
  const items = [];
  const title = latest ? p.task.title : t.title;
  const n = pageThreads().indexOf(t) + 1;
  if (title) {
    // 正在改标题：定时刷新不重画它
    items.push({ key: `task:${t.id}`, at: -Infinity, keep: latest && S.editingTitle, sig: JSON.stringify(latest ? [title, p.task.body, p.task.items, p.task.rules, t.from, n] : [title, t.from, n]), make: () => headEl(t, latest) });
  }
  // 这一棒变了（交接写完了、有了复核……）：展开的全文也要重新取，不能一直显示第一次展开时的样子。
  const stints = threadStints(t);
  for (const s of stints) items.push({ key: `s${s.id}`, at: msOf(s.startedAt), stop: true, sig: stintSig(s), make: () => stintCard(s), changed: () => S.detail.delete(s.id) });
  const rb = p.lastRollback;
  if (rb && inRange(rangeOf(t), msOf(rb.ts))) items.push({ key: `rb:${rb.ts}`, at: msOf(rb.ts), sig: String(rb.undone), make: () => rollbackLine(rb) });
  // 线路的终点：最新的任务看验收；全自动的结果放在它开始时的那段对话里（换了任务之后，上一个任务的「验收通过」不能跑到新任务里）。
  // 只做一棒停了、出错，那一棒的小条上已经写了，不再画终点。
  const g = p.go;
  // 全自动当时做完了，后来退回、加了一步：验收已经不是「通过」，那句「验收通过」不能再挂在终点上。
  const outdated = g && g.status === 'done' && latest && !!p.acceptance && !accepted();
  const res = g && g.mode === 'auto' && g.result && ['done', 'needs-human', 'failed', 'stopped'].includes(g.status) && !outdated && S.dismissed !== g.id && inRange(rangeOf(t), msOf(g.startedAt || g.updatedAt)) ? g : null;
  const a = latest && p.acceptance && p.acceptance.state !== 'working' ? p.acceptance : null;
  if (res || a) {
    const last = stints.length ? Math.max(...stints.map((s) => msOf(s.endedAt || s.startedAt))) : msOf(t.from);
    items.push({ key: res ? `res:${res.id}:${res.status}` : `acc:${t.id}`, at: res ? msOf(res.updatedAt) || Infinity : last + 1, stop: true, sig: JSON.stringify([res && res.result, a && [a.state, a.headline, a.items]]), make: () => verdictEl(res, a) });
  }
  items.sort((a, b) => a.at - b.at);
  if (latest && p.protocol !== 'ok') items.push({ key: `proto:${p.protocol}`, sig: p.protocol, make: protocolLine });
  return items;
}

/** 新来的一项：从下面浮上来；一批一起来的，一个接一个。放完就把动画拿掉（切回对话时不再重放）。 */
function enterAnim(el, i) {
  if (still()) return;
  el.style.setProperty('--d', `${stagger(i)}ms`);
  el.classList.add('enter');
  const done = (e) => {
    if (e.target !== el) return;
    el.classList.remove('enter');
    el.style.removeProperty('--d');
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
}

/** 一项换成新画的：状态、那一句、底下一行、时间里变了的淡一下换上，不是一下子跳过去。 */
const MORPH_PARTS = ['.pill', '.sum', '.say', '.foot', '.vt', '.why', '.q', '.opts', '.text', '.cap', '.ttl', '.sub'];
function settle(old, fresh) {
  if (still()) return;
  for (const sel of MORPH_PARTS) {
    const a = old.querySelector(sel);
    const b = fresh.querySelector(sel);
    if (b && (!a || a.textContent !== b.textContent)) b.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 300, easing: EASE.ease });
  }
  // 清单：AI 打了勾的那一行也画一笔勾，新加的一步淡进来
  const was = old.querySelectorAll('.checks li:not(.add)');
  fresh.querySelectorAll('.checks li:not(.add)').forEach((li, i) => {
    const o = was[i];
    if (o && !o.classList.contains('done') && li.classList.contains('done')) li.classList.add('ticked');
    else if (!o || o.textContent !== li.textContent) li.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE.ease });
  });
}

/** 按 key 对齐：没变的不动，变了的换掉（变了的地方淡一下），新来的加进来（带一点动画），不要了的淡出。keep：正在编辑，先别动。 */
function syncList(box, items, animate) {
  const old = new Map();
  for (const el of [...box.children]) {
    if (el.dataset.key && !el.classList.contains('leave')) old.set(el.dataset.key, el);
    else if (!el.classList.contains('leave')) el.remove();
  }
  let prev = null;
  let added = 0;
  for (const it of items) {
    let el = old.get(it.key);
    if (el && el.dataset.sig !== it.sig && !it.keep) {
      if (it.changed) it.changed();
      const fresh = it.make();
      fresh.dataset.key = it.key;
      fresh.dataset.sig = it.sig;
      el.replaceWith(fresh);
      if (animate) settle(el, fresh);
      el = fresh;
    } else if (!el) {
      el = it.make();
      el.dataset.key = it.key;
      el.dataset.sig = it.sig;
      if (animate) enterAnim(el, added);
      added++;
    }
    old.delete(it.key);
    let want = prev ? prev.nextSibling : box.firstChild;
    while (want && want.classList.contains('leave')) want = want.nextSibling;
    if (el !== want) box.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) (animate ? leave(el) : el.remove());
  return added;
}

/** 线路：第一站到终点之间夹着的对话，线从旁边穿过去；最后一站下面不再画线。 */
function railMarks() {
  const kids = [...CE.stream.children];
  let first = -1;
  let last = -1;
  kids.forEach((el, i) => {
    if (!el.classList.contains('stop')) return;
    if (first < 0) first = i;
    last = i;
  });
  kids.forEach((el, i) => {
    el.classList.toggle('via', i > first && i < last && !el.classList.contains('stop'));
    el.classList.toggle('last', i === last);
  });
}

function renderStream(t) {
  const fresh = streamThread !== t.id;
  if (fresh) {
    CE.stream.replaceChildren();
    CE.stream.classList.remove('talk');
    streamThread = t.id;
    stick = true;
  }
  const wasStuck = stick;
  const added = syncList(CE.stream, streamItems(t), !fresh);
  railMarks();
  // 换到另一段对话：看得见的最后几项依次浮上来（切页时整页滑进来，不再一项一项浮）
  if (fresh && !S.swap) [...CE.stream.children].slice(-8).forEach((el, i) => enterAnim(el, i));
  updateLive();
  for (const el of CE.stream.querySelectorAll('.card.open')) {
    const s = stintById(Number(el.dataset.stint));
    if (!s) continue;
    if (!el.querySelector('.detail')) fillDetail(el, s);
    if (!S.detail.has(s.id)) loadDetail(s.id);
  }
  if (fresh || wasStuck) scrollBottom();
  else if (added) show(CE.toBottom, true);
}

/** 正在干活的那一棒：日志尾巴原地更新，不重画卡片。 */
function updateLive() {
  const g = S.st.project.go;
  for (const pre of CE.stream.querySelectorAll('.tail')) {
    const id = Number(pre.dataset.stint);
    const text = g && g.current && g.current.stint === id ? (g.logTail || '').split('\n').filter((l) => !/^(\d\d:\d\d:\d\d )?[#$] /.test(l)).join('\n').trim() : '';
    if (pre.textContent === text) continue;
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    pre.textContent = text;
    pre.hidden = !text;
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
}

/** 任务：日子是刻度（清单进度在顶栏）；标题是人写的字（写在「：」前面的是标题，后面的是说明）。 */
function headEl(t, latest) {
  const task = S.st.project.task;
  const raw = latest ? task.title : t.title;
  const cut = raw.indexOf('：');
  const [title, lead] = cut > 3 && cut < 40 && cut < raw.length - 1 ? [raw.slice(0, cut), raw.slice(cut + 1)] : [raw, ''];
  const sub = [lead, latest ? task.body.split('\n').slice(1).join('\n').trim() : ''].filter(Boolean).join('\n');
  return h(
    'header',
    { class: 'head' },
    h('div', { class: 'cap' }, dayClock(t.from)),
    latest ? h('h2', { class: 'ttl', role: 'button', tabindex: '0', 'data-tip': T`改标题`, html: inline(esc(title)), onclick: editTitle, onkeydown: (e) => e.key === 'Enter' && editTitle() }) : h('h2', { class: 'ttl', html: inline(esc(title)) }),
    sub ? h('p', { class: 'sub' }, sub.length > 400 ? `${sub.slice(0, 400)}…` : sub) : null,
    latest ? checklist(task) : null,
    latest && task.rules ? h('details', { class: 'rules' }, h('summary', { class: 'link' }, T`约定`), h('div', { class: 'doc-md', html: md(task.rules) })) : null,
    latest ? iconBtn(T`编辑任务`, 'pencil', editTaskRaw, '', 'edit') : null
  );
}

/** 清单：点方框打勾，悬停出现删除，最后一行直接写下一步。没做的步骤下面用小字写做法（派活时强模型写的）。 */
function checklist(task) {
  let marked = false;
  return h(
    'ul',
    { class: 'checks' },
    task.items.map((it, i) => {
      const next = !it.done && !marked;
      if (next) marked = true;
      return h(
        'li',
        { class: it.done ? 'done' : next ? 'next' : null },
        h(
          'button',
          {
            class: 'box',
            role: 'checkbox',
            'aria-checked': String(it.done),
            'aria-label': it.text,
            onclick: () => {
              const cur = S.st.project.task.items[i];
              editStep({ op: 'toggle', index: i, done: !cur.done }, () => (cur.done = !cur.done));
            },
          },
          icon('check')
        ),
        h('span', { class: 'step' }, h('span', { html: inline(esc(it.text)) }), !it.done && it.note ? h('small', { html: inline(esc(it.note)) }) : null),
        h('button', { class: 'x', 'aria-label': T`删除这一步`, 'data-tip': T`删除`, onclick: () => editStep({ op: 'remove', index: i }, () => S.st.project.task.items.splice(i, 1)) }, icon('x'))
      );
    }),
    h(
      'li',
      { class: 'add' },
      icon('plus'),
      h('input', {
        type: 'text',
        placeholder: T`加一步`,
        'aria-label': T`加一步`,
        onkeydown: (e) => {
          if (e.isComposing || e.keyCode === 229 || e.key !== 'Enter' || !e.target.value.trim()) return;
          const text = e.target.value.trim();
          e.target.value = '';
          editStep({ op: 'add', text }, () => S.st.project.task.items.push({ done: false, text }));
        },
      })
    )
  );
}

function talkRow(r) {
  if (r.kind === 'human') {
    const { body, files } = splitFiles(r.text);
    return h(
      'div',
      { class: 'me' },
      h('span', { class: 'cap' }, [r.mode === 'solo' ? T`对比` : '', clock(r.ts)].filter(Boolean).join(' · ')),
      body ? h('div', { class: 'note', html: inline(esc(body)) }) : null,
      files.length ? h('div', { class: 'att' }, files.map(fileEl)) : null
    );
  }
  if (r.kind === 'system') return h('div', { class: 'sys' }, r.text);
  return aiRow(r);
}

/** 长回答（超过 14 行或 900 字）先收起，点「展开」看全文：高度从收起的样子长开。 */
function foldable(box, text) {
  if (text.length <= 900 && text.split('\n').length <= 14) return [box];
  box.classList.add('fold');
  const btn = h(
    'button',
    {
      class: 'link unfold',
      onclick: () => {
        const from = box.offsetHeight;
        box.classList.remove('fold');
        btn.remove();
        setTimeout(paperHolesSoon, 300);
        if (!still()) box.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${box.offsetHeight}px`, overflow: 'hidden' }], { duration: 280, easing: EASE.snap });
      },
    },
    T`展开`
  );
  return [box, btn];
}

function aiRow(r, compact) {
  const name = nameOf(r.who, r.model);
  return h(
    'div',
    { class: 'ai' },
    h('span', { class: 'who-tile', 'data-tip': memberByName(r.agent) ? memberTip(memberByName(r.agent)) : name }, tile({ agent: r.agent, label: r.who, model: r.model })),
    h('div', null, h('div', { class: 'who' }, h('b', null, name), compact ? null : h('span', { class: 'time' }, clock(r.ts))), ...foldable(h('div', { class: `text doc-md${r.error ? ' err' : ''}`, html: md(r.text) }), r.text)),
    compact ? null : h('div', { class: 'hover-acts' }, iconBtn(T`复制`, 'copy', () => copyToast(r.text)))
  );
}

function roundBox(rows) {
  return h('div', { class: 'round' }, h('span', { class: 'cap' }, T`对比 · ${rows.length}`), h('div', { class: 'round-cols' }, rows.map((r) => aiRow(r, true))));
}

function typingLine(st) {
  const names = st.speaking.map((x) => nameOf(x.label));
  return h(
    'div',
    { class: 'typing' },
    h('span', { class: 'tiles' }, st.speaking.map((x) => tile({ agent: x.agent, label: x.label })), st.queue.map((x) => tile({ agent: x.agent, label: x.label }, '', 'cooling'))),
    h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
    names.length ? T`${names.join(T`、`)} 正在输入` : T`排队中`
  );
}

function rollbackLine(rb) {
  const note = rb.interrupted ? T` · 中途停了，文件可能只退回了一部分` : rb.left && rb.left.length ? T` · ${rb.left.length} 个文件没退回` : '';
  return h('div', { class: 'sys', 'data-tip': rb.left && rb.left.length ? rb.left.slice(0, 8).join('\n') : null }, icon('undo'), T`${clock(rb.ts)} 退回到${rb.label} · 第 ${rb.dropped.join(T`、`)} 棒作废${note}`, rb.undone ? T`· 已撤销` : h('button', { class: 'link', onclick: (e) => undoRollback(e.currentTarget) }, T`撤销`));
}

/**
 * 线路的终点：和别的站一样大的圆圈（通过了是实心的），旁边一行字说结果、一行说还差什么。
 * 最新的任务看验收；更早的任务没有验收记录，就写当时全自动的结果。
 */
function verdictEl(g, a) {
  const state = a ? a.state : { done: 'accepted', 'needs-human': 'blocked', failed: 'failed', stopped: 'stopped' }[g.status];
  const [ic, title] = { accepted: ['check', T`验收通过`], blocked: ['warn', a ? T`验收没过` : T`全自动停止`], unknown: ['unknown', T`没法验收`], failed: ['warn', T`全自动出错`], stopped: ['stop', T`全自动已停止`] }[state];
  const why = a ? (a.state === 'accepted' ? tr(a.headline.replace(/^验收通过：/, '')) : a.items.map((i) => tr(i.text)).join(T`；`)) : tr(g.result.replace(/^(验收通过|验收没过|没法验收|全自动停止|全自动已停止)：/, ''));
  const body = [state === 'blocked' || state === 'failed' ? h('span', { class: 'rd' }) : null, title];
  return h(
    'div',
    { class: `stop verdict ${state}` },
    h('span', { class: 'no', 'aria-hidden': 'true' }, ic === 'unknown' ? '?' : icon(ic)),
    a ? h('button', { class: 'vt', 'aria-haspopup': 'dialog', onclick: acceptPanel }, body) : h('div', { class: 'vt' }, body),
    why ? h('p', { class: 'why' }, why) : null,
    g ? h('span', { class: 'cap' }, [clock(g.updatedAt), g.mode === 'auto' ? (g.dispatch ? T`派活` : T`全自动`) : '', g.stints && g.stints.length ? T`${g.stints.length} 棒` : '', lasted(g.startedAt, g.updatedAt), tokenSplit(g.stints || [])].filter(Boolean).join(' · ')) : null,
    g
      ? iconBtn(
          T`收起`,
          'x',
          () => {
            S.dismissed = g.id;
            store.set('dismissed', g.id);
            renderCenter();
          },
          '',
          'x'
        )
      : null
  );
}

function protocolLine() {
  const p = S.st.project;
  return h('div', { class: 'sys' }, icon('warn'), p.protocol === 'old' ? T`接力规矩有新版本` : T`接力规矩不见了`, h('button', { class: 'link', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), T`已更新`) }, T`更新`));
}

// ----- 一棒：卡片 -----

function countedReview(s) {
  return [...(s.reviews || [])].reverse().find((r) => !r.weak && !r.void) || null;
}

/** 没成的一棒（额度用完、出错、中途停了）：卡片上那一句写原因。 */
const FAILED = new Set(['quota', 'failed', 'stopped']);

function summaryOf(s) {
  // 派活的一棒是「第 3 步：……」（接力台写的前缀）；后面是人写的步骤，不翻
  if (s.summary) return { text: LANG.zh ? s.summary : s.summary.replace(/^第 (\d+) 步：/, 'Step $1: ') };
  if (s.status === 'working') return { text: s.via === 'relay' ? T`开始了` : T`正在改文件`, faint: true };
  if (s.note && FAILED.has(s.status)) return { text: tr(s.note) };
  if (s.kind === 'review' || s.kind === 'plan') return { text: s.kind === 'plan' ? T`拆解` : T`复核`, faint: true };
  return { text: s.ghost || !s.handoff ? T`没有交接` : T`交接里没写做了什么`, faint: true };
}

/** 一棒是谁做的、现在什么状态：机器的标签，细边框加一个小图标。 */
function pillOf(s) {
  if (s.status === 'working') return h('span', { class: 'pill live' }, h('span', { class: 'dot' }), s.via === 'relay' ? KIND_WORD[s.kind] : T`进行中`);
  if (s.rolledBack) return h('span', { class: 'pill soft' }, T`作废`);
  if (s.kind === 'final' && s.verdictWord) return h('span', { class: 'pill' }, icon('search'), T`终审 · ${tr(s.verdictWord)}`);
  if (s.kind === 'review') return h('span', { class: 'pill' }, icon('review'), T`复核`);
  if (s.kind === 'plan') return h('span', { class: 'pill' }, icon('list'), T`拆解`);
  const [ic, word] = { handed: ['arrow', T`已交接`], unfinished: ['', T`没交接`], quota: ['', T`额度用完${s.quotaUntil ? T` · ${clock(s.quotaUntil)} 恢复` : ''}`], failed: ['', T`出错`], stopped: ['stop', T`已停止`] }[s.status] || [];
  if (!word) return null;
  return h('span', { class: `pill${s.status === 'handed' ? '' : ' soft'}` }, s.status === 'failed' ? h('span', { class: 'rd' }) : ic ? icon(ic) : null, word);
}

/** 做了多久：21:43–21:45 · 2 分钟；正在做的一秒一秒走。 */
function spanOf(s) {
  if (s.status === 'working') return h('span', { class: 'tm', 'data-since': s.startedAt }, elapsed(s.startedAt));
  const from = dayClock(s.startedAt);
  const to = s.endedAt ? clock(s.endedAt) : '';
  return h('span', { class: 'tm' }, `${from}${to && to !== clock(s.startedAt) ? `–${to}` : ''}${s.endedAt ? ` · ${lasted(s.startedAt, s.endedAt)}` : ''}${s.tokens ? ` · ${tokenText(s.tokens.input + s.tokens.output)} ${L('token')}` : ''}`);
}

/** 一棒：钉在线路上的一张小条。没交接、身份不明的是虚线；什么都没干的只留一行。 */
function stintCard(s) {
  const live = s.status === 'working';
  const name = nameOf(s.who.label, s.who.model);
  const sum = summaryOf(s);
  const open = S.open.has(s.id);
  const files = s.facts && s.facts.files;
  const ghost = !live && (s.ghost || !s.handoff || s.who.tier === 'unknown');
  const compact = ghost && !files && s.review !== 'needed';
  return h(
    'article',
    {
      class: `stop card${ghost ? ' ghost' : ''}${compact ? ' compact' : ''}${live ? ' live' : ''}${open ? ' open' : ''}${s.rolledBack ? ' void' : ''}`,
      'data-stint': String(s.id),
      tabindex: '0',
      'aria-expanded': String(open),
      onclick: (e) => {
        if (e.target.closest('button, a, input, .detail, .tail')) return;
        toggleCard(s.id);
      },
      onkeydown: (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          toggleCard(s.id);
        }
      },
      onmouseenter: (e) => {
        lightStint(s);
        wireTo(files ? e.currentTarget : null);
      },
      onmouseleave: () => {
        unlight();
        wireTo(null);
      },
      oncontextmenu: (e) => ctx(e, stintMenuItems(s)),
    },
    h('span', { class: 'no', 'aria-hidden': 'true' }, String(s.id)),
    h(
      'div',
      { class: 'slip' },
      h(
        'div',
        { class: 'who' },
        h('span', { class: 'who-tile', 'data-tip': whoTip(s.who) }, tile(s.who)),
        h('b', null, name === '不知道是谁' ? T`身份不明` : name),
        // 只写「弱」：弱模型的棒要复核，强的不用标
        s.who.tier === 'weak' ? h('span', { class: 'mdl' }, T`弱`) : null,
        pillOf(s),
        compact ? h('span', { class: 'say' }, sum.text) : null,
        spanOf(s)
      ),
      compact ? null : h('div', { class: `sum${sum.faint ? ' faint' : ''}`, html: inline(esc(sum.text)) }),
      cardFoot(s),
      live && s.via === 'relay' ? h('pre', { class: 'tail', 'data-stint': String(s.id), hidden: true }) : null,
      h('div', { class: 'more-body' }, h('div', null))
    ),
    h('div', { class: 'hover-acts' }, files ? iconBtn(T`改动`, 'diff', () => openDiff(s.id)) : null, iconBtn(T`更多`, 'more', (e) => openMenu(e.currentTarget, stintMenuItems(s), { align: 'end' })))
  );
}

/** 小条底下一行淡字：只写要注意的（正常交接了就不写），改了哪些文件合成一句，点开看改动。 */
function cardFoot(s) {
  const bits = [];
  const st = (cls, ...kids) => h('span', { class: `st ${cls}`.trim() }, ...kids);
  if (!s.rolledBack && s.review === 'needed' && s.status !== 'working') {
    // 为什么还待复核：复核写了「有问题」「证据不足」、只有弱模型复核过、读不到改动……
    const why = tr(s.reviewText.replace(/^待复核( · )?/, ''));
    const el = st('pend', h('span', { class: 'rd' }), h('span', { class: 'ell' }, s.reviewWarn && why ? why.replace(/（[^）]*）$/, '') : T`待复核`));
    if (why) el.dataset.tip = why;
    bits.push(el);
  } else if (!s.rolledBack && s.review === 'done') {
    // 谁复核的看小图标（复核算数的都是强模型），悬停看全名，点一下跳过去
    const c = countedReview(s);
    const by = c && stintById(c.by);
    const who = by ? by.who : c && { label: c.byLabel, tier: 'strong' };
    if (c) bits.push(h('button', { class: 'st ok link-st', 'data-tip': whoTip(who), onclick: () => by && jumpTo(by.id) }, tile(who, 's16'), T`复核 · ${tr(c.verdictWord)}`));
  }
  const warn = (text, tip) => {
    const el = st('bad', h('span', { class: 'rd' }), text);
    if (tip) el.dataset.tip = tip;
    bits.push(el);
  };
  if (s.factsError) warn(T`读不到改动`, s.factsError);
  if (s.gate && s.gate.status === 'fail') warn(T`检查没过`);
  if (s.gate && s.gate.status === 'error') warn(T`检查没跑成`, s.gate.detail);
  if (s.protectedHits) warn(T`改了不许改的文件`, s.protectedHits.join('\n'));
  // 复核、并进了复核的终审：列出复核了哪几棒、结论是什么
  if (s.kind !== 'work' && s.targets) {
    for (const id of s.targets) {
      const tg = stintById(id);
      const r = tg && (tg.reviews || []).find((x) => x.by === s.id);
      bits.push(h('button', { class: 'st link-st', onclick: () => jumpTo(id) }, T`第 ${id} 棒${r ? ` · ${tr(r.verdictWord)}` : ''}${r && r.weak ? T` · 不算数` : ''}`));
    }
  }
  const f = s.facts;
  if (f && f.files) {
    const shown = f.paths.slice(0, 12);
    bits.push(
      h(
        'button',
        {
          class: 'st link-st',
          'data-tip': shown.join('\n') + (f.files > shown.length ? T`\n… 一共 ${f.files} 个` : ''),
          onclick: () => openDiff(s.id, f.files === 1 ? f.paths[0] : undefined),
        },
        h('span', { class: 'ell' }, f.files === 1 ? basename(f.paths[0]) : T`${f.files} 个文件`),
        h('span', { class: 'num' }, `+${f.added} −${f.removed}`)
      )
    );
  }
  return bits.length ? h('div', { class: 'foot' }, bits) : null;
}

function stintMenuItems(s) {
  const pending = s.review === 'needed' && s.status !== 'working' && !s.rolledBack;
  const rv = reviewer();
  return [
    s.facts && s.facts.files ? { label: T`改动`, icon: 'diff', run: () => openDiff(s.id) } : null,
    s.log ? { label: T`日志`, icon: 'log', run: () => openLog(s) } : null,
    s.handoff ? { label: T`复制交接`, icon: 'copy', run: () => copyHandoff(s) } : null,
    '-',
    pending ? { label: T`复核`, sub: rv ? rv.label : T`没有可用的强模型`, icon: 'review', disabled: !rv || runState().running, run: () => goWith(null, rv, 'review') } : null,
    pending ? { label: T`跳过复核`, icon: 'check', run: () => skipReview(null, s) } : null,
    !s.rolledBack && s.status !== 'working' ? { label: T`退回到这之前`, icon: 'undo', disabled: S.st.project.now.kind === 'relay', run: () => rollbackTo(null, s) } : null,
  ];
}

function toggleCard(id) {
  const el = CE.stream.querySelector(`.card[data-stint="${id}"]`);
  if (!el) return;
  if (S.open.has(id)) {
    S.open.delete(id);
    el.classList.remove('open');
    el.setAttribute('aria-expanded', 'false');
    return;
  }
  S.open.add(id);
  const s = stintById(id);
  if (s) fillDetail(el, s);
  void el.offsetHeight; // 先量一次，展开才有过渡
  el.classList.add('open');
  el.setAttribute('aria-expanded', 'true');
  if (!S.detail.has(id)) loadDetail(id);
}

/** 正在取全文的棒（定时刷新时别重复去取）。 */
const detailLoading = new Set();

async function loadDetail(id) {
  if (detailLoading.has(id)) return;
  detailLoading.add(id);
  const t = ticket(`detail:${id}`);
  try {
    const d = await api(q(`/api/stint?id=${id}`));
    if (stale(t)) return;
    S.detail.set(id, d);
    const el = CE.stream.querySelector(`.card[data-stint="${id}"]`);
    const s = stintById(id);
    if (el && s) fillDetail(el, s);
  } catch (e) {
    if (!stale(t)) fail(T`读取这一棒`, e);
  } finally {
    detailLoading.delete(id);
  }
}

function fillDetail(el, s) {
  const slot = el.querySelector('.more-body > div');
  if (slot) slot.replaceChildren(detailBox(s));
}

const SECTION = [
  [/做了/, T`做了`],
  [/没做完|下一步/, T`没做完`],
  [/不确定|拿不准|可能有错/, T`拿不准`],
  [/验证/, T`验证`],
];

/** 交接单：像一张实验记录表。交接里的每一节是一行（做了、没做完、拿不准、验证），最后一行是改了哪些文件。 */
function handoffForm(s, text) {
  const secs = [];
  let status = '';
  let cur = null;
  for (const l of text.replace(/\r/g, '').split('\n')) {
    const hm = l.match(/^##\s+(.+)$/);
    if (hm) secs.push((cur = { head: hm[1].trim(), body: [] }));
    else if (cur) cur.body.push(l);
    else if (/^\s*[-*]\s*状态[:：]/.test(l)) status = l.replace(/^\s*[-*]\s*状态[:：]\s*/, '').trim();
  }
  const rows = [];
  for (const x of secs) {
    const body = x.body.join('\n').trim();
    if (body) rows.push(h('dt', null, (SECTION.find(([re]) => re.test(x.head)) || [])[1] || x.head.slice(0, 5)), h('dd', { class: 'doc-md', html: md(body) }));
  }
  if (!secs.length && text.trim()) rows.push(h('dt', null, T`交接`), h('dd', { class: 'doc-md', html: md(text.replace(/^#\s+.*\n+/, '')) }));
  const f = s.facts;
  if (f && f.files) {
    rows.push(
      h('dt', null, T`改了`),
      h(
        'dd',
        { class: 'files' },
        f.paths.slice(0, 12).map((p) => h('button', { onclick: () => openDiff(s.id, p), onmouseenter: () => lightPaths([p]), onmouseleave: () => lightStint(s) }, p)),
        f.files > 12 ? h('em', null, T`… 一共 ${f.files} 个`) : null,
        h('em', null, `+${f.added} −${f.removed}`)
      )
    );
  }
  return h('div', { class: 'form' }, h('div', { class: 'fh' }, h('span', { class: 'cap' }, T`交接单 · 第 ${s.id} 棒${s.ghost ? T` · 接力台代写` : ''}`), status ? h('span', { class: 'cap' }, status) : null), h('dl', null, rows));
}

function detailBox(s) {
  const d = S.detail.get(s.id);
  const box = h('div', { class: 'detail' });
  if (!d) {
    box.append(h('div', { class: 'skel', style: 'width:62%' }), h('div', { class: 'skel', style: 'width:38%' }));
    return box;
  }
  if (d.handoff || (s.facts && s.facts.files)) box.append(handoffForm(s, d.handoff || ''));
  if (s.who.claimed && s.who.claimed !== s.who.label) box.append(h('p', { class: 'aside' }, T`交接里写的是「${s.who.claimed}」`));
  for (const r of d.reviews) {
    // 复核人：按复核文件找到那一棒，用它记下的身份（名字、模型、强弱）；终审自己写的就是这一棒
    const mark = (s.reviews || []).find((x) => x.file === r.file);
    const by = mark && stintById(mark.by);
    const who = by ? by.who : r.file === s.reviewFile ? s.who : { label: r.by, tier: r.weak ? 'weak' : 'strong' };
    const byName = nameOf(who.label, who.model);
    box.append(
      h(
        'div',
        { class: `review-box${r.weak ? ' weak' : ''}` },
        h('div', { class: 'rb-head' }, tile(who, 's16'), h('b', null, byName === '不知道是谁' ? T`身份不明` : byName), r.weak ? h('span', null, T`不算数`) : null),
        h('div', { class: 'doc-md', html: md(r.text.replace(/^#\s+.*\n+/, '')) })
      )
    );
  }
  if (s.gate) box.append(h('section', null, h('h5', null, T`检查`), h('div', { class: 'pre' }, `${{ pass: T`通过`, fail: T`没通过`, error: T`没跑成` }[s.gate.status] || s.gate.status}${s.gate.command ? ` · ${s.gate.command}` : ''}${s.gate.detail ? `\n\n${s.gate.detail}` : ''}`)));
  if (s.note && summaryOf(s).text !== tr(s.note)) box.append(h('section', null, h('h5', null, T`说明`), h('p', { class: 'aside' }, tr(s.note))));
  const acts = [];
  const pending = s.review === 'needed' && s.status !== 'working' && !s.rolledBack;
  if (s.facts && s.facts.files) acts.push(h('button', { class: 'btn small', onclick: () => openDiff(s.id) }, icon('diff'), T`改动`));
  if (s.log) acts.push(h('button', { class: 'btn small', onclick: () => openLog(s) }, icon('log'), T`日志`));
  if (pending) {
    const rv = reviewer();
    if (rv) acts.push(h('button', { class: 'btn small primary', disabled: runState().running, onclick: (e) => goWith(e.currentTarget, rv, 'review') }, icon('review'), T`复核`));
    acts.push(h('button', { class: 'btn small', onclick: (e) => skipReview(e.currentTarget, s) }, T`跳过复核`));
  }
  if (!s.rolledBack && s.status !== 'working') acts.push(h('button', { class: 'btn small ghost', disabled: S.st.project.now.kind === 'relay', onclick: (e) => rollbackTo(e.currentTarget, s) }, icon('undo'), T`退回到这之前`));
  if (acts.length) box.append(h('div', { class: 'acts' }, acts));
  return box;
}

async function copyHandoff(s) {
  let d = S.detail.get(s.id);
  if (!d) {
    const t = ticket(`detail:${s.id}`);
    try {
      d = await api(q(`/api/stint?id=${s.id}`));
      if (stale(t)) return;
      S.detail.set(s.id, d);
    } catch (e) {
      return stale(t) ? undefined : fail(T`复制交接`, e);
    }
  }
  copyToast(d.handoff || '');
}

async function skipReview(btn, s) {
  if (!S.st) return;
  const { root, name } = S.st.project;
  const who = s.who.tier === 'unknown' ? T`身份不明` : s.who.tier === 'weak' ? T`弱模型` : T`还没复核`;
  if (!(await confirmSheet(T`跳过第 ${s.id} 棒的复核？`, T`「${name}」第 ${s.id} 棒（${who}）跳过后不再等复核。可以撤销。`, T`跳过复核`))) return;
  if (!S.st || S.st.project.root !== root) return fail(T`跳过复核`, T`项目已经换了`);
  const r = await act(btn, () => api('/api/mark', { dir: root, stint: s.id }));
  if (r) toast(T`第 ${s.id} 棒已跳过复核`, { action: { label: T`撤销`, run: () => act(null, () => api('/api/mark', { dir: root, stint: s.id, review: 'needed' }), T`已改回待复核`) } });
}

async function rollbackTo(btn, s) {
  if (!S.st) return;
  const { root, name } = S.st.project;
  if (!(await confirmSheet(T`退回到第 ${s.id} 棒之前？`, T`「${name}」第 ${s.id} 棒和之后的改动作废，清单里对应的勾去掉。可以撤销。`, T`退回`))) return;
  if (!S.st || S.st.project.root !== root) return fail(T`退回`, T`项目已经换了`);
  const r = await act(btn, () => api('/api/rollback', { dir: root, stint: s.id }));
  if (r) {
    const tk = r.task && r.task.missing ? T` · 清单没跟着退回（旧账本）` : r.task && r.task.unchecked.length ? T` · 清单去掉 ${r.task.unchecked.length} 个勾` : '';
    const left = r.left && r.left.length ? T` · ${r.left.length} 个文件没退回` : '';
    toast(T`已退回 · ${r.files} 个文件${left}${tk}`, { action: { label: T`撤销`, run: () => undoRollback(null) } });
    loadTree();
  }
}

function undoRollback(btn) {
  act(btn, () => api('/api/rollback/undo', {}), T`已撤销`).then(() => loadTree());
}

/** 跳到某一棒：不在当前这段对话里就先切过去，然后闪一下。 */
function jumpTo(id) {
  closeMenus();
  const go = () => {
    const el = CE.stream.querySelector(`.card[data-stint="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };
  const t = threads().find((x) => x.stints.includes(id));
  if (t && selectedThread() !== t) return selectThread(t, go);
  if (S.tab !== 0) {
    S.tab = 0;
    renderCenter();
  }
  go();
}

// ----- 群聊：一个项目里的几段群聊（正在用的一段，加上点「新群聊」时存下的） -----

function talkHas(d) {
  return !!d && (d.rows.length > 0 || d.votes.length > 0);
}

function talkLive() {
  const st = S.talk.status;
  return st.speaking.length > 0 || st.queue.length > 0;
}

/** 一段群聊叫什么：第一句问话（没有就是第一个投票的问题）。 */
function talkTitle(d) {
  const first = d.rows.find((r) => r.kind === 'human');
  const text = first ? first.text : d.votes.length ? d.votes[0].question : '';
  return text.trim().split('\n')[0].slice(0, 60);
}

function talkAt(d) {
  const r = d.rows[d.rows.length - 1];
  const v = d.votes[d.votes.length - 1];
  return [r && r.ts, v && v.ts].filter(Boolean).sort().pop() || '';
}

/** 在接力那一页时，群聊有人在说话、或者来了新回答：「群聊」上点一下。 */
function talkNews() {
  if (S.view === 'chat') return false;
  if (talkLive() || (S.talk.sessions || []).some((x) => x.busy)) return true;
  const last = S.talk.rows[S.talk.rows.length - 1];
  return !!last && last.kind !== 'human' && last.ts > (store.get(`seen:${S.dir}`) || '');
}

function sessionEl(x) {
  const live = x.id ? !!x.busy : talkLive();
  return h('button', { class: 'thread', 'data-id': `chat:${x.id}`, onclick: () => selectChat(x.id || null) }, h('span', { class: 't' }, x.title), h('span', { class: 'when' }, live ? h('span', { class: 'dot live' }) : x.at ? when(x.at) : T`现在`));
}

function selectChat(id) {
  showView('chat');
  S.chat = id;
  S.tab = 0;
  closeDrawers();
  if (id && !(S.archive && S.archive.id === id)) loadArchive(id);
  turnPage(() => {
    renderAll();
    scrollBottom();
  });
}

async function loadArchive(id) {
  const t = ticket('archive');
  try {
    const d = await api(q(`/api/talk?id=${encodeURIComponent(id)}`));
    if (stale(t) || S.chat !== id) return;
    S.archive = d;
    renderCenter();
  } catch (e) {
    if (!stale(t)) fail(T`读取群聊记录`, e);
  }
}

/** 新群聊：正在用的那段有内容就存档（左边还看得到；还有人在说也行，接着写进存档那段），换一段空的。 */
async function newChat() {
  if (talkHas(S.talk)) {
    try {
      await api('/api/talk/clear', {});
    } catch (e) {
      return fail(T`新建群聊`, e);
    }
    streamThread = null;
    await loadTalk();
  }
  S.chat = null;
  showView('chat');
  S.tab = 0;
  closeDrawers();
  renderAll();
  focusComposer();
}

/** 看的是存档的一段、它还没说完（中途点了「新群聊」）：跟着刷新。 */
function archiveLive() {
  const a = S.chat && S.archive && S.archive.id === S.chat ? S.archive : null;
  return !!a && (a.status.speaking.length > 0 || a.status.queue.length > 0 || a.votes.some((v) => v.status !== 'done'));
}

function chatData() {
  return S.chat ? (S.archive && S.archive.id === S.chat ? S.archive : null) : S.talk;
}

/** 群聊这一页现在是什么样：还没接入（先接入，群聊记录放在接入后的 .relay 里）、一段空的新群聊、有内容的群聊。 */
function chatMode() {
  if (S.st.project.pick) return 'pick';
  if (!S.st.project.init) return 'chat-setup';
  return S.chat || talkHas(S.talk) || talkLive() ? 'chat' : 'chat-new';
}

/** 群聊里的每一项：人说的、AI 说的、「对比」那一轮、投票，按时间排；最后是谁在输入（存档的那段还没说完也有）。 */
function chatItems(d, live) {
  const items = [];
  const rounds = new Map();
  for (const r of d.rows) {
    if (r.round) {
      let g = rounds.get(r.round);
      if (!g) {
        g = { rows: [] };
        rounds.set(r.round, g);
        items.push({ key: `round:${r.round}`, at: msOf(r.ts), group: g, make: () => roundBox(g.rows) });
      }
      g.rows.push(r);
    } else items.push({ key: `r:${r.ts}:${r.who}`, at: msOf(r.ts), sig: JSON.stringify([r.text, r.error, looks.key]), make: () => talkRow(r) });
  }
  for (const it of items) if (it.group) it.sig = JSON.stringify([it.group.rows.map((r) => [r.ts, r.text, r.error]), looks.key]);
  for (const v of d.votes) items.push({ key: `v:${v.id}`, at: voteBorn(v), sig: JSON.stringify([v, live, looks.key]), make: () => voteCard(v, live) });
  items.sort((a, b) => a.at - b.at);
  const st = d.status;
  if (st && (st.speaking.length || st.queue.length)) items.push({ key: 'typing', sig: JSON.stringify([st, looks.key]), make: () => typingLine(st) });
  return items;
}

function renderTalk() {
  const key = `chat:${S.chat || ''}`;
  const fresh = streamThread !== key;
  if (fresh) {
    CE.stream.replaceChildren();
    CE.stream.classList.add('talk');
    streamThread = key;
    stick = true;
  }
  const wasStuck = stick;
  const d = chatData();
  const added = syncList(CE.stream, d ? chatItems(d, !S.chat) : [], !fresh);
  if (fresh && !S.swap) [...CE.stream.children].slice(-8).forEach((el, i) => enterAnim(el, i));
  // 看过了：接力那一页的「群聊」上不再点
  const last = !S.chat && S.talk.rows[S.talk.rows.length - 1];
  if (last && last.ts > (store.get(`seen:${S.dir}`) || '')) store.set(`seen:${S.dir}`, last.ts);
  if (fresh || wasStuck) scrollBottom();
  else if (added) show(CE.toBottom, true);
}

/** 群聊的顶栏：项目 / 这段群聊；存档的写上是哪天的。 */
function renderChatBar() {
  const p = S.st.project;
  const old = S.chat && (S.talk.sessions || []).find((x) => x.id === S.chat);
  const title = old ? old.title : talkTitle(S.talk) || T`群聊`;
  const sig = JSON.stringify(['chat', p.name, S.chat, title, old && old.at, UI.noLeft, UI.noRight, narrow()]);
  if (sig === barSig) return;
  barSig = sig;
  morph(CE.bar, () =>
    CE.bar.replaceChildren(
      h('div', { class: 'bar-l' }, UI.noLeft || narrow() ? sideBtn('left') : null, h('span', { class: 'crumb cap', 'data-k': 'crumb' }, p.name, h('i', null, '/'), title)),
      h('div', { class: 'bar-m' }, old ? h('span', { class: 'cap' }, dayClock(old.at)) : null),
      h('div', { class: 'bar-ctl' }, UI.noRight || narrow() ? sideBtn('right') : null)
    )
  );
}

// ----- 投票 -----

/** 投票：问题是人写的字；每个方案后面是投它的那几位的图形，「我」是一个小圈。存档的群聊里只能看。 */
function voteCard(v, live = true) {
  const done = v.status === 'done';
  const counts = v.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const leaders = new Set(v.leaders || []);
  const ballots = v.ballots || [];
  const mine = ballots.find((b) => b.voter === 'human');
  const aiBallots = ballots.filter((b) => b.voter !== 'human');
  const dots = h('span', { class: 'dots' }, h('i'), h('i'), h('i'));
  const box = h(
    'div',
    { class: 'vote' },
    h(
      'span',
      { class: 'cap' },
      v.status === 'proposing'
        ? [T`投票 · 出方案 `, dots]
        : v.status === 'voting'
          ? [T`投票中 ${aiBallots.length}/${v.voters.length}`, h('span', { class: 'tally', 'aria-hidden': 'true' }, v.voters.map((_, i) => h('i', { class: i < aiBallots.length ? 'on' : i === aiBallots.length ? 'next' : null })))]
          : T`投票 · ${total} 票`
    ),
    h('p', { class: 'q' }, v.question)
  );
  if (v.status === 'proposing') {
    box.append(h('div', { class: 'opts' }, v.voters.map((_, i) => h('div', { class: 'skel', style: `width:${80 - i * 12}%;margin:10px 0` }))));
    return box;
  }
  if (v.error) box.append(h('div', { class: 'sys' }, h('span', { class: 'rd' }), tr(v.error)));
  const me = () => h('span', { class: 'tile human', 'data-tip': T`我` }, T`我`);
  const opts = h('div', { class: 'opts' });
  for (const o of v.options) {
    const n = counts[o.key] || 0;
    const lead = done && leaders.has(o.key) && n > 0;
    const adopted = v.adopted && v.adopted.key === o.key;
    const cast = live && !(mine && mine.choice === o.key);
    opts.append(
      h(
        'div',
        {
          class: `opt${lead ? ' lead' : ''}${adopted ? ' adopted' : ''}${v.adopted && !adopted ? ' dim' : ''}`,
          role: cast ? 'button' : null,
          tabindex: cast ? '0' : null,
          'aria-label': cast ? T`投方案 ${o.key}` : null,
          onclick: cast ? (e) => !e.target.closest('.adopt') && castVote(v, o) : null,
          onkeydown: cast ? (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), castVote(v, o)) : null,
        },
        h('span', { class: 'key' }, o.key),
        h('span', { class: 'otext' }, o.text),
        h('span', { class: 'voters' }, done ? ballots.filter((b) => b.choice === o.key).map((b) => (b.voter === 'human' ? me() : h('span', { 'data-tip': nameOf(b.voterLabel) }, tile({ agent: b.voter, label: b.voterLabel }, 's16')))) : null),
        h('span', { class: 'n' }, done || n ? String(n) : ''),
        h(
          'span',
          { class: 'by' },
          done && o.author !== 'human' ? [tile({ agent: o.author, label: o.authorLabel }, 's16'), T`${nameOf(o.authorLabel)} 出的方案`] : null,
          mine && mine.choice === o.key ? h('span', { class: 'mine' }, T`已投`) : null,
          adopted ? h('span', { class: 'mine' }, T`已采纳`) : null
        ),
        live && done && !v.adopted ? h('button', { class: 'btn small primary adopt', onclick: (e) => adopt(e.currentTarget, v, o) }, T`采纳`) : null
      )
    );
  }
  box.append(opts);
  const why = ballots.filter((b) => b.voter !== 'human' || b.choice);
  if (done && why.length) {
    box.append(
      h(
        'details',
        { class: 'ballots' },
        h('summary', { class: 'link' }, T`每一票 · ${why.length}`),
        why.map((b) =>
          h(
            'div',
            { class: 'b' },
            b.voter === 'human' ? me() : tile({ agent: b.voter, label: b.voterLabel }, 's16'),
            h('span', null, h('b', null, b.voter === 'human' ? T`我` : nameOf(b.voterLabel)), ` · ${b.choice ? T`投 ${b.choice}` : T`弃权${b.void ? T`（${b.void}）` : ''}`}${b.reason ? ` · ${b.reason}` : ''}`)
          )
        )
      )
    );
  }
  return box;
}

function castVote(v, o) {
  act(null, () => api('/api/vote/cast', { id: v.id, key: o.key }), T`已投方案 ${o.key}`).then(loadTalk);
}

function adopt(btn, v, o) {
  act(btn, () => api('/api/vote/adopt', { id: v.id, key: o.key }), T`已采纳方案 ${o.key}`).then(loadTalk);
}

// ----- 页签：打开的文件、改动、接力本、日志 -----

function tabKey(t) {
  return `${t.type}:${t.id || ''}:${t.path || ''}`;
}

function openTab(tab) {
  const i = S.tabs.findIndex((t) => tabKey(t) === tabKey(tab));
  if (i >= 0) S.tab = i + 1;
  else {
    S.tabs.push(tab);
    S.tab = S.tabs.length;
  }
  closeDrawers();
  renderCenter();
}

function closeTab(i) {
  const [t] = S.tabs.splice(i, 1);
  if (t) S.docs.delete(tabKey(t));
  if (S.tab === i + 1) S.tab = Math.min(i, S.tabs.length);
  else if (S.tab > i + 1) S.tab--;
  if (t && t.type === 'file' && S.treeSel === t.path) {
    S.treeSel = '';
    renderRight();
  }
  renderCenter();
}

function tabLabel(t) {
  if (t.type === 'file') return basename(t.path);
  if (t.type === 'diff') return t.path ? T`${basename(t.path)} · 第 ${t.id} 棒` : T`第 ${t.id} 棒 · 改动`;
  if (t.type === 'log') return T`第 ${t.id} 棒 · 日志`;
  return T`接力本`;
}

function renderTabs() {
  const sig = JSON.stringify([S.tabs.map(tabKey), S.tab, S.view]);
  if (sig === tabsSig) return;
  tabsSig = sig;
  const chat = S.view === 'chat';
  // 新开的页签淡进来，别的页签滑过去让位
  morph(CE.tabs, () => CE.tabs.replaceChildren(
    h('button', { class: 'tab chat-tab', 'data-k': 'main', role: 'tab', 'aria-selected': String(S.tab === 0), onclick: () => ((S.tab = 0), renderCenter(), scrollBottom()) }, icon(chat ? 'chat' : S.view === 'dispatch' ? 'list' : 'route'), chat ? T`群聊` : S.view === 'dispatch' ? T`派活` : T`任务`),
    ...S.tabs.map((t, i) =>
      h(
        'div',
        {
          class: 'tab',
          'data-k': tabKey(t),
          role: 'tab',
          tabindex: '0',
          'aria-selected': String(S.tab === i + 1),
          'data-tip': t.path || null,
          onclick: (e) => {
            if (e.target.closest('.x')) return;
            S.tab = i + 1;
            if (t.type === 'file') S.treeSel = t.path;
            renderCenter();
            renderRight();
          },
          onauxclick: (e) => e.button === 1 && closeTab(i),
          onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click(),
        },
        icon(t.type === 'file' ? 'file' : t.type === 'diff' ? 'diff' : t.type === 'log' ? 'log' : 'book'),
        h('span', { class: 'ell' }, tabLabel(t)),
        h('button', { class: 'x', 'aria-label': T`关闭`, onclick: () => closeTab(i) }, icon('x'))
      )
    )
  ), (b) => b.children);
}

function openFile(path) {
  S.treeSel = path;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) S.treeOpen.add(parts.slice(0, i).join('/'));
  saveTreeOpen();
  renderRight();
  RE.rows && RE.rows.get(path)?.scrollIntoView({ block: 'nearest' });
  openTab({ type: 'file', path, view: 0 });
}

function openDiff(id, path) {
  openTab({ type: 'diff', id, path: path || '' });
}

function openBrief() {
  openTab({ type: 'brief' });
}

function openLog(s) {
  openTab({ type: 'log', id: s.id, path: s.log });
}

async function loadDoc(t) {
  const key = tabKey(t);
  const tk = ticket(`doc:${key}`);
  try {
    let data;
    if (t.type === 'file') data = await api(q(`/api/file?path=${encodeURIComponent(t.path)}`));
    else if (t.type === 'diff') data = await api(q(`/api/diff?id=${t.id}${t.path ? `&path=${encodeURIComponent(t.path)}` : ''}`));
    else if (t.type === 'log') data = await api(q(`/api/log?path=${encodeURIComponent(t.path)}`));
    else data = await api(q('/api/brief'));
    if (stale(tk)) return;
    S.docs.set(key, { data });
  } catch (e) {
    if (stale(tk)) return;
    S.docs.set(key, { error: e.message });
  }
  docSig = '';
  renderCenter();
}

async function loadFileDiff(t, id) {
  const key = `${tabKey(t)}#${id}`;
  const tk = ticket(`doc:${key}`);
  try {
    const d = await api(q(`/api/diff?id=${id}&path=${encodeURIComponent(t.path)}`));
    if (stale(tk)) return;
    S.docs.set(key, { data: d });
  } catch (e) {
    if (stale(tk)) return;
    S.docs.set(key, { error: e.message });
  }
  docSig = '';
  renderCenter();
}

/** 这段对话里，哪几棒改过这个文件。 */
function touchers(path) {
  const t = selectedThread();
  if (!t) return [];
  return threadStints(t).filter((s) => !s.rolledBack && s.facts && s.facts.paths.includes(path));
}

function renderDoc(t) {
  const key = tabKey(t);
  const d = S.docs.get(key);
  const extra = t.type === 'file' && t.view ? S.docs.get(`${key}#${t.view}`) : null;
  const sig = JSON.stringify([key, t.view, !!d, d && d.error, !!extra, touchers(t.path || '').map((s) => s.id)]);
  if (sig === docSig) return;
  docSig = sig;
  if (!d) {
    S.docs.set(key, { loading: true });
    loadDoc(t);
  }
  const head = h('div', { class: 'doc-head' });
  const body = h('div', { class: 'doc-body' });
  if (d && d.error) body.append(h('div', { class: 'empty-note' }, tr(d.error)));
  else if (!d || d.loading) body.append(h('div', { class: 'skel', style: 'width:50%;margin:16px 0' }), h('div', { class: 'skel', style: 'width:70%' }));

  if (t.type === 'file') {
    const parts = t.path.split('/');
    head.append(
      h('div', { class: 'crumbs' }, parts.slice(0, -1).map((x) => [h('span', null, x), icon('chev')]), h('b', null, parts[parts.length - 1]), d && d.data ? h('span', null, ` · ${size(d.data.size)}`) : null)
    );
    const who = touchers(t.path);
    if (who.length) {
      head.append(
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': T`看什么` },
          h('button', { 'aria-pressed': String(!t.view), onclick: () => ((t.view = 0), (docSig = ''), renderCenter()) }, T`内容`),
          who.map((s) =>
            h(
              'button',
              {
                'aria-pressed': String(t.view === s.id),
                'data-tip': T`第 ${s.id} 棒 · ${nameOf(s.who.label, s.who.model)}`,
                onclick: () => {
                  t.view = s.id;
                  docSig = '';
                  if (!S.docs.get(`${key}#${s.id}`)) loadFileDiff(t, s.id);
                  renderCenter();
                },
              },
              T`第 ${s.id} 棒`
            )
          )
        )
      );
    }
    head.append(
      iconBtn(T`引用`, 'insert', () => addFile(t.path)),
      iconBtn(T`复制路径`, 'copy', () => copyToast(t.path)),
      iconBtn(REVEAL, 'folder', () => reveal(t.path))
    );
    if (t.view) {
      if (!extra || extra.loading) body.append(h('div', { class: 'skel', style: 'width:60%;margin:16px 0' }));
      else if (extra.error) body.append(h('div', { class: 'empty-note' }, tr(extra.error)));
      else body.append(extra.data.diff ? h('div', { class: 'diff-file' }, h('div', { class: 'diff', html: diffHtml(extra.data.diff) })) : h('div', { class: 'empty-note' }, T`这一棒没有改它`));
    } else if (d && d.data) {
      const f = d.data;
      if (f.binary) body.append(h('div', { class: 'empty-note' }, T`二进制文件 · ${size(f.size)}`));
      else {
        const lines = f.text.replace(/\n$/, '').split('\n');
        const cap = 4000;
        body.append(h('div', { class: 'code', html: lines.slice(0, cap).map((l) => `<div class="l">${esc(l) || ' '}</div>`).join('') }));
        if (lines.length > cap || f.truncated) body.append(h('div', { class: 'empty-note' }, T`只显示了前面一部分`));
      }
    }
  } else if (t.type === 'diff') {
    const s = stintById(t.id);
    head.append(
      h('div', { class: 'crumbs' }, s ? tile(s.who, 's20') : null, h('b', null, T`第 ${t.id} 棒`), s ? h('span', null, ` · ${nameOf(s.who.label, s.who.model)}`) : null, t.path ? [icon('chev'), h('span', null, t.path)] : null),
      ...(t.path ? [h('button', { class: 'btn small ghost', onclick: () => openDiff(t.id) }, T`全部文件`)] : [])
    );
    if (d && d.data) {
      const files = splitDiff(d.data.diff);
      if (!files.length) body.append(h('div', { class: 'empty-note' }, T`没有改动`));
      for (const f of files) {
        body.append(
          h(
            'details',
            { class: 'diff-file', open: files.length <= 12 },
            h(
              'summary',
              null,
              icon('chev', 'caret'),
              h('b', null, f.path),
              h('span', { class: 'chip line num' }, `+${f.add} −${f.del}`),
              h(
                'button',
                {
                  class: 'icon-btn',
                  'aria-label': T`打开文件`,
                  'data-tip': T`打开文件`,
                  onclick: (e) => {
                    e.preventDefault();
                    openFile(f.path);
                  },
                },
                icon('file')
              )
            ),
            h('div', { class: 'diff', html: diffHtml(f.lines.join('\n')) })
          )
        );
      }
    }
  } else if (t.type === 'log') {
    head.append(h('div', { class: 'crumbs' }, h('b', null, T`第 ${t.id} 棒 · 日志`)));
    if (d && d.data) body.append(h('pre', { class: 'pre' }, d.data.text || T`（空的）`));
  } else {
    head.append(h('div', { class: 'crumbs' }, h('b', null, T`接力本`)));
    if (d && d.data) body.append(h('div', { class: 'doc-md' }, h('div', { class: 'doc-md', html: md(d.data.text || T`（还没有）`) })));
  }
  CE.doc.replaceChildren(h('div', { class: 'doc-pane' }, head, body));
}

// ---------- 输入框 ----------

const C = {};

function buildComposer() {
  C.attach = h('div', { class: 'attach' });
  C.pill = h('span', { class: 'slash-pill', hidden: true });
  C.ta = h('textarea', { rows: '1', 'aria-label': T`输入`, oninput: onComposerInput, onkeydown: onComposerKey, onclick: updateSuggest, onpaste: onComposerPaste });
  C.fileIn = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: () => {
      uploadFiles([...C.fileIn.files]);
      C.fileIn.value = '';
    },
  });
  C.plus = iconBtn(T`上传文件`, 'plus', () => C.fileIn.click(), '', 'plus-btn');
  C.optInput = h('input', {
    type: 'text',
    placeholder: T`加选项`,
    'aria-label': T`加选项`,
    onkeydown: (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && C.optInput.value.trim()) {
        e.preventDefault();
        S.options.push(C.optInput.value.trim());
        C.optInput.value = '';
        drawOptions();
        updateComposer();
      } else if (e.key === 'Backspace' && !C.optInput.value && S.options.length) {
        S.options.pop();
        drawOptions();
        updateComposer();
      }
    },
  });
  C.optChips = h('span', { style: 'display:contents' });
  C.optRow = h('div', { class: 'opt-row', hidden: true }, C.optChips, C.optInput);
  C.seg = h(
    'div',
    { class: 'seg ink', role: 'group', 'aria-label': T`方式` },
    [
      ['turn', T`讨论`, T`轮流回答，后面的看得到前面的`],
      ['solo', T`对比`, T`同时回答，互相看不到，并排放`],
      ['vote', T`投票`, T`各出方案，匿名投票`],
    ].map(([k, label, tip]) =>
      h(
        'button',
        {
          'data-mode': k,
          'data-tip': tip,
          'aria-pressed': String(S.mode === k),
          onclick: () => {
            S.mode = k;
            updateComposer();
            C.ta.focus();
          },
        },
        label
      )
    )
  );
  // 谁来回答：选中的几位叠成一叠，点开勾选
  C.pick = h('button', { class: 'picker', 'aria-haspopup': 'menu', 'aria-label': T`成员`, 'data-tip': T`成员`, onclick: (e) => pickMenu(e.currentTarget) });
  C.auto = h(
    'button',
    {
      class: 'switch',
      role: 'switch',
      'aria-checked': 'false',
      onclick: () => {
        S.autoAfter = !S.autoAfter;
        C.auto.setAttribute('aria-checked', String(S.autoAfter));
      },
    },
    h('span', { class: 'track' }),
    (C.autoWord = h('span', null, T`全自动`))
  );
  C.send = h('button', { class: 'send', 'aria-label': T`发送`, 'data-tip': T`发送`, 'data-kbd': '↵', onclick: send }, icon('up'));
  C.tools = h('div', { class: 'tools' }, C.plus, C.seg, C.auto, C.pick, h('span', { class: 'sp' }), C.send);
  C.box = h(
    'div',
    {
      class: 'composer',
      ondragover: (e) => {
        const types = [...e.dataTransfer.types];
        if (!types.includes('application/x-relay-path') && !types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        C.box.classList.add('drop');
      },
      ondragleave: (e) => {
        if (!C.box.contains(e.relatedTarget)) C.box.classList.remove('drop');
      },
      ondrop: (e) => {
        const p = e.dataTransfer.getData('application/x-relay-path');
        C.box.classList.remove('drop');
        if (!p && !e.dataTransfer.files.length) return;
        e.preventDefault();
        if (p) addFile(p);
        else uploadFiles([...e.dataTransfer.files]);
      },
    },
    C.fileIn,
    C.attach,
    C.pill,
    C.ta,
    C.optRow,
    C.tools
  );
  C.wrap = h('div', { class: 'composer-wrap' }, C.box);
  // 打字打高了：空白页上输入框周围深一圈的纸跟着挪
  new ResizeObserver(() => paperAura()).observe(C.box);
  C.kind = '';
  // 输入框浮在对话上面：对话底下留出它的高度，「新消息」按钮也跟着它走
  new ResizeObserver(() => {
    if (C.wrap.parentNode !== CE.chat) return;
    CE.chat.style.setProperty('--compose-h', `${C.wrap.offsetHeight}px`);
    if (stick) scrollBottom();
  }).observe(C.wrap);
  restoreDraft();
}

function setComposerKind(kind) {
  if (C.kind !== kind) {
    C.kind = kind;
    if (kind === 'task') S.slash = null;
  }
  updateComposer();
}

function drawOptions() {
  C.optChips.replaceChildren(
    ...S.options.map((o, i) =>
      h(
        'span',
        { class: 'chip' },
        h('span', { class: 'k' }, String.fromCharCode(65 + i)),
        h('span', { class: 'ell' }, o),
        h(
          'button',
          {
            class: 'x',
            'aria-label': T`去掉`,
            onclick: () => {
              S.options.splice(i, 1);
              drawOptions();
              updateComposer();
            },
          },
          icon('x')
        )
      )
    )
  );
}

function updateComposer() {
  if (!S.st) return;
  const task = C.kind === 'task';
  const vote = !task && S.mode === 'vote';
  C.seg.hidden = task || !!S.slash;
  C.pick.hidden = task || !!S.slash;
  C.plus.hidden = !!S.slash;
  C.auto.hidden = !task;
  C.auto.setAttribute('aria-checked', String(S.autoAfter));
  C.autoWord.textContent = S.view === 'dispatch' ? T`派活` : T`全自动`;
  C.optRow.hidden = !vote || !!S.slash;
  for (const b of C.seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode));
  C.pill.hidden = !S.slash;
  if (S.slash) {
    C.pill.replaceChildren(
      icon(S.slash.icon),
      S.slash.label,
      h(
        'button',
        {
          class: 'x',
          'aria-label': T`取消`,
          onclick: () => {
            S.slash = null;
            updateComposer();
            C.ta.focus();
          },
        },
        icon('x')
      )
    );
  }
  C.ta.placeholder = task ? T`要做什么` : S.slash ? S.slash.placeholder : vote ? T`投票的问题` : T`消息`;
  // 谁来回答
  const people = talkers();
  if (!S.ask) {
    const saved = store.json(`ask:${S.dir}`, null);
    S.ask = new Set(Array.isArray(saved) ? saved.filter((n) => people.some((m) => m.name === n)) : people.filter((m) => !m.cooling).map((m) => m.name));
  }
  const askSig = JSON.stringify([people.map((m) => [m.name, m.cooling, m.llm]), [...S.ask], looks.key]);
  if (C.pick.dataset.sig !== askSig) {
    C.pick.dataset.sig = askSig;
    const chosen = people.filter((m) => S.ask.has(m.name));
    C.pick.replaceChildren(chosen.length ? stack(chosen, (m) => (m.cooling ? 'cooling' : ''), 6) : h('span', { class: 'none' }, T`成员`), icon('down', 'caret'));
    C.pick.dataset.tip = chosen.length ? chosen.map(memberName).join(T`、`) : T`成员`;
  }
  // 带上的文件：图片是缩略图；正在传的转圈（只在变了的时候重画，缩略图不会每打一个字就重新读）
  const attSig = JSON.stringify([S.files, S.uploading.map((u) => u.name)]);
  if (C.attach.dataset.sig !== attSig) {
    C.attach.dataset.sig = attSig;
    C.attach.replaceChildren(
      ...S.files.map((f, i) =>
        h(
          'span',
          {
            class: 'chip',
            'data-tip': f,
            // 带上的是项目里的文件：停上去，文件树里那一行点亮、拉一根线过去
            onmouseenter: (e) => {
              if (f.startsWith(UPLOADS)) return;
              lightPaths([f]);
              wireTo(e.currentTarget);
            },
            onmouseleave: () => {
              unlight();
              wireTo(null);
            },
          },
          isShot(f) ? h('img', { class: 'thumb', src: rawUrl(f), alt: '' }) : icon('file'),
          h('span', { class: 'ell' }, fileLabel(f)),
          h(
            'button',
            {
              class: 'x',
              'aria-label': T`去掉`,
              onclick: () => {
                S.files.splice(i, 1);
                updateComposer();
              },
            },
            icon('x')
          )
        )
      ),
      ...S.uploading.map((u) => h('span', { class: 'chip busy', 'data-tip': T`上传中` }, h('span', { class: 'spin' }), h('span', { class: 'ell' }, u.name)))
    );
  }
  const text = C.ta.value.trim();
  const asked = [...S.ask].filter((n) => people.some((m) => m.name === n));
  let ok;
  if (S.uploading.length) ok = false;
  else if (task) ok = !!text;
  else if (S.slash) ok = !S.slash.needsText || !!text;
  else if (vote) ok = !!text && asked.length >= 2;
  else ok = (!!text || S.files.length > 0) && asked.length > 0;
  C.send.disabled = !ok;
  autoGrow();
  syncSegs(C.box);
}

function saveAsk() {
  store.set(`ask:${S.dir}`, JSON.stringify([...S.ask]));
}

/** 勾选谁来回答：菜单不收起，连着勾；「全部」一下全勾上或全去掉。 */
function pickMenu(anchor) {
  const people = talkers();
  const all = () => people.length > 0 && people.every((m) => S.ask.has(m.name));
  const set = (names) => {
    S.ask = new Set(names);
    saveAsk();
    updateComposer();
  };
  openMenu(
    anchor,
    [
      { label: T`全部`, icon: 'user', keep: true, on: all, run: () => set(all() ? [] : people.filter((m) => !m.cooling).map((m) => m.name)) },
      '-',
      ...people.map((m) => ({
        label: memberName(m),
        sub: m.cooling ? T`额度用完 · ${tr(m.coolingText)}` : tr(m.tool) || '',
        tile: tile(m, 's20', m.cooling ? 'cooling' : ''),
        keep: true,
        on: () => S.ask.has(m.name),
        run: () => set(S.ask.has(m.name) ? [...S.ask].filter((n) => n !== m.name) : [...S.ask, m.name]),
      })),
    ],
    { side: 'top' }
  );
}

function autoGrow() {
  C.ta.style.height = 'auto';
  C.ta.style.height = `${Math.min(C.ta.scrollHeight, Math.round(innerHeight * 0.4))}px`;
}

let draftTimer = null;

function onComposerInput() {
  updateComposer();
  updateSuggest();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => store.set(`draft:${S.dir}`, C.ta.value), 300);
}

function restoreDraft() {
  if (!C.ta) return;
  C.ta.value = store.get(`draft:${S.dir}`) || '';
  S.options = [];
  drawOptions();
}

function focusComposer() {
  if (C.wrap.isConnected) C.ta.focus();
}

/** 引用一个文件：放进看得见的输入框；一个任务的线路上没有输入框，就到群聊里问。 */
function addFile(p) {
  if (!S.files.includes(p)) S.files.push(p);
  if (!C.wrap.isConnected) setView('chat');
  else if (S.tab !== 0) {
    S.tab = 0;
    renderCenter();
  }
  updateComposer();
  C.ta.focus();
}

// 传文件：+ 号、粘贴、从访达拖进来都走这里。存进项目的 .relay/uploads，AI 按路径打开

const UPLOADS = '.relay/uploads/';
const rawUrl = (p) => q(`/api/raw?path=${encodeURIComponent(p)}`);
/** 传上来的图片（画缩略图）。 */
const isShot = (p) => p.startsWith(UPLOADS) && /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(p);
/** 传上来的文件显示原来的名字（去掉前面加的「0926-2310-」）。 */
const fileLabel = (p) => (p.startsWith(UPLOADS) ? basename(p).replace(/^\d{4}-\d{4}-/, '') : basename(p));

async function uploadFiles(files) {
  if (!files.length) return;
  if (!C.wrap.isConnected) setView('chat');
  try {
    if (!S.st.project.init) {
      await api('/api/init', {});
      await refresh(true);
    }
  } catch (e) {
    return fail(T`上传`, e);
  }
  await Promise.all(
    files.map(async (f) => {
      const job = { name: f.name || T`图片` };
      S.uploading.push(job);
      updateComposer();
      try {
        const r = await fetch(q(`/api/upload?name=${encodeURIComponent(job.name)}`), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
        const j = await r.json().catch(() => ({ ok: false, error: T`传不上去（${r.status}）` }));
        if (!j.ok) throw new Error(j.error || T`出错`);
        if (!S.files.includes(j.path)) S.files.push(j.path);
      } catch (e) {
        fail(T`上传「${job.name}」`, e);
      } finally {
        S.uploading = S.uploading.filter((x) => x !== job);
        updateComposer();
      }
    })
  );
  C.ta.focus();
}

/** 粘贴截图、从访达复制的文件：传上去。带格式的文字（网页、文档里复制的）照常粘贴成字。 */
function onComposerPaste(e) {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || e.clipboardData.types.includes('text/html')) return;
  e.preventDefault();
  uploadFiles(files);
}

/** 人说的话最后一段全是反引号括起来的路径：那是带上的文件，画成缩略图和文件小条。 */
function splitFiles(text) {
  const m = text.match(/(?:^|\n\n)((?:`[^`\n]+`[ \t]*)+)$/);
  const files = m ? [...m[1].matchAll(/`([^`\n]+)`/g)].map((x) => x[1]) : [];
  if (!files.length || !files.every((f) => /[/.]/.test(f))) return { body: text, files: [] };
  return { body: text.slice(0, m.index).trimEnd(), files };
}

function fileEl(f) {
  if (isShot(f)) return h('a', { class: 'shot', href: rawUrl(f), target: '_blank', rel: 'noopener', 'data-tip': fileLabel(f) }, h('img', { src: rawUrl(f), alt: fileLabel(f), loading: 'lazy' }));
  const up = f.startsWith(UPLOADS);
  return h('button', { class: 'chip line', 'data-tip': f, onclick: () => (up ? window.open(rawUrl(f), '_blank', 'noopener') : openFile(f)) }, icon('file'), h('span', { class: 'ell' }, fileLabel(f)));
}

function onComposerKey(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (SUG.menu) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSuggest(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickSuggest(SUG.hot);
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSuggest();
      return;
    }
  }
  if (e.key === 'Backspace' && S.slash && !C.ta.value) {
    S.slash = null;
    updateComposer();
    return;
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    C.ta.blur();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    send();
  }
}

// 斜杠命令和 @：跟着光标弹出来

const idleNow = () => !runState().running && !runState().waiting;
const SLASH = [
  { key: 'step', label: T`加一步`, icon: 'plus', needsText: true, placeholder: T`这一步`, run: (text) => act(null, () => api('/api/task/edit', { op: 'add', text }), T`已加入清单`) },
  { key: 'go', label: T`接着做`, icon: 'play', when: () => idleNow() && !!defaultWorker(), run: goDefault },
  { key: 'auto', label: T`全自动`, icon: 'bolt', when: () => idleNow() && ready().length > 0 && !accepted(), run: () => act(null, () => startWork('/api/auto', {}), T`已开始全自动`) },
  { key: 'review', label: T`复核`, icon: 'review', when: () => idleNow() && S.st.project.pending.length > 0 && !!reviewer(), run: reviewNow },
  { key: 'stop', label: T`停止`, icon: 'stop', when: () => !idleNow(), run: stopNow },
  { key: 'task', label: T`新任务`, icon: 'plus', run: newThread },
  { key: 'snap', label: T`对账`, icon: 'sync', run: snapNow },
  { key: 'brief', label: T`接力本`, icon: 'book', run: openBrief },
  { key: 'edit', label: T`编辑任务`, icon: 'pencil', run: editTaskRaw },
  { key: 'settings', label: T`设置`, icon: 'sliders', run: () => openSettings() },
];

const SUG = { menu: null, items: [], hot: 0, kind: '', start: 0 };

function closeSuggest() {
  SUG.menu?.remove();
  SUG.menu = null;
  SUG.items = [];
}

function updateSuggest() {
  if (C.kind !== 'talk' || S.slash) return closeSuggest();
  const v = C.ta.value;
  const pos = C.ta.selectionStart;
  const before = v.slice(0, pos);
  let items = [];
  let kind = '';
  const sl = before.match(/^\/(\S*)$/);
  const at = before.match(/(^|\s)@([^\s@]*)$/);
  if (sl) {
    kind = 'slash';
    const qy = sl[1].toLowerCase();
    items = SLASH.filter((c) => (!c.when || c.when()) && (!qy || c.label.includes(qy) || c.key.startsWith(qy))).map((c) => ({ label: c.label, icon: c.icon, cmd: c }));
  } else if (at) {
    kind = 'at';
    SUG.start = pos - at[2].length - 1;
    const qy = at[2].toLowerCase();
    // AI 和文件分成两组，各有一行小标题
    const ais = talkers()
      .filter((m) => !qy || memberName(m).toLowerCase().includes(qy) || m.name.includes(qy))
      .slice(0, 6)
      .map((m) => ({ label: memberName(m), sub: m.tool || '', tile: tile(m, 's20'), member: m }));
    const files = ((S.tree && S.tree.files) || [])
      .filter((f) => !qy || f.toLowerCase().includes(qy))
      .slice(0, qy ? 8 : 4)
      .map((f) => ({ label: basename(f), sub: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', icon: 'file', file: f }));
    if (ais.length) ais[0].head = 'AI';
    if (files.length) files[0].head = T`文件`;
    items = [...ais, ...files];
  }
  if (!items.length) return closeSuggest();
  SUG.kind = kind;
  SUG.items = items;
  SUG.hot = clamp(SUG.hot, 0, items.length - 1);
  if (!SUG.menu) {
    SUG.menu = h('div', { class: 'menu', role: 'listbox', style: 'min-width:260px' });
    layer.append(SUG.menu);
  }
  SUG.menu.replaceChildren(
    ...items.map((it, i) => [
      it.head ? h('div', { class: 'mh' }, it.head) : null,
      h(
        'button',
        {
          class: `mi${i === SUG.hot ? ' hot' : ''}`,
          role: 'option',
          tabindex: '-1',
          onpointerdown: (e) => e.preventDefault(),
          onclick: () => pickSuggest(i),
        },
        it.tile || icon(it.icon),
        h('span', { class: 'grow' }, h('span', null, it.label), it.sub ? h('span', { class: 'sub' }, it.sub) : null)
      ),
    ])
      .flat()
      .filter(Boolean)
  );
  const r = C.box.getBoundingClientRect();
  SUG.menu.style.left = `${r.left + 8}px`;
  SUG.menu.style.top = `${Math.max(8, r.top - SUG.menu.offsetHeight - 6)}px`;
}

function moveSuggest(d) {
  SUG.hot = (SUG.hot + d + SUG.items.length) % SUG.items.length;
  const rows = SUG.menu.querySelectorAll('.mi');
  rows.forEach((b, i) => b.classList.toggle('hot', i === SUG.hot));
  rows[SUG.hot]?.scrollIntoView({ block: 'nearest' });
}

function pickSuggest(i) {
  const it = SUG.items[i];
  if (!it) return;
  closeSuggest();
  if (it.cmd) {
    C.ta.value = '';
    if (it.cmd.needsText) S.slash = it.cmd;
    else it.cmd.run();
  } else {
    const v = C.ta.value;
    const end = C.ta.selectionStart;
    C.ta.value = v.slice(0, SUG.start) + v.slice(end);
    C.ta.selectionStart = C.ta.selectionEnd = SUG.start;
    if (it.member) {
      // @ 只管这一句：发出去之后换回原来选的人。
      if (!S.atUsed) {
        S.askBefore = new Set(S.ask);
        S.ask = new Set();
      }
      S.atUsed = true;
      S.ask.add(it.member.name);
    } else if (it.file && !S.files.includes(it.file)) S.files.push(it.file);
  }
  SUG.hot = 0;
  updateComposer();
  C.ta.focus();
}

async function send() {
  if (C.send.disabled) return;
  const text = C.ta.value.trim();
  const clear = () => {
    C.ta.value = '';
    S.files = [];
    S.options = [];
    S.slash = null;
    if (S.atUsed && S.askBefore) S.ask = S.askBefore;
    S.askBefore = null;
    S.atUsed = false;
    drawOptions();
    store.set(`draft:${S.dir}`, null);
    updateComposer();
    // 发出去了：输入框空出来时占位字淡进来，发送键的箭头从底下补上来
    if (!still()) {
      C.ta.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE.ease });
      C.send.firstChild?.animate([{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 80, easing: EASE.snap, fill: 'backwards' });
    }
  };
  C.send.classList.add('busy');
  C.send.disabled = true;
  try {
    if (C.kind === 'task') {
      await createTask(text);
      clear();
      return;
    }
    if (S.slash) {
      const cmd = S.slash;
      clear();
      await cmd.run(text);
      return;
    }
    const setup = !S.st.project.init;
    if (setup) await api('/api/init', {});
    // 在存档的群聊里说话：先把它换回正在用的那一段
    if (S.chat) {
      await api('/api/talk/resume', { id: S.chat });
      S.chat = null;
      S.archive = null;
    }
    const ask = [...S.ask].filter((n) => talkers().some((m) => m.name === n));
    // 带上的文件写在最后一段（反引号括起来），AI 按路径打开；网页上画成缩略图和文件小条
    const full = S.files.length ? `${text}${text ? '\n\n' : ''}${S.files.map((f) => `\`${f}\``).join(' ')}` : text;
    if (S.mode === 'vote') await api('/api/vote/start', { question: full, voters: ask, options: S.options });
    else await api('/api/talk/say', { text: full, ask, mode: S.mode });
    clear();
    if (setup) await refresh(true);
    await loadTalk();
    schedule();
    scrollBottom(true);
  } catch (e) {
    fail(T`发送`, e);
  } finally {
    C.send.classList.remove('busy');
    updateComposer();
  }
}

/** 第一行是标题；「- 」开头的行是步骤；其余是说明。 */
async function createTask(text) {
  if (!text) return;
  const lines = text.split('\n');
  const steps = [];
  const body = [];
  for (const l of lines.slice(1)) {
    const m = l.match(/^\s*(?:[-*•]|\d+[.、)])\s+(.+)$/);
    if (m) steps.push(m[1].trim());
    else if (l.trim()) body.push(l);
  }
  const p = S.st.project;
  if (!p.init) await api('/api/init', {});
  const refs = S.files.map((f) => `\`${f}\``).join(' ');
  // 派活页写的任务：全自动用派活（强模型拆、弱模型做）
  const dispatch = S.view === 'dispatch';
  await api('/api/task', { text: [lines[0].trim(), ...body, refs].filter(Boolean).join('\n'), steps, ...(dispatch ? { mode: 'dispatch' } : {}) });
  if (S.autoAfter) await startWork('/api/auto', {}).catch((e) => e.code !== 'cancelled' && fail(dispatch ? T`开始派活` : T`开始全自动`, e));
  S.draft = false;
  S.thread = null;
  S.autoAfter = false;
  await refresh();
  await Promise.all([loadTalk(), loadTree()]);
  scrollBottom();
}

// ---------- 右栏：项目文件 ----------

const RE = {};
let treeSig = '';

function buildRight() {
  RE.title = h('span', { class: 'cap' }, T`文件`);
  RE.filterBtn = iconBtn(T`筛选`, 'search', () => toggleFilter(), '⌘P');
  RE.filterBtn.setAttribute('aria-pressed', 'false');
  RE.changedBtn = h(
    'button',
    {
      class: 'switch',
      role: 'switch',
      'aria-checked': 'false',
      onclick: () => {
        S.onlyChanged = !S.onlyChanged;
        renderRight(true);
      },
    },
    h('span', { class: 'track' }),
    T`只看改过的`
  );
  // 全部展开 / 全部收起：按现在是不是全开着，点一下换一边
  RE.foldBtn = iconBtn(T`全部展开`, 'unfold', () => {
    const dirs = treeDirs();
    if (dirs.every((d) => S.treeOpen.has(d))) S.treeOpen.clear();
    else for (const d of dirs) S.treeOpen.add(d);
    saveTreeOpen();
    renderRight(true);
  });
  RE.input = h('input', {
    type: 'text',
    placeholder: T`筛选文件`,
    'aria-label': T`筛选文件`,
    oninput: () => {
      S.treeFilter = RE.input.value;
      renderRight(true);
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        toggleFilter(false);
      } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        const first = RE.tree.querySelector('.tree-row:not(.dir)') || RE.tree.querySelector('.tree-row');
        if (first) {
          if (e.key === 'Enter' && !first.classList.contains('dir')) first.click();
          else first.focus();
        }
      }
    },
  });
  RE.filter = h('div', { class: 'filter', hidden: true }, icon('search'), RE.input, h('button', { class: 'x', 'aria-label': T`清除`, onclick: () => toggleFilter(false) }, icon('x')));
  RE.tree = h('div', { class: 'tree', role: 'tree', 'aria-label': T`项目文件`, onkeydown: treeKeys });
  RE.tree.addEventListener('scroll', () => WIRE.from && drawWires(), { passive: true });
  RE.note = h('div', { class: 'tree-note', hidden: true });
  $('#right-in').append(h('div', { class: 'right-head' }, RE.title, RE.changedBtn, RE.filterBtn, RE.foldBtn, iconBtn(T`收起`, 'sideR', toggleRight, '⌥⌘B')), RE.filter, RE.tree, RE.note);
}

function toggleFilter(on) {
  const show = on === undefined ? RE.filter.hidden : on;
  RE.filter.hidden = !show;
  RE.filterBtn.setAttribute('aria-pressed', String(show));
  if (show) {
    if (narrow() && !app.classList.contains('drawer-right')) drawer('right');
    if (!narrow() && UI.noRight) toggleRight();
    RE.input.focus();
    RE.input.select();
  } else {
    RE.input.value = '';
    S.treeFilter = '';
    renderRight(true);
  }
}

function saveTreeOpen() {
  store.set(`open:${S.dir}`, JSON.stringify([...S.treeOpen].slice(-300)));
}

/** 项目里所有的文件夹（按文件的路径算）。 */
function treeDirs() {
  const out = new Set();
  for (const f of (S.tree && S.tree.files) || []) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) out.add(f.slice(0, i));
  return [...out];
}

/** 展开 / 收起按钮跟着现在的样子换：全开着就是「全部收起」；没有文件夹就不出来。 */
function syncFoldBtn() {
  const dirs = treeDirs();
  const all = dirs.length > 0 && dirs.every((d) => S.treeOpen.has(d));
  RE.foldBtn.hidden = !dirs.length;
  const label = all ? T`全部收起` : T`全部展开`;
  if (RE.foldBtn.dataset.tip === label) return;
  RE.foldBtn.dataset.tip = label;
  RE.foldBtn.setAttribute('aria-label', label);
  const svg = RE.foldBtn.firstChild;
  svg.innerHTML = ICONS[all ? 'fold' : 'unfold'];
  if (!still()) svg.animate([{ transform: 'scaleY(0.2)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
}

/** 这段对话里每个文件：最后是谁改的、有没有待复核的棒改过它。 */
function touchedMap() {
  const map = new Map();
  if (!S.st || !S.st.project.init || centerMode() !== 'thread') return map;
  const t = selectedThread();
  if (!t) return map;
  for (const s of threadStints(t)) {
    if (s.rolledBack || !s.facts) continue;
    const tier = lookOf(s.who).tier;
    const pending = s.review === 'needed' && s.status !== 'working';
    for (const p of s.facts.paths) {
      const cur = map.get(p) || { looks: [], ids: [], pending: false };
      cur.looks = [...cur.looks.filter((x) => x !== tier), tier];
      cur.ids.push(s.id);
      cur.pending = cur.pending || pending;
      map.set(p, cur);
    }
  }
  return map;
}

function buildTree(files, gone) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  const add = (f, isGone) => {
    const parts = f.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let d = node.dirs.get(parts[i]);
      if (!d) {
        d = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] };
        node.dirs.set(parts[i], d);
      }
      node = d;
    }
    node.files.push({ name: parts[parts.length - 1], path: f, gone: isGone });
  };
  for (const f of files) add(f, false);
  for (const f of gone) add(f, true);
  return root;
}

const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });

function renderRight(force) {
  if (!S.st || !RE.tree) return;
  const p = S.st.project;
  RE.changedBtn.setAttribute('aria-checked', String(S.onlyChanged));
  RE.changedBtn.hidden = RE.filterBtn.hidden = !!p.pick;
  syncFoldBtn();
  if (p.pick) {
    // 还没有项目：右边空着
    RE.tree.replaceChildren();
    RE.note.hidden = true;
    treeSig = '';
    return;
  }
  const touched = touchedMap();
  const sig = JSON.stringify([S.treeRev, !!S.tree, [...touched].map(([k, v]) => [k, v.looks, v.pending]), [...S.treeOpen], S.treeFilter, S.onlyChanged, S.treeSel, looks.key]);
  if (!force && sig === treeSig) return;
  treeSig = sig;
  const focused = document.activeElement && RE.tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  const files = (S.tree && S.tree.files) || [];
  const before = rowTops();
  const have = new Set(files);
  const gone = S.onlyChanged ? [...touched.keys()].filter((f) => !have.has(f)) : [];
  const root = buildTree(files, gone);
  const qy = S.treeFilter.trim().toLowerCase();
  const filtering = !!qy || S.onlyChanged;
  const want = (path) => (!qy || path.toLowerCase().includes(qy)) && (!S.onlyChanged || touched.has(path));
  const keep = new Map();
  const scan = (d) => {
    let any = false;
    for (const c of d.dirs.values()) any = scan(c) || any;
    for (const f of d.files) if (want(f.path)) any = true;
    keep.set(d.path, any);
    return any;
  };
  if (filtering) scan(root);
  const touchedDirs = new Set();
  for (const k of touched.keys()) {
    const parts = k.split('/');
    for (let i = 1; i < parts.length; i++) touchedDirs.add(parts.slice(0, i).join('/'));
  }
  const rows = [];
  RE.rows = new Map();
  const walk = (d, depth) => {
    for (const c of [...d.dirs.values()].sort(byName)) {
      if (filtering && !keep.get(c.path)) continue;
      const open = filtering || S.treeOpen.has(c.path);
      rows.push(treeRow({ dir: true, node: c, depth, open, marked: touchedDirs.has(c.path) }, touched));
      if (open) walk(c, depth + 1);
    }
    for (const f of [...d.files].sort(byName)) if (!filtering || want(f.path)) rows.push(treeRow({ dir: false, node: f, depth }, touched));
  };
  walk(root, 0);
  const keepScroll = RE.tree.scrollTop;
  RE.tree.replaceChildren(...rows);
  RE.tree.scrollTop = keepScroll;
  glide(before);
  RE.note.hidden = true;
  if (!S.tree) {
    RE.note.hidden = false;
    RE.note.textContent = T`读取中…`;
  } else if (S.tree.error) {
    RE.note.hidden = false;
    RE.note.textContent = tr(S.tree.error);
  } else if (!rows.length) {
    RE.note.hidden = false;
    RE.note.textContent = filtering ? T`没有匹配的文件` : T`空文件夹`;
  } else if (S.tree.truncated && !filtering) {
    RE.note.hidden = false;
    RE.note.textContent = T`只列出了前 ${files.length} 个文件`;
  }
  if (focused) RE.rows.get(focused)?.focus({ preventScroll: true });
  if (LIT.paths) lightPaths(LIT.paths);
}

/** 文件树重画前：记下看得见的每一行在哪。 */
function rowTops() {
  const out = new Map();
  if (!RE.rows || still()) return out;
  const box = RE.tree.getBoundingClientRect();
  for (const [p, el] of RE.rows) {
    const b = el.getBoundingClientRect();
    if (b.top > box.bottom) break;
    if (b.bottom >= box.top) out.set(p, b.top);
  }
  return out;
}

/** 文件树重画后：还在的行从原来的位置滑过去，新出来的行淡入（展开、收起、筛选都接得上）。 */
function glide(before) {
  if (!before.size) return;
  const box = RE.tree.getBoundingClientRect();
  let k = 0;
  for (const [p, el] of RE.rows) {
    const top = el.getBoundingClientRect().top;
    if (top > box.bottom) break;
    const was = before.get(p);
    if (was === undefined) el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: stagger(k++), easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
    else if (Math.abs(was - top) > 0.5) el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: 490, easing: EASE.spring });
  }
}

function treeRow(r, touched) {
  const p = r.node.path;
  const t = touched.get(p);
  const el = h(
    'div',
    {
      class: `tree-row${r.dir ? ' dir' : ''}${t ? ' touched' : ''}${r.node.gone ? ' gone' : ''}`,
      role: 'treeitem',
      'aria-level': String(r.depth + 1),
      'aria-expanded': r.dir ? String(r.open) : null,
      'aria-selected': !r.dir && S.treeSel === p ? 'true' : null,
      tabindex: '-1',
      style: `--d:${r.depth}`,
      'data-path': p,
      draggable: r.node.gone ? null : 'true',
      onclick: () => (r.dir ? toggleDir(p) : r.node.gone ? null : openFile(p)),
      oncontextmenu: (e) => ctx(e, fileMenuItems(p, r.dir, r.node.gone)),
      ondragstart: (e) => {
        e.dataTransfer.setData('application/x-relay-path', p);
        e.dataTransfer.setData('text/plain', p);
        e.dataTransfer.effectAllowed = 'copy';
        const ghost = h('div', { class: 'drag-ghost' }, p);
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 12, 13);
        setTimeout(() => ghost.remove(), 0);
        el.classList.add('dragging');
      },
      ondragend: () => el.classList.remove('dragging'),
      onmouseenter: (e) => lightCards(p, r.dir) && wireTo(e.currentTarget),
      onmouseleave: () => {
        unlightCards();
        wireTo(null);
      },
    },
    r.dir ? icon('chev', 'caret') : t ? h('span', { class: `ring ${t.looks[t.looks.length - 1]}`, 'data-tip': t.ids.map((id) => T`第 ${id} 棒`).join(T`、`) }) : h('span', { class: 'fi' }),
    h('span', { class: 'nm' }, r.node.name),
    t && t.pending ? h('span', { class: 'rd', 'data-tip': T`待复核` }) : null,
    r.dir && r.marked && !r.open ? h('span', { class: 'd' }) : null
  );
  RE.rows.set(p, el);
  return el;
}

function toggleDir(p) {
  if (S.treeFilter.trim() || S.onlyChanged) return;
  if (S.treeOpen.has(p)) S.treeOpen.delete(p);
  else S.treeOpen.add(p);
  saveTreeOpen();
  renderRight(true);
  RE.rows.get(p)?.focus({ preventScroll: true });
}

function fileMenuItems(p, dir, gone) {
  if (gone) return [{ label: T`复制路径`, icon: 'copy', run: () => copyToast(p) }];
  return [
    dir ? { label: S.treeOpen.has(p) ? T`收起` : T`展开`, icon: 'chev', run: () => toggleDir(p) } : { label: T`打开`, icon: 'file', run: () => openFile(p) },
    { label: T`引用`, icon: 'insert', run: () => addFile(p) },
    '-',
    { label: T`复制路径`, icon: 'copy', run: () => copyToast(p) },
    { label: REVEAL, icon: 'folder', run: () => reveal(p) },
  ];
}

function treeKeys(e) {
  const rows = [...RE.tree.querySelectorAll('.tree-row')];
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement);
  const go = (j) => {
    const r = rows[clamp(j, 0, rows.length - 1)];
    r.focus();
    r.scrollIntoView({ block: 'nearest' });
  };
  const row = rows[i];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    go(i + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    go(i - 1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    go(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    go(rows.length - 1);
  } else if (e.key === 'ArrowRight' && row && row.classList.contains('dir')) {
    e.preventDefault();
    if (row.getAttribute('aria-expanded') === 'false') toggleDir(row.dataset.path);
    else go(i + 1);
  } else if (e.key === 'ArrowLeft' && row) {
    e.preventDefault();
    if (row.classList.contains('dir') && row.getAttribute('aria-expanded') === 'true') toggleDir(row.dataset.path);
    else {
      const parent = row.dataset.path.split('/').slice(0, -1).join('/');
      if (parent) RE.rows.get(parent)?.focus();
    }
  } else if (e.key === 'Enter' && row) {
    e.preventDefault();
    row.click();
  }
}

// 两边互相点亮：停在一棒上，它改过的文件变黑；停在文件上，改过它的那几棒描边。

const LIT = { paths: null };

function lightStint(s) {
  lightPaths(s.facts && !s.rolledBack ? s.facts.paths : []);
}

function lightPaths(paths) {
  clearLit();
  LIT.paths = paths;
  if (!RE.rows) return;
  for (const p of paths) {
    const row = RE.rows.get(p);
    if (row) {
      row.classList.add('lit');
      continue;
    }
    const parts = p.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const dirRow = RE.rows.get(parts.slice(0, i).join('/'));
      if (dirRow) {
        dirRow.classList.add('lit-in');
        break;
      }
    }
  }
  if (WIRE.from) drawWires();
}

function clearLit() {
  for (const el of RE.tree.querySelectorAll('.lit, .lit-in')) el.classList.remove('lit', 'lit-in');
}

function unlight() {
  LIT.paths = null;
  clearLit();
}

/** 停在文件上：改过它的那几棒描边（点亮了几张）。 */
function lightCards(p, dir) {
  const t = selectedThread();
  if (!t || centerMode() !== 'thread' || S.view === 'chat') return 0;
  const hit = (path) => (dir ? path.startsWith(`${p}/`) : path === p);
  return lightStints(threadStints(t).filter((s) => !s.rolledBack && s.facts && s.facts.paths.some(hit)).map((s) => s.id));
}

/** 这几棒描边（停在文件上、停在「待复核」上）。 */
function lightStints(ids) {
  let n = 0;
  for (const id of ids) {
    const el = CE.stream.querySelector(`.card[data-stint="${id}"]`);
    if (el) {
      el.classList.add('lit');
      n++;
    }
  }
  return n;
}

function unlightCards() {
  for (const el of CE.stream.querySelectorAll('.card.lit')) el.classList.remove('lit');
}

// 连线（实验笔记里钉照片的点线）：停在一棒上，从小条右边拉线到它改过的文件；停在文件上，从文件拉线到改过它的那几棒；
// 停在输入框里带上的文件上，拉到文件树里的那一行。线从「+」那头一格一格点出去、一根接一根；移开时收回「+」。
// 只在看得见的时候画，滚动、换大小时跟着走。

const WIRE = { svg: null, from: null, raf: 0, off: 0 };

/** 从 el 拉线（一棒的卡片、文件树的一行、输入框里的文件）；null：收回去。 */
function wireTo(el) {
  WIRE.from = el;
  drawWires(true);
}

/** 这一刻要画的线：起点（「+」的位置）和每一根的终点；画不了（看不见、没有要连的）就是 null。 */
function wireLines() {
  const el = WIRE.from;
  if (!el || !el.isConnected || narrow() || UI.noRight || S.tab !== 0) return null;
  const view = CE.scroll.getBoundingClientRect();
  const tree = RE.tree.getBoundingClientRect();
  const mark = (r) => (r.querySelector('.ring, .caret, .fi') || r).getBoundingClientRect();
  const lines = [];
  let hub;
  if (el.classList.contains('tree-row')) {
    // 文件 → 改过它的那几棒（小条右边、名字那一行的高度）
    const m = mark(el);
    hub = [m.left - 6, m.top + m.height / 2];
    for (const c of CE.stream.querySelectorAll('.card.lit')) {
      const slip = c.querySelector('.slip').getBoundingClientRect();
      // 露出一半的小条也连：连到露出来的那一截
      if (slip.bottom > view.top + 16 && slip.top < view.bottom - 16) lines.push([slip.right, clamp(slip.top + 24, view.top + 12, Math.min(slip.bottom - 10, view.bottom - 12))]);
    }
  } else {
    // 一棒、带上的文件 → 文件树里点亮的那几行
    const card = el.classList.contains('card');
    const r = (card ? el.querySelector('.slip') : el).getBoundingClientRect();
    if (card && (r.bottom < view.top + 20 || r.top > view.bottom - 20)) return null;
    hub = [r.right + (card ? 0 : 6), card ? clamp(r.top + 24, view.top + 12, view.bottom - 12) : r.top + r.height / 2];
    for (const row of RE.tree.querySelectorAll('.tree-row.lit, .tree-row.lit-in')) {
      const m = mark(row);
      const y = m.top + m.height / 2;
      if (y >= tree.top && y <= tree.bottom) lines.push([m.left - 5, y]);
    }
  }
  return lines.length ? { hub, lines } : null;
}

function drawWires(fresh) {
  cancelAnimationFrame(WIRE.raf);
  WIRE.raf = requestAnimationFrame(() => {
    if (!WIRE.svg) {
      WIRE.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      WIRE.svg.setAttribute('class', 'wires');
      WIRE.svg.setAttribute('aria-hidden', 'true');
      document.body.append(WIRE.svg);
    }
    const svg = WIRE.svg;
    const w = wireLines();
    if (!w) return unwire();
    clearTimeout(WIRE.off);
    svg.classList.remove('off');
    const [x, y] = w.hub.map((v) => v.toFixed(1));
    // 每根线是一串点；刚出来时从「+」那头一格一格点到终点（下面那层遮罩按 draw 的动画画出来）
    let out = '';
    let reveal = '';
    w.lines.forEach(([x2, y2], i) => {
      const xy = `x1="${x}" y1="${y}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"`;
      out += `<line ${xy}/>`;
      reveal += `<line ${xy} style="--len:${Math.hypot(x2 - x, y2 - y).toFixed(0)};--i:${i}"/>`;
    });
    svg.innerHTML = `<mask id="wire-m" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">${reveal}</mask><g mask="url(#wire-m)">${out}</g><path class="hub" d="M${x - 4.5} ${y}h9M${x} ${y - 4.5}v9"/>`;
    svg.classList.toggle('draw', !!fresh && !still());
  });
}

/** 线收回「+」那头再拿掉（不是一下子没了）。 */
function unwire() {
  const svg = WIRE.svg;
  if (!svg || !svg.firstChild || svg.classList.contains('off')) return;
  if (still()) return svg.replaceChildren();
  svg.classList.remove('draw');
  svg.classList.add('off');
  WIRE.off = setTimeout(() => {
    svg.replaceChildren();
    svg.classList.remove('off');
  }, 230);
}

// ---------- 设置 ----------

let settingsTab = 'members';
let consentCache = null;

function openSettings(tab) {
  if (tab) settingsTab = tab;
  const tabs = [
    ['members', T`成员`, 'user'],
    ['project', L('项目', '设置'), 'folder'],
    ['relay', T`运行`, 'bolt'],
    ['general', T`通用`, 'sliders'],
  ];
  // 左边的页签：选中的那一块是滑过去的（和分段按钮一样的弹簧）
  const hl = h('span', { class: 'hl', 'aria-hidden': 'true' });
  const btns = tabs.map(([k, label, ic]) => h('button', { role: 'tab', 'data-tab': k, onclick: () => go(k) }, icon(ic), label));
  const nav = h('nav', { 'aria-label': T`设置` }, h('h3', null, T`设置`), hl, btns);
  const pane = h('div', { class: 'pane-in' });
  const mark = () => {
    const on = btns.find((b) => b.dataset.tab === settingsTab);
    for (const b of btns) b.setAttribute('aria-selected', String(b === on));
    if (on && on.offsetHeight) nav.style.setProperty('--hy', `${on.offsetTop}px`);
  };
  // 换一页：这一页先淡出一点点，新的一页一行接一行升上来；存完设置后原地重画不再升
  const draw = (enter) => {
    pane.replaceChildren(h('button', { class: 'icon-btn close', 'aria-label': T`关闭`, onclick: () => close() }, icon('x')), ...settingsPane(settingsTab, draw));
    syncSegs(pane);
    if (enter === true && !still()) [...pane.children].forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: Math.round(stagger(i) * 0.6), easing: EASE.ease, fill: 'backwards' }));
  };
  let out = null;
  const go = (k) => {
    if (k === settingsTab) return;
    settingsTab = k;
    mark();
    out?.cancel();
    if (still()) return draw(true);
    out = pane.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 110, easing: EASE.exit });
    out.onfinish = () => draw(true);
  };
  const close = sheet({
    title: T`设置`,
    wide: true,
    bare: true,
    body: h('div', { class: 'settings' }, nav, pane),
  });
  mark();
  requestAnimationFrame(() => nav.classList.add('ready'));
  draw(true);
}

/** 各页返回的列表里可能有空位（比如接力规矩是最新的就没有「更新」那一行）：去掉，不然会显示成「null」。 */
function settingsPane(tab, redraw) {
  return settingsBody(tab, redraw).filter((x) => x !== null && x !== undefined && x !== false);
}

let savedAt = 0;

/** 「已保存」：存完面板会重画，所以记住存的时间，新画出来的也亮一会儿。 */
function savedMark() {
  const m = h('span', { class: 'saved' }, icon('check'), T`已保存`);
  const light = () => {
    const left = 1600 - (Date.now() - savedAt);
    if (left <= 0) return;
    m.classList.add('on');
    setTimeout(() => m.classList.remove('on'), left);
  };
  setTimeout(light, 0);
  return {
    el: m,
    flash() {
      savedAt = Date.now();
      light();
    },
  };
}

/** 设置里的一行：名字，底下一行灰字写它管什么（只写事实），右边是开关、数字或分段。 */
function setRow(label, desc, control) {
  const d = h('small', null, desc);
  const row = h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('span', null, label), desc ? d : null), control);
  row.desc = d;
  return row;
}

/** 设置里的一栏：名字、灰字说明、输入框，底下可以再跟一行结果。 */
function setField(label, desc, input, ...after) {
  return h('div', { class: 'field' }, h('span', null, label), desc ? h('small', null, desc) : null, input, ...after);
}

/** 一小节的标题：几行设置归在一起。 */
function setSec(text) {
  return h('div', { class: 'set-sec' }, text);
}

const LEVEL_DESC = {
  safe: T`只改这个项目文件夹里的文件，命令在各家工具自己的沙箱里跑。`,
  full: T`工具不拦截任何操作：能装依赖、联网、改项目以外的文件。`,
};

function settingsBody(tab, redraw) {
  const st = S.st;
  if (tab === 'members') return membersPane(redraw);
  if (tab === 'project') {
    const p = st.project;
    if (!p.init) return [h('div', { class: 'set-title' }, L('项目', '设置')), h('div', { class: 'empty-note' }, T`这个文件夹还没接入`)];
    const mark = savedMark();
    const gate = h('input', { class: 'input mono', value: p.config.gate, placeholder: T`例如 npm test`, 'aria-label': T`检查命令` });
    const tags = [...p.config.protectedPaths];
    const tagBox = h('div', { class: 'tags' });
    const saveCfg = async () => {
      try {
        await api('/api/config/save', { config: { gate: { command: gate.value.trim() }, protectedPaths: tags } });
        mark.flash();
        await refresh();
      } catch (e) {
        fail(T`保存设置`, e);
      }
    };
    const tagInput = h('input', {
      type: 'text',
      placeholder: tags.length ? '' : T`文件或文件夹，例如 .env、secrets/`,
      'aria-label': T`不许改的文件`,
      onkeydown: (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if ((e.key === 'Enter' || e.key === ',') && tagInput.value.trim()) {
          e.preventDefault();
          tags.push(tagInput.value.trim());
          tagInput.value = '';
          drawTags();
          saveCfg();
        } else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
          tags.pop();
          drawTags();
          saveCfg();
        }
      },
    });
    const drawTags = () => {
      tagInput.placeholder = tags.length ? '' : T`文件或文件夹，例如 .env、secrets/`;
      tagBox.replaceChildren(
        ...tags.map((t, i) =>
          h(
            'span',
            { class: 'chip' },
            t,
            h(
              'button',
              {
                class: 'x',
                'aria-label': T`去掉 ${t}`,
                onclick: () => {
                  tags.splice(i, 1);
                  drawTags();
                  saveCfg();
                },
              },
              icon('x')
            )
          )
        ),
        tagInput
      );
    };
    drawTags();
    gate.addEventListener('keydown', (e) => e.key === 'Enter' && gate.blur());
    gate.addEventListener('change', saveCfg);
    return [
      h('div', { class: 'set-title' }, L('项目', '设置'), mark.el),
      setField(T`检查命令`, T`每一棒结束后在项目文件夹里跑一遍，确认没改坏（比如跑测试）。没通过就不算完成。`, gate, gateResult(p)),
      setField(T`不许改的文件`, T`写进给每位 AI 的接力规矩。哪一棒改到了，会标在那一棒上。`, tagBox),
      p.protocol === 'ok'
        ? null
        : setRow(
            p.protocol === 'old' ? T`接力规矩有新版本` : T`接力规矩不见了`,
            T`项目里的 AGENTS.md、CLAUDE.md 里写给各家 AI 的那一段。`,
            h('button', { class: 'btn small primary', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), T`已更新`).then(redraw) }, T`更新`)
          ),
    ];
  }
  if (tab === 'relay') {
    const s = st.settings;
    const mark = savedMark();
    // 原地改好再存：开关的圆钮、分段的滑块是滑过去的，存的时候不重画这一页；存失败再按接力台的重画回来
    const save = async (patch) => {
      Object.assign(s, patch);
      try {
        const r = await api('/api/settings', { settings: { ...S.st.settings, ...patch } });
        S.st.settings = r.settings;
        mark.flash();
      } catch (e) {
        fail(T`保存设置`, e);
        redraw();
      }
    };
    const stepper = (key, lo, hi, unit, step = 1) => {
      const input = h('input', { type: 'number', min: String(lo), max: String(hi), value: String(s[key]), 'aria-label': unit });
      const set = (v) => {
        const n = clamp(Math.round(Number(v) || s[key]), lo, hi);
        if (String(n) !== input.value) {
          input.value = String(n);
          if (!still()) input.animate([{ opacity: 0.3, transform: `translateY(${n > s[key] ? 5 : -5}px)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE.snap });
        }
        if (n !== s[key]) save({ [key]: n });
      };
      input.addEventListener('change', () => set(input.value));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      return h(
        'span',
        { class: 'stepper' },
        h('button', { 'aria-label': T`减少`, onclick: () => set(Number(input.value) - step) }, icon('minus')),
        input,
        h('button', { 'aria-label': T`增加`, onclick: () => set(Number(input.value) + step) }, icon('plus')),
        h('span', { class: 'u' }, unit)
      );
    };
    const sw = (key, label) => {
      const b = h('button', {
        class: 'switch',
        role: 'switch',
        'aria-checked': String(!!s[key]),
        'aria-label': label,
        onclick: () => {
          b.setAttribute('aria-checked', String(!s[key]));
          save({ [key]: !s[key] });
        },
      }, h('span', { class: 'track' }));
      return b;
    };
    const levelBtn = (lv, label) =>
      h(
        'button',
        {
          'data-lv': lv,
          'aria-pressed': String(s.level === lv),
          onclick: async () => {
            if (s.level === lv) return;
            if (lv === 'full' && !(await confirmSheet(T`不限制 AI 的权限？`, LEVEL_DESC.full, T`不限制`))) return;
            for (const b of level.querySelectorAll(':scope > button')) b.setAttribute('aria-pressed', String(b.dataset.lv === lv));
            syncSegs(level.parentNode);
            swapText(levelRow.desc, LEVEL_DESC[lv]);
            save({ level: lv });
          },
        },
        label
      );
    const level = h('div', { class: 'seg', role: 'group', 'aria-label': T`AI 的权限` });
    level.append(levelBtn('safe', T`只在项目里`), levelBtn('full', T`不限制`));
    const levelRow = setRow(T`AI 的权限`, LEVEL_DESC[s.level], level);
    return [
      h('div', { class: 'set-title' }, T`运行`, mark.el),
      setSec(T`权限`),
      levelRow,
      setSec(T`时限`),
      setRow(T`每一棒最长`, T`一位 AI 接着做一段叫一棒。到时间还没交接就停下，算作出错。`, stepper('stintTimeoutMin', 1, 600, T`分钟`, 5)),
      setRow(T`复核、终审最长`, T`强模型检查别人做的活，到时间就停下。`, stepper('reviewTimeoutMin', 1, 240, T`分钟`, 5)),
      setSec(T`全自动`),
      setRow(T`最多接力`, T`接满这么多棒就停下，不会一直做下去。`, stepper('maxStints', 1, 100, T`棒`)),
      setRow(T`额度用完时等恢复`, T`所有 AI 的额度都用完时，等最早恢复的那一位接着做；关掉就直接停下。`, sw('waitForQuota', T`额度用完时等恢复`)),
      setRow(T`做完后终审`, T`清单全部打勾后，请强模型把整件事从头过一遍，通过了才算完成。`, sw('finalReview', T`做完后终审`)),
    ];
  }
  const theme = store.get('theme') || '';
  const setTheme = (t) => {
    store.set('theme', t);
    const apply = () => {
      if (t) document.documentElement.dataset.theme = t;
      else delete document.documentElement.dataset.theme;
    };
    // 换浅色、深色：整页淡入淡出，不是一下子跳过去
    if (document.startViewTransition && !still()) document.startViewTransition(apply);
    else apply();
  };
  const look = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': T`外观` },
    [
      ['', T`跟随系统`],
      ['light', T`浅色`],
      ['dark', T`深色`],
    ].map(([k, label]) =>
      h(
        'button',
        {
          'data-k': k,
          'aria-pressed': String(theme === k),
          onclick: (e) => {
            for (const b of look.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            syncSegs(look.parentNode);
            setTheme(k);
          },
        },
        label
      )
    )
  );
  return [
    h('div', { class: 'set-title' }, T`通用`),
    setRow(T`语言`, null, langSeg()),
    setRow(T`外观`, null, look),
    setRow(
      T`关闭接力台`,
      T`正在做的会先停下、记好账。下次打开「接力台」时自己启动。`,
      h(
        'button',
        {
          class: 'btn small',
          onclick: async (e) => {
            const b = e.currentTarget;
            if (!(await confirmSheet(T`关闭接力台？`, T`正在进行的调度会停止。`, T`关闭`))) return;
            b.disabled = true;
            try {
              await api('/api/quit', {});
            } catch (err) {
              // 接力台先回话再退出；回话前就断了也算关上了
              if (!(err instanceof TypeError)) {
                b.disabled = false;
                return fail(T`关闭接力台`, err);
              }
            }
            S.closed = true;
            for (const close of [...sheetStack].reverse()) close();
            setOffline(true);
          },
        },
        icon('power'),
        T`关闭`
      )
    ),
  ];
}

/** 检查命令底下一行：最近一次跑的结果、是哪一棒之后跑的（验收看的就是它）。 */
function gateResult(p) {
  const g = p.acceptance && p.acceptance.gate;
  if (!g || g.status === 'off') return null;
  const after = g.stint ? T` · 第 ${g.stint} 棒之后` : '';
  if (g.status === 'pass') return h('small', { class: 'res' }, icon('check'), T`上次通过${after}`);
  if (g.status === 'fail') return h('small', { class: 'res bad' }, h('span', { class: 'rd' }), T`上次没通过${after}`);
  if (g.status === 'error') return h('small', { class: 'res bad', 'data-tip': tr(g.text) }, h('span', { class: 'rd' }), T`上次没跑成${after}`);
  return h('small', { class: 'res' }, g.status === 'none' ? T`还没跑过` : tr(g.text));
}

/** 一行字换成另一句：旧的淡出、新的淡进来。 */
function swapText(el, text) {
  if (!el || el.textContent === text) return;
  if (still()) return (el.textContent = text);
  el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: EASE.exit }).onfinish = () => {
    el.textContent = text;
    el.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE.ease });
  };
}

function membersPane(redraw) {
  const st = S.st;
  const all = members();
  const drivable = all.filter((m) => m.canWork).map((m) => m.name);
  const list = h('div', { class: 'members' });
  let dragName = null;
  for (const m of all) {
    const name = memberName(m);
    const canDrag = drivable.includes(m.name);
    const look = h('span', { class: 'mt' }, tile(m, 's28', m.cooling ? 'cooling' : ''));
    const seg = h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': T`${name} 强弱` },
      ['strong', 'weak'].map((t) => h('button', { 'data-t': t, 'aria-pressed': String(m.tier === t), onclick: () => m.tier !== t && setTier(t) }, t === 'strong' ? T`强` : T`弱`))
    );
    const paint = (t) => {
      for (const b of seg.querySelectorAll(':scope > button')) b.setAttribute('aria-pressed', String(b.dataset.t === t));
      syncSegs(seg);
      look.replaceChildren(tile({ ...m, tier: t }, 's28', m.cooling ? 'cooling' : ''));
    };
    // 强弱：滑块先滑过去、图标先换颜色，存好了再按接力台算出来的对一遍（改回自动时由它按模型定）
    const setTier = async (t) => {
      if (t !== 'auto') paint(t);
      const r = await act(null, () => api('/api/members/tier', { name: m.name, tier: t }));
      Object.assign(m, (r && r.members.find((x) => x.name === m.name)) || {});
      paint(m.tier);
    };
    const note = memberNote(m);
    const row = h(
      'div',
      {
        class: 'member',
        'data-name': m.name,
        draggable: canDrag ? 'true' : null,
        oncontextmenu: (e) => ctx(e, [m.tierSet ? { label: T`强弱改回自动`, icon: 'sync', run: () => setTier('auto') } : null, { label: T`删除`, icon: 'trash', run: () => removeMember(m, row) }]),
        ondragstart: (e) => {
          dragName = m.name;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', m.name);
          row.classList.add('dragging');
        },
        ondragend: () => row.classList.remove('dragging'),
        ondragover: (e) => {
          if (!dragName || !canDrag || dragName === m.name) return;
          e.preventDefault();
          row.classList.add('drag-over');
        },
        ondragleave: () => row.classList.remove('drag-over'),
        ondrop: async (e) => {
          row.classList.remove('drag-over');
          if (!dragName || dragName === m.name) return;
          e.preventDefault();
          const order = drivable.filter((n) => n !== dragName);
          order.splice(order.indexOf(m.name), 0, dragName);
          dragName = null;
          const r = await act(null, () => api('/api/settings', { settings: { ...S.st.settings, order } }));
          // 按存好的顺序把行挪过去：还在的从原来的位置滑过去
          if (r) flip(list, () => r.members.forEach((x) => list.querySelector(`[data-name="${CSS.escape(x.name)}"]`) && list.append(list.querySelector(`[data-name="${CSS.escape(x.name)}"]`))));
        },
      },
      h('span', { class: `handle${canDrag ? '' : ' off'}`, 'aria-hidden': 'true' }, icon('grip')),
      look,
      h('div', { class: 'mn' }, h('b', null, name), note ? h('small', { 'data-tip': tr(m.update || (!m.canWork && m.why ? m.why : null)) || limitsTip(m) }, note) : null),
      seg,
      h('button', { class: 'icon-btn del', 'aria-label': T`删除 ${name}`, 'data-tip': T`删除`, onclick: () => removeMember(m, row) }, icon('trash'))
    );
    list.append(row);
  }
  if (!all.length) list.append(h('div', { class: 'empty-note' }, T`名单是空的`));
  const consent = h('div');
  const fillConsent = (want) =>
    consent.replaceChildren(
      ...want.map((p) =>
        h(
          'div',
          { class: 'consent' },
          icon('warn'),
          h('span', { class: 'grow' }, `${llmName(p.model) || p.label}${p.model ? ` · ${p.label}` : ''}`),
          h('button', { class: 'btn small primary', onclick: (e) => act(e.currentTarget, () => api('/api/detect/use', { id: p.id }), T`已加入`).then(() => ((consentCache = null), redraw())) }, T`同意使用`)
        )
      )
    );
  if (consentCache) fillConsent(consentCache);
  else
    api('/api/detect')
      .then((d) => {
        const used = new Set(members().map((m) => m.agent && m.agent.api && m.agent.api.keyFrom).filter(Boolean));
        consentCache = ((d.report && d.report.providers) || []).filter((p) => p.needsConsent && !used.has(p.keyFrom));
        fillConsent(consentCache);
      })
      .catch(() => null);
  return [
    h(
      'div',
      { class: 'set-title' },
      T`成员`,
      h('span', { class: 'sp' }),
      h(
        'button',
        {
          class: `btn small${st.detecting ? ' busy' : ''}`,
          onclick: (e) =>
            act(e.currentTarget, () => api('/api/detect', {}), (r) => (r.changes.length ? T`名单更新了 ${r.changes.length} 处` : T`名单没有变化`)).then(() => {
              consentCache = null;
              redraw();
            }),
        },
        icon('sync'),
        T`重新识别`
      ),
      h(
        'button',
        {
          class: 'btn small',
          'aria-haspopup': 'menu',
          onclick: (e) =>
            openMenu(
              e.currentTarget,
              [
                { label: T`接口`, icon: 'plus', run: () => addApiSheet(redraw) },
                { label: T`桌面程序`, icon: 'plus', run: () => addAppSheet(redraw) },
              ],
              { align: 'end' }
            ),
        },
        icon('plus'),
        T`添加`
      )
    ),
    h('p', { class: 'set-desc' }, T`弱模型做的每一棒都要强模型复核。派活按这个顺序，额度用完的跳过。`),
    list,
    consent,
  ];
}

/** 接力台对这个工具实测到什么程度：都实测过的不写。 */
const TESTED_WORD = { partial: T`部分实测`, no: T`没实测` };

/** 成员名字底下一行：在哪个工具里跑（名字就是工具名时不重复写）、实测到什么程度、现在能不能用。 */
function memberNote(m) {
  const name = memberName(m);
  const tool = m.kind === 'app' ? (m.tool && m.tool !== name ? T`${m.tool} 桌面版` : T`桌面程序`) : m.tool && m.tool !== name ? tr(m.tool) : '';
  const state = m.cooling ? T`额度用完 · ${tr(m.coolingText)}` : !m.canWork && m.kind !== 'app' ? T`不可调度` : limitsText(m);
  return [tool, TESTED_WORD[m.tested], state, m.update ? T`命令行需要更新` : ''].filter(Boolean).join(' · ');
}

const LIMIT_WORD = { '5h': T`5 小时`, '7d': T`一周`, '7d-opus': 'Opus' };

/** 工具自己报的额度：「5 小时 5% · 一周 72%」；没报过就是空的。 */
function limitsText(m) {
  return (m.limits || []).map((w) => `${LIMIT_WORD[w.kind] || w.kind} ${Math.round(w.used)}%`).join(' · ');
}

/** 悬停看几点恢复：「5 小时 21:40 恢复 · 一周 周五 09:00 恢复」。 */
function limitsTip(m) {
  return (m.limits || []).filter((w) => w.resetsAt).map((w) => T`${LIMIT_WORD[w.kind] || w.kind} ${aheadClock(w.resetsAt)} 恢复`).join(' · ') || null;
}

/** 将来的时间：今天写几点，明天写「明天 00:30」，一周内写星期，再远写日期。 */
function aheadClock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.round((day(d) - day(new Date())) / 86400000);
  const pre = n <= 0 ? '' : n === 1 ? T`明天 ` : n < 7 ? `${[T`周日`, T`周一`, T`周二`, T`周三`, T`周四`, T`周五`, T`周六`][d.getDay()]} ` : T`${d.getMonth() + 1}月${d.getDate()}日 `;
  return pre + clock(ts);
}

/** 删掉一位：它那一行淡出，下面的行滑上来补位。 */
async function removeMember(m, row) {
  const name = memberName(m);
  if (!(await confirmSheet(T`删除 ${name}？`, T`它自己的程序不受影响；重新识别也不会再加回来。`, T`删除`))) return;
  const r = await act(null, () => api('/api/workers/delete', { name: m.name }), T`已删除 ${name}`);
  if (!r || !row.isConnected) return;
  row.classList.add('going');
  setTimeout(() => {
    const list = row.parentNode;
    if (!list) return;
    flip(list, () => row.remove());
    // 少了一位，别的名字可能变了（两位同一个模型时名字后面带的工具不用再写了）
    for (const el of list.children) {
      const x = memberByName(el.dataset.name);
      const b = x && el.querySelector('.mn b');
      if (b) b.textContent = memberName(x);
    }
  }, still() ? 0 : 180);
}

function field(label, input) {
  return h('label', { class: 'field' }, h('span', null, label), input);
}

/** 添加成员的弹窗：几个输入框加强弱，点「添加」存进名单。 */
function addSheet(title, inputs, agentOf, redraw) {
  let tier = 'weak';
  const seg = h(
    'div',
    { class: 'seg' },
    ['strong', 'weak'].map((t) =>
      h(
        'button',
        {
          'aria-pressed': String(tier === t),
          'data-t': t,
          onclick: () => {
            tier = t;
            for (const b of seg.querySelectorAll(':scope > button')) b.setAttribute('aria-pressed', String(b.dataset.t === tier));
            syncSegs(layer);
          },
        },
        t === 'strong' ? T`强` : T`弱`
      )
    )
  );
  const close = sheet({
    title,
    body: h('div', null, inputs.map(([label, input]) => field(label, input)), h('div', { class: 'field' }, h('span', null, T`强弱`), seg)),
    foot: [
      h('button', { class: 'btn ghost', onclick: () => close() }, T`取消`),
      h('button', { class: 'btn primary', onclick: (e) => act(e.currentTarget, () => api('/api/workers/save', { agent: { ...agentOf(), tier, tierSet: true } }), T`已添加`).then((r) => r && (close(), redraw())) }, T`添加`),
    ],
  });
  syncSegs(layer);
}

function addApiSheet(redraw) {
  const [name, label, base, model, env] = [['kimi'], ['Kimi'], ['https://api.moonshot.cn/v1', 'mono'], ['kimi-k2', 'mono'], ['MOONSHOT_API_KEY', 'mono']].map(([ph, mono]) => h('input', { class: `input ${mono || ''}`.trim(), placeholder: ph }));
  addSheet(
    T`添加接口`,
    [
      [T`名字`, name],
      [T`显示名`, label],
      [T`接口地址`, base],
      [T`模型`, model],
      [T`密钥环境变量`, env],
    ],
    () => ({ name: name.value.trim(), label: label.value.trim() || undefined, kind: 'api', api: { baseUrl: base.value.trim(), model: model.value.trim(), apiKeyEnv: env.value.trim() } }),
    redraw
  );
}

function addAppSheet(redraw) {
  const name = h('input', { class: 'input', placeholder: 'trae' });
  const app = h('input', { class: 'input', placeholder: 'Trae' });
  addSheet(
    T`添加桌面程序`,
    [
      [T`名字`, name],
      [T`程序`, app],
    ],
    () => {
      const a = app.value.trim();
      return { name: name.value.trim(), label: a, kind: 'app', cmd: `open -a ${/\s/.test(a) ? `"${a}"` : a} {{dir}}` };
    },
    redraw
  );
}

// ---------- 搜索（⌘K） ----------

const PAL = { el: null };

/** 模糊匹配：按顺序出现就算，连着的、在开头的分高。返回分数和命中的位置。 */
function fuzzy(text, qy) {
  if (!qy) return { score: 1, hits: [] };
  const t = text.toLowerCase();
  const idx = t.indexOf(qy);
  if (idx >= 0) return { score: 100 - idx + (idx === 0 ? 50 : 0), hits: [...Array(qy.length).keys()].map((i) => idx + i) };
  const hits = [];
  let j = 0;
  for (let i = 0; i < t.length && j < qy.length; i++) if (t[i] === qy[j]) hits.push(i), j++;
  if (j < qy.length) return null;
  return { score: 40 - (hits[hits.length - 1] - hits[0]), hits };
}

function marked(text, hits) {
  if (!hits.length) return esc(text);
  const set = new Set(hits);
  return [...text].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join('');
}

function paletteItems(query, scope) {
  const qy = query.trim().toLowerCase();
  const p = S.st.project;
  const run = runState();
  const groups = [];
  const pick = (list, label, n) => {
    const scored = [];
    for (const it of list) {
      const m = fuzzy(it.label, qy) || (qy && it.alt && it.alt.toLowerCase().includes(qy) ? { score: 10, hits: [] } : null);
      if (m) scored.push({ ...it, score: m.score, hits: m.hits });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length) groups.push({ label, items: scored.slice(0, n) });
  };
  if (scope !== 'files') {
    const cmds = [
      ...[
        ['relay', T`接力`, 'route'],
        ['dispatch', T`派活`, 'list'],
        ['chat', T`群聊`, 'chat'],
      ]
        .filter(([v]) => v !== S.view)
        .map(([v, label, ic]) => ({ label, icon: ic, run: () => setView(v) })),
      p.pick ? null : { label: T`新任务`, icon: 'plus', run: newThread },
      p.pick ? null : { label: T`新群聊`, icon: 'plus', run: newChat },
      p.init && !p.task.empty && !run.running && ready().length ? { label: T`接着做`, icon: 'play', run: goDefault } : null,
      ...(p.init && !p.task.empty && !run.running && ready().length && !accepted() ? [pageOf(threads().at(-1)) === 'dispatch' ? T`派活` : T`全自动`] : []).map((word) => ({ label: word, icon: 'bolt', run: () => act(null, () => startWork('/api/auto', {}), T`已开始${word}`) })),
      p.pending.length && reviewer() ? { label: T`复核`, icon: 'review', run: reviewNow } : null,
      run.running || run.waiting ? { label: T`停止`, icon: 'stop', kbd: '⌘.', run: stopNow } : null,
      p.init ? { label: T`编辑任务`, icon: 'pencil', run: editTaskRaw } : null,
      p.init ? { label: T`接力本`, sub: SUB.brief, icon: 'book', run: openBrief } : null,
      p.init ? { label: T`对账`, sub: SUB.snap, icon: 'sync', run: snapNow } : null,
      { label: T`打开文件夹`, icon: 'folder', run: chooseFolder },
      p.pick ? null : { label: REVEAL, icon: 'folder', run: () => reveal('') },
      p.pick ? null : { label: T`复制开场白`, sub: SUB.hint, icon: 'copy', run: copyHint },
      { label: T`成员`, icon: 'user', run: () => openSettings('members') },
      { label: T`设置`, icon: 'sliders', run: () => openSettings() },
      { label: UI.noLeft ? T`显示左栏` : T`隐藏左栏`, icon: 'sideL', kbd: '⌘B', run: toggleLeft },
      { label: UI.noRight ? T`显示右栏` : T`隐藏右栏`, icon: 'sideR', kbd: '⌥⌘B', run: toggleRight },
      { label: LANG.zh ? 'English' : '中文', alt: 'language 语言 english 中文', icon: 'sync', run: () => switchLang(LANG.zh ? 'en' : 'zh') },
    ].filter(Boolean);
    pick(cmds, T`操作`, qy ? 6 : 8);
    if (p.init && !p.task.empty) pick(ready().map((m) => ({ label: T`派给 ${memberName(m)}`, alt: `${m.name} ${m.tool || ''}`, tile: tile(m, 's20'), sub: m.tool || '', run: () => goWith(null, m) })), T`成员`, 5);
    pick([...threads()].reverse().filter((t) => !blank(t)).map((t) => ({ label: t.title || T`未命名`, icon: pageOf(t) === 'dispatch' ? 'list' : 'route', sub: when(lastActive(t)), run: () => selectThread(t) })), T`任务`, 6);
    const chats = [talkHas(S.talk) ? { id: null, title: talkTitle(S.talk) || T`群聊`, at: talkAt(S.talk) } : null, ...(S.talk.sessions || [])].filter(Boolean);
    pick(chats.map((x) => ({ label: x.title, icon: 'chat', sub: x.at ? when(x.at) : '', run: () => selectChat(x.id) })), T`群聊`, 6);
    pick(S.st.projects.filter((x) => !x.current).map((x) => ({ label: x.name, icon: 'folder', sub: tildify(x.root), alt: x.root, run: () => switchProject(x.root) })), T`项目`, 5);
  }
  if (qy || scope === 'files') {
    const files = ((S.tree && S.tree.files) || []).map((f) => ({ label: basename(f), alt: f, sub: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', icon: 'file', run: () => openFile(f) }));
    pick(files, T`文件`, scope === 'files' ? 40 : 10);
  }
  // 输入的正好是一个文件名：文件排在最前面
  const fg = groups.find((g) => g.label === T`文件`);
  if (fg && fg.items.some((it) => it.label.toLowerCase() === qy)) groups.unshift(...groups.splice(groups.indexOf(fg), 1));
  return groups;
}

function openPalette(initial = '', scope = '') {
  if (!S.st) return;
  closeMenus();
  if (PAL.el) return PAL.input.focus();
  const input = h('input', { type: 'text', value: initial, placeholder: scope === 'files' ? T`文件名` : T`搜索`, 'aria-label': T`搜索` });
  const list = h('div', { class: 'plist', role: 'listbox' });
  const scrim = h('div', { class: 'scrim', onclick: () => close() });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-label': T`搜索` }, h('div', { class: 'pin' }, icon('search'), input), list);
  let flat = [];
  let hot = 0;
  const close = () => {
    leave(scrim);
    leave(box);
    PAL.el = null;
    PAL.close = null;
  };
  const choose = (it) => {
    close();
    it.run();
  };
  const draw = () => {
    const groups = paletteItems(input.value, scope);
    flat = groups.flatMap((g) => g.items);
    hot = clamp(hot, 0, Math.max(0, flat.length - 1));
    let k = 0;
    list.replaceChildren(
      ...groups.flatMap((g) => [
        h('div', { class: 'mh' }, g.label),
        ...g.items.map((it) => {
          const i = k++;
          return h(
            'button',
            { class: `mi${i === hot ? ' hot' : ''}`, role: 'option', 'aria-selected': String(i === hot), tabindex: '-1', onmousemove: () => i !== hot && ((hot = i), paint()), onclick: () => choose(it) },
            it.tile || icon(it.icon),
            h('span', { class: 't', html: marked(it.label, it.hits || []) }),
            it.sub ? h('span', { class: 'sub' }, it.sub) : null,
            it.kbd ? h('kbd', null, keys(it.kbd)) : null
          );
        }),
      ])
    );
    if (!flat.length) list.append(h('div', { class: 'none' }, T`没有结果`));
  };
  const paint = () => {
    [...list.querySelectorAll('.mi')].forEach((b, i) => {
      b.classList.toggle('hot', i === hot);
      b.setAttribute('aria-selected', String(i === hot));
    });
    list.querySelectorAll('.mi')[hot]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    hot = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      hot = (hot + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[hot]) choose(flat[hot]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  layer.append(scrim, box);
  PAL.el = box;
  PAL.input = input;
  PAL.close = close;
  draw();
  input.focus();
  input.select();
}

// ---------- 快捷键 ----------

function typing() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio'].includes(a.type)) || a.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.code === 'KeyK') {
    e.preventDefault();
    openPalette();
  } else if (mod && e.code === 'KeyP') {
    e.preventDefault();
    openPalette('', 'files');
  } else if (mod && e.code === 'KeyB') {
    e.preventDefault();
    if (e.altKey) toggleRight();
    else toggleLeft();
  } else if (mod && e.key === '.') {
    e.preventDefault();
    stopNow();
  } else if (e.key === 'Escape') {
    if (layer.querySelector('.menu:not(.leave)')) closeMenus();
    else if (PAL.close) PAL.close();
    else if (sheetStack.length) sheetStack[sheetStack.length - 1]();
    else if (app.classList.contains('drawer-left') || app.classList.contains('drawer-right')) closeDrawers();
    else if (S.tab !== 0 && !typing() && !sheetStack.length) {
      S.tab = 0;
      renderCenter();
    }
  } else if (e.key === '/' && !mod && !typing() && !sheetStack.length && !PAL.el) {
    e.preventDefault();
    focusComposer();
    if (C.wrap.isConnected && !C.ta.value) {
      C.ta.value = '/';
      onComposerInput();
    }
  }
});

// 每秒走一下：进行中的计时。页面在后台时不走。
setInterval(() => {
  if (document.hidden) return;
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = elapsed(el.dataset.since);
}, 1000);

// 窗口拉宽拉窄过了 1180px：右栏跟着自己收放（和点按钮一样滑、扫一道点）
mqMid.addEventListener('change', () => {
  UI.peek = false;
  if (!fitRight() || narrow()) return;
  applyLayout();
  sideSweep('right', !UI.noRight);
  wireTo(null);
  renderAll();
});

mqNarrow.addEventListener('change', () => {
  closeDrawers();
  barSig = '';
  heroSig = '';
  renderAll();
});

// 开关原地拨过去了（重画出来的新开关不算）：墨点铺满或散掉
new MutationObserver((recs) => {
  for (const r of recs) if (r.target.classList.contains('switch') && r.oldValue !== r.target.getAttribute('aria-checked')) switchSpecks(r.target);
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-checked'], attributeOldValue: true });

addEventListener('resize', () => {
  if (SUG.menu) updateSuggest();
  if (WIRE.from) drawWires();
  syncSegs();
});
// 纸：这一栏大小变了换画布重画，换了浅色 / 深色换颜色重画
new ResizeObserver(() => (paperSize(), paperHolesSoon())).observe($('#center'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paperInk);
new MutationObserver(paperInk).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---------- 语言 ----------

/** 按钮上写的是另一种语言的名字（中文界面写 EN，英文界面写「中」），点一下就换。 */
function langBtn() {
  const to = LANG.zh ? 'en' : 'zh';
  return h('button', { class: 'lang-btn', lang: to === 'zh' ? 'zh-CN' : 'en', 'aria-label': to === 'zh' ? '中文' : 'English', 'data-tip': to === 'zh' ? '中文' : 'English', onclick: () => switchLang(to) }, to === 'zh' ? '中' : 'EN');
}

function langSeg() {
  const seg = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': T`语言` },
    [
      ['zh', '中文'],
      ['en', 'English'],
    ].map(([k, label]) =>
      h(
        'button',
        {
          lang: k === 'zh' ? 'zh-CN' : 'en',
          'aria-pressed': String(LANG.now === k),
          onclick: (e) => {
            for (const b of seg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            syncSegs(seg.parentNode);
            setTimeout(() => switchLang(k), still() ? 0 : 220);
          },
        },
        label
      )
    )
  );
  return seg;
}

/**
 * 换语言：界面上的字都是画的时候取的，最稳的是整页重新载入一次。先记下正在看的（哪段对话、打开的页签、
 * 展开的卡片、滚到哪、设置开在哪一页）和输入框里的字，整页淡出；载入后照原样摆好再淡进来（i18n.js 里先藏着）。
 */
function switchLang(to) {
  if (to === LANG.now) return;
  try {
    localStorage.setItem('relay.lang', to);
    if (C.ta && S.dir) store.set(`draft:${S.dir}`, C.ta.value);
    const t = S.st && centerMode() === 'thread' ? selectedThread() : null;
    sessionStorage.setItem(
      'relay.carry',
      JSON.stringify({ thread: S.thread, draft: S.draft, chat: S.chat, tabs: S.tabs, tab: S.tab, open: [...S.open], scroll: t ? CE.scroll.scrollTop : null, stick, settings: layer.querySelector('.settings') ? settingsTab : null })
    );
  } catch (e) {
    return fail(T`换语言`, e);
  }
  document.documentElement.classList.add('lang-out');
  // 接力台那边也记一下：英文时请 AI 用英文写交接、复核和回答
  const told = syncLang(to);
  Promise.race([told, new Promise((r) => setTimeout(r, still() ? 0 : 200))]).then(() => setTimeout(() => location.reload(), 0));
}

/** 网页的语言告诉接力台（存在运行设置里）；和记下的一样就不发。 */
function syncLang(lang = LANG.now) {
  const cur = S.st && S.st.settings;
  if (!cur || cur.lang === lang) return Promise.resolve();
  return api('/api/settings', { settings: { ...cur, lang } }).catch(() => {});
}

/** 换语言之后第一次画好：摆回原样，淡进来。 */
function carryBack() {
  let c = null;
  try {
    c = JSON.parse(sessionStorage.getItem('relay.carry') || 'null');
    sessionStorage.removeItem('relay.carry');
  } catch {
    /* 拿不到就从头看 */
  }
  if (c && S.st) {
    Object.assign(S, { thread: c.thread ?? null, draft: !!c.draft, chat: c.chat ?? null, tabs: Array.isArray(c.tabs) ? c.tabs : [], tab: Number(c.tab) || 0, open: new Set(c.open || []) });
    if (S.tab >= S.tabs.length + 1) S.tab = 0;
    renderAll();
    if (c.scroll !== null && !c.stick) CE.scroll.scrollTop = c.scroll;
    else scrollBottom();
    if (c.settings) openSettings(c.settings);
  }
  requestAnimationFrame(() => document.documentElement.classList.remove('lang-in'));
}

// ---------- 开始 ----------

function renderAll() {
  if (!S.st) return;
  refreshLooks();
  renderLeft();
  renderCenter();
  renderRight();
  if (S.swap) {
    swapIn(S.swap);
    paperSweep(S.swap);
    S.swap = 0;
  }
}

(async function start() {
  $('#left').setAttribute('aria-label', T`项目和对话`);
  $('#right').setAttribute('aria-label', T`项目文件`);
  applyLayout();
  buildCenter();
  buildComposer();
  paperInk();
  buildRight();
  await refresh();
  if (S.st) S.treeOpen = new Set(store.json(`open:${S.st.project.root}`, []));
  await Promise.all([loadTalk(), loadTree()]);
  stintsKey = S.st ? S.st.project.stints.map((s) => `${s.id}${s.status}${s.endedAt || ''}`).join() : '';
  scrollBottom();
  carryBack();
  syncLang();
  schedule();
})();
