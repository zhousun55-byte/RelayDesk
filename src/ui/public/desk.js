const $ = (id) => document.getElementById(id);
const has = (id) => !!$(id);
const params = new URLSearchParams(location.search);
let last = null;
const ui = { cabinet: false, menu: false, paper: "", view: "work", draftTask: "", atOn: false, clips: [], clipNames: {}, clipPreview: {}, winsOpen: false, talkWins: false };

function writeUrl(root, view) {
  const u = new URL(location.href);
  if (root) u.searchParams.set("root", root);
  u.hash = view === "talk" ? "talk" : "";
  history.replaceState(null, "", u);
}

function setView(view) {
  ui.view = view === "talk" ? "talk" : "work";
  document.body.classList.toggle("on-talk", ui.view === "talk");
  if (ui.view === "talk" && has("cabinet")) {
    ui.cabinet = false;
    setFold($("cabinet"), false);
  }
  if (has("talk-door")) {
    $("talk-door").textContent = ui.view === "talk" ? "接力" : "群聊";
    $("talk-door").classList.toggle("on", ui.view === "talk");
  }
  writeUrl(rootValue(), ui.view);
  if (last) renderHistory(last);
}

function rootValue() {
  return $("current-path").dataset.root || "";
}

function setRoot(v) {
  $("current-path").dataset.root = v;
  writeUrl(v, ui.view);
}

async function api(path, body) {
  let r;
  try {
    r = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("网页断了");
  }
  const raw = await r.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("网页断了");
  }
  if (!r.ok) throw new Error(data.error || data.out || "没做成");
  return data;
}

function humanize(msg) {
  const t = String(msg || "").replace(/^relay:\s*/i, "").trim();
  if (/无活跃任务|relay start/i.test(t)) return "还没开始。先写下要做什么，再按开始。";
  if (/已有活跃任务|单仓库单任务/.test(t)) return "这件事还没做完。先合回去，或者按不要了。";
  if (/先写一句要干什么|先写一句/.test(t)) return "先写下要做什么。";
  if (/先点一个工人/.test(t)) return "先点一扇窗口。";
  if (/没选文件夹|访达/.test(t)) return "没有选文件夹。";
  if (/worktree 不存在|已被清理/.test(t)) return "干活的那份不见了。按不要了清掉，再开始。";
  if (/注册表中没有|没有 agent/.test(t)) return "没有这个窗口。";
  if (/是 CLI 客人|不能用 relay open/.test(t)) return "这个窗口不能从这里打开。";
  if (/是 App 客人|不能用 relay run/.test(t)) return "这个窗口要从这里打开。";
  if (/保护路径/.test(t)) return "动到了不能动的文件，合不回去。";
  if (/主仓库工作区不干净/.test(t)) return "正式文件夹里还有没收好的改动。";
  if (/门禁未通过|gate/.test(t) && /拒绝|没过/.test(t)) return "检查没过，还不能合回去。";
  if (/软锁|窗口还开着/.test(t)) return "这扇窗已经开着。到里面做，做完按交接。";
  if (/找不到文件夹|找不到页面/.test(t)) return "找不到这个位置。";
  if (/不在 git|不是 git|须在目标项目/.test(t)) return "这个文件夹还不是项目。写下要做什么，按开始，这里会做成项目。";
  if (/未找到.*config|请先.*init/.test(t)) return "这个项目还没布置。写下要做什么，按开始。";
  if (/窗口没开/.test(t)) return "这扇窗还没开。";
  if (/还在等上一句/.test(t)) return "还在等上一句。";
  if (/先说一句/.test(t)) return "先说一句。";
  if (/网页断了|Failed to fetch|NetworkError|ECONNREFUSED/i.test(t)) return "没发出去。页面断了，再发一次。";
  if (/还不会在群里/.test(t)) return "这扇窗还不会在群里自动回。先打开群聊稿。";
  return t.replace(/\brelay\s+[a-z-]+/gi, "").replace(/\s{2,}/g, " ").trim() || t;
}

function toast(msg) {
  const el = $("toast");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = humanize(msg);
}

function btn(cls, label, fn) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}

async function loadState(root, side, rel) {
  const q = new URLSearchParams();
  if (root) q.set("root", root);
  if (side) q.set("side", side);
  if (rel != null) q.set("rel", rel);
  return api(`/api/state?${q}`);
}

async function act(path, extra = {}) {
  toast("");
  try {
    const data = await api(path, { root: rootValue(), ...extra });
    render(data.state || data);
  } catch (e) {
    toast(e.message);
  }
}

function dots() {
  const wrap = document.createElement("div");
  wrap.className = "dots";
  wrap.innerHTML = "<i></i><i></i><i></i>";
  return wrap;
}

function setFold(el, on) {
  el.classList.toggle("on", !!on);
}

function taskField() {
  return document.querySelector("#actions input");
}

function openWindow(agent, llm) {
  const rec = ((last && last.agents) || []).find((a) => a.name === agent);
  const path = rec && rec.kind === "cli" ? "/api/run" : "/api/open";
  return act(path, { agent, llm });
}

async function runLine() {
  if (!last) return;
  if (last.phase === "not_git" || last.phase === "need_init") await act("/api/init");
  if (last.phase === "idle") {
    let task = (taskField() && taskField().value.trim()) || "";
    const files = ui.clips.map((rel) => ui.clipNames[rel] || clipName(rel));
    if (files.length) task = [task, "文件：" + files.join("、")].filter(Boolean).join("\n");
    if (!task) {
      if (taskField()) taskField().focus();
      return;
    }
    await act("/api/start", { task });
    clearClips();
  }
  if (last.phase === "working" && last.windowId) {
    await openWindow(last.windowId, last.llmId);
  }
}

async function trackAction(id) {
  if (!last) return;
  if (id === "work") {
    if (last.phase === "not_git" || last.phase === "idle" || last.phase === "need_init") {
      toast("还没开始。先写下要做什么，再按开始。");
      if (taskField()) taskField().focus();
      return;
    }
    if (last.windowId) {
      return openWindow(last.windowId, last.llmId);
    }
    toast("先点一扇窗口。");
    return;
  }
  if (id === "hand") return act("/api/handoff");
  if (id === "review") {
    const d = (last.dockets || []).find((x) => x.current);
    const pick =
      (d && (d.papers || []).find((p) => p.id === "review" && !p.empty)) ||
      (d && (d.papers || []).find((p) => p.id === "summary" && !p.empty));
    if (!d || !pick) return;
    ui.paper = `${d.root}::${pick.id}`;
    renderDockets(last);
    return;
  }
  if (id === "merge") {
    const d = (last.dockets || []).find((x) => x.current);
    const pick = d && (d.papers || []).find((p) => p.id === "summary" && !p.empty);
    if (!d || !pick) {
      toast("还没有总结");
      return;
    }
    ui.paper = `${d.root}::summary`;
    renderDockets(last);
  }
}

function brainText(raw) {
  return String(raw || "").replace(/\s*[·•]\s*最认真/g, "").replace(/最认真/g, "").trim();
}

function knownWindows(s) {
  const rows = (s.windows || []).filter((w) => w.on || w.running || brainText(w.brain));
  const seen = new Set(rows.map((w) => w.id));
  (s.chat || []).forEach((line) => {
    if (!line || line.kind === "system" || !line.windowId || line.windowId === "human" || seen.has(line.windowId)) return;
    seen.add(line.windowId);
    rows.push({ id: line.windowId, label: line.who || line.windowId, brain: "", on: false, running: true });
  });
  return rows;
}

function renderPile(s) {
  const pile = $("pile");
  if (!pile) return;
  const front = knownWindows(s).find((w) => w.on) || knownWindows(s)[0];
  const layered = front ? [front] : [];
  const keep = new Set(layered.map((w) => w.id));
  [...pile.querySelectorAll(".win")].forEach((el) => {
    if (!keep.has(el.dataset.id)) el.remove();
  });
  layered.forEach((w) => {
    let card = pile.querySelector(`[data-id="${w.id}"]`);
    if (!card) {
      card = document.createElement("div");
      card.dataset.id = w.id;
      card.append(dots());
      card.append(document.createElement("strong"), document.createElement("span"));
      pile.append(card);
    }
    card.className = "win front";
    card.querySelector("strong").textContent = w.label;
    card.querySelector("span").textContent = "";
  });
}

function fillWinList(box, rows) {
  box.innerHTML = "";
  rows.forEach((w) => {
    const p = document.createElement("p");
    p.className = "win-line";
    p.textContent = [w.label, brainText(w.brain)].filter(Boolean).join(" · ");
    box.append(p);
  });
}

function renderWindows(s) {
  const all = knownWindows(s);
  const front = all.find((w) => w.on) || all[0];
  const rest = all.filter((w) => w !== front);
  const brain = brainText((front && front.brain) || s.llmHint || s.llmLabel || "");
  if (has("who-win")) $("who-win").textContent = front ? front.label : s.who || "未识别";
  if (has("who-brain")) $("who-brain").textContent = brain;
  const fold = $("win-fold");
  const more = $("win-rest");
  if (fold && more) {
    fold.hidden = rest.length === 0;
    fold.textContent = ui.winsOpen ? "收起" : "还有 " + rest.length;
    more.hidden = !ui.winsOpen || rest.length === 0;
    fillWinList(more, rest);
  }
  const who = $("talk-who");
  if (!who) return;
  who.innerHTML = "";
  const line = document.createElement("button");
  line.type = "button";
  line.className = "who-fold";
  const title = [front ? front.label : s.who || "", brain].filter(Boolean).join(" · ");
  line.textContent = rest.length ? title + (ui.talkWins ? "  ▴" : "  ▾") : title;
  if (rest.length) {
    line.addEventListener("click", () => {
      ui.talkWins = !ui.talkWins;
      renderWindows(last || s);
    });
  }
  who.append(line);
  if (ui.talkWins && rest.length) {
    const list = document.createElement("div");
    list.className = "who-rest";
    fillWinList(list, rest);
    who.append(list);
  }
}

function railFill(from, to) {
  if (!from || from.state === "wait") return "wait";
  if (from.state === "here") return "now";
  if (!to || to.state === "wait") return "now";
  return "full";
}

function renderTrack(s) {
  const box = $("track");
  if (!box) return;
  const legs = s.legs || [];
  const here = legs.find((l) => l.state === "here");
  const passed = legs.filter((l) => l.state === "done" || l.state === "here").length;
  box.dataset.step = here ? here.id : passed === legs.length && legs.length ? "done" : "idle";
  box.setAttribute("aria-valuemin", "0");
  box.setAttribute("aria-valuemax", String(legs.length));
  box.setAttribute("aria-valuenow", String(passed));
  box.innerHTML = "";
  legs.forEach((leg, i) => {
    const li = document.createElement("li");
    li.className = "stop";
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.id = leg.id;
    b.className = leg.state;
    b.append(document.createTextNode(leg.label));
    const sm = document.createElement("small");
    sm.textContent = leg.who || "";
    b.append(sm);
    b.addEventListener("click", () => trackAction(leg.id));
    li.append(b);
    box.append(li);
    if (i < legs.length - 1) {
      const rail = document.createElement("li");
      rail.className = "rail";
      rail.setAttribute("aria-hidden", "true");
      const fill = document.createElement("i");
      fill.className = railFill(leg, legs[i + 1]);
      rail.append(fill);
      box.append(rail);
    }
  });
}

function isMine(line) {
  if (line.kind !== "person") return false;
  return !!(line.mine || line.windowId === "human");
}

function renderTalk(s) {
  const box = $("talk");
  if (!box) return;
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const prev = box.scrollTop;
  box.innerHTML = "";
  (s.chat || []).forEach((line) => {
    if (line.kind === "system") {
      const p = document.createElement("p");
      p.className = "sys";
      p.textContent = line.text;
      box.append(p);
      return;
    }
    if (line.kind === "baton") {
      const p = document.createElement("p");
      p.className = "baton";
      p.textContent = line.text;
      box.append(p);
      return;
    }
    const mine = isMine(line);
    const row = document.createElement("div");
    row.className = "bubble-row " + (mine ? "me" : "them") + (line.pending ? " pending" : "");
    const mini = document.createElement("div");
    mini.className = "mini";
    mini.append(dots());
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = `<b></b><i></i><span></span>`;
    bubble.querySelector("b").textContent = line.who;
    bubble.querySelector("i").textContent = (line.sub || "").replace(/\s*[·•]\s*最认真/g, "").replace(/最认真/g, "").trim();
    bubble.querySelector("span").textContent = line.text;
    if (line.files && line.files.length) {
      const files = document.createElement("div");
      files.className = "files";
      line.files.forEach((f) => {
        const chip = document.createElement("span");
        if (isImagePath(f)) {
          const img = document.createElement("img");
          img.src = fileUrl(f);
          img.alt = clipName(f);
          chip.append(img);
        }
        chip.append(document.createTextNode(clipName(f)));
        files.append(chip);
      });
      bubble.append(files);
    }
    row.append(bubble);
    box.append(row);
  });
  if (s.chat && s.chat.length) box.scrollTop = stick ? box.scrollHeight : prev;
}

function renderSeats(s) {
  const box = $("seats");
  if (!box) return;
  box.innerHTML = "";
  const spoken = new Set((s.chat || []).map((l) => l.windowId).filter(Boolean));
  (s.windows || [])
    .filter((w) => w.running)
    .forEach((w) => {
      const inRoom = spoken.has(w.id) || s.pendingTalk === w.id;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = w.label;
      if (inRoom) b.className = "on";
      if (!inRoom) b.addEventListener("click", () => inviteWindow(w.id));
      else b.addEventListener("click", () => mention(w.label));
      box.append(b);
    });
}

async function inviteWindow(id) {
  setView("talk");
  await act("/api/invite", { agent: id });
}

function talkField() {
  return $("talk-input");
}

function composing(e) {
  return !!(e.isComposing || e.keyCode === 229);
}

function mention(label) {
  const field = talkField();
  if (!field) return;
  const cur = field.value;
  const at = "@" + label + " ";
  field.value = /@\S*$/.test(cur) ? cur.replace(/@\S*$/, at) : (cur.replace(/\s*$/, "") + (cur.trim() ? " " : "") + at);
  hideAt();
  field.focus();
}

function hideAt() {
  const box = $("at-list");
  if (!box) return;
  box.hidden = true;
  box.innerHTML = "";
  ui.atOn = false;
}

function showAt() {
  if (!last) return;
  const box = $("at-list");
  const field = talkField();
  if (!box || !field) return;
  const m = field.value.match(/@([^\s@]*)$/);
  if (!m) {
    hideAt();
    return;
  }
  const q = m[1].toLowerCase();
  const wins = (last.windows || []).filter((w) => w.running || (last.chat || []).some((l) => l.windowId === w.id));
  const hits = wins.filter((w) => !q || w.label.toLowerCase().includes(q) || w.id.toLowerCase().includes(q));
  box.innerHTML = "";
  hits.forEach((w) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "@" + w.label;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      mention(w.label);
    });
    box.append(b);
  });
  box.hidden = hits.length === 0;
  ui.atOn = hits.length > 0;
}

function clipName(rel) {
  return String(rel).split("/").pop() || rel;
}

function isImagePath(rel) {
  return /\.(png|jpe?g|gif|webp)$/i.test(String(rel));
}

function fileUrl(rel) {
  const q = new URLSearchParams({ root: rootValue(), rel: String(rel) });
  return `/api/file?${q}`;
}

function clearClips() {
  Object.values(ui.clipPreview).forEach((u) => URL.revokeObjectURL(u));
  ui.clipPreview = {};
  ui.clipNames = {};
  ui.clips = [];
  renderClips();
}

function removeClip(rel) {
  if (ui.clipPreview[rel]) URL.revokeObjectURL(ui.clipPreview[rel]);
  delete ui.clipPreview[rel];
  delete ui.clipNames[rel];
  ui.clips = ui.clips.filter((x) => x !== rel);
  renderClips();
}

function renderClipBox(box) {
  if (!box) return;
  box.innerHTML = "";
  ui.clips.forEach((rel) => {
    const chip = document.createElement("div");
    chip.className = "clip";
    if (ui.clipPreview[rel] || isImagePath(rel)) {
      const img = document.createElement("img");
      img.src = ui.clipPreview[rel] || fileUrl(rel);
      img.alt = "";
      chip.append(img);
    }
    const name = document.createElement("button");
    name.type = "button";
    name.className = "clip-name";
    name.textContent = ui.clipNames[rel] || clipName(rel);
    name.title = "修改";
    name.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "title-edit";
      input.value = name.textContent;
      name.replaceWith(input);
      input.focus();
      input.select();
      let saved = false;
      const save = () => {
        if (saved) return;
        saved = true;
        const next = input.value.trim();
        if (next) ui.clipNames[rel] = next;
        renderClips();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") renderClips();
      });
      input.addEventListener("blur", save);
    });
    const x = document.createElement("button");
    x.type = "button";
    x.className = "clip-x";
    x.textContent = "×";
    x.title = "拿下";
    x.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeClip(rel);
    });
    chip.append(name, x);
    box.append(chip);
  });
}

function renderClips() {
  renderClipBox($("clips"));
  renderClipBox($("work-clips"));
}

function addClip(rel) {
  const t = String(rel || "").trim();
  if (!t || ui.clips.includes(t)) return;
  ui.clips.push(t);
  renderClips();
}

function wireDrop(el) {
  if (!el || el.dataset.drop) return;
  el.dataset.drop = "1";
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", (e) => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove("drop");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop");
    const dropped = e.dataTransfer && e.dataTransfer.files;
    if (dropped && dropped.length) {
      [...dropped].forEach((file) => uploadLocal(file));
      return;
    }
    const rel = e.dataTransfer && e.dataTransfer.getData("text/plain");
    if (rel) addClip(rel);
  });
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      resolve(raw.slice(raw.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadLocal(file) {
  try {
    const data = await fileToB64(file);
    const saved = await api("/api/talk-file", { root: rootValue(), name: file.name, data });
    if (file.type && file.type.startsWith("image/")) ui.clipPreview[saved.path] = URL.createObjectURL(file);
    addClip(saved.path);
  } catch (e) {
    toast(e.message);
  }
}

async function sendTalk() {
  const field = talkField();
  if (!field) return;
  const text = field.value.trim();
  const files = ui.clips.slice();
  if (!text && !files.length) {
    field.focus();
    return;
  }
  hideAt();
  setView("talk");
  try {
    const data = await api("/api/talk", { root: rootValue(), text, files });
    field.value = "";
    clearClips();
    render(data.state || data);
    field.focus();
  } catch (e) {
    field.value = text;
    toast(e.message);
    field.focus();
  }
}

async function openTalkWindow() {
  setView("talk");
  await act("/api/open-talk", { agent: (last && last.windowId) || "claude" });
}

async function startFromTalk() {
  try {
    const data = await api("/api/talk-task", { root: rootValue() });
    ui.draftTask = (data.task || "").trim();
    if (data.state) render(data.state);
    setView("work");
    const field = taskField();
    if (field && ui.draftTask) {
      field.value = ui.draftTask;
      field.focus();
    } else toast("没有话");
  } catch (e) {
    toast(e.message);
  }
}

function renderDockets(s) {
  const box = $("dockets");
  if (!box) return;
  box.innerHTML = "";
  (s.dockets || []).forEach((d) => {
    const wrap = document.createElement("article");
    wrap.className = "docket";
    const head = document.createElement("div");
    head.className = "docket-head";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "docket-name";
    name.textContent = d.name;
    name.addEventListener("click", async () => {
      if (d.current) return;
      toast("");
      try {
        ui.paper = "";
        render(await loadState(d.root));
      } catch (e) {
        toast(e.message);
      }
    });
    head.append(name);
    ["summary", "review"].forEach((kind) => {
      const paper = (d.papers || []).find((p) => p.id === kind);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = kind === "summary" ? "总结" : "自审";
      const key = `${d.root}::${kind}`;
      chip.disabled = !paper || paper.empty;
      if (ui.paper === key) chip.classList.add("on");
      chip.addEventListener("click", () => {
        if (chip.disabled) return;
        ui.paper = ui.paper === key ? "" : key;
        renderDockets(last || s);
      });
      head.append(chip);
    });
    const body = document.createElement("div");
    body.className = "docket-body";
    const pre = document.createElement("pre");
    const open = (d.papers || []).find((p) => `${d.root}::${p.id}` === ui.paper);
    if (open && !open.empty) {
      pre.textContent = open.body;
      requestAnimationFrame(() => body.classList.add("on"));
    }
    body.append(pre);
    wrap.append(head, body);
    box.append(wrap);
  });
}

function renderRoomMenu(s) {
  if (!has("room-menu")) return;
  const inner = $("room-menu").querySelector(".fold-in");
  inner.innerHTML = "";
  (s.projects || []).forEach((p) => {
    inner.append(
      btn(p.current ? "on" : "", p.name, async () => {
        ui.menu = false;
        setFold($("room-menu"), false);
        toast("");
        try {
          ui.paper = "";
          render(await loadState(p.root));
        } catch (e) {
          toast(e.message);
        }
      })
    );
  });
  inner.append(
    btn("", "其他文件夹", () => {
      ui.menu = false;
      setFold($("room-menu"), false);
      pickFolder();
    })
  );
  setFold($("room-menu"), ui.menu);
}

function renderSides(s) {
  const box = $("sides");
  if (!box) return;
  box.innerHTML = "";
  box.append(btn(s.fileSide === "project" ? "on" : "", "正式", () => loadState(s.root, "project", "").then(render).catch((e) => toast(e.message))));
  if (s.worktreeExists) {
    box.append(btn(s.fileSide === "site" ? "on" : "", "正在改", () => loadState(s.root, "site", "").then(render).catch((e) => toast(e.message))));
  }
}

function renderFiles(s) {
  const box = $("filelist");
  if (!box) return;
  box.innerHTML = "";
  $("crumb").textContent = (s.fileSide === "site" ? "正在改" : "正式") + (s.fileRel ? " / " + s.fileRel : "");
  if (s.fileParent !== null && s.fileRel) {
    box.append(btn("", "上一层", () => loadState(s.root, s.fileSide, s.fileParent).then(render).catch((e) => toast(e.message))));
  }
  (s.files || []).forEach((f) => {
    const row = document.createElement("button");
    row.textContent = f.name;
    row.addEventListener("click", async () => {
      if (f.kind === "dir") {
        const next = s.fileRel ? `${s.fileRel}/${f.name}` : f.name;
        try {
          render(await loadState(s.root, s.fileSide, next));
        } catch (e) {
          toast(e.message);
        }
        return;
      }
      try {
        const q = new URLSearchParams({
          root: s.root,
          side: s.fileSide,
          rel: s.fileRel || "",
          file: f.name,
        });
        $("preview").textContent = (await api(`/api/preview?${q}`)).content;
      } catch (e) {
        $("preview").textContent = e.message;
      }
    });
    box.append(row);
  });
  setFold($("cabinet"), ui.cabinet);
}

function renderActions(s) {
  const box = $("actions");
  if (!box) return;
  box.innerHTML = "";
  const who = s.windowId;
  const llm = s.llmId;

  if (s.phase === "not_git" || s.phase === "need_init" || s.phase === "idle") {
    if (s.phase === "not_git") {
      const lead = document.createElement("p");
      lead.className = "lead";
      lead.textContent = "这个文件夹还不是项目。写下要做什么，按开始，这里会做成项目。";
      box.append(lead);
    }
    const field = document.createElement("input");
    field.placeholder = "要做什么";
    if (ui.draftTask) field.value = ui.draftTask;
    box.append(field);
    box.append(btn("go", "开始", () => runLine()));
  } else if (s.phase === "working") {
    const front = (s.windows || []).find((w) => w.on);
    const win = front ? front.label : s.windowId || "";
    const brain = (s.llmHint || s.llmLabel || "").replace(/最认真/g, "").trim();
    const lead = document.createElement("p");
    lead.className = "lead";
    lead.textContent = win
      ? `按打开窗口，到 ${win}${brain ? " · " + brain : ""} 里做。做完回到这里按交接。`
      : "做完回到这里按交接。";
    box.append(lead);
    if (who) box.append(btn("go", "打开窗口", () => openWindow(who, llm)));
    box.append(btn("", "交接", () => act("/api/handoff")));
    box.append(btn("danger", "不要了", () => confirm("不要这次的改动？") && act("/api/abandon")));
  } else if (s.phase === "handed") {
    if (who) box.append(btn("", "再打开", () => openWindow(who, llm)));
    box.append(btn("go", "合回去", () => act("/api/merge")));
    box.append(btn("danger", "不要了", () => confirm("不要这次的改动？") && act("/api/abandon")));
  }
}

async function pickFolder() {
  try {
    render((await api("/api/choose-folder", {})).state);
  } catch (e) {
    toast(e.message);
  }
}

function render(s) {
  if (last && last.root !== s.root) {
    if (has("preview")) $("preview").textContent = "";
    ui.paper = "";
  }
  last = s;
  setRoot(s.root);
  const name = ((s.projects || []).find((p) => p.current) || {}).name || "接力";
  if (has("room-name")) $("room-name").textContent = name;
  if (has("talk-door")) {
    $("talk-door").textContent = ui.view === "talk" ? "接力" : "群聊";
    $("talk-door").classList.toggle("on", ui.view === "talk");
  }
  if (has("files-toggle")) $("files-toggle").classList.toggle("on", ui.cabinet);
  renderWindows(s);
  if (has("task")) {
    $("task").hidden = !s.task;
    $("task").textContent = s.task || "";
  }
  renderPile(s);
  renderTrack(s);
  renderSeats(s);
  renderTalk(s);
  renderDockets(s);
  renderRoomMenu(s);
  renderSides(s);
  renderFiles(s);
  renderRail(s);
  renderActions(s);
}

function renderPast(s) {
  const box = $("past");
  if (!box) return;
  box.innerHTML = "";
  const talks = s.talks || [];
  if (!talks.length) {
    const p = document.createElement("p");
    p.className = "empty-side";
    p.textContent = "还没有";
    box.append(p);
    return;
  }
  talks.forEach((t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "past" + (t.current ? " on" : "");
    const name = document.createElement("b");
    name.textContent = t.name;
    b.append(name);
    b.addEventListener("click", async () => {
      toast("");
      try {
        ui.paper = "";
        clearClips();
        setView("talk");
        if (!t.current) render(await loadState(t.root));
      } catch (e) {
        toast(e.message);
      }
    });
    box.append(b);
  });
}

function renderHistory(s) {
  const label = document.querySelector("#history .label");
  if (label) label.textContent = ui.view === "talk" ? "对话" : "项目";
  if (ui.view === "talk") renderPast(s);
  else renderProjects(s);
}

function renderProjects(s) {
  const box = $("past");
  if (!box) return;
  box.innerHTML = "";
  (s.projects || []).forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "past" + (p.current ? " on" : "");
    const name = document.createElement("b");
    name.textContent = p.name;
    b.append(name);
    b.addEventListener("click", () => {
      if (p.current) {
        renameProject(b, p);
        return;
      }
      toast("");
      ui.paper = "";
      loadState(p.root).then(render).catch((e) => toast(e.message));
    });
    box.append(b);
  });
  box.append(btn("", "其他文件夹", () => pickFolder()));
}

function renameProject(button, project) {
  const name = button.querySelector("b");
  if (!name) return;
  const input = document.createElement("input");
  input.className = "title-edit";
  input.value = project.name;
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (!title || title === project.name) {
      renderProjects(last);
      return;
    }
    try {
      const data = await api("/api/title", { root: project.root, title });
      if (data.state) render(data.state);
    } catch (e) {
      toast(e.message);
      renderProjects(last);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish();
    }
    if (e.key === "Escape") {
      input.value = project.name;
      finish();
    }
  });
  input.addEventListener("blur", () => finish());
}

function renderRail(s) {
  renderHistory(s);
  const sides = $("rail-sides");
  if (sides) {
    sides.innerHTML = "";
    sides.append(
      btn(s.fileSide === "project" ? "on" : "", "正式", () =>
        loadState(s.root, "project", "").then(render).catch((e) => toast(e.message))
      )
    );
    if (s.worktreeExists) {
      sides.append(
        btn(s.fileSide === "site" ? "on" : "", "正在改", () =>
          loadState(s.root, "site", "").then(render).catch((e) => toast(e.message))
        )
      );
    }
  }
  const crumb = $("rail-crumb");
  if (crumb) crumb.textContent = (s.fileSide === "site" ? "正在改" : "正式") + (s.fileRel ? " / " + s.fileRel : "");
  const box = $("rail-files");
  if (!box) return;
  box.innerHTML = "";
  if (s.fileParent !== null && s.fileRel) {
    box.append(
      btn("", "上一层", () => loadState(s.root, s.fileSide, s.fileParent).then(render).catch((e) => toast(e.message)))
    );
  }
  (s.files || []).forEach((f) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-item";
    row.textContent = f.name;
    const rel = s.fileRel ? `${s.fileRel}/${f.name}` : f.name;
    if (f.kind === "dir") {
      row.addEventListener("click", () => {
        if ($("rail-preview")) $("rail-preview").textContent = "";
        loadState(s.root, s.fileSide, rel).then(render).catch((e) => toast(e.message));
      });
    } else {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", rel);
        e.dataTransfer.effectAllowed = "copy";
      });
      row.addEventListener("click", async () => {
        if (ui.view === "talk") {
          addClip(rel);
          return;
        }
        try {
          const q = new URLSearchParams({
            root: s.root,
            side: s.fileSide,
            rel: s.fileRel || "",
            file: f.name,
          });
          if ($("rail-preview")) $("rail-preview").textContent = (await api(`/api/preview?${q}`)).content;
        } catch (e) {
          if ($("rail-preview")) $("rail-preview").textContent = e.message;
        }
      });
    }
    box.append(row);
  });
}

if (has("win-fold")) {
  $("win-fold").addEventListener("click", () => {
    ui.winsOpen = !ui.winsOpen;
    if (last) renderWindows(last);
  });
}
if (has("files-toggle")) {
  $("files-toggle").addEventListener("click", () => {
    ui.cabinet = !ui.cabinet;
    setFold($("cabinet"), ui.cabinet);
  });
}
if (has("talk-door")) {
  $("talk-door").addEventListener("click", () => setView(ui.view === "talk" ? "work" : "talk"));
}
if (has("talk-send")) $("talk-send").addEventListener("click", () => sendTalk());
if (has("talk-open")) $("talk-open").addEventListener("click", () => openTalkWindow());
if (has("talk-start")) $("talk-start").addEventListener("click", () => startFromTalk());
wireDrop($("composer-box"));
wireDrop($("work-composer"));
if (has("talk-add") && has("talk-file")) {
  $("talk-add").addEventListener("click", () => $("talk-file").click());
  $("talk-file").addEventListener("change", () => {
    [...($("talk-file").files || [])].forEach((file) => uploadLocal(file));
    $("talk-file").value = "";
  });
}
if (has("talk-input")) {
  $("talk-input").addEventListener("input", () => showAt());
  $("talk-input").addEventListener("keydown", (e) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      hideAt();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendTalk();
    }
  });
}
window.addEventListener("hashchange", () => setView(location.hash === "#talk" ? "talk" : "work"));
function tick() {
  const wait = last && last.pendingTalk ? 2500 : 7000;
  setTimeout(async () => {
    if (!document.hidden && last) {
      const el = document.activeElement;
      const inField = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      const talkField = el && el.id === "talk-input";
      const watchReply = !!(last.pendingTalk && talkField);
      if (!inField || talkField || watchReply) {
        try {
          render(await loadState(rootValue(), last.fileSide, last.fileRel));
        } catch {
          /* keep last frame */
        }
      }
    }
    tick();
  }, wait);
}
tick();

async function boot() {
  setView(location.hash === "#talk" ? "talk" : "work");
  try {
    render(await loadState(params.get("root") || ""));
  } catch (e) {
    if (has("who-win")) $("who-win").textContent = "没打开";
    if (has("who-brain")) $("who-brain").textContent = humanize(e.message);
  }
}

boot();
