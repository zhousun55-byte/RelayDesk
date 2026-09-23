'use strict';
/* 接力台网页。没有构建步骤、不连外网：直接由 relay ui 提供。
   所有状态都来自 /api/state（服务端算好的），这里只负责显示和把按钮变成请求。 */

// ---------- 小工具 ----------

const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'open') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, String(v));
  }
  el.append(...kids);
  return el;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 行内格式：先转义，再加 code / strong 标签，所以不会注入。 */
function inline(escaped) {
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function diffHtml(text) {
  return String(text)
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => {
      let cls = 'l';
      if (l.startsWith('# ↓')) cls += ' note';
      else if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary)/.test(l)) cls += ' meta';
      else if (l.startsWith('@@')) cls += ' hunk';
      else if (l.startsWith('+')) cls += ' add';
      else if (l.startsWith('-')) cls += ' del';
      return `<div class="${cls}">${esc(l) || ' '}</div>`;
    })
    .join('');
}

/** 很小的 Markdown：标题、列表、引用、代码块（diff 高亮）、行内代码、粗体。 */
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
      out.push(lang === 'diff' ? `<div class="diff">${diffHtml(buf.join('\n'))}</div>` : `<pre>${esc(buf.join('\n'))}</pre>`);
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
    const lm = l.match(/^\s*[-*]\s+(.*)$/) || l.match(/^\s*\d+\.\s+(.*)$/);
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

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime()) || !ts) return '';
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function since(ts) {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (!Number.isFinite(s)) return '';
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分钟`;
}

const short = (sha) => String(sha || '').slice(0, 7);

function tildify(p) {
  const home = S.st && S.st.home;
  return home && p && p.startsWith(home) ? `~${p.slice(home.length)}` : p || '';
}

function hash(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x;
}

/** 每个工人一种线路色：按名字哈希，撞了就顺延，换页面也不变。 */
function colorMap(workers) {
  const used = new Set();
  const map = {};
  for (const w of workers) {
    let i = hash(w.name) % 8;
    for (let k = 0; k < 8 && used.has(i); k++) i = (i + 1) % 8;
    used.add(i);
    map[w.name] = `var(--l${i})`;
  }
  return map;
}

const colorOf = (name) => (name && S.colors[name]) || 'var(--main)';

function btn(label, onclick, cls = '', extra = {}) {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), onclick, ...extra }, label);
}

function link(label, onclick) {
  return h('button', { type: 'button', class: 'link', onclick }, label);
}

function banner(kind, content, action) {
  return h('div', { class: `banner ${kind}` }, h('div', { class: 'grow' }, content), action || null);
}

function empty(text) {
  return h('div', { class: 'empty' }, text);
}

// ---------- 状态 ----------

const params = new URLSearchParams(location.search);
const S = {
  dir: params.get('dir') || params.get('root') || '',
  view: ['task', 'talk', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'task',
  st: null,
  talk: null,
  colors: {},
  acting: null,
  sub: 'changes',
  diff: null,
  audit: null,
  openStop: null,
  pick: null,
  files: { side: 'task', sub: '', list: null, preview: null, error: null },
  talkPick: loadPick(),
  workerForm: null,
  cfgRoot: null,
  doctor: null,
  keep: {},
  offline: false,
};

function loadPick() {
  try {
    const v = JSON.parse(localStorage.getItem('relay.talkPick') || 'null');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function savePick() {
  try {
    localStorage.setItem('relay.talkPick', JSON.stringify(S.talkPick));
  } catch {
    /* 私密窗口等情况下存不了，不影响使用 */
  }
}

function resetProjectLocal() {
  S.diff = null;
  S.audit = null;
  S.openStop = null;
  S.pick = null;
  S.sub = 'changes';
  S.files = { side: 'task', sub: '', list: null, preview: null, error: null };
  S.talk = null;
  S.cfgRoot = null;
  S.doctor = null;
}

function writeUrl() {
  const q = S.dir ? `?dir=${encodeURIComponent(S.dir)}` : '';
  history.replaceState(null, '', `${location.pathname}${q}${S.view !== 'task' ? `#${S.view}` : ''}`);
}

/** 输入框的内容存在 S.keep 里：页面每隔几秒重画一次，打到一半的字不会丢。 */
function keepInput(id, el) {
  el.dataset.keep = id;
  if (S.keep[id] !== undefined) el.value = S.keep[id];
  else S.keep[id] = el.value;
  el.addEventListener('input', () => {
    S.keep[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return el;
}

/** 内容有变化才重画一块区域；重画后把焦点和光标放回原来的输入框。 */
function mount(box, key, build) {
  if (box.__key === key) return;
  const active = document.activeElement;
  const keepId = active && active.dataset ? active.dataset.keep : null;
  let sel = null;
  if (keepId && typeof active.selectionStart === 'number') sel = [active.selectionStart, active.selectionEnd];
  box.replaceChildren(build());
  box.__key = key;
  if (keepId) {
    const el = box.querySelector(`[data-keep="${CSS.escape(keepId)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* 有的输入框不支持选区 */
        }
      }
    }
  }
}

// ---------- 请求 ----------

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    const e = new Error('连不上接力台。它可能已经关掉了。');
    e.code = 'offline';
    throw e;
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok || data.ok === false) {
    const e = new Error(data.error || `出错了（${res.status}）`);
    e.code = data.code;
    throw e;
  }
  return data;
}

const get = (path, q = {}) => api(`${path}?${new URLSearchParams({ dir: S.dir, ...q })}`);
const post = (path, body = {}) => api(path, { dir: S.dir, ...body });

let refreshing = null;

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const st = await get('/api/state');
      setOffline(false);
      const root = st.project.root;
      if (root && root !== S.dir) {
        if (S.st && S.st.project.root !== root) resetProjectLocal();
        S.dir = root;
        writeUrl();
      }
      S.st = st;
      S.colors = colorMap(st.workers);
      if (!st.project.task) {
        S.diff = null;
        S.openStop = null;
      }
      render();
      noticeTaskChange(st.project.task);
    } catch (e) {
      if (e.code === 'offline') setOffline(true);
      else if (e.code === 'no-dir' && S.dir) {
        toast(`${e.message}，改打开上次的项目。`, true);
        S.dir = '';
        writeUrl();
      } else toast(e.message, true);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function loadTalk() {
  try {
    S.talk = await get('/api/talk');
    render();
  } catch (e) {
    if (e.code !== 'offline') toast(e.message, true);
  }
}

async function loadDoctor() {
  S.doctor = { loading: true, lines: (S.doctor && S.doctor.lines) || [] };
  render();
  try {
    const r = await get('/api/doctor');
    S.doctor = { loading: false, lines: r.lines };
  } catch (e) {
    S.doctor = { loading: false, lines: [{ level: 'bad', text: e.message }] };
  }
  render();
}

function setOffline(on) {
  S.offline = on;
  $('offline').hidden = !on;
}

/** 做一件事：期间按钮都变灰；做完刷新状态。出错就弹提示。 */
async function act(label, fn) {
  if (S.acting) {
    toast(`正在${S.acting}，请稍等。`);
    return null;
  }
  S.acting = label;
  render();
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    S.acting = null;
    await refresh();
  }
}

// ---------- 提示、对话框 ----------

let toastTimer = null;

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isError ? 10000 : 4500);
}

let dlg = null;

function closeDialog() {
  if (dlg && dlg.busyNow) return;
  $('dialog').hidden = true;
  $('scrim').hidden = true;
  $('dialog').replaceChildren();
  dlg = null;
}

function dialog(spec) {
  if (dlg) {
    dlg.busyNow = false;
    closeDialog();
  }
  const box = $('dialog');
  const d = {
    busyNow: false,
    saved: null,
    close() {
      d.busyNow = false;
      closeDialog();
    },
    busy(text) {
      d.busyNow = true;
      const body = box.querySelector('.dialog-body');
      d.saved = [...body.childNodes];
      body.replaceChildren(h('div', { class: 'progress' }, h('span', { class: 'spin' }), text));
      box.querySelectorAll('.buttons button').forEach((b) => (b.disabled = true));
    },
    error(msg) {
      d.busyNow = false;
      const body = box.querySelector('.dialog-body');
      body.replaceChildren(h('p', { class: 'form-error' }, msg), ...(d.saved || []));
      box.querySelectorAll('.buttons button').forEach((b) => (b.disabled = false));
    },
    replace(next) {
      d.busyNow = false;
      draw(next);
    },
  };
  function draw({ title, body, buttons }) {
    const list = buttons || [{ label: '好', cls: 'primary' }];
    box.replaceChildren(
      h('h3', { id: 'dialog-title' }, title),
      h('div', { class: 'dialog-body' }, body),
      h(
        'div',
        { class: 'buttons' },
        list.map((b) =>
          btn(b.label, async () => {
            if (!b.keepOpen) d.close();
            if (b.run) await b.run(d);
          }, b.cls || '')
        )
      )
    );
    const first = box.querySelector('textarea, input[type="text"]') || box.querySelector('.buttons .btn.primary, .buttons .btn.solid') || box.querySelector('.buttons .btn');
    if (first) first.focus();
  }
  draw(spec);
  box.hidden = false;
  $('scrim').hidden = false;
  dlg = d;
  return d;
}

function copybox(text) {
  const code = h('code', null, text);
  return h(
    'div',
    { class: 'copybox' },
    code,
    btn('复制', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制。');
      } catch {
        const r = document.createRange();
        r.selectNodeContents(code);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        toast('已选中，按 ⌘C 复制。');
      }
    }, 'small')
  );
}

// ---------- 顶栏 ----------

function renderBar() {
  const p = S.st && S.st.project;
  $('project-name').textContent = p ? p.name : '…';
  $('project-path').textContent = p ? tildify(p.root) : '';
  document.title = p ? `${p.name} · 接力台` : '接力台';
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === S.view));
  const n = S.st && S.st.talk ? S.st.talk.count : 0;
  $('talk-count').textContent = n ? String(n) : '';
}

function openMenu() {
  const menu = $('project-menu');
  const projects = (S.st && S.st.projects) || [];
  menu.replaceChildren(
    ...projects.map((p) =>
      h(
        'button',
        { type: 'button', class: `menu-item${p.current ? ' on' : ''}`, onclick: () => switchProject(p.root) },
        h('span', { class: `dot${p.hasTask ? ' busy' : ''}`, title: p.hasTask ? '有进行中的任务' : '' }),
        h('span', null, p.name, p.hasTask ? h('span', { class: 'muted small' }, ' · 有进行中的任务') : null),
        h('span', { class: 'p' }, tildify(p.root))
      )
    ),
    projects.length ? h('hr') : null,
    h('button', { type: 'button', class: 'menu-item', onclick: chooseFolder }, h('span', { class: 'dot' }), h('span', null, '选择其他文件夹…'))
  );
  menu.hidden = false;
  $('project-btn').setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  $('project-menu').hidden = true;
  $('project-btn').setAttribute('aria-expanded', 'false');
}

async function switchProject(root) {
  closeMenu();
  if (root === S.dir) return;
  S.dir = root;
  resetProjectLocal();
  writeUrl();
  await refresh();
  if (S.view === 'talk') loadTalk();
}

async function chooseFolder() {
  closeMenu();
  try {
    toast('在弹出的窗口里选一个文件夹……');
    const r = await post('/api/choose-folder');
    $('toast').hidden = true;
    await switchProject(r.dir);
  } catch (e) {
    if (e.code === 'cancelled') $('toast').hidden = true;
    else toast(e.message, true);
  }
}

function setView(v) {
  S.view = v;
  writeUrl();
  if (v === 'talk') loadTalk();
  if (v === 'settings' && !S.doctor) loadDoctor();
  render();
  window.scrollTo(0, 0);
}

// ---------- 总渲染 ----------

function render() {
  renderBar();
  for (const v of ['task', 'talk', 'settings']) $(`view-${v}`).hidden = S.view !== v;
  if (!S.st) {
    mount($(`view-${S.view}`), 'loading', () => h('div', { class: 'skeleton' }, '正在读取……'));
    return;
  }
  if (S.view === 'task') renderTask();
  else if (S.view === 'talk') renderTalk();
  else renderSettings();
}

// ---------- 任务页 ----------

function renderTask() {
  const st = S.st;
  const p = st.project;
  const box = $('view-task');
  if (!p.task) {
    mount(
      box,
      JSON.stringify(['idle', p.root, p.isGit, p.hasConfig, p.hasCommits, p.past, st.workers.map((w) => [w.name, w.kind]), p.mainDirty, S.acting, p.configError, p.taskError, st.auto, st.team, st.detecting]),
      () => viewIdle(st)
    );
    return;
  }
  mount(box, JSON.stringify(['task', p.root, p.task, st.workers, st.busy, S.acting, S.sub, S.diff, S.audit, S.openStop, S.pick, S.files, S.colors, p.config && p.config.keySet, st.auto, st.team]), () =>
    viewTask(st)
  );
}

function pastGlyph(result) {
  const color = result === 'merged' ? 'var(--go)' : result === 'abandoned' ? 'var(--ink-3)' : 'var(--warn)';
  const kids = [
    svg('path', { d: 'M6 1v32', style: 'stroke:var(--main);stroke-width:3;stroke-linecap:round;fill:none' }),
    svg('path', {
      d: result === 'merged' ? 'M6 5c0 5 12 3 12 8v8c0 5-12 3-12 8' : 'M6 5c0 5 12 3 12 8v10',
      style: `stroke:${color};stroke-width:3;stroke-linecap:round;fill:none${result === 'unfinished' ? ';stroke-dasharray:3 4' : ''}`,
    }),
  ];
  if (result === 'abandoned') kids.push(svg('path', { d: 'M13 24h10', style: `stroke:${color};stroke-width:3;stroke-linecap:round` }));
  return svg('svg', { viewBox: '0 0 26 34', 'aria-hidden': 'true' }, ...kids);
}

function pastList(past) {
  if (!past.length) return h('p', { class: 'hint' }, '还没有做过任务。每个任务都会在这里留一条线：合回的回到主线，放弃的在半路截断。');
  const word = { merged: '已合回', abandoned: '已放弃', unfinished: '没做完' };
  return h(
    'ul',
    { class: 'past' },
    past.map((t) =>
      h('li', null, pastGlyph(t.result), h('div', null, h('div', { class: 't' }, t.title), h('div', { class: 'm' }, h('span', { class: 'num' }, fmtTime(t.date)), ` · ${word[t.result]}`)))
    )
  );
}

function steps() {
  const items = [
    ['写下要做什么', '点「全自动完成」。接力台在别处建一个隔离副本，正式文件夹一直不动。'],
    ['AI 自己干活', '主力按任务改隔离副本；做不出来会自动换下一位。'],
    ['另一个 AI 审查', '不合格就把意见交给下一轮接着改，最多几轮可以在设置里调。'],
    ['通过后合回', '随时能停、能继续；也可以「只开始任务」，自己安排工人上岗、交接、合回。'],
  ];
  return h('ol', { class: 'howto' }, items.map(([t, d], i) => h('li', null, h('span', { class: 'hnum num', 'aria-hidden': 'true' }, String(i + 1)), h('strong', null, t), h('span', { class: 'hdesc' }, d))));
}

function viewIdle(st) {
  const p = st.project;
  const task = keepInput('task', h('textarea', { class: 'task-input', rows: 4, 'aria-label': '要做什么', placeholder: '一句话说清楚。例如：帮我做一份 iPhone 5s 风格的 Lightroom 滤镜（XMP 文件）' }));
  task.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      if (st.team.workers.length) startAutoRun(true);
      else startTask();
    }
  });
  return h(
    'div',
    { class: 'grid' },
    h('aside', { class: 'side' }, h('p', { class: 'side-title' }, '以前的任务'), pastList(p.past)),
    h(
      'div',
      null,
      p.configError ? banner('stop', p.configError) : null,
      p.taskError ? banner('stop', p.taskError) : null,
      !p.isGit || !p.hasConfig || !p.hasCommits
        ? banner('info', `「${p.name}」第一次用：开始任务时会自动把它设为接力项目${p.isGit ? '' : '（先建一个 git 记录，把现有文件存为第一版，文件本身不改）'}。`)
        : null,
      st.auto ? autoPanel(st) : null,
      st.detecting
        ? banner('info', '正在自动识别这台电脑上的 AI 工具（Claude Code、Codex、Cursor Agent……）和模型接口，十几秒就好。')
        : !st.team.workers.length
          ? banner('info', '没找到能全自动干活的 AI 工具（要装好并登录 Claude Code、Codex、Cursor Agent 等之一）。装好后去「设置」点「重新识别」。', btn('去设置', () => setView('settings'), 'small'))
          : null,
      h(
        'section',
        { class: 'board' },
        h(
          'div',
          { class: 'compose' },
          h('p', { class: 'eyebrow' }, '新任务'),
          h('h1', null, '要做什么？'),
          task,
          h(
            'details',
            { open: !!S.keep.acceptance },
            h('summary', null, '怎样算做完（可不填）'),
            keepInput('acceptance', h('textarea', { rows: 3, 'aria-label': '验收标准', placeholder: '例如：导入 Lightroom 不报错；照片整体偏暖，暗部带一点青' }))
          ),
          h(
            'div',
            { class: 'foot' },
            btn(S.acting === '全自动' ? '正在开始……' : '全自动完成', () => startAutoRun(true), 'primary', { disabled: !!S.acting || !st.team.workers.length }),
            btn(S.acting === '开始任务' ? '正在开始……' : '只开始任务（手动安排）', startTask, '', { disabled: !!S.acting }),
            h('span', { class: 'hint kbd-hint' }, h('kbd', null, '⌘'), h('kbd', null, 'Enter'), ' 全自动')
          ),
          p.mainDirty ? h('p', { class: 'hint' }, `正式文件夹里有 ${p.mainDirty} 个没提交的改动，它们不会带进任务。`) : null
        ),
        h('div', { class: 'compose-team' }, teamLine(st.team))
      ),
      h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, '怎么用')), steps())
    )
  );
}

async function startTask() {
  const task = String(S.keep.task || '').trim();
  if (!task) {
    toast('先写下要做什么。', true);
    const el = document.querySelector('[data-keep="task"]');
    if (el) el.focus();
    return;
  }
  await act('开始任务', async () => {
    const r = await post('/api/start', { task, acceptance: S.keep.acceptance || '' });
    S.keep.task = '';
    S.keep.acceptance = '';
    resetProjectLocal();
    toast([`任务开始了：${r.title}`, ...r.notes].join(' '));
  });
}

// —— 全自动 ——

const AUTO_WORDS = { running: '进行中', done: '完成', ready: '审查通过，等你合回', 'needs-human': '需要你来看一下', failed: '没做成', stopped: '已停止' };

function autoRunning(st) {
  return !!(st.auto && st.auto.state && st.auto.state.status === 'running');
}

/** 一位成员的线路标签：线路色点 + 名字（+ 模型）。 */
function memberChip(m) {
  return h('span', { class: 'lchip', style: `--c:${colorOf(m.name)}` }, h('i', { 'aria-hidden': 'true' }), m.label, m.model ? h('small', null, m.model) : null);
}

function routeChips(list) {
  if (!list.length) return [h('span', { class: 'muted small' }, '（没有）')];
  const out = [];
  list.forEach((m, i) => {
    if (i) out.push(h('span', { class: 'lsep', 'aria-hidden': 'true' }, '→'));
    out.push(memberChip(m));
  });
  return out;
}

/** 全自动的安排：谁干活、谁审查（按顺序，前一位做不出来才换下一位）、几轮、什么档位。 */
function teamLine(team, edit = true) {
  const s = team.settings;
  return h(
    'div',
    { class: 'team' },
    h('div', { class: 'team-row' }, h('span', { class: 'team-k' }, '干活'), h('div', { class: 'team-chips' }, routeChips(team.workers))),
    h('div', { class: 'team-row' }, h('span', { class: 'team-k' }, '审查'), h('div', { class: 'team-chips' }, routeChips(team.reviewers))),
    h(
      'div',
      { class: 'team-meta' },
      `最多 ${s.maxRounds} 轮 · ${s.level === 'full' ? '完全放开' : '安全档'} · ${s.autoMerge ? '通过后自动合回' : '通过后等你合回'}`,
      edit ? h('span', null, '　', link('改安排', () => setView('settings'))) : null
    )
  );
}

function tookText(st) {
  return st.endedAt ? `${Math.max(1, Math.round((new Date(st.endedAt) - new Date(st.startedAt)) / 1000))} 秒` : since(st.startedAt);
}

/** 全自动的一步：线路上的一站，颜色跟着这一步的工人走。 */
function autoStepEl(st) {
  const icon = { ok: '✓', fail: '✕', skip: '–', running: '' }[st.status] ?? '·';
  const c = st.agent ? colorOf(st.agent) : st.kind === 'merge' ? 'var(--go)' : 'var(--main)';
  return h(
    'li',
    { class: `rstop is-${st.status}`, style: `--c:${c}` },
    h('span', { class: 'rdot', 'aria-hidden': 'true' }, icon),
    h(
      'div',
      { class: 'rbody' },
      h('div', { class: 'rlabel' }, h('span', null, st.label), h('span', { class: 'rtook num' }, tookText(st))),
      st.detail ? h('div', { class: 'rdetail' }, st.detail) : null
    )
  );
}

/** 长的结论拆成「第一句（标题）+ 其余（说明）」。 */
function headline(text) {
  const t = String(text || '');
  const i = t.indexOf('。');
  if (t.length <= 44 || i < 0 || i === t.length - 1) return [t, ''];
  return [t.slice(0, i + 1), t.slice(i + 1)];
}

const AUTO_TONE = { running: 'run', done: 'go', ready: 'go', 'needs-human': 'warn', failed: 'bad', stopped: 'warn' };

function autoPanel(st) {
  const a = st.auto && st.auto.state;
  const team = st.team;
  const running = autoRunning(st);
  const hasTask = !!st.project.task;
  if (!a && !hasTask) return null;
  const tone = a ? AUTO_TONE[a.status] || 'warn' : 'idle';
  const current = running ? [...a.steps].reverse().find((x) => x.status === 'running') : null;
  const pill = a
    ? h(
        'span',
        { class: `pill ${tone === 'go' ? 'go' : tone === 'bad' ? 'stop' : tone === 'run' ? 'line' : 'warn'}`, style: current && current.agent ? `--c:${colorOf(current.agent)}` : '--c:var(--go)' },
        running ? h('span', { class: 'spin' }) : null,
        `${AUTO_WORDS[a.status]}${a.interrupted ? '（被中断）' : ''}`
      )
    : null;
  const buttons = [];
  if (running) buttons.push(btn(S.acting === '停止' ? '正在停止……' : '停止', stopAutoRun, 'danger', { disabled: !!S.acting }));
  else if (hasTask) buttons.push(btn(a ? '继续全自动' : '全自动做完它', () => startAutoRun(false), 'primary', { disabled: !!S.acting || !team.workers.length || !!st.busy }));
  const tail = a && st.auto.tail;
  return h(
    'section',
    { class: `board auto-board tone-${tone}` },
    running ? h('div', { class: 'auto-rail', 'aria-hidden': 'true', style: current && current.agent ? `--c:${colorOf(current.agent)}` : '' }) : null,
    h(
      'div',
      { class: 'auto-head' },
      h(
        'div',
        { class: 'auto-titles' },
        h('p', { class: 'eyebrow' }, '全自动', a ? h('span', { class: 'num' }, running ? ` · 第 ${a.round} 轮 / 最多 ${a.maxRounds} 轮` : ` · 一共 ${a.round} 轮`) : null),
        h('h2', { class: 'auto-title' }, a ? headline(a.phase)[0] : '让 AI 们自己把这个任务做完'),
        a && headline(a.phase)[1] ? h('p', { class: 'auto-more' }, headline(a.phase)[1]) : null,
        h('p', { class: 'auto-goal' }, a ? [`目标：${a.goal}`, h('span', { class: 'muted' }, `　${fmtTime(a.startedAt)} 开始`)] : '干活 → 另一个 AI 审查 → 要改就再来一轮 → 通过后合回。')
      ),
      pill
    ),
    a ? h('ol', { class: 'route' }, a.steps.map(autoStepEl)) : null,
    tail
      ? h('details', { class: 'auto-log-box', open: running }, h('summary', null, '日志', h('span', { class: 'muted' }, ` · ${tail.label}`)), h('pre', { class: 'auto-log' }, tail.text || '（还没有输出）'))
      : null,
    h('div', { class: 'auto-foot' }, buttons.length ? h('div', { class: 'row' }, buttons) : null, teamLine(team)),
    !team.workers.length ? h('div', { class: 'auto-note' }, banner('info', '还没有能全自动干活的 AI 工具。去「设置」点「重新识别」。', btn('去设置', () => setView('settings'), 'small'))) : null,
    (team.problems || []).length ? h('div', { class: 'auto-note' }, (team.problems || []).map((pr) => h('p', { class: 'hint warn-text' }, `⚠ ${pr}`))) : null
  );
}

async function startAutoRun(withGoal) {
  const goal = withGoal ? String(S.keep.task || '').trim() : '';
  if (withGoal && !goal) {
    toast('先写下要做什么。', true);
    const el = document.querySelector('[data-keep="task"]');
    if (el) el.focus();
    return;
  }
  await act('全自动', async () => {
    const r = await post('/api/auto/start', { goal, acceptance: withGoal ? S.keep.acceptance || '' : '' });
    if (withGoal) {
      S.keep.task = '';
      S.keep.acceptance = '';
      resetProjectLocal();
    }
    toast(`全自动开始了：${r.state.goal}`);
  });
}

async function stopAutoRun() {
  await act('停止', async () => {
    const r = await post('/api/auto/stop');
    toast(r.stopped ? '已发出停止请求，正在干活的工具会被结束。' : '现在没有在跑的全自动。');
  });
}

// —— 支线图 ——

function buildStops(t) {
  const cps = new Set((t.checkpoints || []).map((c) => c.sha));
  const stops = [
    { id: 'origin', cls: 'station', dot: 'var(--main)', when: fmtTime(t.startedAt), what: '从正式文件夹分出', sub: `基准 ${t.base}${t.mainBranch ? ` · ${t.mainBranch}` : ''}` },
  ];
  t.timeline.forEach((it, i) => {
    const id = `${i}-${it.kind}`;
    switch (it.kind) {
      case 'start':
        break;
      case 'open':
      case 'run':
        stops.push({ id, cls: 'shift', dot: colorOf(it.agent), when: fmtTime(it.ts), tag: `${it.who} 上岗 · ${it.kind === 'open' ? '桌面' : it.auto ? '全自动' : '终端'}`, sub: it.detail });
        break;
      case 'exit':
        stops.push({ id, cls: 'minor', dot: colorOf(it.agent), when: fmtTime(it.ts), what: it.text });
        break;
      case 'handoff':
        stops.push({
          id,
          cls: 'station',
          dot: colorOf(it.agent),
          when: fmtTime(it.ts),
          what: `${it.who} 交接`,
          sub: it.size,
          badge: it.ok === undefined ? null : it.ok ? ['ok', '检查通过'] : ['bad', '检查没过'],
          sha: it.sha,
          report: it.report,
          detail: it.detail,
          canBack: cps.has(it.sha),
          handoff: true,
        });
        break;
      case 'take':
      case 'sync':
      case 'rollback':
      case 'gate':
        stops.push({ id, cls: 'minor', dot: it.kind === 'rollback' ? 'var(--warn)' : 'var(--main)', when: fmtTime(it.ts), what: it.text, detail: it.detail });
        break;
      default:
        break;
    }
  });
  if (t.onShift && t.onShift.kind !== 'op') {
    stops.push({
      id: 'now',
      cls: 'train',
      dot: colorOf(t.onShift.agent),
      when: '现在',
      what: `${t.onShift.label}${t.onShift.llm ? ` · ${t.onShift.llm}` : ''} 正在干活`,
      sub: t.pending.length ? `已经改了 ${t.pending.length} 个文件` : '还没看到改动',
    });
  } else if (t.pending.length) {
    stops.push({ id: 'now', cls: 'alert', dot: 'var(--warn)', when: '现在', what: `${t.pending.length} 个改动还没交接` });
  }
  const ready = t.phase === 'mergeable';
  stops.push({
    id: 'end',
    cls: 'terminal',
    dot: ready ? 'var(--go)' : 'var(--main)',
    what: '合回正式文件夹',
    sub: ready ? '可以合回了' : t.totals.files ? `目前改了 ${t.totals.files} 个文件` : '还没有要合回的改动',
  });
  // 线段颜色：谁在岗就是谁的颜色；交接之后、下一个人上岗之前是空闲的浅灰；通往终点的一段，能合回才画成实线。
  let seg = 'var(--rule)';
  for (const s of stops) {
    if (s.cls === 'shift' || s.cls === 'train') seg = s.dot;
    else if (s.handoff) seg = 'var(--rule)';
    s.seg = seg;
  }
  const pre = stops[stops.length - 2];
  if (pre) {
    pre.seg = ready ? 'var(--go)' : 'var(--ink-3)';
    pre.dashed = !ready;
  }
  return stops;
}

function stopEl(s) {
  const expandable = !!(s.handoff || s.detail);
  const open = expandable && S.openStop === s.id;
  const head = h(
    expandable ? 'button' : 'div',
    {
      class: 'stop-head',
      type: expandable ? 'button' : null,
      'aria-expanded': expandable ? String(open) : null,
      onclick: expandable
        ? () => {
            S.openStop = open ? null : s.id;
            render();
          }
        : null,
    },
    s.when ? h('span', { class: 'when' }, s.when) : null,
    s.tag ? h('span', { class: 'tag' }, s.tag) : h('span', { class: 'what' }, s.what, s.badge ? h('span', { class: `badge ${s.badge[0]}` }, s.badge[1]) : null),
    s.sub ? h('span', { class: 'sub' }, s.sub) : null
  );
  const body = open
    ? h(
        'div',
        { class: 'open' },
        s.detail ? h('p', null, s.detail) : null,
        s.sha ? h('p', { class: 'muted' }, '检查点 ', h('span', { class: 'mono' }, short(s.sha))) : null,
        h(
          'div',
          { class: 'row' },
          s.report ? link('看审计报告', () => showAudit(s.report)) : null,
          s.canBack ? link('退回到这里…', () => openRollback(s.sha, `${s.what}（${s.when}）`)) : null
        )
      )
    : null;
  return h('li', { class: `stop ${s.cls}${s.dashed ? ' dashed' : ''}`, style: `--dot:${s.dot};--seg:${s.seg}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), head, body);
}

function lineMap(t) {
  return h('ol', { class: 'line', 'aria-label': '支线图：这个任务从正式文件夹分出后的经过' }, buildStops(t).map(stopEl));
}

// —— 任务状态牌 ——

function phasePill(t, busyOp, autoOn) {
  if (autoOn) return h('span', { class: 'pill line', style: `--c:${t.onShift ? colorOf(t.onShift.agent) : 'var(--go)'}` }, '全自动');
  if (busyOp || t.phase === 'busy') return h('span', { class: 'pill' }, h('span', { class: 'spin' }), '处理中');
  if (t.phase === 'working' && t.onShift) return h('span', { class: 'pill line', style: `--c:${colorOf(t.onShift.agent)}` }, '在岗');
  const map = {
    conflict: ['stop', '有冲突'],
    unsaved: ['warn', '待交接'],
    fresh: ['', '等人上岗'],
    blocked: ['stop', '拦住了'],
    mergeable: ['go', '可以合回'],
    broken: ['stop', '出问题了'],
  };
  const [cls, word] = map[t.phase] || ['', t.phase];
  return h('span', { class: `pill ${cls}` }, word);
}

function phaseActions(t, busyOp, autoOn) {
  if (autoOn || (t.onShift && t.onShift.auto)) return [h('span', { class: 'hint' }, '全自动正在进行：会自己交接、审查、合回。要中途停下，用上面的「停止」。')];
  if (busyOp || t.phase === 'busy') return [];
  const out = [];
  switch (t.phase) {
    case 'working':
      if (t.onShift.kind === 'app') {
        out.push(btn('交接', openHandoff, 'primary'), btn(`再打开 ${t.onShift.label}`, () => startShift(t.onShift.agent, t.onShift.llm)), btn('复制上岗那句话', copyHint, 'ghost'));
      } else {
        out.push(h('span', { class: 'hint' }, '在终端里让它结束（或连按两次 Ctrl-C），然后回来交接。'));
      }
      break;
    case 'unsaved':
      out.push(btn('交接', openHandoff, 'primary'));
      break;
    case 'conflict':
      out.push(h('span', { class: 'hint' }, '在下面选一个工人来解决冲突。'), btn('撤销同步', abortSync, 'ghost'));
      break;
    case 'blocked':
      out.push(btn('看交接文档', () => ((S.sub = 'handoff'), render())), btn('仍然合回…', () => openMerge(true), 'danger'));
      break;
    case 'mergeable':
      out.push(btn('合回正式文件夹', () => openMerge(false), 'primary'));
      break;
    case 'broken':
      out.push(btn('放弃这个任务…', () => openAbandon(t), 'danger'));
      break;
    default:
      break;
  }
  return out;
}

function boardEl(t, busyOp, autoOn, autoPhase) {
  return h(
    'section',
    { class: 'board' },
    h(
      'div',
      { class: 'board-head' },
      h('p', { class: 'eyebrow' }, '任务 · ', h('span', { class: 'num' }, fmtTime(t.startedAt)), ' 开始'),
      h('h1', { class: 'task-title' }, t.title),
      t.taskText ? h('details', null, h('summary', null, '任务说明'), h('div', { class: 'doc', style: 'margin-top:10px', html: md(t.taskText) })) : null
    ),
    h('div', { class: 'phase' }, phasePill(t, busyOp, autoOn), h('p', null, autoOn && autoPhase ? `全自动进行中：${autoPhase}` : busyOp ? `正在${busyOp}……` : t.phaseText)),
    h('div', { class: 'actions' }, phaseActions(t, busyOp, autoOn))
  );
}

function banners(t, p, autoOn) {
  const out = [];
  const off = !!S.acting || !!autoOn;
  if (t.stray.length) {
    out.push(
      banner(
        'warn',
        [h('strong', null, '正式文件夹在任务期间被改了：'), t.stray.map((s) => `${s.path}（${s.word}）`).join('、'), h('div', { class: 'hint' }, '多半是 AI 开错了文件夹，改到了正式版上。收进任务后，正式文件夹会恢复原样。')],
        btn('收进任务', takeStray, 'primary small', { disabled: off })
      )
    );
  }
  if (t.mainAhead && t.phase !== 'working' && t.phase !== 'conflict') {
    out.push(
      banner('info', `正式文件夹有 ${t.mainAhead} 个新提交，任务里还没有。合回时会自动合并；担心冲突的话可以先同步。`, btn('同步到任务里', syncMain, 'small', { disabled: off }))
    );
  }
  if (t.review && t.review.weak && (t.phase === 'fresh' || t.phase === 'mergeable')) {
    out.push(banner('info', `上一段是「${t.review.label}」干的，它的能力标记为「弱」。下一位上岗时会被要求先审查这一段的改动。`));
  }
  if (p.configError) out.push(banner('stop', p.configError));
  return out;
}

// —— 让谁上岗 ——

function workersSection(t, st, busyOp) {
  const workers = st.workers.filter((w) => w.kind !== 'api');
  if (!workers.length) {
    return h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', null, '让谁上岗')),
      banner('info', '还没有能干活的工人。去「设置」添加一个。', btn('去设置', () => setView('settings'), 'small'))
    );
  }
  const shift = t.onShift && t.onShift.kind !== 'op' ? t.onShift : null;
  const tickets = workers.map((w) => {
    const here = shift && shift.agent === w.name;
    const disabled = !!busyOp || (shift && shift.kind === 'cli');
    return h(
      'button',
      {
        type: 'button',
        class: `ticket${S.pick === w.name ? ' on' : ''}`,
        style: `--c:${colorOf(w.name)}`,
        disabled,
        'aria-expanded': String(S.pick === w.name),
        onclick: () => {
          S.pick = S.pick === w.name ? null : w.name;
          render();
        },
      },
      here ? h('span', { class: 'here' }, '在岗') : null,
      h('span', { class: 'name' }, w.label),
      h('span', { class: 'meta' }, [w.kind === 'app' ? '桌面' : '终端', w.tier === 'weak' ? '弱' : '强', w.model].filter(Boolean).join(' · ')),
      w.check && !w.check.ok ? h('span', { class: 'prob' }, w.check.problem) : null
    );
  });
  const w = workers.find((x) => x.name === S.pick);
  if (w) tickets.push(launchPanel(w, shift));
  const api = st.workers.filter((x) => x.kind === 'api');
  return h(
    'section',
    { class: 'section' },
    h(
      'div',
      { class: 'section-head' },
      h('h2', null, t.phase === 'conflict' ? '让谁来解决冲突' : '让谁上岗'),
      api.length ? h('span', { class: 'hint' }, `${api.map((a) => a.label).join('、')} 是模型接口：在全自动里干活、审查，或者参加讨论`) : null
    ),
    h('div', { class: 'tickets' }, tickets)
  );
}

function launchPanel(w, shift) {
  const here = shift && shift.agent === w.name;
  const other = shift && !here ? shift : null;
  const model = keepInput(`model-${w.name}`, h('input', { type: 'text', id: 'pick-model', value: w.model || '', placeholder: '例如 grok-4.6、claude-opus' }));
  const go = () => startShift(w.name, S.keep[`model-${w.name}`]);
  model.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) go();
  });
  return h(
    'div',
    { class: 'launch', style: `--c:${colorOf(w.name)}` },
    h('div', { class: 'field' }, h('label', { for: 'pick-model' }, `这一段 ${w.label} 用的模型（可不填，只做记录）`), model),
    btn(here ? `再打开 ${w.label}` : w.kind === 'app' ? `用 ${w.label} 打开` : `在终端里启动 ${w.label}`, go, 'primary', { disabled: !!S.acting }),
    btn('取消', () => ((S.pick = null), render()), 'ghost'),
    other ? h('p', { class: 'hint', style: 'flex-basis:100%;margin:0' }, `${other.label} 还在岗。先交接，再让 ${w.label} 上岗。`) : null
  );
}

async function startShift(name, model, force = false) {
  if (S.acting) return;
  S.acting = '安排上岗';
  render();
  let r = null;
  try {
    r = await post('/api/work', { agent: name, model: model || '', force });
    S.pick = null;
  } catch (e) {
    if (e.code === 'pending' || e.code === 'locked-app') {
      S.acting = null;
      offerForce(name, model, e.message);
      await refresh();
      return;
    }
    toast(e.message, true);
  } finally {
    S.acting = null;
  }
  await refresh();
  if (r) showShiftResult(r);
}

function offerForce(name, model, msg) {
  dialog({
    title: '上一位还没交接',
    body: [
      h('p', null, msg),
      h('p', { class: 'hint' }, '建议先交接：把它的改动存成检查点、写好审计，下一位接手时看得清楚。也可以强行上岗，交接记录里会注明是强行接替的。'),
    ],
    buttons: [{ label: '取消' }, { label: '强行上岗', cls: 'danger', run: () => startShift(name, model, true) }, { label: '先交接', cls: 'primary', run: () => openHandoff() }],
  });
}

function showShiftResult(r) {
  if (r.kind === 'app') {
    dialog({
      title: r.reopened ? `又打开了一次 ${r.label}` : `${r.label} 已打开隔离副本`,
      body: [
        r.reopened ? h('p', { class: 'hint' }, '还是同一段，不算换人。') : null,
        h('p', null, r.copied ? '上岗那句话已经复制好了，到它的 AI 对话框里粘贴发送：' : '把这句话发给它的 AI 对话框：'),
        copybox(r.hint),
        h('p', { class: 'hint' }, '隔离副本在 ', h('span', { class: 'mono' }, tildify(r.worktree)), '。它停手后，回到这里点「交接」。'),
        (r.notes || []).map((n) => h('p', { class: 'hint' }, n)),
      ],
      buttons: [{ label: '知道了', cls: 'primary' }],
    });
    return;
  }
  if (r.opened) {
    toast(`已在「终端」里启动 ${r.label}。它退出后，回来点「交接」。`);
    return;
  }
  dialog({
    title: `在终端里启动 ${r.label}`,
    body: [h('p', null, '接力台没能自动打开「终端」。把下面这条命令粘贴到「终端」里运行：'), copybox(r.command), r.error ? h('p', { class: 'hint' }, `原因：${r.error}`) : null],
    buttons: [{ label: '知道了', cls: 'primary' }],
  });
}

async function copyHint() {
  try {
    const r = await post('/api/copy-hint');
    if (!r.copied) await navigator.clipboard.writeText(r.hint);
    toast('上岗那句话已复制，粘贴到它的 AI 对话框里。');
  } catch (e) {
    toast(e.message, true);
  }
}

// —— 交接、合回、放弃、退回 ——

function openHandoff() {
  const t = S.st && S.st.project.task;
  if (!t) return;
  const who = t.onShift ? t.onShift.label : t.lastWorker ? t.lastWorker.label : '';
  const note = h('textarea', { rows: 3, placeholder: '例如：配色做完了，还差导出测试' });
  const withModel = S.st.project.config && S.st.project.config.keySet;
  dialog({
    title: '交接',
    body: [
      h('p', null, `${who ? `${who} 这一段` : '这一段'}会被存成一个检查点（以后可以退回到这里），然后写审计、跑检查。${withModel ? '还会请审计模型写一段阅读面，可能要一两分钟。' : ''}`),
      t.pending.length
        ? h('p', { class: 'hint' }, `这次会存下：${t.pending.slice(0, 8).join('、')}${t.pending.length > 8 ? ' …' : ''}`)
        : h('p', { class: 'hint' }, '这一段没有改动：交接只是让当前工人下岗，好换人。'),
      h('div', { class: 'field' }, h('label', null, '留给下一位的话（可不填）'), note),
    ],
    buttons: [
      { label: '取消' },
      {
        label: '交接',
        cls: 'primary',
        keepOpen: true,
        run: async (d) => {
          d.busy('正在交接：存检查点 → 写审计 → 跑检查……');
          try {
            const r = await post('/api/handoff', { note: note.value });
            d.replace(handoffResult(r));
          } catch (e) {
            d.error(e.message);
          }
          refresh();
        },
      },
    ],
  });
}

function facts(rows) {
  return h(
    'ul',
    { class: 'facts' },
    rows.filter(Boolean).map(([k, v]) => h('li', null, h('span', null, k), h('span', null, v)))
  );
}

/** 检查结果的说法。没配置检查命令时服务端记的是「(未配置)」，不能说成通过。 */
function gateLine(g) {
  if (!g) return '没有改动，沿用上一次';
  if (g.command === '(未配置)') return '没配置检查命令（不检查）';
  return g.status === 'pass' ? `✅ 通过（${g.command}）` : `❌ 没通过（${g.command}）`;
}

function handoffResult(r) {
  return {
    title: '交接好了',
    body: [
      facts([
        ['谁', r.label],
        ['改动', r.empty ? '没有改动' : `${r.files} 个文件  +${r.added} −${r.removed}`],
        ['检查点', h('span', { class: 'mono' }, short(r.checkpoint))],
        ['检查', gateLine(r.gate)],
        ['审计', r.audit.status === 'ok' ? '有模型写的阅读面' : `只有事实${r.audit.note ? `（${r.audit.note}）` : ''}`],
      ]),
      (r.notes || []).map((n) => h('p', { class: 'hint', style: 'margin-top:10px' }, n)),
    ],
    buttons: [{ label: '好', cls: 'primary' }],
  };
}

/** 「不许改」的小红标签（项目设置里的保护路径）。 */
function protectedTag(hits, p) {
  return hits && hits.includes(p) ? h('span', { class: 'badge bad', style: 'margin-left:8px' }, '不许改') : null;
}

function miniFiles(changes, hits = []) {
  if (!changes.length) return null;
  const rows = changes.slice(0, 8).map((f) => h('li', null, h('div', { class: 'file-row', style: 'cursor:default' }, h('span', { class: `st ${f.status}` }, f.status), h('span', { class: 'path' }, f.path, protectedTag(hits, f.path)), h('span', null))));
  return h('div', { style: 'margin:12px 0' }, h('ul', { class: 'files' }, rows), changes.length > 8 ? h('p', { class: 'hint' }, `…还有 ${changes.length - 8} 个`) : null);
}

/** 强制合回前要让人看清的全部拦截原因。 */
function blockReasons(t) {
  const out = [];
  if (t.gate && t.gate.status === 'fail' && t.gate.command !== '(未配置)') out.push(`检查没通过（${t.gate.command}）。`);
  if (t.protectedHits && t.protectedHits.length) out.push(`改到了不许改的文件：${t.protectedHits.join('、')}。`);
  if (t.pending.length) out.push(`还有 ${t.pending.length} 个改动没交接，合回时不会带上。`);
  if (t.onShift && t.onShift.kind === 'app') out.push(`${t.onShift.label} 还在岗，它没交接的改动不会带上。`);
  return out.length ? out : [t.phaseText];
}

function openMerge(force) {
  const t = S.st && S.st.project.task;
  if (!t) return;
  const keep = h('input', { type: 'checkbox' });
  const hits = t.protectedHits || [];
  const ack = force && hits.length ? h('input', { type: 'checkbox' }) : null;
  const needAck = h('p', { class: 'form-error', hidden: true }, '先勾选上面那一项：确认你知道改到了不许改的文件。');
  dialog({
    title: force ? '仍然合回？' : '合回正式文件夹',
    body: [
      h('p', null, `会把这个任务的改动（${t.totals.files} 个文件，+${t.totals.added} −${t.totals.removed}）作为一个提交放进正式文件夹。隔离副本会删掉，接力分支保留备查。`),
      force ? h('div', { class: 'form-error' }, h('strong', null, '被拦下的原因：'), blockReasons(t).map((r) => h('div', null, `· ${r}`))) : null,
      miniFiles(t.changes, hits),
      ack ? h('label', { class: 'checkline' }, ack, `我知道 ${hits.join('、')} 是不许改的文件，仍然要把它合进正式文件夹`) : null,
      needAck,
      h('label', { class: 'checkline' }, keep, '把审计报告也留进正式文件夹（.relay/audits/）'),
    ],
    buttons: [
      { label: '取消' },
      {
        label: force ? '仍然合回' : '合回',
        cls: force ? 'danger solid' : 'primary',
        keepOpen: true,
        run: async (d) => {
          if (ack && !ack.checked) {
            needAck.hidden = false;
            return;
          }
          d.busy('正在合回……');
          try {
            const r = await post('/api/merge', { force, keepAudits: keep.checked });
            d.replace({
              title: '合回好了',
              body: [
                h('p', null, r.commit ? `正式文件夹多了一个提交（${short(r.commit)}），包含 ${r.files.length} 个文件的改动。` : '任务已经收尾。'),
                (r.notes || []).map((n) => h('p', { class: 'hint' }, n)),
                h('p', { class: 'hint' }, `接力分支 ${r.branch} 保留备查。`),
              ],
            });
            resetProjectLocal();
          } catch (e) {
            d.error(e.message);
          }
          refresh();
        },
      },
    ],
  });
}

function openAbandon(t) {
  const onShift = t.onShift && t.onShift.kind === 'app' ? t.onShift : null;
  dialog({
    title: '放弃这个任务？',
    body: [
      h('p', null, '隔离副本会删掉；里面剩下的东西会先存进接力分支留底，以后还能找回。正式文件夹不会有任何变化。'),
      onShift ? h('p', { class: 'form-error' }, `${onShift.label} 还在岗，它没交接的改动也会一起存进留底。`) : null,
    ],
    buttons: [
      { label: '取消' },
      {
        label: '放弃任务',
        cls: 'danger solid',
        keepOpen: true,
        run: async (d) => {
          d.busy('正在放弃……');
          try {
            await post('/api/abandon', { force: !!onShift || t.phase === 'broken' });
            d.close();
            resetProjectLocal();
            toast('已放弃这个任务。');
          } catch (e) {
            d.error(e.message);
          }
          refresh();
        },
      },
    ],
  });
}

function openRollback(sha, label) {
  dialog({
    title: '退回到这里？',
    body: [
      h('p', null, `隔离副本里的文件会恢复成「${label}」时的样子。`),
      h('p', { class: 'hint' }, '之后的交接记录和审计报告都还在，退回本身也会记一笔；还没交接的改动会丢掉。正式文件夹不受影响。'),
    ],
    buttons: [
      { label: '取消' },
      {
        label: '退回',
        cls: 'danger solid',
        keepOpen: true,
        run: async (d) => {
          d.busy('正在退回……');
          try {
            await post('/api/rollback', { sha });
            d.close();
            S.openStop = null;
            S.diff = null;
            toast('已退回。');
          } catch (e) {
            d.error(e.message);
          }
          refresh();
        },
      },
    ],
  });
}

function openRollbackList(t) {
  const cps = [...t.checkpoints].reverse();
  let picked = cps[0] ? cps[0].sha : null;
  const list = h(
    'div',
    null,
    cps.map((c, i) =>
      h(
        'label',
        { class: 'checkline', style: 'padding:6px 0' },
        h('input', { type: 'radio', name: 'cp', checked: i === 0, onchange: () => (picked = c.sha) }),
        h('span', { class: 'num' }, fmtTime(c.ts) || '—'),
        h('span', null, c.who || (c.label === '交接' ? `${c.agent} 交接后` : '任务开始时')),
        h('span', { class: 'mono muted' }, short(c.sha))
      )
    )
  );
  dialog({
    title: '退回到哪一站？',
    body: [h('p', { class: 'hint' }, '隔离副本会恢复成那时的样子；之后的记录都保留。正式文件夹不受影响。'), list],
    buttons: [
      { label: '取消' },
      {
        label: '退回',
        cls: 'danger solid',
        keepOpen: true,
        run: async (d) => {
          if (!picked) return;
          d.busy('正在退回……');
          try {
            await post('/api/rollback', { sha: picked });
            d.close();
            toast('已退回。');
          } catch (e) {
            d.error(e.message);
          }
          refresh();
        },
      },
    ],
  });
}

async function takeStray() {
  await act('收进任务', async () => {
    const r = await post('/api/take');
    if (r.taken.length) toast(`已收进任务：${r.taken.join('、')}。记得交接。`);
    for (const s of r.skipped) toast(`${s.path}：${s.why}`, true);
  });
}

async function syncMain() {
  await act('同步', async () => {
    const r = await post('/api/sync');
    if (r.status === 'up-to-date') toast('任务里已经有正式文件夹的全部提交了。');
    else if (r.status === 'merged') toast('同步好了。');
    else toast(`有冲突：${r.conflicts.join('、')}。选一个工人来解决。`, true);
  });
}

async function abortSync() {
  await act('撤销同步', async () => {
    await post('/api/sync', { abort: true });
    toast('已撤销同步。');
  });
}

// —— 详情分页 ——

async function loadDiff(p) {
  if (S.diff && S.diff.path === p) {
    S.diff = null;
    render();
    return;
  }
  S.diff = { path: p, loading: true };
  render();
  try {
    const r = await get('/api/diff', { path: p });
    if (S.diff && S.diff.path === p) S.diff = { path: p, text: r.diff };
  } catch (e) {
    S.diff = { path: p, error: e.message };
  }
  render();
}

/** 不切换开关，重新读一遍已经打开的改动对比。 */
async function reloadDiff(p) {
  try {
    const r = await get('/api/diff', { path: p });
    if (S.diff && S.diff.path === p) S.diff = { path: p, text: r.diff };
  } catch (e) {
    if (S.diff && S.diff.path === p) S.diff = { path: p, error: e.message };
  }
  render();
}

/** 重新读当前文件夹的列表和正在看的文件，不清空界面。 */
async function refreshFilesQuietly() {
  const f = S.files;
  try {
    const r = await get('/api/files', { side: f.side, sub: f.sub });
    let preview = f.preview;
    if (preview && preview.path && !preview.loading) {
      try {
        preview = await get('/api/file', { side: f.side, path: preview.path });
      } catch (e) {
        preview = { path: preview.path, error: e.message };
      }
    }
    if (S.files.side === f.side && S.files.sub === f.sub) S.files = { ...S.files, list: r.entries, preview };
  } catch {
    /* 文件夹可能已经没了（任务合回或放弃），下次刷新会重画 */
  }
  render();
}

/** 任务有了新进展（交接、退回、收进、同步、没交接的改动变了）：打开着的改动对比和文件预览跟着更新。 */
let taskVer = null;
function noticeTaskChange(t) {
  const ver = t ? JSON.stringify([t.branch, t.timeline.length, t.pending]) : null;
  const changed = taskVer !== null && ver !== taskVer;
  taskVer = ver;
  if (!changed || !t) return;
  if (S.diff && S.diff.path && !S.diff.loading) reloadDiff(S.diff.path);
  if (S.files && S.files.list && !S.files.loading) refreshFilesQuietly();
}

async function loadAudit(report) {
  S.audit = { path: report, loading: true };
  render();
  try {
    const r = await get('/api/audit', { path: report });
    if (S.audit && S.audit.path === report) S.audit = { path: report, text: r.text };
  } catch (e) {
    S.audit = { path: report, error: e.message };
  }
  render();
}

/** 从支线图跳到某份审计报告。 */
async function showAudit(report) {
  S.sub = 'audit';
  await loadAudit(report);
  const el = document.querySelector('.subtabs');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadFiles(side, sub) {
  S.files = { ...S.files, side, sub, list: null, preview: null, error: null, loading: true };
  render();
  try {
    const r = await get('/api/files', { side, sub });
    S.files = { ...S.files, list: r.entries, sub: r.sub, loading: false };
  } catch (e) {
    S.files = { ...S.files, error: e.message, list: [], loading: false };
  }
  render();
}

async function openFile(name) {
  const p = S.files.sub ? `${S.files.sub}/${name}` : name;
  S.files = { ...S.files, preview: { path: p, loading: true } };
  render();
  try {
    const r = await get('/api/file', { side: S.files.side, path: p });
    S.files = { ...S.files, preview: r };
  } catch (e) {
    S.files = { ...S.files, preview: { path: p, error: e.message } };
  }
  render();
}

function changesPanel(t) {
  if (!t.changes.length && !t.pending.length) return empty('还没有改动。工人干了活、交接之后，这里会列出相对正式文件夹改了哪些文件。');
  const parts = [];
  if (t.pending.length) {
    parts.push(banner('warn', `还没交接的改动（交接后才算数）：${t.pending.slice(0, 10).join('、')}${t.pending.length > 10 ? ' …' : ''}`));
  }
  if (t.changes.length) {
    parts.push(
      h('p', { class: 'hint', style: 'margin:14px 0 8px' }, `相对正式文件夹：${t.totals.files} 个文件，`, h('span', { class: 'plus num' }, `+${t.totals.added}`), ' ', h('span', { class: 'minus num' }, `−${t.totals.removed}`), '。点文件看具体改了什么。')
    );
    parts.push(
      h(
        'ul',
        { class: 'files' },
        t.changes.map((f) =>
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: `file-row${S.diff && S.diff.path === f.path ? ' on' : ''}`, onclick: () => loadDiff(f.path) },
              h('span', { class: `st ${f.status}` }, f.status),
              h('span', { class: 'path', title: f.orig ? `${f.orig} → ${f.path}` : f.path }, f.orig ? `${f.orig} → ${f.path}` : f.path, protectedTag(t.protectedHits, f.path)),
              h('span', { class: 'num small' }, f.added === null ? h('span', { class: 'muted' }, '二进制') : [h('span', { class: 'plus' }, `+${f.added}`), ' ', h('span', { class: 'minus' }, `−${f.removed}`)])
            )
          )
        )
      )
    );
  }
  if (S.diff) {
    if (S.diff.loading) parts.push(h('p', { class: 'hint' }, '正在读取……'));
    else if (S.diff.error) parts.push(h('p', { class: 'form-error' }, S.diff.error));
    else parts.push(h('div', { class: 'diff', html: diffHtml(S.diff.text || '（没有文字差异，可能是二进制文件）') }));
  }
  return h('div', null, parts);
}

function auditPanel(t) {
  const reports = t.timeline.filter((i) => i.report).reverse();
  if (!reports.length) return empty('还没有审计报告。每次交接都会写一份：事实部分由 git 生成，另有可选的模型阅读面。');
  const current = S.audit ? S.audit.path : null;
  if (!current) setTimeout(() => loadAudit(reports[0].report), 0);
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'reports' },
      reports.map((r) => h('button', { type: 'button', class: `chip-btn${current === r.report ? ' on' : ''}`, onclick: () => loadAudit(r.report) }, `${fmtTime(r.ts)} · ${r.who}`))
    ),
    !S.audit || S.audit.loading ? h('p', { class: 'hint' }, '正在读取……') : S.audit.error ? h('p', { class: 'form-error' }, S.audit.error) : h('div', { class: 'doc', html: md(S.audit.text) })
  );
}

function filesPanel(t) {
  const f = S.files;
  if (f.side === 'task' && !t.worktreeExists) f.side = 'main';
  if (!f.list && !f.error) {
    if (!f.loading) setTimeout(() => loadFiles(f.side, f.sub), 0);
    return h('p', { class: 'hint' }, '正在读取……');
  }
  const crumbs = [h('button', { type: 'button', onclick: () => loadFiles(f.side, '') }, f.side === 'task' ? '隔离副本' : '正式文件夹')];
  const parts = f.sub ? f.sub.split('/') : [];
  parts.forEach((seg, i) => {
    crumbs.push(' / ', h('button', { type: 'button', onclick: () => loadFiles(f.side, parts.slice(0, i + 1).join('/')) }, seg));
  });
  const entries = (f.list || []).map((e) =>
    h(
      'li',
      null,
      h(
        'button',
        {
          type: 'button',
          class: `file-row${f.preview && f.preview.path === (f.sub ? `${f.sub}/${e.name}` : e.name) ? ' on' : ''}`,
          onclick: () => (e.dir ? loadFiles(f.side, f.sub ? `${f.sub}/${e.name}` : e.name) : openFile(e.name)),
        },
        h('span', { class: 'ico', 'aria-hidden': 'true' }, e.dir ? '▸' : '·'),
        h('span', { class: 'path' }, e.name + (e.dir ? '/' : ''))
      )
    )
  );
  let preview = h('div', { class: 'empty' }, '点左边的文件看内容。');
  const pv = f.preview;
  if (pv) {
    if (pv.loading) preview = h('p', { class: 'hint' }, '正在读取……');
    else if (pv.error) preview = h('p', { class: 'form-error' }, pv.error);
    else if (pv.image) preview = h('img', { src: `/api/raw?${new URLSearchParams({ dir: S.dir, side: f.side, path: pv.path })}`, alt: pv.path });
    else if (pv.binary) preview = h('div', { class: 'empty' }, `这是二进制文件（${Math.round(pv.size / 1024)} KB），这里不显示内容。`);
    else preview = h('pre', null, pv.text + (pv.truncated ? '\n\n…（文件太长，只显示了开头）' : ''));
  }
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'browser-bar' },
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': '看哪个文件夹' },
        h('button', { type: 'button', 'aria-pressed': String(f.side === 'task'), disabled: !t.worktreeExists, onclick: () => loadFiles('task', '') }, '隔离副本'),
        h('button', { type: 'button', 'aria-pressed': String(f.side === 'main'), onclick: () => loadFiles('main', '') }, '正式文件夹')
      ),
      h('div', { class: 'crumbs' }, crumbs),
      h('span', { style: 'flex:1' }),
      btn('在访达中显示', () => post('/api/reveal', { side: f.side, path: pv && !pv.error ? pv.path : f.sub }).catch((e) => toast(e.message, true)), 'ghost small')
    ),
    f.error ? h('p', { class: 'form-error' }, f.error) : null,
    h('div', { class: 'browser' }, h('ul', { class: 'files entries' }, entries.length ? entries : h('li', null, h('div', { class: 'file-row muted' }, '（空文件夹）'))), h('div', { class: 'preview' }, preview))
  );
}

function detailsEl(t) {
  const tabs = [
    ['changes', `改动${t.totals.files ? ` · ${t.totals.files}` : ''}`],
    ['handoff', '交接文档'],
    ['audit', '审计报告'],
    ['files', '文件'],
  ];
  let panel;
  if (S.sub === 'changes') panel = changesPanel(t);
  else if (S.sub === 'handoff')
    panel = t.handoffDoc ? h('div', { class: 'doc', html: md(t.handoffDoc) }) : empty('还没有交接过。第一次交接后，这里就是给下一位看的交接文档。');
  else if (S.sub === 'audit') panel = auditPanel(t);
  else panel = filesPanel(t);
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'subtabs', role: 'tablist' },
      tabs.map(([id, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(S.sub === id),
            onclick: () => {
              S.sub = id;
              render();
            },
          },
          label
        )
      )
    ),
    h('div', { class: 'subpanel' }, panel)
  );
}

function dangerZone(t, autoOn) {
  return h(
    'div',
    { class: 'danger-zone' },
    t.checkpoints.length > 1 && t.phase !== 'working' && !autoOn ? btn('退回到……', () => openRollbackList(t), 'small') : null,
    btn('放弃任务……', () => openAbandon(t), 'danger small', { disabled: !!S.acting || !!autoOn, title: autoOn ? '全自动正在跑，先停止它' : '' })
  );
}

function viewTask(st) {
  const p = st.project;
  const t = p.task;
  const busyOp = st.busy ? st.busy.op : S.acting;
  const autoOn = autoRunning(st);
  return h(
    'div',
    { class: 'grid' },
    h('aside', { class: 'side' }, h('p', { class: 'side-title' }, '支线图'), lineMap(t), dangerZone(t, autoOn)),
    h(
      'div',
      null,
      // 全自动跑过（或正在跑）时它是主角，放最上面；手动安排的任务先看任务本身，全自动只是一个可选的按钮。
      st.auto && st.auto.state ? autoPanel(st) : null,
      boardEl(t, busyOp, autoOn, st.auto && st.auto.state ? st.auto.state.phase : ''),
      banners(t, p, autoOn),
      st.auto && st.auto.state ? null : autoPanel(st),
      t.phase !== 'broken' && t.phase !== 'busy' && !autoOn ? workersSection(t, st, busyOp) : null,
      t.worktreeExists ? detailsEl(t) : null
    )
  );
}

// ---------- 讨论页 ----------

function talkers() {
  return S.st.workers.filter((w) => w.canTalk);
}

function pickedNames() {
  const names = talkers().map((w) => w.name);
  if (!S.talkPick) return names;
  return S.talkPick.filter((n) => names.includes(n));
}

function renderTalk() {
  const box = $('view-talk');
  const st = S.st;
  const rows = S.talk ? S.talk.rows : null;
  const status = S.talk ? S.talk.status : null;
  const wasBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  const before = box.__key;
  mount(
    box,
    JSON.stringify(['talk', st.project.root, st.workers.map((w) => [w.name, w.label, w.canTalk, w.model]), pickedNames(), rows ? rows.length : -1, rows && rows.length ? rows[rows.length - 1].ts : '', status, !!st.project.task, S.colors, S.acting]),
    () => viewTalk(st, rows, status)
  );
  if (box.__key !== before && (wasBottom || S.talkStick)) {
    S.talkStick = false;
    window.scrollTo(0, document.body.scrollHeight);
  }
}

function personRow(w, picked) {
  const box = h('input', {
    type: 'checkbox',
    checked: picked.includes(w.name),
    onchange: (e) => {
      const now = pickedNames().filter((n) => n !== w.name);
      if (e.target.checked) now.push(w.name);
      const order = talkers().map((x) => x.name);
      S.talkPick = order.filter((n) => now.includes(n));
      savePick();
      render();
    },
  });
  return h(
    'li',
    null,
    h(
      'label',
      { class: 'person', style: `--c:${colorOf(w.name)}` },
      box,
      h('span', { class: 'n' }, w.label),
      h('span', { class: 'd' }, [w.kind === 'api' ? '接口' : w.kind === 'app' ? '桌面' : '终端', w.model].filter(Boolean).join(' · '), w.check && !w.check.ok && w.kind === 'api' ? h('span', { style: 'color:var(--warn)' }, ` · ${w.check.problem}`) : null)
    )
  );
}

function msgEl(row, hasTask) {
  if (row.kind === 'system') return h('div', { class: `msg system${row.error ? ' error' : ''}` }, row.text);
  const mine = row.kind === 'human';
  return h(
    'div',
    { class: `msg ${mine ? 'human' : 'ai'}`, style: mine ? null : `--c:${colorOf(row.agent)}` },
    h('div', { class: 'top' }, h('span', { class: 'who' }, row.who), h('span', { class: 'when' }, fmtTime(row.ts))),
    h('div', { class: 'body' }, h('div', { class: 'text' }, row.text)),
    !hasTask
      ? h(
          'div',
          { class: 'tools' },
          link('用这句开始任务', () => {
            S.keep.task = row.text;
            setView('task');
          })
        )
      : null
  );
}

function viewTalk(st, rows, status) {
  const people = talkers();
  const others = st.workers.filter((w) => !w.canTalk);
  const picked = pickedNames();
  const hasTask = !!st.project.task;
  const ta = keepInput('talk', h('textarea', { rows: 2, 'aria-label': '要说的话', placeholder: '写下你的问题或看法……（⌘ Enter 发送）' }));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      sendTalk();
    }
  });
  const label = (n) => (people.find((w) => w.name === n) || { label: n }).label;
  const thinking = status && status.current
    ? h(
        'div',
        { class: 'msg ai thinking', style: `--c:${colorOf(status.current.agent)}` },
        h('div', { class: 'top' }, h('span', { class: 'who' }, status.current.label)),
        h('div', { class: 'body' }, '正在想', h('span', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', { class: 'muted num' }, `  ${since(status.current.since)}`))
      )
    : null;
  const queue = status && status.queue && status.queue.length ? h('p', { class: 'queue' }, `接下来：${status.queue.map((q) => q.label).join('、')}`) : null;
  return h(
    'div',
    { class: 'grid' },
    h(
      'aside',
      { class: 'side' },
      h('p', { class: 'side-title' }, '请谁发言'),
      people.length
        ? h('ul', { class: 'people' }, people.map((w) => personRow(w, picked)))
        : h('p', { class: 'hint' }, '还没有能参加讨论的 AI。在「设置」里给工人填「讨论命令」（比如 claude -p），或者添加一个 API 模型（比如 DeepSeek）。'),
      others.length ? h('p', { class: 'hint', style: 'margin-top:14px' }, `${others.map((w) => w.label).join('、')} 没有讨论命令，不参加讨论。`) : null,
      h('p', { style: 'margin-top:14px' }, link('去设置', () => setView('settings')))
    ),
    h(
      'div',
      { class: 'talk-main' },
      h(
        'div',
        { class: 'talk-head' },
        h('div', null, h('h1', null, '讨论'), h('p', null, '选几个 AI，问一句，它们按顺序发言，每个都看得到前面所有人说的话。只说话，不改文件。')),
        rows && rows.length ? btn('清空讨论', clearTalk, 'ghost small', { disabled: !!(status && status.current) }) : null
      ),
      h(
        'div',
        { class: 'transcript' },
        rows === null ? h('p', { class: 'hint' }, '正在读取……') : rows.length ? rows.map((r) => msgEl(r, hasTask)) : empty('还没有人说话。在下面写下你的问题，比如「这个滤镜的色调怎么定比较好？」'),
        thinking,
        queue
      ),
      h(
        'div',
        { class: 'composer' },
        h(
          'div',
          { class: 'composer-box' },
          ta,
          h(
            'div',
            { class: 'composer-foot' },
            h('span', { class: 'hint' }, picked.length ? `会请 ${picked.map(label).join('、')} 依次回答` : '左边先选要请谁发言'),
            btn('发送', sendTalk, 'primary', { disabled: !picked.length || !!S.acting })
          )
        )
      )
    )
  );
}

async function sendTalk() {
  const text = String(S.keep.talk || '').trim();
  if (!text) return;
  const ask = pickedNames();
  if (!ask.length) {
    toast('先在左边选要请谁发言。', true);
    return;
  }
  try {
    await post('/api/talk/say', { text, ask });
    S.keep.talk = '';
    S.talkStick = true;
    await loadTalk();
  } catch (e) {
    toast(e.message, true);
  }
}

function clearTalk() {
  dialog({
    title: '清空讨论？',
    body: [h('p', null, '现在的讨论记录会改名存档（留在项目的 .relay 文件夹里），页面上从头开始。')],
    buttons: [
      { label: '取消' },
      {
        label: '清空',
        cls: 'danger solid',
        run: async () => {
          try {
            await post('/api/talk/clear');
            await loadTalk();
            refresh();
          } catch (e) {
            toast(e.message, true);
          }
        },
      },
    ],
  });
}

// ---------- 设置页 ----------

const WF = ['name', 'label', 'kind', 'cmd', 'mode', 'tier', 'model', 'effort', 'harness', 'ask', 'apiBase', 'apiModel', 'apiKey', 'apiFormat', 'note'];

/** 认得的编程工具（绑定后能全自动）。和 core/harness.ts 的 HARNESSES 对应。 */
const HARNESS_OPTIONS = [
  ['', '不绑定（只能手动在终端里用）'],
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor-agent', 'Cursor Agent'],
  ['zcode', 'ZCode 命令行'],
  ['agy', 'Antigravity'],
  ['gemini', 'Gemini CLI'],
  ['qwen', 'Qwen Code'],
  ['opencode', 'OpenCode'],
  ['droid', 'Factory Droid'],
  ['copilot', 'GitHub Copilot CLI'],
  ['grok', 'Grok CLI'],
];

function fillWorkerForm(a) {
  const v = {
    name: a.name || '',
    label: a.label || '',
    kind: a.kind || 'cli',
    cmd: a.cmd || '',
    mode: (a.prompt && a.prompt.mode) || 'file',
    tier: a.tier || 'strong',
    model: a.model || '',
    effort: a.effort || '',
    harness: a.harness || '',
    ask: a.ask || '',
    apiBase: (a.api && a.api.baseUrl) || '',
    apiModel: (a.api && a.api.model) || '',
    apiKey: (a.api && a.api.apiKeyEnv) || '',
    apiFormat: (a.api && a.api.format) || 'openai',
    note: a.note || '',
  };
  for (const k of WF) S.keep[`wf-${k}`] = v[k];
}

/** 表单上没有的字段（自动识别的标记、用户同意过的密钥来源）原样带回去，保存时不会丢。 */
function workerFromForm() {
  const g = (k) => String(S.keep[`wf-${k}`] ?? '').trim();
  const base = (S.workerForm && S.workerForm.base) || {};
  const kind = g('kind') || 'cli';
  const a = { name: g('name'), label: g('label'), kind, tier: g('tier') || 'strong', model: kind === 'api' ? g('apiModel') : g('model'), note: g('note') };
  if (kind === 'api') {
    a.api = { baseUrl: g('apiBase'), model: g('apiModel'), apiKeyEnv: g('apiKey') };
    if (g('apiFormat') === 'anthropic') a.api.format = 'anthropic';
    if (base.api && base.api.keyFrom) a.api.keyFrom = base.api.keyFrom;
    if (base.detected) a.detected = true;
  } else {
    a.cmd = g('cmd');
    a.prompt = { mode: g('mode') || 'file' };
    a.ask = g('ask');
    if (kind === 'cli') {
      if (g('harness')) a.harness = g('harness');
      if (g('effort')) a.effort = g('effort');
    }
    // 自动识别加的条目：命令没改才保留标记（改过就是你的了，识别不会再覆盖它）。
    if (base.detected && a.cmd === (base.cmd || '')) a.detected = true;
  }
  return a;
}

function newWorker() {
  S.workerForm = { mode: 'new', original: null, error: null, preset: '', base: {} };
  fillWorkerForm({ kind: 'cli', tier: 'strong', prompt: { mode: 'file' } });
  render();
}

function editWorker(w) {
  S.workerForm = { mode: 'edit', original: w.name, error: null, base: w };
  fillWorkerForm(w);
  render();
}

async function saveWorker() {
  const f = S.workerForm;
  if (!f) return;
  try {
    await post('/api/workers/save', { agent: workerFromForm(), originalName: f.mode === 'edit' ? f.original : undefined });
    S.workerForm = null;
    toast('工人已保存。');
    await refresh();
    loadDoctor();
  } catch (e) {
    S.workerForm = { ...f, error: e.message };
    render();
  }
}

function deleteWorker(w) {
  dialog({
    title: `删除工人「${w.label}」？`,
    body: [h('p', null, '只是从名单里拿掉，已经记下的交接记录不受影响。')],
    buttons: [
      { label: '取消' },
      {
        label: '删除',
        cls: 'danger solid',
        run: async () => {
          try {
            await post('/api/workers/delete', { name: w.name });
            toast('已删除。');
          } catch (e) {
            toast(e.message, true);
          }
          refresh();
        },
      },
    ],
  });
}

function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

function segCtl(keepId, options, onchange) {
  const cur = S.keep[keepId];
  return h(
    'div',
    { class: 'seg', role: 'group' },
    options.map(([v, text]) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(cur === v),
          onclick: () => {
            S.keep[keepId] = v;
            if (onchange) onchange(v);
            render();
          },
        },
        text
      )
    )
  );
}

function workerFormEl(st) {
  const f = S.workerForm;
  const kind = S.keep['wf-kind'] || 'cli';
  const presets = (st.presets || []);
  const input = (k, props = {}) => keepInput(`wf-${k}`, h('input', { type: 'text', ...props }));
  const presetSel =
    f.mode === 'new' && presets.length
      ? field(
          '从现成的开始',
          h(
            'select',
            {
              onchange: (e) => {
                const p = presets.find((x) => x.id === e.target.value);
                f.preset = e.target.value;
                if (p) fillWorkerForm(p.agent);
                render();
              },
            },
            h('option', { value: '' }, '（选一个，或者自己填）'),
            presets.map((p) => h('option', { value: p.id, selected: f.preset === p.id }, p.title))
          ),
          f.preset ? (presets.find((x) => x.id === f.preset) || {}).hint : '常用的 AI 工具都有现成配置，选了再按需要改。'
        )
      : null;
  return h(
    'div',
    { class: 'worker-form' },
    h('h3', null, f.mode === 'new' ? '添加工人' : `修改「${f.original}」`),
    f.error ? h('p', { class: 'form-error' }, f.error) : null,
    presetSel,
    field('类型', segCtl('wf-kind', [['cli', '终端工具'], ['app', '桌面 App'], ['api', '模型接口（API）']])),
    h(
      'div',
      { class: 'two' },
      field('名字（英文）', input('name', { class: 'mono-input', placeholder: '如 claude、cursor' }), '命令行里用它：relay run 名字'),
      field('显示名', input('label', { placeholder: '如 Claude Code' }))
    ),
    kind !== 'api'
      ? field(
          '启动命令',
          input('cmd', { class: 'mono-input', placeholder: kind === 'app' ? 'open -a Cursor {{worktree}}' : 'claude' }),
          kind === 'app' ? '要含 {{worktree}}，接力台会换成隔离副本的路径。macOS 上一般写 open -a "App 的名字" {{worktree}}。' : '在隔离副本里执行的命令。'
        )
      : null,
    kind === 'cli'
      ? h(
          'div',
          { class: 'two' },
          field(
            '全自动时用哪个编程工具',
            keepInput('wf-harness', h('select', null, HARNESS_OPTIONS.map(([v, t]) => h('option', { value: v }, t)))),
            '绑定后，全自动就用这个工具的无人值守模式干活、审查。自动识别会替你选好。'
          ),
          field('思考强度（可不填）', input('effort', { class: 'mono-input', placeholder: '如 low / medium / high' }), '全自动时要求的思考强度，比如 Codex 的 low 最省时间。')
        )
      : null,
    kind === 'cli'
      ? field(
          '手动上岗时，那句话怎么给它',
          keepInput(
            'wf-mode',
            h(
              'select',
              null,
              h('option', { value: 'arg' }, '当参数传给它（claude、codex 都支持）'),
              h('option', { value: 'stdin' }, '从标准输入喂给它'),
              h('option', { value: 'file' }, '不喂，在终端里提示我转告')
            )
          )
        )
      : null,
    kind === 'api'
      ? [
          field('接口地址', input('apiBase', { class: 'mono-input', placeholder: 'https://api.deepseek.com' })),
          h(
            'div',
            { class: 'two' },
            field('模型', input('apiModel', { class: 'mono-input', placeholder: 'deepseek-v4-pro' })),
            field('接口协议', keepInput('wf-apiFormat', h('select', null, h('option', { value: 'openai' }, 'OpenAI 兼容（/chat/completions）'), h('option', { value: 'anthropic' }, 'Anthropic 兼容（/v1/messages）'))))
          ),
          f.base && f.base.api && f.base.api.keyFrom
            ? h('p', { class: 'hint' }, `密钥：用 ${f.base.api.keyFrom.split(':')[0] === 'mimocode' ? 'MiMo 桌面版' : f.base.api.keyFrom.split(':')[0]} 配置里保存的（你同意过），调用时才读，不存到接力台。`)
            : [
                field('密钥的环境变量名', input('apiKey', { class: 'mono-input', placeholder: 'DEEPSEEK_API_KEY' }), '本机服务（127.0.0.1）可以不填。'),
                h('p', { class: 'hint', style: 'margin-top:-6px' }, '密钥不写在这里。在「终端」里执行 echo \'export 变量名=你的密钥\' >> ~/.zshrc，然后重新打开接力台。'),
              ],
          h('p', { class: 'hint' }, '接口模型能审查、讨论，也能在全自动里用接力台内置的小代理干活（排在编程工具后面兜底）。'),
        ]
      : null,
    h(
      'div',
      { class: 'two' },
      field('能力', segCtl('wf-tier', [['strong', '强'], ['weak', '弱']]), '前任是「弱」时，下一位上岗必须先审查它的改动。'),
      kind === 'cli'
        ? field('模型（可不填）', input('model', { class: 'mono-input', placeholder: '如 gpt-6-astra' }), '全自动时指定给工具；不填就用工具自己的默认模型。')
        : kind === 'app'
          ? field('正在用的模型（只做记录）', input('model', { placeholder: '如 GLM-5.3' }))
          : h('span')
    ),
    kind !== 'api'
      ? field(
          '讨论命令（可不填）',
          input('ask', { class: 'mono-input', placeholder: kind === 'cli' ? 'claude -p --tools Read,Grep,Glob' : '' }),
          '绑定了编程工具的不用填（讨论时自动用它的只读模式）。填了就用这条命令：接力台把题目从标准输入喂给它，读它打印的回答；含 {{out}} 时改为从这个临时文件读回答。'
        )
      : null,
    field('备注', input('note', { placeholder: '可不填' })),
    h('div', { class: 'row' }, btn('保存', saveWorker, 'primary'), btn('取消', () => ((S.workerForm = null), render()), 'ghost'))
  );
}

function workersCard(st) {
  const rows = st.workers.map((w) =>
    h(
      'div',
      { class: 'worker-row', style: `--c:${colorOf(w.name)}` },
      h('span', { class: 'bar-c' }),
      h(
        'div',
        null,
        h('div', { class: 'n' }, w.label, h('span', { class: 'mono muted small' }, `  ${w.name}`)),
        h('div', { class: 'd' }, [w.kind === 'api' ? '模型接口' : w.kind === 'app' ? '桌面 App（手动）' : '终端工具', w.tier === 'weak' ? '弱' : '强', w.model, w.effort ? `思考 ${w.effort}` : null, w.canTalk ? '能讨论' : null].filter(Boolean).join(' · ')),
        h('div', { class: 'd mono' }, w.kind === 'api' ? (w.api ? w.api.baseUrl : '') : w.cmd),
        w.auto
          ? h(
              'div',
              { class: 'd' },
              `全自动：${[w.auto.work ? '能干活' : null, w.auto.review ? '能审查' : null].filter(Boolean).join('、') || '不能用'}${w.auto.model ? ` · 模型 ${w.auto.model}` : ''}${w.effort ? ` · 思考 ${w.effort}` : ''}${w.auto.why ? `（${w.auto.why}）` : ''}`
            )
          : null,
        w.check && !w.check.ok ? h('div', { class: 'prob' }, `⚠ ${w.check.problem}`) : null
      ),
      h('div', { class: 'row' }, btn('修改', () => editWorker(w), 'small'), btn('删除', () => deleteWorker(w), 'ghost small'))
    )
  );
  return h(
    'section',
    { class: 'card' },
    h('h2', null, '工人'),
    h('p', { class: 'lead' }, '能轮流干活的 AI 工具。名单是全局的，所有项目共用。'),
    rows.length ? rows : h('p', { class: 'hint' }, '还没有工人。'),
    S.workerForm ? workerFormEl(st) : h('div', { style: 'margin-top:14px' }, btn('添加工人', newWorker, 'primary'))
  );
}

function projectCard(st) {
  const p = st.project;
  if (!p.hasConfig || !p.config) {
    return h('section', { class: 'card' }, h('h2', null, '这个项目'), h('p', { class: 'lead' }, p.configError || '当前文件夹还不是接力项目。到「任务」页设一下。'));
  }
  if (S.cfgRoot !== p.root) {
    S.cfgRoot = p.root;
    S.keep['cfg-gate'] = p.config.gate.command;
    S.keep['cfg-protected'] = p.config.protectedPaths.join('\n');
    S.keep['cfg-base'] = p.config.audit.baseUrl;
    S.keep['cfg-model'] = p.config.audit.model;
    S.keep['cfg-key'] = p.config.audit.apiKeyEnv;
  }
  const save = () =>
    act('保存设置', async () => {
      await post('/api/config/save', {
        config: {
          gate: { command: S.keep['cfg-gate'] || '' },
          protectedPaths: String(S.keep['cfg-protected'] || '').split('\n').map((x) => x.trim()).filter(Boolean),
          audit: { baseUrl: S.keep['cfg-base'] || '', model: S.keep['cfg-model'] || '', apiKeyEnv: S.keep['cfg-key'] || '' },
        },
      });
      S.cfgRoot = null;
      toast('项目设置已保存，马上生效（存在 .relay/config.json，会随下一次合回或开始任务一起提交）。');
      loadDoctor();
    });
  return h(
    'section',
    { class: 'card' },
    h('h2', null, `这个项目：${p.name}`),
    h('p', { class: 'lead' }, '只对当前项目生效，存在项目的 .relay/config.json 里。'),
    field('检查命令（可不填）', keepInput('cfg-gate', h('input', { type: 'text', class: 'mono-input', placeholder: '如 npm test' })), '每次交接都会在隔离副本里跑一遍；没通过就不让合回。不填就不检查。'),
    field('不许改的文件（每行一个，可不填）', keepInput('cfg-protected', h('textarea', { rows: 3, class: 'mono-input', placeholder: '如 .env\nconfig/\n**/*.key' })), '工人改到这些文件会标红，合回时拒绝。支持 * 和 **。'),
    h('p', { class: 'eyebrow', style: 'margin:22px 0 10px' }, '审计模型（可不填）'),
    h('p', { class: 'hint', style: 'margin:-4px 0 12px' }, '交接时请一个便宜模型读一遍改动，写「改了什么、有什么风险、下一步」。它说的只是参考，事实以 git 为准。'),
    field('接口地址', keepInput('cfg-base', h('input', { type: 'text', class: 'mono-input', placeholder: 'https://api.deepseek.com' }))),
    h(
      'div',
      { class: 'two' },
      field('模型', keepInput('cfg-model', h('input', { type: 'text', class: 'mono-input', placeholder: 'deepseek-chat' }))),
      field('密钥的环境变量名', keepInput('cfg-key', h('input', { type: 'text', class: 'mono-input', placeholder: 'DEEPSEEK_API_KEY' })))
    ),
    h('p', { class: 'hint' }, p.config.keySet ? `✓ 环境变量 ${p.config.audit.apiKeyEnv} 已设置。` : `⚠ 环境变量 ${p.config.audit.apiKeyEnv || '（没填）'} 没有设置：交接照常，只是没有模型写的阅读面。`),
    h('div', { class: 'row', style: 'margin-top:14px' }, btn('保存设置', save, 'primary', { disabled: !!S.acting }))
  );
}

/** 状态灯：ok 绿、no 红、其余黄。 */
function stateDot(state) {
  const cls = state === 'ok' ? 'ok' : state === 'no' ? 'bad' : 'warn';
  return h('span', { class: `sdot ${cls}`, 'aria-hidden': 'true' });
}

function loadDetect() {
  S.detect = { loading: false, report: null, changes: [], loaded: false };
  get('/api/detect')
    .then((r) => {
      S.detect = { ...S.detect, report: r.report, loaded: true };
      render();
    })
    .catch(() => undefined);
}

async function runDetect() {
  S.detect = { ...(S.detect || {}), loading: true };
  render();
  await act('识别', async () => {
    try {
      const r = await post('/api/detect');
      S.detect = { loading: false, report: r.report, changes: r.changes, loaded: true };
      toast(r.changes.length ? `识别完成。工人名单有 ${r.changes.length} 处变化。` : '识别完成，工人名单不用改。');
    } finally {
      if (S.detect) S.detect.loading = false;
    }
  });
}

function toolCard(x) {
  const tested = x.tested === 'yes' ? ['ok', '实测过'] : x.tested === 'partial' ? ['warn', '部分实测'] : ['plain', '没实测'];
  return h(
    'div',
    { class: `tool is-${x.login.state}` },
    h('div', { class: 'tool-top' }, stateDot(x.login.state), h('strong', null, x.label), h('span', { class: `badge ${tested[0]}` }, tested[1])),
    h('div', { class: 'tool-model' }, h('span', { class: 'mchip' }, x.model.label || x.model.model || '工具默认模型'), x.model.effort ? h('span', { class: 'muted small' }, `思考 ${x.model.effort}`) : null),
    h('div', { class: 'tool-meta' }, x.login.detail, h('span', { class: 'muted' }, ` · 版本 ${x.version}`)),
    x.model.via ? h('div', { class: 'tool-note' }, `经 ${x.model.via}`) : null,
    x.login.state === 'no' ? h('div', { class: 'tool-note warn-text' }, x.loginHint) : null,
    x.note ? h('div', { class: 'tool-note' }, x.note) : null,
    !x.workLevels.includes('safe') ? h('div', { class: 'tool-note' }, '只能在「完全放开」档干活') : null
  );
}

function providerCard(p, enabled) {
  const on = p.needsConsent ? enabled : p.state === 'ok';
  return h(
    'div',
    { class: `tool is-${on ? 'ok' : p.state}` },
    h('div', { class: 'tool-top' }, stateDot(on ? 'ok' : p.state), h('strong', null, p.label)),
    h('div', { class: 'tool-model' }, h('span', { class: 'mchip' }, p.model || '—')),
    h('div', { class: 'tool-meta mono small' }, p.baseUrl),
    h('div', { class: 'tool-note' }, p.needsConsent && enabled ? '已同意使用' : p.detail),
    p.needsConsent && !enabled
      ? h(
          'div',
          { style: 'margin-top:10px' },
          btn(
            '同意使用',
            () =>
              act('启用接口', async () => {
                await post('/api/detect/use', { id: p.id });
                toast(`已启用 ${p.label}。`);
              }),
            'primary small'
          )
        )
      : null
  );
}

function detectCard(st) {
  const d = S.detect || {};
  const r = d.report;
  const enabled = (p) => st.workers.some((w) => w.api && w.api.keyFrom && w.api.keyFrom === p.keyFrom);
  const kids = [
    h('div', { class: 'section-head' }, h('h2', null, '自动识别'), btn(d.loading ? '识别中……（十几秒）' : r ? '重新识别' : '开始识别', runDetect, 'primary small', { disabled: !!S.acting || d.loading })),
    h('p', { class: 'lead' }, '找出这台电脑上的 AI 编程工具和配好的模型接口：登没登录、默认用什么模型，都自动看；能用的自动加进工人名单。'),
  ];
  if (!r) {
    kids.push(h('p', { class: 'hint' }, d.loaded ? '还没识别过。点「开始识别」。' : '正在读取……'));
    return h('section', { class: 'card' }, ...kids);
  }
  if (d.changes && d.changes.length) kids.push(h('ul', { class: 'checks changes' }, d.changes.map((c) => h('li', null, h('span', { class: 'ok' }, '✓'), h('span', null, c)))));
  kids.push(h('h3', { class: 'sub-h' }, '编程工具', h('span', { class: 'muted small' }, ' · 能自己改文件，全自动的主力')));
  kids.push(
    r.harnesses.length
      ? h('div', { class: 'tools' }, r.harnesses.map(toolCard))
      : h('p', { class: 'hint' }, '一个都没找到。装好并登录 Claude Code / Codex / Cursor Agent 之一，再识别一次。')
  );
  kids.push(h('h3', { class: 'sub-h' }, '模型接口', h('span', { class: 'muted small' }, ' · 能审查、讨论，也能用内置小代理干活')));
  kids.push(r.providers.length ? h('div', { class: 'tools' }, r.providers.map((p) => providerCard(p, enabled(p)))) : h('p', { class: 'hint' }, '没找到配置好的密钥。'));
  if (r.unknownKeys.length) kids.push(h('p', { class: 'hint' }, `还有不认识的密钥：${r.unknownKeys.join('、')}（不知道接口地址，没用上；可以在下面「工人」里手动加成接口工人）。`));
  if (r.apps.length) {
    kids.push(h('h3', { class: 'sub-h' }, '桌面 App', h('span', { class: 'muted small' }, ' · 只能手动用')));
    kids.push(h('div', { class: 'app-chips' }, r.apps.map((a) => h('span', { class: 'app-chip', title: a.hint }, a.name))));
  }
  kids.push(h('p', { class: 'hint', style: 'margin-top:14px' }, `上次识别：${fmtTime(r.at)}`));
  return h('section', { class: 'card' }, ...kids);
}

function autoSettingsCard(st) {
  const t = st.team;
  const s = t.settings;
  const sig = JSON.stringify(s);
  if (S.autoCfg !== sig) {
    S.autoCfg = sig;
    S.keep['as-workers'] = s.workers.join(', ');
    S.keep['as-reviewers'] = s.reviewers.join(', ');
    S.keep['as-rounds'] = String(s.maxRounds);
    S.keep['as-merge'] = s.autoMerge;
    S.keep['as-level'] = s.level;
    S.keep['as-wt'] = String(s.workTimeoutMin);
    S.keep['as-rt'] = String(s.reviewTimeoutMin);
  }
  const merge = h('input', { type: 'checkbox', checked: !!S.keep['as-merge'] });
  merge.addEventListener('change', () => (S.keep['as-merge'] = merge.checked));
  const level = keepInput('as-level', h('select', null, h('option', { value: 'safe' }, '安全档：只改隔离副本，命令在工具自己的沙箱里跑'), h('option', { value: 'full' }, '完全放开：工具不再拦任何操作（风险自负）')));
  const save = () =>
    act('保存全自动设置', async () => {
      await post('/api/auto/settings', {
        settings: {
          workers: S.keep['as-workers'] || '',
          reviewers: S.keep['as-reviewers'] || '',
          maxRounds: Number(S.keep['as-rounds'] || 3),
          autoMerge: !!S.keep['as-merge'],
          level: S.keep['as-level'] || 'safe',
          workTimeoutMin: Number(S.keep['as-wt'] || 60),
          reviewTimeoutMin: Number(S.keep['as-rt'] || 20),
        },
      });
      S.autoCfg = null;
      toast('全自动设置已保存。');
    });
  const names = t.members.map((m) =>
    h(
      'span',
      { class: `lchip name-chip${m.work || m.review ? '' : ' off'}`, style: `--c:${colorOf(m.name)}`, title: m.why || '' },
      h('i', { 'aria-hidden': 'true' }),
      h('code', null, m.name),
      h('small', null, [m.label, m.model].filter(Boolean).join(' · ')),
      h('small', { class: 'roles' }, [m.work ? '干活' : null, m.review ? '审查' : null].filter(Boolean).join('/') || '不能用')
    )
  );
  return h(
    'section',
    { class: 'card' },
    h('h2', null, '全自动设置'),
    h('p', { class: 'lead' }, '全机通用，所有项目都按这个安排。'),
    h('div', { class: 'team-box' }, teamLine(t, false)),
    field('干活的人（按优先级，逗号分隔；空 = 自动排）', keepInput('as-workers', h('input', { type: 'text', class: 'mono-input', placeholder: '例如 codex, claude' })), '第一位是主力；它做不出东西（出错、没登录、额度用完）才换下一位。'),
    field('审查的人（按优先级；空 = 自动排）', keepInput('as-reviewers', h('input', { type: 'text', class: 'mono-input', placeholder: '例如 cursor-agent, deepseek' })), '每一轮会挑一个和干活的人不同的来审。'),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '可以填的名字'), names.length ? h('div', { class: 'name-chips' }, names) : h('p', { class: 'hint' }, '（还没有，先识别）')),
    h(
      'div',
      { class: 'two' },
      field('最多改几轮', keepInput('as-rounds', h('input', { type: 'number', min: 1, max: 10, class: 'mono-input' }))),
      field('权限档位', level)
    ),
    h(
      'div',
      { class: 'two' },
      field('干活一段最长（分钟）', keepInput('as-wt', h('input', { type: 'number', min: 1, max: 600, class: 'mono-input' }))),
      field('审查一次最长（分钟）', keepInput('as-rt', h('input', { type: 'number', min: 1, max: 120, class: 'mono-input' })))
    ),
    h('label', { class: 'check-line' }, merge, ' 审查通过后自动合回正式文件夹'),
    ...(t.problems || []).map((pr) => h('p', { class: 'hint warn-text' }, `⚠ ${pr}`)),
    h('div', { class: 'row', style: 'margin-top:14px' }, btn('保存', save, 'primary', { disabled: !!S.acting }))
  );
}

function doctorCard() {
  const d = S.doctor;
  const icon = { ok: '✓', warn: '⚠', bad: '✗' };
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'section-head' }, h('h2', null, '环境检查'), btn(d && d.loading ? '检查中……' : '重新检查', loadDoctor, 'ghost small', { disabled: !!(d && d.loading) })),
    h('p', { class: 'lead' }, '这台电脑、工人的命令、当前项目能不能用。'),
    d && d.lines.length ? h('ul', { class: 'checks' }, d.lines.map((l) => h('li', null, h('span', { class: l.level }, icon[l.level]), h('span', null, l.text)))) : h('p', { class: 'hint' }, '正在检查……')
  );
}

function renderSettings() {
  const st = S.st;
  if (!S.presets) {
    S.presets = [];
    get('/api/presets')
      .then((r) => {
        S.presets = r.presets;
        render();
      })
      .catch(() => undefined);
  }
  if (!S.doctor) loadDoctor();
  if (!S.detect) loadDetect();
  const box = $('view-settings');
  const view = { ...st, presets: S.presets };
  mount(
    box,
    JSON.stringify(['settings', st.workers, st.project.root, st.project.config, st.project.configError, S.workerForm, S.workerForm ? S.keep['wf-kind'] : null, S.workerForm ? S.keep['wf-tier'] : null, S.doctor, S.acting, S.presets.length, S.colors, S.detect, st.team]),
    () =>
      h(
        'div',
        { class: 'settings' },
        detectCard(st),
        autoSettingsCard(st),
        workersCard(view),
        projectCard(st),
        doctorCard(),
        h('p', { class: 'hint', style: 'text-align:center' }, `接力台 ${st.version} · 命令行也能用：relay --help`)
      )
  );
}

// ---------- 启动 ----------

for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setView(b.dataset.view));

$('project-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('project-menu').hidden) openMenu();
  else closeMenu();
});

document.addEventListener('click', (e) => {
  if (!$('project-menu').hidden && !e.target.closest('.project-switch')) closeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('project-menu').hidden) closeMenu();
  else if (dlg) closeDialog();
});

$('scrim').addEventListener('click', () => closeDialog());
$('toast').addEventListener('click', () => ($('toast').hidden = true));

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (['task', 'talk', 'settings'].includes(v) && v !== S.view) setView(v);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refresh();
    if (S.view === 'talk') loadTalk();
  }
});

function loop() {
  const running = S.st && (S.st.busy || (S.st.talk && S.st.talk.current) || autoRunning(S.st) || S.st.detecting);
  const delay = document.hidden ? 20000 : running || S.acting ? 1500 : 4000;
  setTimeout(async () => {
    if (!document.hidden) {
      await refresh();
      if (S.view === 'talk') await loadTalk();
    }
    loop();
  }, delay);
}

render();
refresh().then(() => {
  if (S.view === 'talk') loadTalk();
});
loop();
