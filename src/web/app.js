'use strict';
/* 接力台网页。没有构建步骤、不连外网：直接由 relay ui 提供。
   状态都来自 /api/state（服务端算好），这里只负责显示和把按钮变成请求。
   原则：一眼看清「任务到哪了、现在谁在做、谁该接着做」；细节都收起来，点开才看。 */

// ---------- 小工具 ----------

const $ = (id) => document.getElementById(id);

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
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |Binary|# )/.test(l)) cls += ' meta';
      else if (l.startsWith('@@')) cls += ' hunk';
      else if (l.startsWith('+')) cls += ' add';
      else if (l.startsWith('-')) cls += ' del';
      return `<div class="${cls}">${esc(l) || ' '}</div>`;
    })
    .join('');
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

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

function since(ts) {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

function tildify(p) {
  const home = S.st && S.st.home;
  return home && p && p.startsWith(home) ? `~${p.slice(home.length)}` : p || '';
}

/** 计票用「正」字：一 丅 下 止 正。 */
function zheng(n) {
  const parts = ['', '一', '丅', '下', '止'];
  if (!n) return '·';
  return '正'.repeat(Math.floor(n / 5)) + parts[n % 5];
}

// ---------- 状态 ----------

const S = {
  dir: new URLSearchParams(location.search).get('dir') || '',
  view: 'relay',
  st: null,
  /** 展开的棒。 */
  open: new Set(),
  /** 已经见过的印章（新出现的才有盖章动画）。 */
  seenSeals: new Set(),
  firstPaint: true,
  showAll: false,
  showChecklist: false,
  showLog: false,
  dismissed: '',
  talk: { rows: [], votes: [], status: { speaking: [], queue: [] } },
  talkAsk: null,
  talkMode: 'turn',
  draft: '',
  voteDraft: { question: '', options: '' },
  /** 还没提交的输入（页面重画时不丢）。 */
  initDraft: '',
  taskDraft: { title: '', steps: '' },
  detail: new Map(),
};

async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: S.dir || undefined, ...body }) };
  const res = await fetch(path, init);
  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error(`接力台返回了看不懂的内容（${res.status}）`);
  }
  if (!j.ok) throw Object.assign(new Error(j.error || '出错了'), { code: j.code });
  return j;
}

/** GET 地址带上当前项目。 */
function q(path) {
  return S.dir ? `${path}${path.includes('?') ? '&' : '?'}dir=${encodeURIComponent(S.dir)}` : path;
}

let toastTimer = null;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3200);
}

/** 按钮点下去：请求期间变灰（慢的话按钮上写「…」），出错弹提示，做完刷新。 */
async function act(btn, fn, okText) {
  let slow = null;
  const label = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    slow = setTimeout(() => {
      if (btn.isConnected) btn.textContent = `${label}…`;
    }, 400);
  }
  try {
    const r = await fn();
    if (okText) toast(typeof okText === 'function' ? okText(r) : okText);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    clearTimeout(slow);
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- 弹窗 ----------

function openDialog(title, body, foot) {
  const d = $('dialog');
  d.replaceChildren(h('h3', { id: 'dialog-title' }, title), body, foot ? h('div', { class: 'foot' }, foot) : null);
  d.hidden = false;
  $('scrim').hidden = false;
  const f = d.querySelector('textarea, input, .foot .primary, .foot .seal-btn, .foot button');
  if (f) f.focus();
}

function closeDialog() {
  $('dialog').hidden = true;
  $('scrim').hidden = true;
  $('dialog').replaceChildren();
}

function confirmDialog(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    const ok = h('button', { class: `btn ${danger ? 'seal-btn' : 'primary'}`, onclick: () => (closeDialog(), resolve(true)) }, okLabel);
    const no = h('button', { class: 'btn', onclick: () => (closeDialog(), resolve(false)) }, '算了');
    openDialog(title, h('div', { class: 'doc' }, h('p', null, text)), [no, ok]);
  });
}

function askDialog(title, hint, placeholder, okLabel) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder, style: 'width:100%' });
    const ok = h('button', { class: 'btn primary', onclick: () => (closeDialog(), resolve(input.value.trim())) }, okLabel);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ok.click());
    openDialog(title, h('div', null, h('p', { class: 'faint', style: 'margin:0 0 10px' }, hint), input), [h('button', { class: 'btn', onclick: () => (closeDialog(), resolve('')) }, '算了'), ok]);
  });
}

$('scrim').addEventListener('click', closeDialog);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('dialog').hidden) closeDialog();
  closeMenu();
  closePops();
});

// ---------- 刷新 ----------

let pollTimer = null;

async function refresh(fromPoll = false) {
  try {
    const st = await api(q('/api/state'));
    S.st = st;
    if (!S.dir) S.dir = st.project.root;
    setOffline(false);
    // 设置页上可能有没保存的修改：定时刷新不重画它，点了按钮才重画。
    if (fromPoll && S.view === 'settings') return;
    render();
  } catch (e) {
    if (e instanceof TypeError) setOffline(true);
    else toast(e.message, true);
  }
}

function setOffline(v) {
  $('offline').hidden = !v;
}

function schedule() {
  clearTimeout(pollTimer);
  const p = S.st && S.st.project;
  const live = p && (p.now.kind === 'relay' || p.now.kind === 'waiting' || (p.go && p.go.status === 'running'));
  const t = S.talk;
  const talking = S.view === 'talk' && (t.status.speaking.length || t.status.queue.length || t.votes.some((v) => v.status !== 'done'));
  const ms = document.hidden ? 15000 : talking ? 1200 : live ? 1500 : 3000;
  pollTimer = setTimeout(async () => {
    if (!busyTyping() && $('dialog').hidden) {
      await refresh(true);
      if (S.view === 'talk') await loadTalk();
    }
    schedule();
  }, ms);
}

/** 正在填东西时不刷新页面（不然输入框会被重画，焦点和没保存的内容都会丢）。 */
function busyTyping() {
  const a = document.activeElement;
  if (!a || !['TEXTAREA', 'INPUT', 'SELECT'].includes(a.tagName)) return false;
  return !(a.tagName === 'INPUT' && (a.type === 'checkbox' || a.type === 'radio'));
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().then(schedule);
});

// ---------- 顶栏：项目、页签 ----------

function render() {
  const st = S.st;
  if (!st) return;
  const p = st.project;
  $('project-name').textContent = p.name || '选一个项目文件夹';
  $('project-btn').title = p.root;
  document.title = p.name ? `${p.name} · 接力台` : '接力台';
  $('talk-dot').hidden = !(st.talk.speaking && st.talk.speaking.length);
  for (const v of ['relay', 'talk', 'settings']) {
    $(`view-${v}`).hidden = S.view !== v;
    const tab = $(`tab-${v}`);
    if (S.view === v) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const scroll = window.scrollY;
  if (S.view === 'relay') renderRelay();
  else if (S.view === 'talk') renderTalk();
  else renderSettings();
  window.scrollTo(0, scroll);
  S.firstPaint = false;
}

function setView(v) {
  S.view = v;
  history.replaceState(null, '', `${location.pathname}${location.search}#${v}`);
  render();
  if (v === 'talk') loadTalk();
  schedule();
}

for (const a of document.querySelectorAll('.tabs a')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    setView(a.dataset.view);
  });
}

function closeMenu() {
  $('project-menu').hidden = true;
  $('project-btn').setAttribute('aria-expanded', 'false');
}

function closePops() {
  for (const m of document.querySelectorAll('.menu.pop')) m.remove();
}

$('project-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('project-menu');
  if (!m.hidden) return closeMenu();
  const st = S.st;
  const items = [];
  for (const p of (st && st.projects) || []) {
    if (p.current) continue;
    items.push(
      h(
        'button',
        { onclick: () => switchProject(p.root) },
        p.name,
        p.pending ? h('span', { class: 'badge bad', style: 'margin-left:8px' }, `${p.pending} 棒待复核`) : !p.init ? h('span', { class: 'faint', style: 'margin-left:8px' }, '没接入') : null,
        h('span', { class: 'sub' }, tildify(p.root))
      )
    );
  }
  if (items.length) items.push(h('div', { class: 'sep' }));
  items.push(h('button', { onclick: chooseFolder }, '打开别的文件夹…', h('span', { class: 'sub' }, '接力台会记住你打开过的项目')));
  if (st && st.project.root) {
    items.push(h('button', { onclick: () => (closeMenu(), copyText(st.project.root).then((ok) => toast(ok ? '路径复制好了' : st.project.root))) }, '复制这个文件夹的路径', h('span', { class: 'sub' }, tildify(st.project.root))));
  }
  m.replaceChildren(...items);
  m.hidden = false;
  $('project-btn').setAttribute('aria-expanded', 'true');
});

document.addEventListener('click', (e) => {
  if (!$('project-menu').hidden && !$('project-menu').contains(e.target)) closeMenu();
  for (const m of document.querySelectorAll('.menu.pop')) if (!m.contains(e.target)) m.remove();
});

function switchProject(root) {
  closeMenu();
  S.dir = root;
  S.open.clear();
  S.detail.clear();
  S.seenSeals.clear();
  S.firstPaint = true;
  S.showAll = false;
  S.talkAsk = null;
  history.replaceState(null, '', `/?dir=${encodeURIComponent(root)}#${S.view}`);
  refresh().then(() => S.view === 'talk' && loadTalk());
}

async function chooseFolder() {
  closeMenu();
  try {
    const r = await api('/api/choose-folder', {});
    switchProject(r.dir);
  } catch (e) {
    if (e.code !== 'cancelled') toast(e.message, true);
  }
}

// ---------- 成员 ----------

function members() {
  return (S.st && S.st.members) || [];
}

function ready() {
  return members().filter((m) => m.canWork && !m.cooling);
}

function tierEl(t) {
  const word = t === 'strong' ? '强' : t === 'weak' ? '弱' : '？';
  const title = t === 'strong' ? '强模型：它交接的不用复核' : t === 'weak' ? '弱模型：它做的要等强模型复核' : '不知道是谁：按弱处理，要复核';
  return h('span', { class: `tier ${t || 'unknown'}`, title, 'aria-label': title }, word);
}

function seal(kind, text, key) {
  const fresh = key && !S.firstPaint && !S.seenSeals.has(key);
  if (key) S.seenSeals.add(key);
  return h('span', { class: `seal ${kind}${fresh ? ' fresh' : ''}`, role: 'img', 'aria-label': text }, text);
}

// ---------- 接力页 ----------

function renderRelay() {
  const el = $('view-relay');
  const p = S.st.project;
  if (!p.init) return el.replaceChildren(...welcome(p));
  el.replaceChildren(...taskBlock(p), nowBlock(p), ...pendingBlock(p), ...logBlock(p), footBlock(p));
}

function welcome(p) {
  const text = h('input', { type: 'text', placeholder: '写一句要做什么（也可以先不写）', style: 'flex:1;min-width:220px', value: S.initDraft, oninput: (e) => (S.initDraft = e.target.value) });
  const go = h(
    'button',
    {
      class: 'btn primary',
      onclick: (e) =>
        act(e.currentTarget, () => api('/api/init', { task: text.value.trim() || undefined }), (r) => (r.actions && r.actions.length ? `接入好了：${r.actions.join('；')}` : '接入好了')).then((r) => r && (S.initDraft = '')),
    },
    '接入这个文件夹'
  );
  text.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  return [
    h(
      'div',
      { class: 'welcome' },
      h('h1', null, `「${p.name}」还没接入`),
      h('p', { class: 'muted' }, '接入之后，不管换哪个 AI 接着做，进度都接得上，弱模型的活也有人把关。'),
      h(
        'ul',
        { class: 'promise' },
        h('li', null, h('b', null, '接得上'), h('span', null, '各家 AI 开工先读「接力本」：任务、进度、上一棒留的话都在里面。')),
        h('li', null, h('b', null, '有账可查'), h('span', null, '每一棒改了什么、自己说了什么都记下来；额度用完被打断、没留话的，接力台替它记一笔。')),
        h('li', null, h('b', null, '有人把关'), h('span', null, '弱模型做的棒盖「待核」章，强模型额度回来后先复核、改好，再往下做。')),
        h('li', null, h('b', null, '能退回'), h('span', null, '每一棒前后都存了快照，改坏了就退回到那一棒之前。'))
      ),
      h('div', { class: 'row' }, text, go),
      h(
        'p',
        { class: 'will' },
        '会做的事：在这个文件夹里建 ',
        h('code', null, '.relay/'),
        '，在 ',
        h('code', null, 'AGENTS.md'),
        ' 和 ',
        h('code', null, 'CLAUDE.md'),
        ' 末尾加一段接力规矩（你自己写的内容不动），存一张快照。不需要 git，也不碰你的 git。',
        h('br'),
        '文件夹：',
        tildify(p.root)
      )
    ),
  ];
}

function taskBlock(p) {
  const t = p.task;
  if (t.empty) {
    const title = h('input', { type: 'text', placeholder: '一句话说清楚要做成什么样', style: 'width:100%', value: S.taskDraft.title, oninput: (e) => (S.taskDraft.title = e.target.value) });
    const steps = h('textarea', { placeholder: '拆成几步（每行一步；可以不写，让接手的 AI 来拆）', rows: 3, style: 'width:100%', value: S.taskDraft.steps, oninput: (e) => (S.taskDraft.steps = e.target.value) });
    const save = h(
      'button',
      {
        class: 'btn primary',
        onclick: (e) =>
          act(
            e.currentTarget,
            () =>
              api('/api/task', {
                text: title.value,
                steps: steps.value
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean),
              }),
            '任务写好了'
          ).then((r) => r && (S.taskDraft = { title: '', steps: '' })),
      },
      '写好了'
    );
    title.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
    return [
      h('h1', { class: 'task-title' }, '要做什么？'),
      h('p', { class: 'muted', style: 'margin:6px 0 14px' }, '写下来，每个接手的 AI 都会看到。也可以直接告诉某个 AI，它会写到这里。'),
      h('div', { class: 'new-task', style: 'display:grid;gap:10px' }, title, steps, h('div', null, save)),
    ];
  }
  const out = [h('h1', { class: 'task-title' }, h('button', { onclick: editTask, title: '改任务' }, t.title))];
  const rest = t.body.split('\n').slice(1).join('\n').trim();
  if (rest) out.push(h('p', { class: 'task-body' }, rest.length > 240 ? `${rest.slice(0, 240)}…` : rest));
  if (t.total) {
    const next = t.items.find((i) => !i.done);
    const prog =
      t.total <= 24
        ? h(
            'div',
            { class: 'cells', 'aria-hidden': 'true' },
            t.items.map((i) => h('i', { class: i.done ? 'done' : '' }))
          )
        : h('div', { class: 'bar' }, h('span', { style: `width:${Math.round((t.done / t.total) * 100)}%` }));
    const nextText = next ? `下一步：${next.text.length > 30 ? `${next.text.slice(0, 30)}…` : next.text}` : '全部打勾了';
    out.push(
      h(
        'div',
        { class: 'progress' },
        prog,
        h('span', { class: 'num' }, `${t.done} / ${t.total}`),
        h('button', { class: 'link', 'aria-expanded': S.showChecklist ? 'true' : 'false', onclick: () => ((S.showChecklist = !S.showChecklist), render()) }, S.showChecklist ? '收起清单' : nextText)
      )
    );
    if (S.showChecklist) {
      let marked = false;
      out.push(
        h(
          'ul',
          { class: 'checklist' },
          t.items.map((i) => {
            const isNext = !i.done && !marked;
            if (isNext) marked = true;
            return h('li', { class: i.done ? 'done' : isNext ? 'next' : '' }, i.text);
          })
        )
      );
    }
  } else {
    out.push(h('p', { class: 'faint', style: 'margin-top:10px' }, '还没拆成步骤。接手的 AI 会先拆好写进清单；你也可以', h('button', { class: 'link', onclick: editTask }, '自己拆'), '。'));
  }
  if (t.rules && (S.showChecklist || !t.total)) out.push(h('div', { class: 'rules' }, h('b', null, '约定'), h('div', { class: 'doc', html: md(t.rules) })));
  return out;
}

async function editTask() {
  let raw = '';
  try {
    raw = (await api(q('/api/task'))).raw;
  } catch (e) {
    return toast(e.message, true);
  }
  const ta = h('textarea', { class: 'code', value: raw, spellcheck: 'false' });
  const save = h('button', { class: 'btn primary', onclick: (e) => act(e.currentTarget, () => api('/api/task/save', { raw: ta.value }), '任务存好了').then((r) => r && closeDialog()) }, '保存');
  const fresh = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        const text = await askDialog('换一个新任务', '旧任务会存进 .relay/做完的任务.md。', '一句话说清楚要做成什么样', '换');
        if (text) await act(null, () => api('/api/task', { text }), '换好了新任务');
      },
    },
    '换一个新任务'
  );
  openDialog(
    '改任务（.relay/任务.md）',
    h('div', null, h('p', { class: 'faint', style: 'margin:0 0 8px' }, '「进度」里每行一步：- [ ] 没做，- [x] 做完了。「约定」里写所有 AI 都要遵守的。'), ta),
    [fresh, h('span', { style: 'flex:1' }), h('button', { class: 'btn', onclick: closeDialog }, '算了'), save]
  );
}

/** 默认让谁接着做：有待复核就先挑强的（它会先复核）；否则按顺序第一个有额度的。 */
function defaultWorker(p) {
  const r = ready();
  if (!r.length) return null;
  if (p.pending.length) return r.find((m) => m.tier === 'strong') || r[0];
  return r[0];
}

function nowBlock(p) {
  const box = h('section', { class: 'now', 'aria-label': '现在' });
  const g = p.go;
  const running = p.now.kind === 'relay' || p.now.kind === 'waiting' || (g && (g.status === 'running' || g.status === 'waiting'));
  if (running) {
    const waiting = p.now.kind === 'waiting' || (g && g.status === 'waiting');
    const cur = g && g.current;
    const what = cur ? `${cur.label} 正在${cur.kind === 'review' ? '复核' : cur.kind === 'final' ? '终审' : '干活'}（第 ${cur.stint} 棒，${since(cur.since)}）` : p.now.text;
    box.append(
      h('div', { class: 'now-line' }, h('span', { class: `pulse ${waiting ? 'wait' : 'live'}` }), h('span', null, waiting ? g.phase : what)),
      h(
        'div',
        { class: 'row actions' },
        h('button', { class: 'btn', onclick: (e) => act(e.currentTarget, () => api('/api/stop', {}), '叫停了：正在干活的工具会被结束') }, '停下'),
        cur ? h('button', { class: 'link', 'aria-expanded': S.showLog ? 'true' : 'false', onclick: () => ((S.showLog = !S.showLog), render()) }, S.showLog ? '收起' : '看它在干什么') : null,
        g && g.mode === 'auto' ? h('span', { class: 'faint' }, '全自动：额度用完换人，弱模型的棒先请强模型复核') : null
      )
    );
    if (S.showLog && g && g.logTail) {
      const log = h('pre', { class: 'log' }, g.logTail);
      box.append(log);
      requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
    }
    return box;
  }

  box.append(h('div', { class: 'now-line' }, h('span', { class: `pulse ${p.now.kind === 'native' ? 'live' : 'idle'}` }), h('span', null, p.now.kind === 'native' ? p.now.text : '空闲。')));

  // 上一次调度的结果（看过就收起来）
  if (g && g.result && ['done', 'needs-human', 'failed', 'stopped'].includes(g.status) && S.dismissed !== g.id) {
    const cls = g.status === 'done' ? 'done' : g.status === 'failed' ? 'bad' : 'warn';
    box.append(h('div', { class: `result ${cls}` }, h('span', { class: 'grow' }, g.result), h('button', { class: 'link', onclick: () => ((S.dismissed = g.id), render()) }, '知道了')));
  }

  const w = defaultWorker(p);
  const acts = h('div', { class: 'row actions' });
  if (w) {
    const main = h('button', { class: 'btn primary', onclick: (e) => goWith(e.currentTarget, w) }, `让 ${w.label} 接着做`);
    const more = h('button', { class: 'btn primary', 'aria-label': '换人', title: '换人', 'aria-haspopup': 'true', onclick: (e) => (e.stopPropagation(), whoMenu(e.currentTarget)) }, '▾');
    acts.append(h('span', { class: 'split' }, main, more));
  } else {
    acts.append(h('button', { class: 'btn', 'aria-haspopup': 'true', onclick: (e) => (e.stopPropagation(), whoMenu(e.currentTarget)) }, '换人接着做 ▾'));
  }
  acts.append(
    h(
      'button',
      {
        class: 'btn',
        disabled: p.task.empty || !ready().length,
        title: p.task.empty ? '先写下任务' : '一直接力到清单全部打勾：额度用完换人，弱模型的活先请强模型复核，最后强模型终审',
        onclick: (e) => act(e.currentTarget, () => api('/api/auto', {}), '全自动开始了'),
      },
      '全自动做完'
    )
  );
  box.append(acts);
  if (!ready().length) {
    const cooling = members().filter((m) => m.canWork && m.cooling);
    box.append(
      h(
        'p',
        { class: 'aside' },
        cooling.length
          ? `能调度的都没额度了：${cooling.map((m) => `${m.label} ${m.coolingText}`).join('、')}。`
          : '接力台现在调度不了任何 AI（没装、没登录）。你自己在别的工具里接着做也一样，接力台照样记账。'
      )
    );
  }
  box.append(h('p', { class: 'aside' }, '也可以自己在任何 AI 工具里打开这个文件夹，对它说', h('span', { class: 'kai' }, '「接着做」'), '。', h('button', { class: 'link', onclick: copyHint }, '复制完整的开场白')));
  return box;
}

async function copyHint() {
  const ok = await copyText(S.st.hint);
  if (!ok) await api('/api/copy-hint', {}).catch(() => null);
  toast('复制好了，粘贴给任何 AI 就行');
}

function goWith(btn, m, kind) {
  return act(btn, () => api('/api/go', { who: m.name, ...(kind ? { kind } : {}) }), `${m.label} 开始${kind === 'review' ? '复核' : '接着做'}了`);
}

function popMenu(anchor, items) {
  closePops();
  const menu = h('div', { class: 'menu pop', role: 'menu' }, items);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'absolute';
  menu.style.top = `${window.scrollY + r.bottom + 6}px`;
  const left = Math.max(12, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 12));
  menu.style.left = `${left}px`;
  const first = menu.querySelector('button:not([disabled])');
  if (first) first.focus();
}

function whoMenu(anchor) {
  const items = [];
  const drive = members().filter((m) => m.canWork);
  if (drive.length) {
    items.push(h('div', { class: 'group' }, '接力台替你调度（在后台跑，跑完自动记账）'));
    for (const m of drive) {
      items.push(
        h(
          'button',
          { role: 'menuitem', disabled: !!m.cooling, onclick: () => (closePops(), goWith(null, m)) },
          h('span', { class: 'row', style: 'gap:8px' }, tierEl(m.tier), m.label, m.model ? h('span', { class: 'faint' }, m.model) : null),
          m.cooling ? h('span', { class: 'sub' }, `额度用完，${m.coolingText}`) : null
        )
      );
    }
  }
  const self = members().filter((m) => m.kind === 'app' || (m.kind === 'harness' && m.agent && m.agent.cmd));
  if (self.length) {
    items.push(h('div', { class: 'sep' }), h('div', { class: 'group' }, '你自己在它的窗口里接着做（打开它，开场白已复制）'));
    for (const m of self) {
      items.push(
        h(
          'button',
          {
            role: 'menuitem',
            onclick: async () => {
              closePops();
              const r = await act(null, () => api('/api/open', { who: m.name }));
              if (r) {
                if (!r.copied) await copyText(r.hint);
                toast(`${m.label} 打开了。把开场白粘贴给它就行`);
              }
            },
          },
          h('span', { class: 'row', style: 'gap:8px' }, tierEl(m.tier), m.label, m.kind === 'harness' ? h('span', { class: 'faint' }, '在终端里') : null)
        )
      );
    }
  }
  if (!items.length) items.push(h('div', { class: 'group' }, '名单里还没有 AI。去「设置」里重新识别一下。'));
  popMenu(anchor, items);
}

function pendingBlock(p) {
  if (!p.pending.length) return [];
  const reviewer = ready().find((m) => m.tier === 'strong');
  const cooling = members().filter((m) => m.tier === 'strong' && m.canWork && m.cooling);
  const busy = p.now.kind === 'relay' || (p.go && p.go.status === 'running');
  const out = [h('h2', { class: 'label' }, '待复核', h('span', { class: 'count' }, `${p.pending.length} 棒`))];
  const list = h('div', { class: 'pending' });
  for (const s of p.pending) {
    list.append(
      h(
        'div',
        { class: 'pend' },
        seal('pending', '待核', `p${s.id}`),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'who' }, `第 ${s.id} 棒 · ${s.who.label}`, tierEl(s.who.tier)),
          h('p', { class: 'what kai' }, s.summary || (s.ghost ? '它没留交接' : '（没写做了什么）')),
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'faint' }, [factsText(s), s.gate ? (s.gate.status === 'pass' ? '检查通过' : '检查没过') : '', fmtTime(s.endedAt)].filter(Boolean).join(' · ')),
            h('span', { style: 'flex:1' }),
            h('button', { class: 'btn small quiet', onclick: () => showDiff(s) }, '看改动'),
            h('button', { class: 'btn small quiet', title: '比如其实是你自己改的', onclick: (e) => act(e.currentTarget, () => api('/api/mark', { stint: s.id }), `第 ${s.id} 棒标成不用复核了`) }, '不用复核')
          )
        )
      )
    );
  }
  out.push(list);
  const foot = h('div', { class: 'row', style: 'margin-top:12px' });
  if (reviewer && !busy) foot.append(h('button', { class: 'btn seal-btn', onclick: (e) => goWith(e.currentTarget, reviewer, 'review') }, `请 ${reviewer.label} 复核`));
  foot.append(
    h(
      'span',
      { class: 'faint', style: 'flex:1;min-width:200px' },
      reviewer
        ? '复核：对照它的交接看真实改动，错的直接修好，再盖章。'
        : cooling.length
          ? `强模型都没额度了（${cooling.map((m) => `${m.label} ${m.coolingText}`).join('、')}）。到时候再请它复核；你自己打开强模型说「接着做」，它也会先复核。`
          : '名单里没有能调度的强模型。自己打开一个强模型说「接着做」，它会先复核。'
    )
  );
  out.push(foot);
  return out;
}

function factsText(s) {
  const f = s.facts;
  if (!f) return '';
  return f.files ? `改了 ${f.files} 个文件 +${f.added} −${f.removed}` : '没改文件';
}

function sealFor(s) {
  if (s.rolledBack) return seal('void', '作废', `v${s.id}`);
  if (s.kind === 'final') return seal('final', '终审', `f${s.id}`);
  if (s.status === 'working') return null;
  if (s.review === 'needed') return seal('pending', '待核', `p${s.id}`);
  if (s.review === 'done') return seal('', '已核', `d${s.id}`);
  return null;
}

function logBlock(p) {
  const list = p.stints;
  if (!list.length) return [h('h2', { class: 'label' }, '接力记录'), h('p', { class: 'empty' }, '还没有人接过棒。上面派一个 AI，或者自己在别的工具里开始做。')];
  const shown = S.showAll ? list : list.slice(0, 8);
  const ol = h('ol', { class: 'log-list' });
  for (const s of shown) ol.append(entry(s, p));
  const out = [h('h2', { class: 'label' }, '接力记录', h('span', { class: 'count' }, `${list.length} 棒`)), ol];
  if (list.length > shown.length) out.push(h('button', { class: 'link more', onclick: () => ((S.showAll = true), render()) }, `更早的 ${list.length - shown.length} 棒`));
  if (p.lastRollback) {
    const r = p.lastRollback;
    out.push(
      h(
        'p',
        { class: 'faint', style: 'margin-top:14px' },
        `${fmtTime(r.ts)} 退回到了「${r.label}」，第 ${r.dropped.join('、')} 棒作废了。`,
        r.undone ? null : h('button', { class: 'link', onclick: (e) => act(e.currentTarget, () => api('/api/rollback/undo', {}), '撤销了：那几棒的改动回来了') }, '撤销这次退回')
      )
    );
  }
  return out;
}

function entry(s, p) {
  const isOpen = S.open.has(s.id);
  const live = s.status === 'working';
  const kind = s.kind === 'review' ? '复核' : s.kind === 'final' ? '终审' : '';
  const badges = [];
  if (s.status === 'quota') badges.push(h('span', { class: 'badge quota' }, '额度用完'));
  if (s.status === 'failed') badges.push(h('span', { class: 'badge bad' }, '出错了'));
  if (s.status === 'unfinished') badges.push(h('span', { class: 'badge quota' }, '没留交接'));
  if (s.status === 'stopped') badges.push(h('span', { class: 'badge quota' }, '叫停了'));
  if (s.gate && s.gate.status === 'fail') badges.push(h('span', { class: 'badge bad' }, '检查没过'));
  if (s.protectedHits) badges.push(h('span', { class: 'badge bad' }, '改到了不许改的文件'));
  const last = s.reviews.length ? s.reviews[s.reviews.length - 1] : null;
  const li = h(
    'li',
    { class: `entry${s.rolledBack ? ' void' : ''}${live ? ' open-now' : ''}` },
    h('div', { class: 'no' }, String(s.id), h('small', null, '棒')),
    h(
      'div',
      null,
      h(
        'div',
        { class: 'head' },
        h('button', { class: 'name', 'aria-expanded': isOpen ? 'true' : 'false', title: isOpen ? '收起' : '看交接、改动、复核', onclick: () => toggle(s.id) }, s.who.label),
        tierEl(s.who.tier),
        kind ? h('span', { class: 'kind-tag' }, kind) : null,
        live ? h('span', { class: 'badge ok' }, '进行中') : null,
        badges
      ),
      s.summary || s.note ? h('p', { class: 'said kai' }, s.summary || s.note) : null,
      h(
        'div',
        { class: 'meta' },
        h('span', null, fmtTime(s.endedAt || s.startedAt)),
        s.facts ? h('span', null, factsText(s)) : null,
        h('span', null, s.via === 'relay' ? '接力台调度' : '自己在工具里做'),
        s.review === 'done' && last ? h('span', null, `${last.byLabel} 复核：${last.verdictWord}`) : null
      )
    ),
    h('div', { class: 'stamp' }, sealFor(s))
  );
  if (isOpen) li.append(detailBox(s, p));
  return li;
}

function toggle(id) {
  if (S.open.has(id)) S.open.delete(id);
  else {
    S.open.add(id);
    loadDetail(id);
  }
  render();
}

async function loadDetail(id) {
  try {
    const d = await api(q(`/api/stint?id=${id}`));
    S.detail.set(id, d);
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

function detailBox(s, p) {
  const d = S.detail.get(s.id);
  const box = h('div', { class: 'detail' });
  if (!d) {
    box.append(h('p', { class: 'faint' }, '读取中…'));
    return box;
  }
  if (d.handoff) box.append(h('h5', null, s.ghost ? '接力台代写的交接' : '它自己写的交接'), h('div', { class: `doc${s.ghost ? '' : ' handwritten'}`, html: md(d.handoff) }));
  else box.append(h('h5', null, '交接'), h('p', { class: 'faint' }, s.status === 'working' ? '还没写交接。' : '没有交接。'));
  if (s.who.claimed) box.append(h('p', { class: 'faint' }, `它自己写的身份：${s.who.claimed}`));
  for (const r of d.reviews) box.append(h('h5', null, '复核'), h('div', { class: 'doc handwritten', html: md(r.text) }));
  if (s.facts && s.facts.paths.length) {
    box.append(
      h('h5', null, `改了哪些文件（${s.facts.files}）`),
      h(
        'ul',
        { class: 'files' },
        s.facts.paths.slice(0, 60).map((f) => h('li', null, h('button', { onclick: () => showDiff(s, f) }, f)))
      )
    );
  }
  if (s.gate) box.append(h('h5', null, '检查'), h('p', { class: 'faint' }, `${s.gate.status === 'pass' ? '通过' : '没通过'}：${s.gate.command}`), s.gate.detail ? h('pre', { class: 'log' }, s.gate.detail) : null);
  if (s.note && s.summary) box.append(h('h5', null, '接力台的说明'), h('p', { class: 'faint' }, s.note));
  const acts = h('div', { class: 'row', style: 'margin-top:14px' });
  if (s.facts && s.facts.files) acts.append(h('button', { class: 'btn small', onclick: () => showDiff(s) }, '看全部改动'));
  if (s.log) acts.append(h('button', { class: 'btn small quiet', onclick: () => showLog(s) }, '看运行日志'));
  if (!s.rolledBack && s.status !== 'working') {
    acts.append(
      h(
        'button',
        {
          class: 'btn small danger',
          disabled: p.now.kind === 'relay',
          onclick: async (e) => {
            const btn = e.currentTarget;
            const ok = await confirmDialog(
              `退回到第 ${s.id} 棒之前？`,
              `整个文件夹恢复成第 ${s.id} 棒开始前的样子，第 ${s.id} 棒和之后的改动作废（账上还留着）。退回前会先存一张快照，退错了可以撤销。`,
              '退回',
              true
            );
            if (ok) act(btn, () => api('/api/rollback', { stint: s.id }), (r) => `退回好了：${r.files} 个文件恢复了`);
          },
        },
        '退回到这一棒之前'
      )
    );
  }
  box.append(acts);
  return box;
}

async function showDiff(s, file) {
  try {
    const d = await api(q(`/api/diff?id=${s.id}${file ? `&path=${encodeURIComponent(file)}` : ''}`));
    openDialog(file ? `第 ${s.id} 棒 · ${file}` : `第 ${s.id} 棒改了什么`, h('div', { class: 'diff', html: diffHtml(d.diff || '（没有改动）') }), [h('button', { class: 'btn', onclick: closeDialog }, '关上')]);
  } catch (e) {
    toast(e.message, true);
  }
}

async function showLog(s) {
  try {
    const d = await api(q(`/api/log?path=${encodeURIComponent(s.log)}`));
    openDialog(`第 ${s.id} 棒的运行日志`, h('pre', { class: 'log', style: 'max-height:62vh' }, d.text || '（空的）'), [h('button', { class: 'btn', onclick: closeDialog }, '关上')]);
  } catch (e) {
    toast(e.message, true);
  }
}

function footBlock(p) {
  const bits = [];
  if (p.protocol !== 'ok') {
    bits.push(
      h(
        'div',
        { class: 'result warn', style: 'margin-top:26px' },
        h('span', { class: 'grow' }, p.protocol === 'old' ? 'AGENTS.md / CLAUDE.md 里的接力规矩是旧版的。' : 'AGENTS.md / CLAUDE.md 里的接力规矩不见了：AI 开工时就不会先读接力本。'),
        h('button', { class: 'link', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), '规矩更新好了') }, p.protocol === 'old' ? '更新' : '补上')
      )
    );
  }
  if (S.st.watchError) bits.push(h('p', { class: 'faint' }, `盯文件夹出了点问题（${S.st.watchError}），接力台每分钟会自己对一次账。`));
  bits.push(
    h(
      'p',
      { class: 'faint', style: 'margin-top:26px' },
      h('button', { class: 'link', onclick: showBrief }, '看接力本'),
      '（AI 开工先读的那份） · ',
      h('button', { class: 'link', onclick: (e) => act(e.currentTarget, () => api('/api/snap', {}), (r) => (r.changed ? '记好了' : '没有新变化')) }, '现在对一次账')
    )
  );
  return h('div', null, bits);
}

async function showBrief() {
  try {
    const d = await api(q('/api/brief'));
    openDialog('接力本（.relay/接力本.md）', h('div', { class: 'doc', html: md(d.text || '（还没有）') }), [h('button', { class: 'btn', onclick: closeDialog }, '关上')]);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 群聊 ----------

async function loadTalk() {
  if (!S.dir) return;
  try {
    S.talk = await api(q('/api/talk'));
    if (S.view === 'talk' && !busyTyping()) renderTalk();
  } catch (e) {
    if (!(e instanceof TypeError)) toast(e.message, true);
  }
}

function talkers() {
  return members().filter((m) => m.canTalk);
}

const MODE_HINT = {
  turn: '一个接一个说，后面的看得到前面的。',
  solo: '同时问，互相看不到别人的回答：弱模型不会跟着强模型的思路走。',
  vote: '方案匿名、打乱顺序；一个 AI 一票，不分强弱，不能投自己。你也可以投一票；采纳的写进任务的约定。',
};

function renderTalk() {
  const el = $('view-talk');
  if (!S.st) return;
  const people = talkers();
  if (S.talkAsk === null) S.talkAsk = new Set(people.filter((m) => !m.cooling).map((m) => m.name));
  const bar = h(
    'div',
    { class: 'talk-bar' },
    h(
      'div',
      { class: 'people', role: 'group', 'aria-label': '谁参加' },
      people.map((m) =>
        h(
          'button',
          {
            class: 'person',
            'aria-pressed': S.talkAsk.has(m.name) ? 'true' : 'false',
            title: m.cooling ? `额度用完，${m.coolingText}` : m.model || '',
            onclick: () => {
              if (S.talkAsk.has(m.name)) S.talkAsk.delete(m.name);
              else S.talkAsk.add(m.name);
              renderTalk();
            },
          },
          tierEl(m.tier),
          m.label
        )
      )
    ),
    h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': '怎么说' },
      [
        ['turn', '轮流说'],
        ['solo', '各自先想'],
        ['vote', '投票'],
      ].map(([k, label]) => h('button', { 'aria-pressed': S.talkMode === k ? 'true' : 'false', onclick: () => ((S.talkMode = k), renderTalk()) }, label))
    )
  );

  const stream = h('div', { class: 'stream' });
  for (const item of streamItems()) stream.append(item);
  const st = S.talk.status;
  if (st.speaking.length || st.queue.length) {
    stream.append(
      h('p', { class: 'speaking' }, h('span', { class: 'pulse' }), `${st.speaking.map((x) => x.label).join('、') || '有人'} 正在想…${st.queue.length ? `（排队：${st.queue.map((x) => x.label).join('、')}）` : ''}`)
    );
  }
  if (!stream.children.length) {
    stream.append(h('p', { class: 'empty' }, people.length ? '还没人说话。问一个问题，听听几个 AI 各自怎么想。' : '还没有能参加群聊的 AI。去「设置」里重新识别一下。'));
  }
  el.replaceChildren(bar, h('p', { class: 'faint', style: 'margin:10px 0 0' }, MODE_HINT[S.talkMode]), stream, composer());
}

/** 记录和投票按时间排好；「各自先想」的同一轮并排放（它们互相没看见）。 */
function streamItems() {
  const rows = S.talk.rows || [];
  const votes = S.talk.votes || [];
  const items = [];
  const rounds = new Map();
  for (const r of rows) {
    if (r.round) {
      let g = rounds.get(r.round);
      if (!g) {
        g = { ts: r.ts, kind: 'round', rows: [] };
        rounds.set(r.round, g);
        items.push(g);
      }
      g.rows.push(r);
    } else items.push({ ts: r.ts, kind: 'row', row: r });
  }
  for (const v of votes) items.push({ ts: v.ts, kind: 'vote', vote: v });
  items.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return items.slice(-60).map((it) => (it.kind === 'row' ? msg(it.row) : it.kind === 'round' ? roundBox(it.rows) : voteCard(it.vote)));
}

function msg(r) {
  const cls = r.kind === 'human' ? 'msg me' : r.kind === 'system' ? 'msg sys' : 'msg';
  const [name, model] = String(r.who).split(' · ');
  return h(
    'div',
    { class: cls },
    h('div', { class: 'from' }, h('b', null, name), model ? h('span', { class: 'faint' }, model) : null, h('span', { class: 'faint' }, fmtTime(r.ts))),
    h('div', { class: 'text' }, r.text)
  );
}

function roundBox(rows) {
  return h('div', { class: 'round' }, h('div', { class: 'faint' }, `各自先想 · ${rows.length} 位，互相没看见`), h('div', { class: 'cols' }, rows.map(msg)));
}

function voteCard(v) {
  const box = h('div', { class: 'vote' });
  box.append(h('h4', null, `投票：${v.question}`));
  if (v.status === 'proposing') {
    box.append(h('p', { class: 'speaking' }, h('span', { class: 'pulse' }), `${v.voters.length} 位 AI 在各自出方案…`));
    return box;
  }
  if (v.error) box.append(h('p', { class: 'result bad' }, v.error));
  const done = v.status === 'done';
  const leaders = new Set(v.leaders || []);
  const counts = v.counts || {};
  const mine = (v.ballots || []).find((b) => b.voter === 'human');
  const opts = h('div', { class: 'options' });
  for (const o of v.options) {
    const n = counts[o.key] || 0;
    opts.append(
      h(
        'div',
        { class: `option${done && leaders.has(o.key) && n ? ' lead' : ''}` },
        h('div', { class: 'key' }, o.key),
        h('div', { class: 'body' }, o.text),
        h('div', { class: 'tally', title: `${n} 票` }, done || n ? zheng(n) : '', h('small', null, done || n ? `${n} 票` : '')),
        h('div', { class: 'by' }, done ? `${o.authorLabel} 出的` : '投完揭晓是谁出的'),
        done
          ? h(
              'div',
              { class: 'acts row' },
              mine && mine.choice === o.key
                ? h('span', { class: 'faint' }, '你投了它')
                : h('button', { class: 'btn small', onclick: (e) => act(e.currentTarget, () => api('/api/vote/cast', { id: v.id, key: o.key }), `你投了方案 ${o.key}`).then(loadTalk) }, '我也投它'),
              v.adopted ? null : h('button', { class: 'btn small seal-btn', onclick: (e) => act(e.currentTarget, () => api('/api/vote/adopt', { id: v.id, key: o.key }), '采纳了：写进了任务的约定').then(loadTalk) }, '采纳')
            )
          : null
      )
    );
  }
  box.append(opts);
  const aiBallots = (v.ballots || []).filter((b) => b.voter !== 'human');
  if (!done) box.append(h('p', { class: 'speaking', style: 'margin-top:10px' }, h('span', { class: 'pulse' }), `在投票：${aiBallots.length} / ${v.voters.length}`));
  if (done && v.leaders && v.leaders.length > 1) box.append(h('p', { class: 'result warn' }, `平票：方案 ${v.leaders.join('、')}。你来定，点「采纳」。`));
  if (v.adopted) box.append(h('p', { class: 'adopted' }, `采纳了方案 ${v.adopted.key}，写进了任务的约定，之后接力的每一棒都会看到。`));
  const ballots = (v.ballots || []).filter((b) => b.voter !== 'human' || b.choice);
  if (done && ballots.length) {
    const d = h('details', { class: 'ballots' }, h('summary', { class: 'link' }, '每一票和理由'));
    d.append(
      h(
        'ul',
        null,
        ballots.map((b) =>
          h(
            'li',
            null,
            h('b', null, b.voterLabel),
            b.tier ? [' ', tierEl(b.tier)] : null,
            '：',
            b.choice ? `投 ${b.choice}` : `弃权（${b.void || ''}）`,
            b.reason ? h('span', { class: 'kai' }, ` —— ${b.reason}`) : null
          )
        )
      )
    );
    box.append(d);
  }
  return box;
}

function composer() {
  const people = [...(S.talkAsk || [])];
  if (S.talkMode === 'vote') {
    const qn = h('input', { type: 'text', placeholder: '要大家拿主意的问题，比如：导出用什么格式？', value: S.voteDraft.question, oninput: (e) => (S.voteDraft.question = e.target.value) });
    const opts = h('textarea', { rows: 3, placeholder: '选项（每行一个）。不写就请每个 AI 先各自出一个方案。', value: S.voteDraft.options, oninput: (e) => (S.voteDraft.options = e.target.value) });
    const start = h(
      'button',
      {
        class: 'btn seal-btn',
        disabled: people.length < 2,
        onclick: async (e) => {
          const options = opts.value
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean);
          const r = await act(e.currentTarget, () => api('/api/vote/start', { question: qn.value, voters: people, options }), '开始投票了');
          if (r) {
            S.voteDraft = { question: '', options: '' };
            await loadTalk();
          }
        },
      },
      '开始投票'
    );
    return h('div', { class: 'composer' }, qn, opts, h('div', { class: 'row' }, h('span', { class: 'faint' }, people.length < 2 ? '至少选两个 AI 来投票' : `${people.length} 位投票`), start));
  }
  const ta = h('textarea', {
    placeholder: S.talkMode === 'solo' ? '问一个问题，大家各自独立回答（⌘Enter 发出）' : '说点什么（⌘Enter 发出）',
    value: S.draft,
    oninput: (e) => (S.draft = e.target.value),
  });
  const send = h(
    'button',
    {
      class: 'btn primary',
      disabled: !people.length,
      onclick: async (e) => {
        const text = ta.value.trim();
        if (!text) return;
        const r = await act(e.currentTarget, () => api('/api/talk/say', { text, ask: people, mode: S.talkMode }));
        if (r) {
          S.draft = '';
          ta.value = '';
          await loadTalk();
        }
      },
    },
    S.talkMode === 'solo' ? '各自先想' : '说'
  );
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send.click();
  });
  const clear = h(
    'button',
    {
      class: 'btn small quiet',
      onclick: async (e) => {
        const btn = e.currentTarget;
        if (!(await confirmDialog('清空群聊？', '旧记录会改名存档（talk-时间.jsonl），不会删掉。', '清空'))) return;
        await act(btn, () => api('/api/talk/clear', {}), '清空了，旧记录存了档');
        await loadTalk();
      },
    },
    '清空'
  );
  return h('div', { class: 'composer' }, ta, h('div', { class: 'row' }, clear, h('span', { class: 'faint' }, people.length ? `${people.length} 位会回答` : '先在上面选谁参加'), send));
}

// ---------- 设置 ----------

function renderSettings() {
  const el = $('view-settings');
  const st = S.st;
  const p = st.project;
  const s = st.settings;
  const blocks = [];

  blocks.push(h('h2', { class: 'label', style: 'margin-top:0' }, '成员', h('span', { class: 'count' }, st.detectedAt ? `上次识别 ${fmtTime(st.detectedAt)}` : '')));
  blocks.push(h('p', { class: 'faint', style: 'margin:-4px 0 10px' }, '强弱看的是模型，不是工具：Claude Code 接的是 DeepSeek，它就算弱。弱模型做的棒要等强模型复核。派活按这个顺序，额度用完的跳过。'));
  const list = h('div', { class: 'members' });
  const all = members();
  const drivable = all.filter((m) => m.canWork).map((m) => m.name);
  for (const m of all) {
    const state = m.cooling ? `额度用完，${m.coolingText}` : m.canWork ? '接力台能调度' : m.why || '';
    const idx = drivable.indexOf(m.name);
    list.append(
      h(
        'div',
        { class: 'member' },
        h(
          'div',
          { class: 'who' },
          h('b', null, m.label),
          m.model ? h('span', { class: 'faint' }, m.model) : null,
          m.kind === 'app' ? h('span', { class: 'kind-tag' }, '桌面程序') : m.kind === 'api' ? h('span', { class: 'kind-tag' }, '接口') : null
        ),
        h('div', { class: `state${m.cooling ? ' cooling' : ''}` }, state, m.tierSet ? ' · 强弱是你定的' : ''),
        h(
          'div',
          { class: 'ctl' },
          h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': `${m.label} 强还是弱` },
            ['strong', 'weak'].map((t) =>
              h(
                'button',
                { 'aria-pressed': m.tier === t ? 'true' : 'false', onclick: (e) => act(e.currentTarget, () => api('/api/members/tier', { name: m.name, tier: t }), `${m.label} 定成${t === 'strong' ? '强' : '弱'}了`) },
                t === 'strong' ? '强' : '弱'
              )
            )
          ),
          m.tierSet ? h('button', { class: 'order-btn', title: '改回按模型名自动判断', onclick: (e) => act(e.currentTarget, () => api('/api/members/tier', { name: m.name, tier: 'auto' }), '改回自动判断了') }, '自动') : null,
          idx >= 0 ? h('button', { class: 'order-btn', title: '往前排', 'aria-label': `${m.label} 往前排`, disabled: idx === 0, onclick: () => move(m.name, -1) }, '↑') : null,
          idx >= 0 ? h('button', { class: 'order-btn', title: '往后排', 'aria-label': `${m.label} 往后排`, disabled: idx === drivable.length - 1, onclick: () => move(m.name, 1) }, '↓') : null,
          m.detected ? null : h('button', { class: 'order-btn', title: '从名单里去掉', onclick: (e) => removeMember(e.currentTarget, m) }, '去掉')
        )
      )
    );
  }
  if (!all.length) list.append(h('p', { class: 'empty' }, '名单是空的。点「重新识别」，接力台会找出这台电脑上的 AI 工具和配好的接口。'));
  blocks.push(list);
  blocks.push(
    h(
      'div',
      { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn', disabled: st.detecting, onclick: (e) => act(e.currentTarget, () => api('/api/detect', {}), (r) => (r.changes.length ? r.changes.join(' ') : '识别好了，名单不用改')) }, st.detecting ? '正在识别…' : '重新识别'),
      h('button', { class: 'btn quiet', onclick: addApiDialog }, '添加一个接口模型'),
      h('button', { class: 'btn quiet', onclick: addAppDialog }, '添加一个桌面程序')
    )
  );
  blocks.push(consentBlock());

  if (p.init) {
    blocks.push(h('h2', { class: 'label' }, '这个项目'));
    const gate = h('input', { type: 'text', value: p.config.gate, placeholder: '比如 npm test（不填就不检查）', style: 'width:100%' });
    const prot = h('textarea', { rows: 3, value: p.config.protectedPaths.join('\n'), placeholder: '每行一个，比如 .env、config/prod.json、secrets/', style: 'width:100%' });
    blocks.push(
      h('label', { class: 'field' }, h('span', null, '检查命令'), gate, h('small', null, '每一棒结束后跑一遍（测试、构建……）。没通过会写进记录，复核时会看。')),
      h('label', { class: 'field' }, h('span', null, '不许改的文件'), prot, h('small', null, '改到了会在记录里标红。')),
      h(
        'div',
        { class: 'row', style: 'margin-top:12px' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: (e) =>
              act(
                e.currentTarget,
                () =>
                  api('/api/config/save', {
                    config: {
                      gate: { command: gate.value.trim() },
                      protectedPaths: prot.value
                        .split('\n')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  }),
                '存好了'
              ),
          },
          '保存'
        ),
        h('span', { class: 'faint' }, tildify(p.root))
      ),
      h(
        'p',
        { class: 'faint', style: 'margin-top:12px' },
        `接力规矩（AGENTS.md / CLAUDE.md）：${p.protocol === 'ok' ? '是最新的' : p.protocol === 'old' ? '是旧版的' : '不见了'}。`,
        p.protocol === 'ok' ? null : h('button', { class: 'link', onclick: (e) => act(e.currentTarget, () => api('/api/init', {}), '规矩更新好了') }, '更新')
      )
    );
  }

  blocks.push(h('h2', { class: 'label' }, '接力台调度'));
  const level = h(
    'select',
    { style: 'width:100%' },
    h('option', { value: 'safe', selected: s.level === 'safe' ? 'selected' : null }, '安全档：只能改项目文件夹，命令在工具自己的沙箱里跑'),
    h('option', { value: 'full', selected: s.level === 'full' ? 'selected' : null }, '完全放开：工具不再拦任何操作（能装依赖、联网，风险自负）')
  );
  const stint = h('input', { type: 'number', min: 1, max: 600, value: s.stintTimeoutMin, style: 'width:84px' });
  const review = h('input', { type: 'number', min: 1, max: 240, value: s.reviewTimeoutMin, style: 'width:84px' });
  const max = h('input', { type: 'number', min: 1, max: 100, value: s.maxStints, style: 'width:84px' });
  const wait = h('input', { type: 'checkbox', checked: s.waitForQuota });
  const final = h('input', { type: 'checkbox', checked: s.finalReview });
  blocks.push(
    h('label', { class: 'field' }, h('span', null, '权限'), level),
    h('div', { class: 'row', style: 'margin-top:14px;gap:10px 22px' }, h('label', { class: 'row', style: 'gap:8px' }, '一棒最长', stint, '分钟'), h('label', { class: 'row', style: 'gap:8px' }, '复核最长', review, '分钟'), h('label', { class: 'row', style: 'gap:8px' }, '全自动最多', max, '棒')),
    h('label', { class: 'check' }, wait, h('span', null, '所有人都没额度时，等最早恢复的那一位（不等就停下交给你）')),
    h('label', { class: 'check' }, final, h('span', null, '清单全部打勾后，请强模型把整件事从头到尾过一遍（终审）再算完成')),
    h(
      'div',
      { style: 'margin-top:14px' },
      h(
        'button',
        {
          class: 'btn primary',
          onclick: (e) =>
            act(
              e.currentTarget,
              () =>
                api('/api/settings', {
                  settings: { ...s, level: level.value, stintTimeoutMin: Number(stint.value), reviewTimeoutMin: Number(review.value), maxStints: Number(max.value), waitForQuota: wait.checked, finalReview: final.checked },
                }),
              '存好了'
            ),
        },
        '保存'
      )
    )
  );

  blocks.push(
    h(
      'div',
      { class: 'danger-zone row' },
      h('span', { class: 'faint', style: 'flex:1;min-width:220px' }, `接力台 ${st.version}。关掉之后就不记账了；桌面上双击「接力台」能重新打开。`),
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async (e) => {
            const btn = e.currentTarget;
            if (!(await confirmDialog('关闭接力台？', '正在调度的活会先停下。之后在桌面双击「接力台」就能重新打开。', '关闭', true))) return;
            await act(btn, () => api('/api/quit', {}), '接力台关了');
            setTimeout(() => setOffline(true), 600);
          },
        },
        '关闭接力台'
      )
    )
  );
  el.replaceChildren(...blocks);
}

let consentCache = null;
function consentBlock() {
  const box = h('div');
  const fill = (want) => {
    if (!want.length) return;
    box.append(
      h('p', { class: 'faint', style: 'margin-top:14px' }, '这些接口的密钥存在别的工具里，要你同意才会用（只在调用时读进内存，不复制）：'),
      ...want.map((p) =>
        h('div', { class: 'row', style: 'margin-top:6px' }, h('span', null, `${p.label}${p.model ? ` · ${p.model}` : ''}`), h('button', { class: 'btn small', onclick: (e) => act(e.currentTarget, () => api('/api/detect/use', { id: p.id }), '同意了，加进了名单').then(() => (consentCache = null)) }, '同意使用'))
      )
    );
  };
  if (consentCache) fill(consentCache);
  else
    api('/api/detect')
      .then((d) => {
        const used = new Set(members().map((m) => m.agent && m.agent.api && m.agent.api.keyFrom).filter(Boolean));
        consentCache = ((d.report && d.report.providers) || []).filter((p) => p.needsConsent && !used.has(p.keyFrom));
        fill(consentCache);
      })
      .catch(() => null);
  return box;
}

async function move(name, dir) {
  const order = members()
    .filter((m) => m.canWork)
    .map((m) => m.name);
  const i = order.indexOf(name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  await act(null, () => api('/api/settings', { settings: { ...S.st.settings, order } }));
}

async function removeMember(btn, m) {
  if (!(await confirmDialog(`从名单里去掉 ${m.label}？`, '只是不再派它、不再在群聊里请它；它自己的程序和配置不动。', '去掉'))) return;
  act(btn, () => api('/api/workers/delete', { name: m.name }), `去掉了 ${m.label}`);
}

function addApiDialog() {
  const name = h('input', { type: 'text', placeholder: '英文名，比如 kimi' });
  const label = h('input', { type: 'text', placeholder: '显示的名字，比如 Kimi' });
  const base = h('input', { type: 'text', placeholder: 'https://api.moonshot.cn/v1' });
  const model = h('input', { type: 'text', placeholder: '模型名' });
  const env = h('input', { type: 'text', placeholder: '放密钥的环境变量名，比如 MOONSHOT_API_KEY' });
  const tier = h('select', null, h('option', { value: 'weak' }, '弱（它做的要复核）'), h('option', { value: 'strong' }, '强'));
  const save = h(
    'button',
    {
      class: 'btn primary',
      onclick: (e) =>
        act(
          e.currentTarget,
          () =>
            api('/api/workers/save', {
              agent: { name: name.value.trim(), label: label.value.trim() || undefined, kind: 'api', tier: tier.value, tierSet: true, api: { baseUrl: base.value.trim(), model: model.value.trim(), apiKeyEnv: env.value.trim() } },
            }),
          '加好了'
        ).then((r) => r && closeDialog()),
    },
    '添加'
  );
  openDialog(
    '添加一个接口模型',
    h(
      'div',
      null,
      h('p', { class: 'faint', style: 'margin:0' }, '任何 OpenAI 兼容的接口都行。密钥不要填在这里：放在环境变量里（比如写进 ~/.zshrc），这里只填变量名。'),
      h('label', { class: 'field' }, h('span', null, '名字'), name),
      h('label', { class: 'field' }, h('span', null, '显示名'), label),
      h('label', { class: 'field' }, h('span', null, '接口地址'), base),
      h('label', { class: 'field' }, h('span', null, '模型'), model),
      h('label', { class: 'field' }, h('span', null, '密钥环境变量名'), env),
      h('label', { class: 'field' }, h('span', null, '强还是弱'), tier)
    ),
    [h('button', { class: 'btn', onclick: closeDialog }, '算了'), save]
  );
}

function addAppDialog() {
  const name = h('input', { type: 'text', placeholder: '英文名，比如 trae' });
  const app = h('input', { type: 'text', placeholder: '「应用程序」里的名字，比如 Trae' });
  const tier = h('select', null, h('option', { value: 'weak' }, '弱（它做的要复核）'), h('option', { value: 'strong' }, '强'));
  const save = h(
    'button',
    {
      class: 'btn primary',
      onclick: (e) => {
        const a = app.value.trim();
        return act(e.currentTarget, () => api('/api/workers/save', { agent: { name: name.value.trim(), label: a, kind: 'app', tier: tier.value, tierSet: true, cmd: `open -a ${/\s/.test(a) ? `"${a}"` : a} {{dir}}` } }), '加好了').then(
          (r) => r && closeDialog()
        );
      },
    },
    '添加'
  );
  openDialog(
    '添加一个桌面程序',
    h(
      'div',
      null,
      h('p', { class: 'faint', style: 'margin:0' }, '桌面程序接力台调度不了；加进名单后，「换人」菜单里能一键用它打开这个项目，交接时也认得它是谁、强还是弱。'),
      h('label', { class: 'field' }, h('span', null, '名字'), name),
      h('label', { class: 'field' }, h('span', null, '程序'), app),
      h('label', { class: 'field' }, h('span', null, '强还是弱'), tier)
    ),
    [h('button', { class: 'btn', onclick: closeDialog }, '算了'), save]
  );
}

// ---------- 开始 ----------

(async function start() {
  const hash = location.hash.replace('#', '');
  if (['relay', 'talk', 'settings'].includes(hash)) S.view = hash;
  await refresh();
  if (S.view === 'talk') await loadTalk();
  render();
  schedule();
})();
