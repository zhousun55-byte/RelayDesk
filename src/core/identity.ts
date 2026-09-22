import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BrainChip {
  id: string;
  label: string;
  on: boolean;
  detected: boolean;
}

export interface WindowChip {
  id: string;
  label: string;
  running: boolean;
  on: boolean;
  brain: string;
}

export interface Identity {
  who: string;
  windowId: string | null;
  llmId: string | null;
  llmLabel: string;
  llmHint: string;
  windows: WindowChip[];
  brains: BrainChip[];
}

const WINDOW_LABEL: Record<string, string> = {
  cursor: 'Cursor',
  zcode: 'ZCode',
  claude: 'Claude',
  mimo: 'MiMo',
  gpt: 'ChatGPT',
};

const BRAIN_FAMILIES: { id: string; label: string; match: RegExp }[] = [
  { id: 'grok', label: 'Grok', match: /grok/i },
  { id: 'claude', label: 'Claude', match: /claude/i },
  { id: 'composer', label: 'Composer', match: /composer/i },
  { id: 'gemini', label: 'Gemini', match: /gemini/i },
  { id: 'glm', label: 'GLM', match: /glm|chatglm/i },
  { id: 'deepseek', label: 'DeepSeek', match: /deepseek/i },
  { id: 'fable', label: 'Fable', match: /fable/i },
  { id: 'kimi', label: 'Kimi', match: /kimi/i },
  { id: 'gpt', label: 'GPT', match: /gpt/i },
];

export const BRAIN_BY_WINDOW: Record<string, string[]> = {
  cursor: [
    'grok-4.6',
    'composer-2',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'gpt-5.2',
    'gpt-5.1',
    'gemini-2.5-pro',
    'kimi-k2.5',
    'glm-5',
    'deepseek-v3',
    'fable-2',
  ],
  claude: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  zcode: [],
};

export const BRAIN_CATALOG = BRAIN_BY_WINDOW.cursor;

export function windowLabel(name: string): string {
  return WINDOW_LABEL[name.toLowerCase()] ?? name;
}

export function prettyLlm(id: string): string {
  const raw = id.trim();
  if (!raw) return '';
  if (/^gpt-6-astra$/i.test(raw)) return 'GPT-6 Astra';
  if (/^mimo-v2\.6-pro$/i.test(raw)) return 'MiMo-V2.6-Pro';
  if (/^(opus|sonnet|haiku)$/i.test(raw)) {
    const kind = raw[0].toUpperCase() + raw.slice(1).toLowerCase();
    return `Claude ${kind}`;
  }
  for (const fam of BRAIN_FAMILIES) {
    if (fam.match.test(raw)) {
      const ver = raw.match(/(\d+\.\d+)/) || raw.match(/(\d+)/);
      if (fam.id === 'claude') {
        const kind = raw.match(/opus|sonnet|haiku/i);
        const title = kind ? kind[0][0].toUpperCase() + kind[0].slice(1).toLowerCase() : '';
        return ['Claude', title, ver?.[1] ?? ''].filter(Boolean).join(' ');
      }
      return ver ? `${fam.label} ${ver[1]}` : fam.label;
    }
  }
  return raw;
}

export function extractModelId(raw: string): string | null {
  const m = raw.match(
    /\b(claude-(?:opus|sonnet|haiku)[a-z0-9.-]*|grok-[\w.]+|glm-[\w.]+|deepseek-[\w.]+|gpt-[\w.]+|kimi-[\w.]+|fable-[\w.]+|gemini-[\w.]+|composer-[\w.]+)\b/i
  );
  return m ? m[1] : null;
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function prettyEffort(id: string): string {
  const x = id.trim().toLowerCase();
  if (x === 'max' || x === 'xhigh') return '最认真';
  if (x === 'high') return '认真';
  if (x === 'medium') return '一般';
  if (x === 'low') return '省着';
  return '';
}

export function readClaudeSettings(): { model: string | null; effort: string | null } {
  const p = path.join(os.homedir(), '.claude', 'settings.json');
  const j = readJson(p) as {
    model?: string;
    alwaysThinkingEnabled?: boolean;
    env?: Record<string, string>;
  } | null;
  if (!j || typeof j !== 'object') return { model: null, effort: null };
  const model = typeof j.model === 'string' && j.model.trim() ? j.model.trim() : null;
  const envEffort = typeof j.env?.CLAUDE_CODE_EFFORT_LEVEL === 'string' ? j.env.CLAUDE_CODE_EFFORT_LEVEL : null;
  const effort = envEffort || (j.alwaysThinkingEnabled ? 'high' : null);
  return { model, effort };
}

export function readClaudeOpenModel(): string | null {
  const s = readClaudeSettings();
  if (s.model) {
    if (/^(opus|sonnet|haiku)$/i.test(s.model)) return `claude-${s.model.toLowerCase()}`;
    return extractModelId(s.model) || s.model;
  }
  const dir = path.join(os.homedir(), 'Library/Application Support/Claude');
  for (const name of ['claude_desktop_config.json', 'config.json']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const found = extractModelId(fs.readFileSync(p, 'utf8'));
      if (found) return found;
    } catch {
      /* skip unreadable */
    }
  }
  return 'claude';
}

export function readHarnessBrain(windowId: string | null): string | null {
  if (windowId === 'cursor') return readCursorOpenModel();
  if (windowId === 'claude') return readClaudeOpenModel();
  if (windowId === 'zcode') return readZcodeOpenModel();
  if (windowId === 'mimo') return readMimoOpenModel();
  if (windowId === 'gpt') return readGptOpenModel();
  return null;
}

export function readHarnessEffort(windowId: string | null): string {
  if (windowId === 'claude') return prettyEffort(readClaudeSettings().effort || '');
  return '';
}

export function parseCursorOpenModel(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as { selectedModels?: { modelId?: string }[] };
    const id = j.selectedModels?.[0]?.modelId;
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  } catch {
    return null;
  }
}

export function parseComposerModel(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as {
      aiSettings?: { modelConfig?: { composer?: { modelName?: string; selectedModels?: { modelId?: string }[] } } };
    };
    const composer = j.aiSettings?.modelConfig?.composer;
    const id = composer?.selectedModels?.[0]?.modelId;
    if (typeof id === 'string' && id.trim() && id.trim() !== 'default') return id.trim();
    const name = composer?.modelName;
    if (typeof name === 'string' && name.trim() && name.trim() !== 'default') return name.trim();
    return null;
  } catch {
    return null;
  }
}

function cursorStateValue(key: string): string | null {
  const db = path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  if (!fs.existsSync(db)) return null;
  const r = spawnSync('sqlite3', [db, `SELECT value FROM ItemTable WHERE key='${key}'`], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return r.stdout.trim();
}

export function readCursorOpenModel(): string | null {
  const composer = cursorStateValue(
    'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
  );
  const fromComposer = composer ? parseComposerModel(composer) : null;
  if (fromComposer) return fromComposer;
  const applied = cursorStateValue('cursor/applicationOpenModelAppliedConfig');
  return applied ? parseCursorOpenModel(applied) : null;
}

export function parseZcodeModelId(raw: string): string | null {
  const glm = [...raw.matchAll(/"modelId":"(GLM-[^"]+)"/g)];
  if (glm.length) return glm[glm.length - 1][1].trim();
  const found = [...raw.matchAll(/"modelId":"([^"]+)"/g)];
  const id = found.length ? found[found.length - 1][1].trim() : '';
  return id || null;
}

export function readZcodeOpenModel(): string | null {
  const dirs = [
    path.join(os.homedir(), 'Agent/Zcode/.zcode/v2/logs'),
    path.join(os.homedir(), '.zcode/cli/log'),
  ];
  let newest: { p: string; m: number } | null = null;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (!newest || st.mtimeMs > newest.m) newest = { p, m: st.mtimeMs };
      } catch {
        /* skip */
      }
    }
  }
  if (!newest) return null;
  const ranked = [newest.p];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!ranked.includes(p) && fs.existsSync(p) && fs.statSync(p).isFile()) ranked.push(p);
    }
  }
  ranked.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const p of ranked.slice(0, 4)) {
    try {
      const st = fs.statSync(p);
      if (st.size > 3_000_000) continue;
      const id = parseZcodeModelId(fs.readFileSync(p, 'utf8'));
      if (id) return id;
    } catch {
      /* try the next log */
    }
  }
  return null;
}

export function readMimoOpenModel(): string | null {
  const p = path.join(os.homedir(), '.config/mimocode/mimocode.jsonc');
  if (!fs.existsSync(p)) return null;
  try {
    const found = fs.readFileSync(p, 'utf8').match(/"(mimo-v[\w.-]+)"/);
    return found ? found[1] : null;
  } catch {
    return null;
  }
}

export function readGptOpenModel(): string | null {
  const p = path.join(os.homedir(), '.codex/config.toml');
  if (!fs.existsSync(p)) return null;
  try {
    const found = fs.readFileSync(p, 'utf8').match(/^model\s*=\s*"([^"]+)"/m);
    return found ? found[1] : null;
  } catch {
    return null;
  }
}

export function runningHarnesses(): string[] {
  const probes: [string, string][] = [
    ['cursor', 'Cursor.app/'],
    ['zcode', 'ZCode.app/'],
    ['claude', 'Claude.app/'],
    ['mimo', 'Xiaomi MiMo.app/'],
    ['gpt', 'ChatGPT.app/'],
  ];
  return probes
    .filter(([, needle]) => spawnSync('pgrep', ['-f', needle], { encoding: 'utf8' }).status === 0)
    .map(([id]) => id);
}

export function buildIdentity(
  agents: { name: string; kind: string }[],
  lastAgent?: string | null,
  extraLlms: string[] = []
): Identity {
  const running = runningHarnesses();
  const names = agents.map((a) => a.name);

  void extraLlms;
  const windowId =
    (lastAgent && running.includes(lastAgent) && names.includes(lastAgent) ? lastAgent : null) ||
    (running.includes('cursor') && names.includes('cursor') ? 'cursor' : null) ||
    running.find((r) => names.includes(r)) ||
    (lastAgent && names.includes(lastAgent) ? lastAgent : null) ||
    (names.includes('cursor') ? 'cursor' : names[0]) ||
    null;

  const detected = readHarnessBrain(windowId);
  const llmId = detected || null;
  const llmLabel = llmId ? prettyLlm(llmId) : '';
  const winLabel = windowId ? windowLabel(windowId) : '';
  const who = [winLabel, llmLabel].filter(Boolean).join(' · ') || '未识别';
  const llmHint = llmLabel;

  const windows: WindowChip[] = agents.map((a) => ({
    id: a.name,
    label: windowLabel(a.name),
    running: running.includes(a.name),
    on: a.name === windowId,
    brain: prettyLlm(readHarnessBrain(a.name) || ''),
  }));

  const brains: BrainChip[] = [];
  if (detected) {
    brains.push({ id: detected, label: prettyLlm(detected), on: true, detected: true });
  }

  return { who, windowId, llmId, llmLabel, llmHint, windows, brains };
}
