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

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 缓动，和 app.css 的 --snap / --exit / --spring 同一套（弹簧是 CSS 的 linear()，不支持的浏览器退回贝塞尔）。 */
const EASE = (() => {
  const css = getComputedStyle(document.documentElement);
  const v = (k, d) => css.getPropertyValue(k).trim() || d;
  return { snap: v('--snap', 'cubic-bezier(.16,1,.3,1)'), exit: v('--exit', 'cubic-bezier(.4,0,1,1)'), spring: v('--spring', 'cubic-bezier(.2,.7,.2,1)') };
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

/** 分段按钮：选中的那一块滑到按下的按钮下面。 */
function syncSegs(root = document) {
  for (const seg of root.querySelectorAll('.seg')) {
    const on = seg.querySelector('[aria-pressed="true"]');
    if (!on || !on.offsetWidth) continue;
    seg.style.setProperty('--tx', `${on.offsetLeft - 2}px`);
    seg.style.setProperty('--tw', `${on.offsetWidth}px`);
    if (!seg.classList.contains('ready')) requestAnimationFrame(() => seg.classList.add('ready'));
  }
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
  if (sameDay(d, y)) return '昨天';
  if (now - d < 6 * 86400000) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日`;
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
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
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

const basename = (p) => String(p).split('/').pop();

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
  if (!text.includes(' · ')) return text || llmName(model);
  const [tool, m] = splitLabel(text);
  return llmName(m || model) || tool;
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
  view: store.get('view') === 'chat' ? 'chat' : 'relay',
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
  noRight: store.get('noRight') === '1',
};

const app = $('#app');
const layer = $('#layer');
const mqNarrow = matchMedia('(max-width: 860px)');
const narrow = () => mqNarrow.matches;

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
    throw new Error(`接力台返回了看不懂的内容（${res.status}）`);
  }
  if (!j.ok) throw Object.assign(new Error(j.error || '出错'), { code: j.code });
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

/** 按钮点下去：请求期间转圈，出错弹提示，做完刷新。 */
/** 失败的提示：「没能 X：原因」（原因去掉句末的句号）。说法见 docs/设计说明.md「结果怎么说」。 */
function fail(what, e) {
  const why = String((e && e.message) || e || '').trim().replace(/[。.]+$/, '');
  toast(what ? `没能${what}：${why || '出错'}` : why || '出错', { bad: true });
}

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
    if (e.code !== 'cancelled') fail(typeof okText === 'string' && okText.startsWith('已') ? okText.slice(1) : '', e);
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

/** 名单变了才重算：认不出来的成员各给一个几何图形，不重样、不跳来跳去。 */
function refreshLooks() {
  const ms = members();
  const key = ms.map((m) => `${m.name}=${m.label}=${m.model || ''}=${m.tier}`).join('|');
  if (key === looks.key) return;
  const shape = new Map();
  const used = new Set();
  for (const m of [...ms].sort((a, b) => a.name.localeCompare(b.name))) {
    if (brandOf(toolText(m.name, m.label, m.agent), m.model)) continue;
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
  return { brand: brand || (name && looks.shape.get(name)) || SHAPES[hashStr(name || label) % SHAPES.length], tier };
}

function glyph(key) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'g');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = GLYPHS[key] || GLYPHS.unknown;
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

const TIER_WORD = { strong: '强模型', weak: '弱模型' };

function memberTip(m) {
  return [memberName(m), [m.tool, TIER_WORD[m.tier]].filter(Boolean).join(' · '), m.cooling ? `额度用完 · ${m.coolingText}` : ''].filter(Boolean).join('\n');
}

/** 一棒是谁做的：模型的名字，下面一行在哪个工具里、强弱。 */
function whoTip(who) {
  if (!who.label || who.label === '不知道是谁') return '身份不明';
  const name = nameOf(who.label, who.model);
  const tool = splitLabel(who.label)[0];
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
  tipEl = h('div', { class: 'tip', role: 'tooltip' }, t.dataset.tip, t.dataset.kbd ? h('kbd', null, t.dataset.kbd) : null);
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
    box.append(h('div', { class: 'sheet-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': '关闭', onclick: close }, icon('x'))));
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
        h('button', { class: 'btn ghost', onclick: () => close() }, '取消'),
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
  return copyText(text).then((ok) => toast(ok ? '已复制' : '没能复制', { bad: !ok }));
}

// ---------- 布局：三栏、拖动改宽度、收起 ----------

function applyLayout() {
  app.style.setProperty('--left', `${UI.left}px`);
  app.style.setProperty('--right', `${UI.right}px`);
  app.classList.toggle('no-left', UI.noLeft);
  app.classList.toggle('no-right', UI.noRight);
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

function toggleLeft() {
  if (narrow()) return drawer('left');
  UI.noLeft = !UI.noLeft;
  store.set('noLeft', UI.noLeft ? '1' : '');
  applyLayout();
  renderAll();
}

function toggleRight() {
  if (narrow()) return drawer('right');
  UI.noRight = !UI.noRight;
  store.set('noRight', UI.noRight ? '1' : '');
  applyLayout();
  renderAll();
}

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
  return side === 'left' ? iconBtn('项目和对话', 'sideL', toggleLeft, '⌘B') : iconBtn('文件', 'sideR', toggleRight, '⌥⌘B');
}

// ---------- 数据 ----------

function setOffline(v) {
  if (S.offline === v) return;
  S.offline = v;
  if (CE.offline) CE.offline.hidden = !v;
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
    else fail('刷新', e);
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
    if (!stale(t) && !(e instanceof TypeError)) fail('读取群聊', e);
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
  const ts = threads();
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

function selectThread(t) {
  showView('relay');
  S.draft = false;
  S.thread = t.current ? null : t.id;
  S.tab = 0;
  closeDrawers();
  renderAll();
  scrollBottom();
}

function newThread() {
  showView('relay');
  S.draft = true;
  S.thread = null;
  S.tab = 0;
  closeDrawers();
  renderAll();
  C.ta.focus();
}

// ---------- 两页：接力、群聊 ----------

/** 换一页（还没画）：记下从哪边切过来的，画完后新内容从那一边滑进来（renderAll 里的 swapIn）。 */
function showView(v) {
  if (S.view === v) return false;
  S.view = v;
  store.set('view', v);
  S.tab = 0;
  S.swap = v === 'chat' ? 1 : -1;
  return true;
}

function swapIn(dir) {
  if (still()) return;
  for (const el of [CE.bar, CE.chat, CE.hero, CE.doc]) {
    if (!el.hidden) el.animate([{ opacity: 0, transform: `translateX(${dir * 22}px)` }, { opacity: 1, transform: 'none' }], { duration: 490, easing: EASE.spring });
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
  const ts = threads();
  const sig = JSON.stringify([
    S.view,
    st.projects,
    p.root,
    p.init,
    chat
      ? [talkTitle(S.talk), talkAt(S.talk), S.talk.sessions, talkLive()]
      : [ts.map((t) => [t.id, t.title, t.stints, t.pending, lastActive(t), blank(t)]), p.stints.filter((s) => s.status === 'working').map((s) => s.id), S.draft || blank(ts[ts.length - 1])],
    members().map((m) => [m.name, m.llm, m.cooling, m.canWork, m.tier]),
    busyMember(),
    looks.key,
  ]);
  if (sig !== leftSig) {
    leftSig = sig;
    drawLeft();
  }
  for (const b of LE.seg.children) {
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
  const ts = threads();
  const box = $('#left-in');
  if (!LE.brand) {
    LE.news = h('span', { class: 'news', hidden: true });
    LE.seg = h(
      'div',
      { class: 'seg view', role: 'tablist', 'aria-label': '页面' },
      [
        ['relay', '接力'],
        ['chat', '群聊'],
      ].map(([k, label]) => h('button', { role: 'tab', 'data-view': k, onclick: () => setView(k) }, label, k === 'chat' ? LE.news : null))
    );
    LE.brand = h('div', { class: 'brand' }, LE.seg, iconBtn('收起', 'sideL', toggleLeft, '⌘B'));
    LE.body = h('div', { class: 'left-body' });
    box.replaceChildren(LE.brand, LE.body);
  }
  const keep = LE.body.querySelector('.nav')?.scrollTop || 0;
  // 刚切了页：这一列新换上的对话一行接一行浮上来
  const swap = !!S.swap;
  const projects = [];
  for (const pr of orderedProjects()) {
    const cur = pr.current;
    const list = [];
    if (cur && chat && p.init) {
      list.push(sessionEl({ id: '', title: talkTitle(S.talk) || '新群聊', at: talkAt(S.talk) }));
      for (const x of S.talk.sessions || []) list.push(sessionEl(x));
    } else if (cur && p.init) {
      if (S.draft || blank(ts[ts.length - 1])) list.push(h('button', { class: 'thread draft', 'data-id': 'draft', onclick: newThread }, h('span', { class: 't' }, '新任务'), h('span', { class: 'when' }, '现在')));
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
        pr.live ? h('span', { class: 'dot live' }) : pr.pending ? h('span', { class: 'rd', 'data-tip': `${pr.pending} 棒待复核` }) : null
      ),
      iconBtn(`${pr.name} 更多`, 'more', (e) => openMenu(e.currentTarget, projMenuItems(pr)), '', 'more')
    );
    projects.push(h('div', { class: `proj${cur ? ' current' : ''}${cur && !S.fold ? ' open' : ''}` }, row, cur ? h('div', { class: 'threads' }, h('div', null, list)) : null));
  }
  if (!st.projects.length) projects.push(h('div', { class: 'proj' }, h('div', { class: 'proj-row' }, h('button', { class: 'pmain', onclick: chooseFolder }, icon('folder'), h('span', { class: 'name' }, '打开文件夹')))));
  // 成员收成一小叠（在干活的那位放最上面），点开是名单
  const busy = busyMember();
  const team = [...members()].sort((a, b) => Number(b.name === busy) - Number(a.name === busy));
  const look = (m) => (m.name === busy ? 'busy' : m.cooling ? 'cooling' : '');
  LE.body.replaceChildren(
    h(
      'div',
      { class: 'acts' },
      chat
        ? h('button', { class: 'btn line', onclick: newChat, disabled: !!p.pick }, icon('plus'), '新群聊')
        : h('button', { class: 'btn line', onclick: newThread, disabled: !!p.pick || (!p.init && !st.projects.length) }, icon('plus'), '新任务'),
      h('button', { class: 'find', onclick: () => openPalette() }, icon('search'), '搜索', h('kbd', null, '⌘K'))
    ),
    h('nav', { class: 'nav', 'aria-label': '项目' }, h('div', { class: 'nav-label' }, h('span', { class: 'cap' }, '项目'), iconBtn('打开文件夹', 'plus', chooseFolder)), projects),
    h(
      'div',
      { class: 'dock' },
      h(
        'button',
        {
          class: 'team',
          'aria-label': '成员',
          'aria-haspopup': 'menu',
          onclick: (e) =>
            openMenu(
              e.currentTarget,
              [
                ...team.map((m) => ({
                  label: memberName(m),
                  sub: [m.tool, m.name === busy ? '干活中' : m.cooling ? `额度用完 · ${m.coolingText}` : !m.canWork && m.kind !== 'app' ? '不可调度' : ''].filter(Boolean).join(' · '),
                  tile: tile(m, 's20', look(m)),
                  right: m.tier === 'strong' ? '强' : '弱',
                  run: () => openSettings('members'),
                })),
              ],
              { side: 'top' }
            ),
        },
        team.length ? stack(team, look, 3) : h('span', { class: 'more-n' }, '成员')
      ),
      iconBtn('设置', 'sliders', () => openSettings())
    )
  );
  LE.body.querySelector('.nav').scrollTop = keep;
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
    h('span', { class: 't' }, t.title || '未命名'),
    h('span', { class: 'when' }, live ? h('span', { class: 'dot live' }) : t.pending ? [h('span', { class: 'rd' }), `待复核 ${t.pending}`] : when(lastActive(t)))
  );
}

function projMenuItems(pr) {
  return [
    { label: '在访达中显示', icon: 'folder', run: () => reveal('', pr.root) },
    { label: '复制路径', icon: 'copy', run: () => copyToast(pr.root) },
    '-',
    { label: '移出列表', icon: 'x', run: () => forget(pr) },
  ];
}

async function forget(pr) {
  try {
    await api('/api/forget', { dir: pr.root });
    if (pr.current) {
      const next = S.st.projects.find((x) => !x.current);
      if (next) return switchProject(next.root);
    }
    toast('已移出');
    await refresh();
  } catch (e) {
    fail('移出', e);
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
    const r = await api('/api/choose-folder', {});
    switchProject(r.dir);
  } catch (e) {
    if (e.code !== 'cancelled') fail('打开文件夹', e);
  }
}

async function reveal(path, root) {
  try {
    const r = await api('/api/reveal', { path: path || undefined, ...(root ? { dir: root } : {}) });
    if (!r.revealed) toast('没能打开访达', { bad: true });
  } catch (e) {
    fail('打开访达', e);
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
  CE.offline = h('div', { class: 'offline', hidden: true }, h('span', { class: 'rd' }), '连不上接力台', h('button', { class: 'btn small', onclick: () => refresh(true) }, '重试'));
  CE.cfgBad = h('div', { class: 'offline cfg-bad', hidden: true });
  CE.bar = h('header', { class: 'bar' });
  CE.tabs = h('div', { class: 'tabs', role: 'tablist', hidden: true });
  CE.stream = h('div', { class: 'stream' });
  CE.scroll = h('div', { class: 'scroll', onscroll: onScroll }, CE.stream);
  CE.toBottom = h('button', { class: 'to-bottom', hidden: true, onclick: () => scrollBottom(true) }, icon('down'), '新消息');
  CE.chat = h('section', { class: 'pane', 'aria-label': '对话' }, CE.scroll, CE.toBottom);
  CE.doc = h('section', { class: 'pane', hidden: true });
  CE.hero = h('section', { class: 'hero', hidden: true });
  $('#center').append(CE.offline, CE.cfgBad, CE.bar, CE.tabs, CE.chat, CE.doc, CE.hero);
}

function onScroll() {
  const s = CE.scroll;
  stick = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  if (stick) CE.toBottom.hidden = true;
  if (WIRE.card) drawWires();
}

function scrollBottom(smooth) {
  CE.scroll.scrollTo({ top: CE.scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  stick = true;
  CE.toBottom.hidden = true;
}

function renderCenter() {
  if (!S.st) return;
  CE.offline.hidden = !S.offline;
  const cfgErr = S.st.project.config && S.st.project.config.error;
  CE.cfgBad.hidden = !cfgErr;
  if (cfgErr && CE.cfgBad.dataset.err !== cfgErr) {
    CE.cfgBad.dataset.err = cfgErr;
    CE.cfgBad.replaceChildren(h('span', { class: 'rd' }), h('span', { class: 'ell', 'data-tip': cfgErr }, '配置文件坏了'), h('button', { class: 'btn small', onclick: () => openFile('.relay/config.json') }, '打开'));
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
  document.title = S.st.project.name && !S.st.project.pick ? `${S.st.project.name} · 接力台` : '接力台';
}

// ----- 空闲：小标题、要人看的一行、输入框 -----

function renderHero(mode) {
  const p = S.st.project;
  // 还没有项目（停在家目录这种大文件夹）：只请你选一个项目文件夹
  if (mode === 'pick') {
    const sig = JSON.stringify([mode, members().length, !!S.st.detecting, UI.noLeft, UI.noRight, narrow()]);
    if (sig !== heroSig) {
      heroSig = sig;
      C.wrap.remove();
      CE.hero.replaceChildren(
        h('div', { class: 'hero-bar' }, UI.noLeft || narrow() ? sideBtn('left') : null, h('span', { class: 'sp' }), UI.noRight || narrow() ? sideBtn('right') : null),
        h(
          'div',
          { class: 'hero-in' },
          h(
            'div',
            { class: 'hero-head' },
            h('div', null, h('h1', null, '接力台'), h('span', { class: 'cap' }, S.st.detecting && !members().length ? '识别中' : `${members().length} 位 AI`)),
            h('button', { class: 'btn primary', onclick: chooseFolder }, icon('folder'), '打开文件夹')
          )
        )
      );
    }
    return;
  }
  const setup = mode === 'setup' || mode === 'chat-setup';
  const chat = mode === 'chat-new' || mode === 'chat-setup';
  const pend = setup || chat ? [] : p.pending;
  const canCancel = mode === 'new' && S.draft && threads().some((t) => !blank(t));
  const sig = JSON.stringify([mode, p.root, p.name, pend.map((s) => [s.id, s.summary]), UI.noLeft, UI.noRight, narrow(), canCancel]);
  if (sig !== heroSig) {
    heroSig = sig;
    const s = pend[0];
    const head = h(
      'div',
      { class: 'hero-head' },
      h('div', null, h('h1', null, setup ? p.name : chat ? '新群聊' : '新任务'), h('span', { class: 'cap', 'data-tip': setup ? p.root : null }, setup ? `未接入 · ${shortPath(p.root)}` : p.name)),
      setup ? h('button', { class: 'btn line', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), '已接入').then(() => loadTree()) }, '接入') : null
    );
    const notice = s ? h('button', { class: 'notice', onclick: () => jumpTo(s.id) }, h('span', { class: 'rd' }), h('b', null, `第 ${s.id} 棒待复核${pend.length > 1 ? `（共 ${pend.length} 棒）` : ''}`), h('span', { class: 'ell' }, s.summary || '')) : null;
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
            '取消'
          )
        )
      : h('div', { class: 'under', hidden: true });
    CE.hero.replaceChildren(h('div', { class: 'hero-bar' }, UI.noLeft || narrow() ? sideBtn('left') : null, h('span', { class: 'sp' }), UI.noRight || narrow() ? sideBtn('right') : null), h('div', { class: 'hero-in' }, head, notice, C.wrap, under));
  } else if (C.wrap.parentNode !== CE.hero.querySelector('.hero-in')) {
    const inner = CE.hero.querySelector('.hero-in');
    inner.insertBefore(C.wrap, inner.querySelector('.under'));
  }
  setComposerKind(chat ? 'talk' : 'task');
}

// ----- 顶栏：项目 / 任务几，现在谁在做，待复核，清单，控制 -----

const KIND_WORD = { work: '干活中', review: '复核中', final: '终审中', plan: '拆解中' };

function renderBar(t) {
  const p = S.st.project;
  const run = runState();
  const g = run.g;
  const latest = !!t.current;
  const n = threads().indexOf(t) + 1;
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
    members().map((m) => [m.name, m.cooling, m.canWork]),
    UI.noLeft,
    UI.noRight,
    narrow(),
    looks.key,
  ]);
  if (sig === barSig) return;
  barSig = sig;
  const meta = [];
  const ctl = [];
  if (latest) {
    meta.push(statusEl(run));
    if (p.pending.length) meta.push(h('button', { class: 'meta-btn', 'aria-haspopup': 'menu', onclick: (e) => pendingMenu(e.currentTarget) }, h('span', { class: 'rd' }), `待复核 ${p.pending.length}`));
    if (p.task.total) meta.push(h('button', { class: 'meta-btn', 'data-tip': '清单', onclick: () => CE.stream.querySelector('.head')?.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'start' }) }, `清单 ${p.task.done}/${p.task.total}`));
    if (run.running || run.waiting) {
      ctl.push(h('button', { class: 'btn primary', 'data-tip': '停止', 'data-kbd': '⌘.', onclick: (e) => act(e.currentTarget, () => api('/api/stop', {}), '已停止') }, icon('stop'), h('span', { class: 'lbl' }, '停止')));
    } else {
      const why = p.task.empty ? '还没有任务' : !ready().length ? '没有可用的成员' : '';
      ctl.push(
        h(
          'span',
          { class: 'split' },
          h(
            'button',
            { class: 'btn primary', disabled: !!why, 'data-tip': why || null, onclick: (e) => act(e.currentTarget, () => startWork('/api/auto', {}), '已开始全自动') },
            icon('play'),
            h('span', { class: 'lbl' }, '全自动')
          ),
          h('button', { class: 'btn primary', 'aria-label': '只做一棒', 'data-tip': '只做一棒', 'aria-haspopup': 'menu', onclick: (e) => whoMenu(e.currentTarget) }, icon('down'))
        )
      );
    }
    ctl.push(iconBtn('更多', 'more', (e) => barMenu(e.currentTarget)));
  }
  if (UI.noRight || narrow()) ctl.push(sideBtn('right'));
  CE.bar.replaceChildren(
    h('div', { class: 'bar-l' }, UI.noLeft || narrow() ? sideBtn('left') : null, h('span', { class: 'crumb cap' }, p.name, h('i', null, '/'), `任务 ${n}`)),
    h('div', { class: 'bar-m' }, meta),
    h('div', { class: 'bar-ctl' }, ctl)
  );
}

/** 顶栏上一句现在在干什么：谁用小图标表示（全名悬停看），空闲时不写。 */
function statusEl(run) {
  if (run.running) {
    const c = run.cur;
    const auto = run.g && run.g.mode === 'auto';
    return h(
      'span',
      { class: 'status live', 'data-tip': c ? `${auto ? '全自动 · ' : ''}${nameOf(c.label)}` : null },
      h('span', { class: 'dot' }),
      auto ? h('span', { class: 'w' }, '全自动') : null,
      c ? tile({ name: c.member, label: c.label }, 's16') : null,
      h('span', { class: 'w' }, c ? KIND_WORD[c.kind] || '干活中' : '进行中'),
      c ? h('span', { class: 'num', 'data-since': c.since }, elapsed(c.since)) : null
    );
  }
  if (run.waiting) {
    const g = run.g;
    return h('span', { class: 'status wait', 'data-tip': g && g.phase }, h('span', { class: 'dot' }), h('span', { class: 'w' }, `等额度${g && g.waitingUntil ? ` · ${clock(g.waitingUntil)}` : ''}`));
  }
  if (run.native) {
    const s = S.st.project.stints.find((x) => x.status === 'working');
    const known = s && s.who.label !== '不知道是谁';
    return h('span', { class: 'status live', 'data-tip': known ? nameOf(s.who.label, s.who.model) : null }, h('span', { class: 'dot' }), known ? tile(s.who, 's16') : null, h('span', { class: 'w' }, '进行中'));
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
                i.text
              )
            : i.text
        )
      )
    );
  // 读不到的（配置文件坏了、改动读不到）和还差的（没复核、没终审、检查没过）分开说。
  const unread = a.items.filter((i) => i.kind === 'config' || i.kind === 'evidence');
  const missing = a.items.filter((i) => i.kind !== 'config' && i.kind !== 'evidence');
  close = sheet({
    title: { accepted: '验收通过', blocked: '验收没过', unknown: '没法验收' }[a.state] || '验收',
    body: h(
      'div',
      { class: 'accept-list' },
      a.state === 'accepted' ? h('p', null, a.headline) : null,
      unread.length ? h('p', null, '读不到：') : null,
      unread.length ? list(unread) : null,
      missing.length ? h('p', null, '还差：') : null,
      missing.length ? list(missing) : null
    ),
    foot: [h('button', { class: 'btn primary', autofocus: true, onclick: () => close() }, '知道了')],
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
    'aria-label': '任务',
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
    await act(null, () => api('/api/task/edit', { op: 'title', text: v }), '已保存');
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
    fail('改清单', e);
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
    li.className = now[k].className;
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
    items.push({ head: '只做一棒' });
    for (const m of drive) {
      items.push({ label: memberName(m), sub: m.cooling ? `额度用完 · ${m.coolingText}` : m.tool || '', tile: tile(m, 's20'), right: m.tier === 'strong' ? '强' : m.tier === 'weak' ? '弱' : '', disabled: !!m.cooling, run: () => goWith(null, m) });
    }
  }
  if (self.length) {
    items.push('-', { head: '打开' });
    for (const m of self) items.push({ label: memberName(m), sub: m.app, tile: tile(m, 's20'), run: () => openIn(m) });
  }
  if (!items.length) items.push({ label: '没有成员', disabled: true });
  items.push('-', { label: '复制开场白', icon: 'copy', run: copyHint });
  openMenu(anchor, items, { align: 'end' });
}

function pendingMenu(anchor) {
  const p = S.st.project;
  const rv = reviewer();
  const items = p.pending.map((s) => ({ label: `第 ${s.id} 棒 · ${nameOf(s.who.label, s.who.model)}`, sub: s.summary || '', tile: tile(s.who, 's20'), run: () => jumpTo(s.id) }));
  items.push('-', { label: '复核', sub: rv ? memberName(rv) : '没有可用的强模型', icon: 'review', disabled: !rv || runState().running, run: () => goWith(null, rv, 'review') });
  openMenu(anchor, items, { align: 'end' });
}

function barMenu(anchor) {
  const p = S.st.project;
  openMenu(
    anchor,
    [
      { label: '编辑任务', icon: 'pencil', run: editTaskRaw },
      { label: '接力本', icon: 'book', run: openBrief },
      { label: '对账', icon: 'sync', run: snapNow },
      { label: '复制开场白', icon: 'copy', run: copyHint },
      { label: '在访达中显示', icon: 'folder', run: () => reveal('') },
      p.protocol !== 'ok' ? { label: '更新接力规矩', icon: 'warn', run: updateProtocol } : null,
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
    if (!(await confirmSheet('有 AI 还在改这个文件夹', e.message, '换人'))) throw Object.assign(new Error('没有换人。'), { code: 'cancelled' });
    return api(path, { ...body, force: true });
  }
}

function goWith(btn, m, kind) {
  if (!m) return;
  return act(btn, () => startWork('/api/go', { who: m.name, ...(kind ? { kind } : {}) }), `${memberName(m)} 已开始${kind === 'review' ? '复核' : ''}`);
}

function goDefault() {
  const w = defaultWorker();
  if (!w) return toast('没有可用的成员', { bad: true });
  goWith(null, w);
}

function reviewNow() {
  const rv = reviewer();
  if (!rv) return toast('没有可用的强模型', { bad: true });
  goWith(null, rv, 'review');
}

function stopNow() {
  const run = runState();
  if (run.running || run.waiting) act(null, () => api('/api/stop', {}), '已停止');
}

function snapNow() {
  act(null, () => api('/api/snap', {}), (r) => (r.changed ? '已对账' : '没有新改动')).then(() => loadTree());
}

function updateProtocol() {
  act(null, () => api('/api/init', {}), '已更新');
}

async function copyHint() {
  const ok = await copyText(S.st.hint);
  if (!ok) await api('/api/copy-hint', {}).catch(() => null);
  toast('已复制开场白');
}

async function openIn(m) {
  const r = await act(null, () => api('/api/open', { who: m.name }));
  if (!r) return;
  if (!r.copied) await copyText(r.hint);
  toast(r.opened ? `已打开 ${m.app} · 开场白已复制` : '开场白已复制');
}

async function editTaskRaw() {
  let raw = '';
  const t = ticket('task-raw');
  try {
    raw = (await api(q('/api/task'))).raw;
  } catch (e) {
    return stale(t) ? undefined : fail('读取任务', e);
  }
  if (stale(t)) return;
  const ta = h('textarea', { class: 'raw', spellcheck: 'false', value: raw, 'aria-label': '任务' });
  const close = sheet({
    title: '编辑任务',
    wide: true,
    body: ta,
    foot: [
      h('button', { class: 'btn ghost', onclick: () => close() }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: (e) =>
            act(e.currentTarget, () => api('/api/task/save', { raw: ta.value }), '已保存').then((r) => {
              if (r) close();
            }),
        },
        '保存'
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
  const targets = s.kind === 'review' && s.targets ? s.targets.map((id) => (stintById(id) || {}).reviews) : null;
  return JSON.stringify([s.status, s.summary, s.review, s.reviews, s.facts, s.gate, s.protectedHits, s.rolledBack, s.note, s.endedAt, s.who, s.kind, s.targets, s.log, s.quotaUntil, s.handoff, s.ghost, targets, looks.key]);
}

function streamItems(t) {
  const p = S.st.project;
  const latest = !!t.current;
  const items = [];
  const title = latest ? p.task.title : t.title;
  const n = threads().indexOf(t) + 1;
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
  const res = g && g.mode === 'auto' && g.result && ['done', 'needs-human', 'failed', 'stopped'].includes(g.status) && S.dismissed !== g.id && inRange(rangeOf(t), msOf(g.startedAt || g.updatedAt)) ? g : null;
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

/** 按 key 对齐：没变的不动，变了的换掉，新来的加进来（带一点动画）。keep：正在编辑，先别动。 */
function syncList(box, items, animate) {
  const old = new Map();
  for (const el of [...box.children]) {
    if (el.dataset.key) old.set(el.dataset.key, el);
    else el.remove();
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
      el = fresh;
    } else if (!el) {
      el = it.make();
      el.dataset.key = it.key;
      el.dataset.sig = it.sig;
      if (animate) enterAnim(el, added);
      added++;
    }
    old.delete(it.key);
    const want = prev ? prev.nextSibling : box.firstChild;
    if (el !== want) box.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
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
  else if (added) CE.toBottom.hidden = false;
}

/** 正在干活的那一棒：日志尾巴原地更新，不重画卡片。 */
function updateLive() {
  const g = S.st.project.go;
  for (const pre of CE.stream.querySelectorAll('.tail')) {
    const id = Number(pre.dataset.stint);
    const text = g && g.current && g.current.stint === id ? g.logTail || '' : '';
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
    latest ? h('h2', { class: 'ttl', role: 'button', tabindex: '0', 'data-tip': '改标题', html: inline(esc(title)), onclick: editTitle, onkeydown: (e) => e.key === 'Enter' && editTitle() }) : h('h2', { class: 'ttl', html: inline(esc(title)) }),
    sub ? h('p', { class: 'sub' }, sub.length > 400 ? `${sub.slice(0, 400)}…` : sub) : null,
    latest ? checklist(task) : null,
    latest && task.rules ? h('details', { class: 'rules' }, h('summary', { class: 'link' }, '约定'), h('div', { class: 'doc-md', html: md(task.rules) })) : null,
    latest ? iconBtn('编辑任务', 'pencil', editTaskRaw, '', 'edit') : null
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
        h('button', { class: 'x', 'aria-label': '删除这一步', 'data-tip': '删除', onclick: () => editStep({ op: 'remove', index: i }, () => S.st.project.task.items.splice(i, 1)) }, icon('x'))
      );
    }),
    h(
      'li',
      { class: 'add' },
      icon('plus'),
      h('input', {
        type: 'text',
        placeholder: '加一步',
        'aria-label': '加一步',
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
      h('span', { class: 'cap' }, [r.mode === 'solo' ? '对比' : '', clock(r.ts)].filter(Boolean).join(' · ')),
      body ? h('div', { class: 'note', html: inline(esc(body)) }) : null,
      files.length ? h('div', { class: 'att' }, files.map(fileEl)) : null
    );
  }
  if (r.kind === 'system') return h('div', { class: 'sys' }, r.text);
  return aiRow(r);
}

function aiRow(r, compact) {
  const name = nameOf(r.who, r.model);
  return h(
    'div',
    { class: 'ai' },
    h('span', { class: 'who-tile', 'data-tip': memberByName(r.agent) ? memberTip(memberByName(r.agent)) : name }, tile({ agent: r.agent, label: r.who, model: r.model })),
    h('div', null, h('div', { class: 'who' }, h('b', null, name), compact ? null : h('span', { class: 'time' }, clock(r.ts))), h('div', { class: `text doc-md${r.error ? ' err' : ''}`, html: md(r.text) })),
    compact ? null : h('div', { class: 'hover-acts' }, iconBtn('复制', 'copy', () => copyToast(r.text)))
  );
}

function roundBox(rows) {
  return h('div', { class: 'round' }, h('span', { class: 'cap' }, `对比 · ${rows.length}`), h('div', { class: 'round-cols' }, rows.map((r) => aiRow(r, true))));
}

function typingLine(st) {
  const names = st.speaking.map((x) => nameOf(x.label));
  return h(
    'div',
    { class: 'typing' },
    h('span', { class: 'tiles' }, st.speaking.map((x) => tile({ agent: x.agent, label: x.label })), st.queue.map((x) => tile({ agent: x.agent, label: x.label }, '', 'cooling'))),
    h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
    names.length ? `${names.join('、')} 正在输入` : '排队中'
  );
}

function rollbackLine(rb) {
  return h('div', { class: 'sys' }, icon('undo'), `${clock(rb.ts)} 退回到${rb.label} · 第 ${rb.dropped.join('、')} 棒作废`, rb.undone ? '· 已撤销' : h('button', { class: 'link', onclick: (e) => undoRollback(e.currentTarget) }, '撤销'));
}

/**
 * 线路的终点：和别的站一样大的圆圈（通过了是实心的），旁边一行字说结果、一行说还差什么。
 * 最新的任务看验收；更早的任务没有验收记录，就写当时全自动的结果。
 */
function verdictEl(g, a) {
  const state = a ? a.state : { done: 'accepted', 'needs-human': 'blocked', failed: 'failed', stopped: 'stopped' }[g.status];
  const [ic, title] = { accepted: ['check', '验收通过'], blocked: ['warn', a ? '验收没过' : '全自动停止'], unknown: ['unknown', '没法验收'], failed: ['warn', '全自动出错'], stopped: ['stop', '全自动已停止'] }[state];
  const why = (a ? (a.state === 'accepted' ? a.headline : a.items.map((i) => i.text).join('；')) : g.result).replace(/^(验收通过|验收没过|没法验收|全自动停止|全自动已停止)：/, '');
  const body = [state === 'blocked' || state === 'failed' ? h('span', { class: 'rd' }) : null, title];
  return h(
    'div',
    { class: `stop verdict ${state}` },
    h('span', { class: 'no', 'aria-hidden': 'true' }, ic === 'unknown' ? '?' : icon(ic)),
    a ? h('button', { class: 'vt', 'aria-haspopup': 'dialog', onclick: acceptPanel }, body) : h('div', { class: 'vt' }, body),
    why ? h('p', { class: 'why' }, why) : null,
    g ? h('span', { class: 'cap' }, [clock(g.updatedAt), g.mode === 'auto' ? '全自动' : '', g.stints && g.stints.length ? `${g.stints.length} 棒` : '', lasted(g.startedAt, g.updatedAt)].filter(Boolean).join(' · ')) : null,
    g
      ? iconBtn(
          '收起',
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
  return h('div', { class: 'sys' }, icon('warn'), p.protocol === 'old' ? '接力规矩有新版本' : '接力规矩不见了', h('button', { class: 'link', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), '已更新') }, '更新'));
}

// ----- 一棒：卡片 -----

function countedReview(s) {
  return [...(s.reviews || [])].reverse().find((r) => !r.weak && !r.void) || null;
}

/** 没成的一棒（额度用完、出错、中途停了）：卡片上那一句写原因。 */
const FAILED = new Set(['quota', 'failed', 'stopped']);

function summaryOf(s) {
  if (s.summary) return { text: s.summary };
  if (s.status === 'working') return { text: s.via === 'relay' ? '开始了' : '正在改文件', faint: true };
  if (s.note && FAILED.has(s.status)) return { text: s.note };
  if (s.kind === 'review' || s.kind === 'plan') return { text: s.kind === 'plan' ? '拆解' : '复核', faint: true };
  return { text: s.ghost || !s.handoff ? '没有交接' : '交接里没写做了什么', faint: true };
}

/** 一棒是谁做的、现在什么状态：机器的标签，细边框加一个小图标。 */
function pillOf(s) {
  if (s.status === 'working') return h('span', { class: 'pill live' }, h('span', { class: 'dot' }), s.via === 'relay' ? KIND_WORD[s.kind] : '进行中');
  if (s.rolledBack) return h('span', { class: 'pill soft' }, '作废');
  if (s.kind === 'final' && s.verdictWord) return h('span', { class: 'pill' }, icon('search'), `终审 · ${s.verdictWord}`);
  if (s.kind === 'review') return h('span', { class: 'pill' }, icon('review'), '复核');
  if (s.kind === 'plan') return h('span', { class: 'pill' }, icon('list'), '拆解');
  const [ic, word] = { handed: ['arrow', '已交接'], unfinished: ['', '没交接'], quota: ['', `额度用完${s.quotaUntil ? ` · ${clock(s.quotaUntil)} 恢复` : ''}`], failed: ['', '出错'], stopped: ['stop', '已停止'] }[s.status] || [];
  if (!word) return null;
  return h('span', { class: `pill${s.status === 'handed' ? '' : ' soft'}` }, s.status === 'failed' ? h('span', { class: 'rd' }) : ic ? icon(ic) : null, word);
}

/** 做了多久：21:43–21:45 · 2 分钟；正在做的一秒一秒走。 */
function spanOf(s) {
  if (s.status === 'working') return h('span', { class: 'tm', 'data-since': s.startedAt }, elapsed(s.startedAt));
  const from = dayClock(s.startedAt);
  const to = s.endedAt ? clock(s.endedAt) : '';
  return h('span', { class: 'tm' }, `${from}${to && to !== clock(s.startedAt) ? `–${to}` : ''}${s.endedAt ? ` · ${lasted(s.startedAt, s.endedAt)}` : ''}`);
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
        h('b', null, name === '不知道是谁' ? '身份不明' : name),
        h('span', { class: 'mdl' }, { strong: '强', weak: '弱' }[s.who.tier] || ''),
        pillOf(s),
        compact ? h('span', { class: 'say' }, sum.text) : null,
        spanOf(s)
      ),
      compact ? null : h('div', { class: `sum${sum.faint ? ' faint' : ''}`, html: inline(esc(sum.text)) }),
      cardFoot(s),
      live && s.via === 'relay' ? h('pre', { class: 'tail', 'data-stint': String(s.id), hidden: true }) : null,
      h('div', { class: 'more-body' }, h('div', null))
    ),
    h('div', { class: 'hover-acts' }, files ? iconBtn('改动', 'diff', () => openDiff(s.id)) : null, iconBtn('更多', 'more', (e) => openMenu(e.currentTarget, stintMenuItems(s), { align: 'end' })))
  );
}

/** 小条底下一行淡字：只写要注意的（正常交接了就不写），改了哪些文件合成一句，点开看改动。 */
function cardFoot(s) {
  const bits = [];
  const st = (cls, ...kids) => h('span', { class: `st ${cls}`.trim() }, ...kids);
  if (!s.rolledBack && s.review === 'needed' && s.status !== 'working') {
    // 为什么还待复核：复核写了「有问题」「证据不足」、只有弱模型复核过、读不到改动……
    const why = s.reviewText.replace(/^待复核( · )?/, '');
    const el = st('pend', h('span', { class: 'rd' }), h('span', { class: 'ell' }, s.reviewWarn && why ? why.replace(/（[^）]*）$/, '') : '待复核'));
    if (why) el.dataset.tip = why;
    bits.push(el);
  } else if (!s.rolledBack && s.review === 'done') {
    // 谁复核的看小图标（复核算数的都是强模型），悬停看全名，点一下跳过去
    const c = countedReview(s);
    const by = c && stintById(c.by);
    const who = by ? by.who : c && { label: c.byLabel, tier: 'strong' };
    if (c) bits.push(h('button', { class: 'st ok link-st', 'data-tip': whoTip(who), onclick: () => by && jumpTo(by.id) }, tile(who, 's16'), `复核 · ${c.verdictWord}`));
  }
  const warn = (text, tip) => {
    const el = st('bad', h('span', { class: 'rd' }), text);
    if (tip) el.dataset.tip = tip;
    bits.push(el);
  };
  if (s.factsError) warn('读不到改动', s.factsError);
  if (s.gate && s.gate.status === 'fail') warn('检查没过');
  if (s.gate && s.gate.status === 'error') warn('检查没跑成', s.gate.detail);
  if (s.protectedHits) warn('改了保护的文件', s.protectedHits.join('\n'));
  if (s.kind === 'review' && s.targets) {
    for (const id of s.targets) {
      const tg = stintById(id);
      const r = tg && (tg.reviews || []).find((x) => x.by === s.id);
      bits.push(h('button', { class: 'st link-st', onclick: () => jumpTo(id) }, `第 ${id} 棒${r ? ` · ${r.verdictWord}` : ''}${r && r.weak ? ' · 不算数' : ''}`));
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
          'data-tip': shown.join('\n') + (f.files > shown.length ? `\n… 一共 ${f.files} 个` : ''),
          onclick: () => openDiff(s.id, f.files === 1 ? f.paths[0] : undefined),
        },
        h('span', { class: 'ell' }, f.files === 1 ? basename(f.paths[0]) : `${f.files} 个文件`),
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
    s.facts && s.facts.files ? { label: '改动', icon: 'diff', run: () => openDiff(s.id) } : null,
    s.log ? { label: '日志', icon: 'log', run: () => openLog(s) } : null,
    s.handoff ? { label: '复制交接', icon: 'copy', run: () => copyHandoff(s) } : null,
    '-',
    pending ? { label: '复核', sub: rv ? rv.label : '没有可用的强模型', icon: 'review', disabled: !rv || runState().running, run: () => goWith(null, rv, 'review') } : null,
    pending ? { label: '跳过复核', icon: 'check', run: () => skipReview(null, s) } : null,
    !s.rolledBack && s.status !== 'working' ? { label: '退回到这之前', icon: 'undo', disabled: S.st.project.now.kind === 'relay', run: () => rollbackTo(null, s) } : null,
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
    if (!stale(t)) fail('读取这一棒', e);
  } finally {
    detailLoading.delete(id);
  }
}

function fillDetail(el, s) {
  const slot = el.querySelector('.more-body > div');
  if (slot) slot.replaceChildren(detailBox(s));
}

const SECTION = [
  [/做了/, '做了'],
  [/没做完|下一步/, '没做完'],
  [/不确定|拿不准|可能有错/, '拿不准'],
  [/验证/, '验证'],
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
  if (!secs.length && text.trim()) rows.push(h('dt', null, '交接'), h('dd', { class: 'doc-md', html: md(text.replace(/^#\s+.*\n+/, '')) }));
  const f = s.facts;
  if (f && f.files) {
    rows.push(
      h('dt', null, '改了'),
      h(
        'dd',
        { class: 'files' },
        f.paths.slice(0, 12).map((p) => h('button', { onclick: () => openDiff(s.id, p), onmouseenter: () => lightPaths([p]), onmouseleave: () => lightStint(s) }, p)),
        f.files > 12 ? h('em', null, `… 一共 ${f.files} 个`) : null,
        h('em', null, `+${f.added} −${f.removed}`)
      )
    );
  }
  return h('div', { class: 'form' }, h('div', { class: 'fh' }, h('span', { class: 'cap' }, `交接单 · 第 ${s.id} 棒${s.ghost ? ' · 接力台代写' : ''}`), status ? h('span', { class: 'cap' }, status) : null), h('dl', null, rows));
}

function detailBox(s) {
  const d = S.detail.get(s.id);
  const box = h('div', { class: 'detail' });
  if (!d) {
    box.append(h('div', { class: 'skel', style: 'width:62%' }), h('div', { class: 'skel', style: 'width:38%' }));
    return box;
  }
  if (d.handoff || (s.facts && s.facts.files)) box.append(handoffForm(s, d.handoff || ''));
  if (s.who.claimed && s.who.claimed !== s.who.label) box.append(h('p', { class: 'aside' }, `交接里写的是「${s.who.claimed}」`));
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
        h('div', { class: 'rb-head' }, tile(who, 's16'), h('b', null, byName === '不知道是谁' ? '身份不明' : byName), r.weak ? h('span', null, '不算数') : null),
        h('div', { class: 'doc-md', html: md(r.text.replace(/^#\s+.*\n+/, '')) })
      )
    );
  }
  if (s.gate) box.append(h('section', null, h('h5', null, '检查'), h('div', { class: 'pre' }, `${{ pass: '通过', fail: '没通过', error: '没跑成' }[s.gate.status] || s.gate.status}${s.gate.command ? ` · ${s.gate.command}` : ''}${s.gate.detail ? `\n\n${s.gate.detail}` : ''}`)));
  if (s.note && summaryOf(s).text !== s.note) box.append(h('section', null, h('h5', null, '说明'), h('p', { class: 'aside' }, s.note)));
  const acts = [];
  const pending = s.review === 'needed' && s.status !== 'working' && !s.rolledBack;
  if (s.facts && s.facts.files) acts.push(h('button', { class: 'btn small', onclick: () => openDiff(s.id) }, icon('diff'), '改动'));
  if (s.log) acts.push(h('button', { class: 'btn small', onclick: () => openLog(s) }, icon('log'), '日志'));
  if (pending) {
    const rv = reviewer();
    if (rv) acts.push(h('button', { class: 'btn small primary', disabled: runState().running, onclick: (e) => goWith(e.currentTarget, rv, 'review') }, icon('review'), '复核'));
    acts.push(h('button', { class: 'btn small', onclick: (e) => skipReview(e.currentTarget, s) }, '跳过复核'));
  }
  if (!s.rolledBack && s.status !== 'working') acts.push(h('button', { class: 'btn small ghost', disabled: S.st.project.now.kind === 'relay', onclick: (e) => rollbackTo(e.currentTarget, s) }, icon('undo'), '退回到这之前'));
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
      return stale(t) ? undefined : fail('复制交接', e);
    }
  }
  copyToast(d.handoff || '');
}

async function skipReview(btn, s) {
  if (!S.st) return;
  const { root, name } = S.st.project;
  const who = s.who.tier === 'unknown' ? '身份不明' : s.who.tier === 'weak' ? '弱模型' : '还没复核';
  if (!(await confirmSheet(`跳过第 ${s.id} 棒的复核？`, `「${name}」第 ${s.id} 棒（${who}）跳过后不再等复核。可以撤销。`, '跳过复核'))) return;
  if (!S.st || S.st.project.root !== root) return fail('跳过复核', '项目已经换了');
  const r = await act(btn, () => api('/api/mark', { dir: root, stint: s.id }));
  if (r) toast(`第 ${s.id} 棒已跳过复核`, { action: { label: '撤销', run: () => act(null, () => api('/api/mark', { dir: root, stint: s.id, review: 'needed' }), '已改回待复核') } });
}

async function rollbackTo(btn, s) {
  if (!S.st) return;
  const { root, name } = S.st.project;
  if (!(await confirmSheet(`退回到第 ${s.id} 棒之前？`, `「${name}」第 ${s.id} 棒和之后的改动作废，清单里对应的勾去掉。可以撤销。`, '退回'))) return;
  if (!S.st || S.st.project.root !== root) return fail('退回', '项目已经换了');
  const r = await act(btn, () => api('/api/rollback', { dir: root, stint: s.id }));
  if (r) {
    const tk = r.task && r.task.missing ? ' · 清单没跟着退回（旧账本）' : r.task && r.task.unchecked.length ? ` · 清单去掉 ${r.task.unchecked.length} 个勾` : '';
    toast(`已退回 · ${r.files} 个文件${tk}`, { action: { label: '撤销', run: () => undoRollback(null) } });
    loadTree();
  }
}

function undoRollback(btn) {
  act(btn, () => api('/api/rollback/undo', {}), '已撤销').then(() => loadTree());
}

/** 跳到某一棒：不在当前这段对话里就先切过去，然后闪一下。 */
function jumpTo(id) {
  closeMenus();
  const t = threads().find((x) => x.stints.includes(id));
  if (t && selectedThread() !== t) selectThread(t);
  if (S.tab !== 0) {
    S.tab = 0;
    renderCenter();
  }
  const el = CE.stream.querySelector(`.card[data-stint="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
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
  return h('button', { class: 'thread', 'data-id': `chat:${x.id}`, onclick: () => selectChat(x.id || null) }, h('span', { class: 't' }, x.title), h('span', { class: 'when' }, live ? h('span', { class: 'dot live' }) : x.at ? when(x.at) : '现在'));
}

function selectChat(id) {
  showView('chat');
  S.chat = id;
  S.tab = 0;
  closeDrawers();
  if (id && !(S.archive && S.archive.id === id)) loadArchive(id);
  renderAll();
  scrollBottom();
}

async function loadArchive(id) {
  const t = ticket('archive');
  try {
    const d = await api(q(`/api/talk?id=${encodeURIComponent(id)}`));
    if (stale(t) || S.chat !== id) return;
    S.archive = d;
    renderCenter();
  } catch (e) {
    if (!stale(t)) fail('读取群聊记录', e);
  }
}

/** 新群聊：正在用的那段有内容就存档（左边还看得到；还有人在说也行，接着写进存档那段），换一段空的。 */
async function newChat() {
  if (talkHas(S.talk)) {
    try {
      await api('/api/talk/clear', {});
    } catch (e) {
      return fail('新建群聊', e);
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
  else if (added) CE.toBottom.hidden = false;
}

/** 群聊的顶栏：项目 / 这段群聊；存档的写上是哪天的。 */
function renderChatBar() {
  const p = S.st.project;
  const old = S.chat && (S.talk.sessions || []).find((x) => x.id === S.chat);
  const title = old ? old.title : talkTitle(S.talk) || '群聊';
  const sig = JSON.stringify(['chat', p.name, S.chat, title, old && old.at, UI.noLeft, UI.noRight, narrow()]);
  if (sig === barSig) return;
  barSig = sig;
  CE.bar.replaceChildren(
    h('div', { class: 'bar-l' }, UI.noLeft || narrow() ? sideBtn('left') : null, h('span', { class: 'crumb cap' }, p.name, h('i', null, '/'), title)),
    h('div', { class: 'bar-m' }, old ? h('span', { class: 'cap' }, dayClock(old.at)) : null),
    h('div', { class: 'bar-ctl' }, UI.noRight || narrow() ? sideBtn('right') : null)
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
    h('span', { class: 'cap' }, v.status === 'proposing' ? ['投票 · 出方案 ', dots] : v.status === 'voting' ? [`投票中 ${aiBallots.length}/${v.voters.length} `, dots] : `投票 · ${total} 票`),
    h('p', { class: 'q' }, v.question)
  );
  if (v.status === 'proposing') {
    box.append(h('div', { class: 'opts' }, v.voters.map((_, i) => h('div', { class: 'skel', style: `width:${80 - i * 12}%;margin:10px 0` }))));
    return box;
  }
  if (v.error) box.append(h('div', { class: 'sys' }, h('span', { class: 'rd' }), v.error));
  const me = () => h('span', { class: 'tile human', 'data-tip': '我' }, '我');
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
          'aria-label': cast ? `投方案 ${o.key}` : null,
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
          done && o.author !== 'human' ? [tile({ agent: o.author, label: o.authorLabel }, 's16'), `${nameOf(o.authorLabel)} 出的方案`] : null,
          mine && mine.choice === o.key ? h('span', { class: 'mine' }, '已投') : null,
          adopted ? h('span', { class: 'mine' }, '已采纳') : null
        ),
        live && done && !v.adopted ? h('button', { class: 'btn small primary adopt', onclick: (e) => adopt(e.currentTarget, v, o) }, '采纳') : null
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
        h('summary', { class: 'link' }, `每一票 · ${why.length}`),
        why.map((b) =>
          h(
            'div',
            { class: 'b' },
            b.voter === 'human' ? me() : tile({ agent: b.voter, label: b.voterLabel }, 's16'),
            h('span', null, h('b', null, b.voter === 'human' ? '我' : nameOf(b.voterLabel)), ` · ${b.choice ? `投 ${b.choice}` : `弃权${b.void ? `（${b.void}）` : ''}`}${b.reason ? ` · ${b.reason}` : ''}`)
          )
        )
      )
    );
  }
  return box;
}

function castVote(v, o) {
  act(null, () => api('/api/vote/cast', { id: v.id, key: o.key }), `已投方案 ${o.key}`).then(loadTalk);
}

function adopt(btn, v, o) {
  act(btn, () => api('/api/vote/adopt', { id: v.id, key: o.key }), `已采纳方案 ${o.key}`).then(loadTalk);
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
  if (t.type === 'diff') return t.path ? `${basename(t.path)} · 第 ${t.id} 棒` : `第 ${t.id} 棒 · 改动`;
  if (t.type === 'log') return `第 ${t.id} 棒 · 日志`;
  return '接力本';
}

function renderTabs() {
  const sig = JSON.stringify([S.tabs.map(tabKey), S.tab, S.view]);
  if (sig === tabsSig) return;
  tabsSig = sig;
  const chat = S.view === 'chat';
  CE.tabs.replaceChildren(
    h('button', { class: 'tab chat-tab', role: 'tab', 'aria-selected': String(S.tab === 0), onclick: () => ((S.tab = 0), renderCenter(), scrollBottom()) }, icon(chat ? 'chat' : 'route'), chat ? '群聊' : '任务'),
    ...S.tabs.map((t, i) =>
      h(
        'div',
        {
          class: 'tab',
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
        h('button', { class: 'x', 'aria-label': '关闭', onclick: () => closeTab(i) }, icon('x'))
      )
    )
  );
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
  if (d && d.error) body.append(h('div', { class: 'empty-note' }, d.error));
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
          { class: 'seg', role: 'group', 'aria-label': '看什么' },
          h('button', { 'aria-pressed': String(!t.view), onclick: () => ((t.view = 0), (docSig = ''), renderCenter()) }, '内容'),
          who.map((s) =>
            h(
              'button',
              {
                'aria-pressed': String(t.view === s.id),
                'data-tip': `第 ${s.id} 棒 · ${nameOf(s.who.label, s.who.model)}`,
                onclick: () => {
                  t.view = s.id;
                  docSig = '';
                  if (!S.docs.get(`${key}#${s.id}`)) loadFileDiff(t, s.id);
                  renderCenter();
                },
              },
              `第 ${s.id} 棒`
            )
          )
        )
      );
    }
    head.append(
      iconBtn('引用', 'insert', () => addFile(t.path)),
      iconBtn('复制路径', 'copy', () => copyToast(t.path)),
      iconBtn('在访达中显示', 'folder', () => reveal(t.path))
    );
    if (t.view) {
      if (!extra || extra.loading) body.append(h('div', { class: 'skel', style: 'width:60%;margin:16px 0' }));
      else if (extra.error) body.append(h('div', { class: 'empty-note' }, extra.error));
      else body.append(extra.data.diff ? h('div', { class: 'diff-file' }, h('div', { class: 'diff', html: diffHtml(extra.data.diff) })) : h('div', { class: 'empty-note' }, '这一棒没有改它'));
    } else if (d && d.data) {
      const f = d.data;
      if (f.binary) body.append(h('div', { class: 'empty-note' }, `二进制文件 · ${size(f.size)}`));
      else {
        const lines = f.text.replace(/\n$/, '').split('\n');
        const cap = 4000;
        body.append(h('div', { class: 'code', html: lines.slice(0, cap).map((l) => `<div class="l">${esc(l) || ' '}</div>`).join('') }));
        if (lines.length > cap || f.truncated) body.append(h('div', { class: 'empty-note' }, '只显示了前面一部分'));
      }
    }
  } else if (t.type === 'diff') {
    const s = stintById(t.id);
    head.append(
      h('div', { class: 'crumbs' }, s ? tile(s.who, 's20') : null, h('b', null, `第 ${t.id} 棒`), s ? h('span', null, ` · ${nameOf(s.who.label, s.who.model)}`) : null, t.path ? [icon('chev'), h('span', null, t.path)] : null),
      ...(t.path ? [h('button', { class: 'btn small ghost', onclick: () => openDiff(t.id) }, '全部文件')] : [])
    );
    if (d && d.data) {
      const files = splitDiff(d.data.diff);
      if (!files.length) body.append(h('div', { class: 'empty-note' }, '没有改动'));
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
                  'aria-label': '打开文件',
                  'data-tip': '打开文件',
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
    head.append(h('div', { class: 'crumbs' }, h('b', null, `第 ${t.id} 棒 · 日志`)));
    if (d && d.data) body.append(h('pre', { class: 'pre' }, d.data.text || '（空的）'));
  } else {
    head.append(h('div', { class: 'crumbs' }, h('b', null, '接力本')));
    if (d && d.data) body.append(h('div', { class: 'doc-md' }, h('div', { class: 'doc-md', html: md(d.data.text || '（还没有）') })));
  }
  CE.doc.replaceChildren(h('div', { class: 'doc-pane' }, head, body));
}

// ---------- 输入框 ----------

const C = {};

function buildComposer() {
  C.attach = h('div', { class: 'attach' });
  C.pill = h('span', { class: 'slash-pill', hidden: true });
  C.ta = h('textarea', { rows: '1', 'aria-label': '输入', oninput: onComposerInput, onkeydown: onComposerKey, onclick: updateSuggest, onpaste: onComposerPaste });
  C.fileIn = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: () => {
      uploadFiles([...C.fileIn.files]);
      C.fileIn.value = '';
    },
  });
  C.plus = iconBtn('上传文件', 'plus', () => C.fileIn.click(), '', 'plus-btn');
  C.optInput = h('input', {
    type: 'text',
    placeholder: '加选项',
    'aria-label': '加选项',
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
    { class: 'seg ink', role: 'group', 'aria-label': '方式' },
    [
      ['turn', '讨论', '轮流回答，后面的看得到前面的'],
      ['solo', '对比', '同时回答，互相看不到，并排放'],
      ['vote', '投票', '各出方案，匿名投票'],
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
  C.pick = h('button', { class: 'picker', 'aria-haspopup': 'menu', 'aria-label': '成员', 'data-tip': '成员', onclick: (e) => pickMenu(e.currentTarget) });
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
    '全自动'
  );
  C.send = h('button', { class: 'send', 'aria-label': '发送', 'data-tip': '发送', 'data-kbd': '↵', onclick: send }, icon('up'));
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
            'aria-label': '去掉',
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
          'aria-label': '取消',
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
  C.ta.placeholder = task ? '要做什么' : S.slash ? S.slash.placeholder : vote ? '投票的问题' : '消息';
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
    C.pick.replaceChildren(chosen.length ? stack(chosen, (m) => (m.cooling ? 'cooling' : ''), 6) : h('span', { class: 'none' }, '成员'), icon('down', 'caret'));
    C.pick.dataset.tip = chosen.length ? chosen.map(memberName).join('、') : '成员';
  }
  // 带上的文件：图片是缩略图；正在传的转圈（只在变了的时候重画，缩略图不会每打一个字就重新读）
  const attSig = JSON.stringify([S.files, S.uploading.map((u) => u.name)]);
  if (C.attach.dataset.sig !== attSig) {
    C.attach.dataset.sig = attSig;
    C.attach.replaceChildren(
      ...S.files.map((f, i) =>
        h(
          'span',
          { class: 'chip', 'data-tip': f },
          isShot(f) ? h('img', { class: 'thumb', src: rawUrl(f), alt: '' }) : icon('file'),
          h('span', { class: 'ell' }, fileLabel(f)),
          h(
            'button',
            {
              class: 'x',
              'aria-label': '去掉',
              onclick: () => {
                S.files.splice(i, 1);
                updateComposer();
              },
            },
            icon('x')
          )
        )
      ),
      ...S.uploading.map((u) => h('span', { class: 'chip busy', 'data-tip': '上传中' }, h('span', { class: 'spin' }), h('span', { class: 'ell' }, u.name)))
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
      { label: '全部', icon: 'user', keep: true, on: all, run: () => set(all() ? [] : people.filter((m) => !m.cooling).map((m) => m.name)) },
      '-',
      ...people.map((m) => ({
        label: memberName(m),
        sub: m.cooling ? `额度用完 · ${m.coolingText}` : m.tool || '',
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
    return fail('上传', e);
  }
  await Promise.all(
    files.map(async (f) => {
      const job = { name: f.name || '图片' };
      S.uploading.push(job);
      updateComposer();
      try {
        const r = await fetch(q(`/api/upload?name=${encodeURIComponent(job.name)}`), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
        const j = await r.json().catch(() => ({ ok: false, error: `传不上去（${r.status}）` }));
        if (!j.ok) throw new Error(j.error || '出错');
        if (!S.files.includes(j.path)) S.files.push(j.path);
      } catch (e) {
        fail(`上传「${job.name}」`, e);
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
  { key: 'step', label: '加一步', icon: 'plus', needsText: true, placeholder: '这一步', run: (text) => act(null, () => api('/api/task/edit', { op: 'add', text }), '已加入清单') },
  { key: 'go', label: '接着做', icon: 'play', when: () => idleNow() && !!defaultWorker(), run: goDefault },
  { key: 'auto', label: '全自动', icon: 'bolt', when: () => idleNow() && ready().length > 0, run: () => act(null, () => startWork('/api/auto', {}), '已开始全自动') },
  { key: 'review', label: '复核', icon: 'review', when: () => idleNow() && S.st.project.pending.length > 0 && !!reviewer(), run: reviewNow },
  { key: 'stop', label: '停止', icon: 'stop', when: () => !idleNow(), run: stopNow },
  { key: 'task', label: '新任务', icon: 'plus', run: newThread },
  { key: 'snap', label: '对账', icon: 'sync', run: snapNow },
  { key: 'brief', label: '接力本', icon: 'book', run: openBrief },
  { key: 'edit', label: '编辑任务', icon: 'pencil', run: editTaskRaw },
  { key: 'settings', label: '设置', icon: 'sliders', run: () => openSettings() },
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
    if (files.length) files[0].head = '文件';
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
    fail('发送', e);
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
  await api('/api/task', { text: [lines[0].trim(), ...body, refs].filter(Boolean).join('\n'), steps });
  if (S.autoAfter) await startWork('/api/auto', {}).catch((e) => e.code !== 'cancelled' && fail('开始全自动', e));
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
  RE.title = h('span', { class: 'cap' }, '文件');
  RE.filterBtn = iconBtn('筛选', 'search', () => toggleFilter(), '⌘P');
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
    '只看改过的'
  );
  // 全部展开 / 全部收起：按现在是不是全开着，点一下换一边
  RE.foldBtn = iconBtn('全部展开', 'unfold', () => {
    const dirs = treeDirs();
    if (dirs.every((d) => S.treeOpen.has(d))) S.treeOpen.clear();
    else for (const d of dirs) S.treeOpen.add(d);
    saveTreeOpen();
    renderRight(true);
  });
  RE.input = h('input', {
    type: 'text',
    placeholder: '筛选文件',
    'aria-label': '筛选文件',
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
  RE.filter = h('div', { class: 'filter', hidden: true }, icon('search'), RE.input, h('button', { class: 'x', 'aria-label': '清除', onclick: () => toggleFilter(false) }, icon('x')));
  RE.tree = h('div', { class: 'tree', role: 'tree', 'aria-label': '项目文件', onkeydown: treeKeys });
  RE.tree.addEventListener('scroll', () => WIRE.card && drawWires(), { passive: true });
  RE.note = h('div', { class: 'tree-note', hidden: true });
  RE.gate = h('div', { class: 'gate', hidden: true });
  $('#right-in').append(h('div', { class: 'right-head' }, RE.title, RE.changedBtn, RE.filterBtn, RE.foldBtn, iconBtn('收起', 'sideR', toggleRight, '⌥⌘B')), RE.filter, RE.tree, RE.note, RE.gate);
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
  const label = all ? '全部收起' : '全部展开';
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
  renderGate(p);
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
    RE.note.textContent = '读取中…';
  } else if (S.tree.error) {
    RE.note.hidden = false;
    RE.note.textContent = S.tree.error;
  } else if (!rows.length) {
    RE.note.hidden = false;
    RE.note.textContent = filtering ? '没有匹配的文件' : '空文件夹';
  } else if (S.tree.truncated && !filtering) {
    RE.note.hidden = false;
    RE.note.textContent = `只列出了前 ${files.length} 个文件`;
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

/** 右栏底下：检查命令，和最近一次跑的结果。 */
function renderGate(p) {
  const cmd = p.init && p.config && p.config.gate;
  const g = p.acceptance && p.acceptance.gate;
  const sig = JSON.stringify([cmd, g && [g.status, g.text, g.stint]]);
  RE.gate.hidden = !cmd;
  if (!cmd || RE.gate.dataset.sig === sig) return;
  RE.gate.dataset.sig = sig;
  RE.gate.replaceChildren(
    h('span', { class: 'cap' }, '检查'),
    h('code', null, cmd),
    g && g.status ? h('span', { class: 'res' }, g.status === 'pass' ? icon('check') : g.status === 'fail' || g.status === 'error' ? h('span', { class: 'rd' }) : null, [g.text, g.stint ? `第 ${g.stint} 棒` : ''].filter(Boolean).join(' · ')) : null
  );
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
      onmouseenter: () => lightCards(p, r.dir),
      onmouseleave: unlightCards,
    },
    r.dir ? icon('chev', 'caret') : t ? h('span', { class: `ring ${t.looks[t.looks.length - 1]}`, 'data-tip': t.ids.map((id) => `第 ${id} 棒`).join('、') }) : h('span', { class: 'fi' }),
    h('span', { class: 'nm' }, r.node.name),
    t && t.pending ? h('span', { class: 'rd', 'data-tip': '待复核' }) : null,
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
  if (gone) return [{ label: '复制路径', icon: 'copy', run: () => copyToast(p) }];
  return [
    dir ? { label: S.treeOpen.has(p) ? '收起' : '展开', icon: 'chev', run: () => toggleDir(p) } : { label: '打开', icon: 'file', run: () => openFile(p) },
    { label: '引用', icon: 'insert', run: () => addFile(p) },
    '-',
    { label: '复制路径', icon: 'copy', run: () => copyToast(p) },
    { label: '在访达中显示', icon: 'folder', run: () => reveal(p) },
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
  if (WIRE.card) drawWires();
}

function clearLit() {
  for (const el of RE.tree.querySelectorAll('.lit, .lit-in')) el.classList.remove('lit', 'lit-in');
}

function unlight() {
  LIT.paths = null;
  clearLit();
}

function lightCards(p, dir) {
  const t = selectedThread();
  if (!t || centerMode() !== 'thread') return;
  const hit = (path) => (dir ? path.startsWith(`${p}/`) : path === p);
  for (const s of threadStints(t)) {
    if (!s.facts || !s.facts.paths.some(hit)) continue;
    CE.stream.querySelector(`.card[data-stint="${s.id}"]`)?.classList.add('lit');
  }
}

function unlightCards() {
  for (const el of CE.stream.querySelectorAll('.card.lit')) el.classList.remove('lit');
}

// 连线：停在一棒上，从小条右边拉几根细线到它改过的文件（像实验笔记里钉照片的线）。只在看得见的时候画，滚动时跟着走。

const WIRE = { svg: null, card: null, raf: 0 };

function wireTo(card) {
  WIRE.card = card;
  drawWires(true);
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
    const card = WIRE.card;
    const rows = card && card.isConnected && !narrow() && !UI.noRight && S.tab === 0 ? RE.tree.querySelectorAll('.tree-row.lit, .tree-row.lit-in') : [];
    const slip = rows.length && card.querySelector('.slip').getBoundingClientRect();
    const view = CE.scroll.getBoundingClientRect();
    if (!rows.length || slip.bottom < view.top + 20 || slip.top > view.bottom - 20) return WIRE.svg.replaceChildren();
    const tree = RE.tree.getBoundingClientRect();
    const x1 = slip.right;
    const y1 = clamp(slip.top + 24, view.top + 12, view.bottom - 12);
    let out = '';
    for (const r of rows) {
      const mark = (r.querySelector('.ring, .caret') || r).getBoundingClientRect();
      const y2 = mark.top + mark.height / 2;
      if (y2 < tree.top || y2 > tree.bottom) continue;
      const x2 = mark.left - 4;
      out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" style="--len:${Math.hypot(x2 - x1, y2 - y1).toFixed(0)}"/>`;
    }
    WIRE.svg.innerHTML = out ? `${out}<circle class="hub" cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="3"/>` : '';
    WIRE.svg.classList.toggle('draw', !!fresh && !still());
  });
}

// ---------- 设置 ----------

let settingsTab = 'members';
let consentCache = null;

function openSettings(tab) {
  if (tab) settingsTab = tab;
  const nav = h('nav', { 'aria-label': '设置' });
  const pane = h('div', { class: 'pane-in' });
  const tabs = [
    ['members', '成员', 'user'],
    ['project', '项目', 'folder'],
    ['relay', '调度', 'bolt'],
    ['general', '通用', 'sliders'],
  ];
  const draw = () => {
    nav.replaceChildren(
      h('h3', null, '设置'),
      ...tabs.map(([k, label, ic]) =>
        h(
          'button',
          {
            role: 'tab',
            'aria-selected': String(settingsTab === k),
            onclick: () => {
              settingsTab = k;
              draw();
            },
          },
          icon(ic),
          label
        )
      )
    );
    // 各页返回的列表里可能有空位（比如接力规矩是最新的就没有「更新」那一行）：去掉，不然会显示成「null」。
    pane.replaceChildren(h('button', { class: 'icon-btn close', 'aria-label': '关闭', onclick: () => close() }, icon('x')), ...settingsBody(settingsTab, draw).filter((x) => x !== null && x !== undefined && x !== false));
    syncSegs(pane);
  };
  const close = sheet({
    title: '设置',
    wide: true,
    bare: true,
    body: h('div', { class: 'settings' }, nav, pane),
  });
  draw();
}

let savedAt = 0;

/** 「已保存」：存完面板会重画，所以记住存的时间，新画出来的也亮一会儿。 */
function savedMark() {
  const m = h('span', { class: 'saved' }, icon('check'), '已保存');
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

function settingsBody(tab, redraw) {
  const st = S.st;
  if (tab === 'members') return membersPane(redraw);
  if (tab === 'project') {
    const p = st.project;
    if (!p.init) return [h('div', { class: 'set-title' }, '项目'), h('div', { class: 'empty-note' }, '这个文件夹还没接入')];
    const mark = savedMark();
    const gate = h('input', { class: 'input mono', value: p.config.gate, placeholder: 'npm test', 'aria-label': '检查命令' });
    const tags = [...p.config.protectedPaths];
    const tagBox = h('div', { class: 'tags' });
    const saveCfg = async () => {
      try {
        await api('/api/config/save', { config: { gate: { command: gate.value.trim() }, protectedPaths: tags } });
        mark.flash();
        await refresh();
      } catch (e) {
        fail('保存设置', e);
      }
    };
    const tagInput = h('input', {
      type: 'text',
      placeholder: '.env、secrets/',
      'aria-label': '保护的文件',
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
    const drawTags = () =>
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
                'aria-label': `去掉 ${t}`,
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
    drawTags();
    gate.addEventListener('keydown', (e) => e.key === 'Enter' && gate.blur());
    gate.addEventListener('change', saveCfg);
    return [
      h('div', { class: 'set-title' }, '项目', mark.el),
      h('label', { class: 'field' }, h('span', null, '检查命令'), gate),
      h('div', { class: 'field' }, h('span', null, '保护的文件'), tagBox),
      p.protocol === 'ok'
        ? null
        : h(
            'div',
            { class: 'row' },
            h('span', { class: 'lbl' }, p.protocol === 'old' ? '接力规矩有新版本' : '接力规矩不见了'),
            h('button', { class: 'btn small primary', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), '已更新').then(redraw) }, '更新')
          ),
    ];
  }
  if (tab === 'relay') {
    const s = st.settings;
    const mark = savedMark();
    const save = async (patch) => {
      try {
        const r = await api('/api/settings', { settings: { ...S.st.settings, ...patch } });
        S.st.settings = r.settings;
        mark.flash();
      } catch (e) {
        fail('保存设置', e);
      }
      redraw();
    };
    const stepper = (key, lo, hi, unit, step = 1) => {
      const input = h('input', { type: 'number', min: String(lo), max: String(hi), value: String(s[key]), 'aria-label': unit });
      const set = (v) => {
        const n = clamp(Math.round(Number(v) || s[key]), lo, hi);
        input.value = String(n);
        if (n !== S.st.settings[key]) save({ [key]: n });
      };
      input.addEventListener('change', () => set(input.value));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      return h(
        'span',
        { class: 'stepper' },
        h('button', { 'aria-label': '减少', onclick: () => set(Number(input.value) - step) }, icon('minus')),
        input,
        h('button', { 'aria-label': '增加', onclick: () => set(Number(input.value) + step) }, icon('plus')),
        h('span', { class: 'u' }, unit)
      );
    };
    const sw = (key) => h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!s[key]), 'aria-label': key, onclick: () => save({ [key]: !s[key] }) }, h('span', { class: 'track' }));
    return [
      h('div', { class: 'set-title' }, '调度', mark.el),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'lbl' }, '全自动'),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': '全自动' },
          h('button', { 'aria-pressed': String(!s.dispatch), 'data-tip': '按顺序，谁有额度谁做', onclick: () => s.dispatch && save({ dispatch: false }) }, '接力'),
          h('button', { 'aria-pressed': String(!!s.dispatch), 'data-tip': '强模型拆成小步，弱模型一棒做一步，强模型每 3 棒复核一次', onclick: () => !s.dispatch && save({ dispatch: true }) }, '派活')
        )
      ),
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'lbl' }, '权限'),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': '权限' },
          h('button', { 'aria-pressed': String(s.level === 'safe'), onclick: () => s.level !== 'safe' && save({ level: 'safe' }) }, '安全'),
          h(
            'button',
            {
              'aria-pressed': String(s.level === 'full'),
              onclick: async () => {
                if (s.level === 'full') return;
                if (await confirmSheet('完全放开？', '编程工具不再拦截任何操作。', '完全放开')) save({ level: 'full' });
              },
            },
            '完全放开'
          )
        )
      ),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, '一棒上限'), stepper('stintTimeoutMin', 1, 600, '分钟', 5)),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, '复核上限'), stepper('reviewTimeoutMin', 1, 240, '分钟', 5)),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, '全自动上限'), stepper('maxStints', 1, 100, '棒')),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, '等额度恢复'), sw('waitForQuota')),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, '做完后终审'), sw('finalReview')),
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
    redraw();
  };
  return [
    h('div', { class: 'set-title' }, '通用'),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'lbl' }, '外观'),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': '外观' },
        [
          ['', '跟随系统'],
          ['light', '浅色'],
          ['dark', '深色'],
        ].map(([k, label]) => h('button', { 'aria-pressed': String(theme === k), onclick: () => setTheme(k) }, label))
      )
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'lbl' }, '关闭接力台'),
      h(
        'button',
        {
          class: 'btn small',
          onclick: async (e) => {
            const b = e.currentTarget;
            if (!(await confirmSheet('关闭接力台？', '正在进行的调度会停止。', '关闭'))) return;
            await act(b, () => api('/api/quit', {}), '已关闭接力台');
            setTimeout(() => setOffline(true), 600);
          },
        },
        icon('power'),
        '关闭'
      )
    ),
  ];
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
      { class: 'seg', role: 'group', 'aria-label': `${name} 强弱` },
      ['strong', 'weak'].map((t) => h('button', { 'data-t': t, 'aria-pressed': String(m.tier === t), onclick: () => m.tier !== t && setTier(t) }, t === 'strong' ? '强' : '弱'))
    );
    const paint = (t) => {
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.t === t));
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
        oncontextmenu: (e) => ctx(e, [m.tierSet ? { label: '强弱改回自动', icon: 'sync', run: () => setTier('auto') } : null, { label: '删除', icon: 'trash', run: () => removeMember(m, row) }]),
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
      h('div', { class: 'mn' }, h('b', null, name), note ? h('small', { 'data-tip': m.update || (!m.canWork && m.why ? m.why : null) }, note) : null),
      seg,
      h('button', { class: 'icon-btn del', 'aria-label': `删除 ${name}`, 'data-tip': '删除', onclick: () => removeMember(m, row) }, icon('trash'))
    );
    list.append(row);
  }
  if (!all.length) list.append(h('div', { class: 'empty-note' }, '名单是空的'));
  const consent = h('div');
  const fillConsent = (want) =>
    consent.replaceChildren(
      ...want.map((p) =>
        h(
          'div',
          { class: 'consent' },
          icon('warn'),
          h('span', { class: 'grow' }, `${llmName(p.model) || p.label}${p.model ? ` · ${p.label}` : ''}`),
          h('button', { class: 'btn small primary', onclick: (e) => act(e.currentTarget, () => api('/api/detect/use', { id: p.id }), '已加入').then(() => ((consentCache = null), redraw())) }, '同意使用')
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
      '成员',
      h('span', { class: 'sp' }),
      h(
        'button',
        {
          class: `btn small${st.detecting ? ' busy' : ''}`,
          onclick: (e) =>
            act(e.currentTarget, () => api('/api/detect', {}), (r) => (r.changes.length ? `名单更新了 ${r.changes.length} 处` : '名单没有变化')).then(() => {
              consentCache = null;
              redraw();
            }),
        },
        icon('sync'),
        '重新识别'
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
                { label: '接口', icon: 'plus', run: () => addApiSheet(redraw) },
                { label: '桌面程序', icon: 'plus', run: () => addAppSheet(redraw) },
              ],
              { align: 'end' }
            ),
        },
        icon('plus'),
        '添加'
      )
    ),
    list,
    consent,
  ];
}

/** 成员名字底下一行：在哪个工具里跑（名字就是工具名时不重复写），现在能不能用。 */
function memberNote(m) {
  const name = memberName(m);
  const tool = m.kind === 'app' ? (m.tool && m.tool !== name ? `${m.tool} 桌面版` : '桌面程序') : m.tool && m.tool !== name ? m.tool : '';
  const state = m.cooling ? `额度用完 · ${m.coolingText}` : !m.canWork && m.kind !== 'app' ? '不可调度' : '';
  return [tool, state, m.update ? '命令行需要更新' : ''].filter(Boolean).join(' · ');
}

/** 删掉一位：它那一行淡出，下面的行滑上来补位。 */
async function removeMember(m, row) {
  const name = memberName(m);
  if (!(await confirmSheet(`删除 ${name}？`, '它自己的程序不受影响；重新识别也不会再加回来。', '删除'))) return;
  const r = await act(null, () => api('/api/workers/delete', { name: m.name }), `已删除 ${name}`);
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
            for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.t === tier));
            syncSegs(layer);
          },
        },
        t === 'strong' ? '强' : '弱'
      )
    )
  );
  const close = sheet({
    title,
    body: h('div', null, inputs.map(([label, input]) => field(label, input)), h('div', { class: 'field' }, h('span', null, '强弱'), seg)),
    foot: [
      h('button', { class: 'btn ghost', onclick: () => close() }, '取消'),
      h('button', { class: 'btn primary', onclick: (e) => act(e.currentTarget, () => api('/api/workers/save', { agent: { ...agentOf(), tier, tierSet: true } }), '已添加').then((r) => r && (close(), redraw())) }, '添加'),
    ],
  });
  syncSegs(layer);
}

function addApiSheet(redraw) {
  const [name, label, base, model, env] = [['kimi'], ['Kimi'], ['https://api.moonshot.cn/v1', 'mono'], ['kimi-k2', 'mono'], ['MOONSHOT_API_KEY', 'mono']].map(([ph, mono]) => h('input', { class: `input ${mono || ''}`.trim(), placeholder: ph }));
  addSheet(
    '添加接口',
    [
      ['名字', name],
      ['显示名', label],
      ['接口地址', base],
      ['模型', model],
      ['密钥环境变量', env],
    ],
    () => ({ name: name.value.trim(), label: label.value.trim() || undefined, kind: 'api', api: { baseUrl: base.value.trim(), model: model.value.trim(), apiKeyEnv: env.value.trim() } }),
    redraw
  );
}

function addAppSheet(redraw) {
  const name = h('input', { class: 'input', placeholder: 'trae' });
  const app = h('input', { class: 'input', placeholder: 'Trae' });
  addSheet(
    '添加桌面程序',
    [
      ['名字', name],
      ['程序', app],
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
      { label: S.view === 'chat' ? '接力' : '群聊', icon: S.view === 'chat' ? 'route' : 'chat', run: () => setView(S.view === 'chat' ? 'relay' : 'chat') },
      { label: '新任务', icon: 'plus', run: newThread },
      { label: '新群聊', icon: 'plus', run: newChat },
      p.init && !p.task.empty && !run.running && ready().length ? { label: '接着做', icon: 'play', run: goDefault } : null,
      p.init && !p.task.empty && !run.running && ready().length ? { label: '全自动', icon: 'bolt', run: () => act(null, () => startWork('/api/auto', {}), '已开始全自动') } : null,
      p.pending.length && reviewer() ? { label: '复核', icon: 'review', run: reviewNow } : null,
      run.running || run.waiting ? { label: '停止', icon: 'stop', kbd: '⌘.', run: stopNow } : null,
      p.init ? { label: '编辑任务', icon: 'pencil', run: editTaskRaw } : null,
      p.init ? { label: '接力本', icon: 'book', run: openBrief } : null,
      p.init ? { label: '对账', icon: 'sync', run: snapNow } : null,
      { label: '打开文件夹', icon: 'folder', run: chooseFolder },
      { label: '在访达中显示', icon: 'folder', run: () => reveal('') },
      { label: '复制开场白', icon: 'copy', run: copyHint },
      { label: '成员', icon: 'user', run: () => openSettings('members') },
      { label: '设置', icon: 'sliders', run: () => openSettings() },
      { label: UI.noLeft ? '显示左栏' : '隐藏左栏', icon: 'sideL', kbd: '⌘B', run: toggleLeft },
      { label: UI.noRight ? '显示右栏' : '隐藏右栏', icon: 'sideR', kbd: '⌥⌘B', run: toggleRight },
    ].filter(Boolean);
    pick(cmds, '操作', qy ? 6 : 8);
    if (p.init && !p.task.empty) pick(ready().map((m) => ({ label: `派给 ${memberName(m)}`, alt: `${m.name} ${m.tool || ''}`, tile: tile(m, 's20'), sub: m.tool || '', run: () => goWith(null, m) })), '成员', 5);
    pick([...threads()].reverse().filter((t) => !blank(t)).map((t) => ({ label: t.title || '未命名', icon: 'route', sub: when(lastActive(t)), run: () => selectThread(t) })), '任务', 6);
    const chats = [talkHas(S.talk) ? { id: null, title: talkTitle(S.talk) || '群聊', at: talkAt(S.talk) } : null, ...(S.talk.sessions || [])].filter(Boolean);
    pick(chats.map((x) => ({ label: x.title, icon: 'chat', sub: x.at ? when(x.at) : '', run: () => selectChat(x.id) })), '群聊', 6);
    pick(S.st.projects.filter((x) => !x.current).map((x) => ({ label: x.name, icon: 'folder', sub: tildify(x.root), alt: x.root, run: () => switchProject(x.root) })), '项目', 5);
  }
  if (qy || scope === 'files') {
    const files = ((S.tree && S.tree.files) || []).map((f) => ({ label: basename(f), alt: f, sub: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', icon: 'file', run: () => openFile(f) }));
    pick(files, '文件', scope === 'files' ? 40 : 10);
  }
  // 输入的正好是一个文件名：文件排在最前面
  const fg = groups.find((g) => g.label === '文件');
  if (fg && fg.items.some((it) => it.label.toLowerCase() === qy)) groups.unshift(...groups.splice(groups.indexOf(fg), 1));
  return groups;
}

function openPalette(initial = '', scope = '') {
  if (!S.st) return;
  closeMenus();
  if (PAL.el) return PAL.input.focus();
  const input = h('input', { type: 'text', value: initial, placeholder: scope === 'files' ? '文件名' : '搜索', 'aria-label': '搜索' });
  const list = h('div', { class: 'plist', role: 'listbox' });
  const scrim = h('div', { class: 'scrim', onclick: () => close() });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-label': '搜索' }, h('div', { class: 'pin' }, icon('search'), input), list);
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
            it.kbd ? h('kbd', null, it.kbd) : null
          );
        }),
      ])
    );
    if (!flat.length) list.append(h('div', { class: 'none' }, '没有结果'));
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

mqNarrow.addEventListener('change', () => {
  closeDrawers();
  barSig = '';
  heroSig = '';
  renderAll();
});

addEventListener('resize', () => {
  if (SUG.menu) updateSuggest();
  if (WIRE.card) drawWires();
  syncSegs();
});

// ---------- 开始 ----------

function renderAll() {
  if (!S.st) return;
  refreshLooks();
  renderLeft();
  renderCenter();
  renderRight();
  if (S.swap) {
    swapIn(S.swap);
    S.swap = 0;
  }
}

(async function start() {
  applyLayout();
  buildCenter();
  buildComposer();
  buildRight();
  await refresh();
  if (S.st) S.treeOpen = new Set(store.json(`open:${S.st.project.root}`, []));
  await Promise.all([loadTalk(), loadTree()]);
  stintsKey = S.st ? S.st.project.stints.map((s) => `${s.id}${s.status}${s.endedAt || ''}`).join() : '';
  scrollBottom();
  schedule();
})();
