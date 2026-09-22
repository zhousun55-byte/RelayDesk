import fs from 'node:fs';
import path from 'node:path';
import { relayHome } from './session';

export interface UiMemory {
  root?: string;
  recents?: string[];
  agent?: string;
  llm?: string;
  llms?: string[];
  llmByAgent?: Record<string, string>;
}

export function uiMemoryPath(): string {
  return path.join(relayHome(), 'ui-last.json');
}

export function loadUiMemory(): UiMemory {
  try {
    return JSON.parse(fs.readFileSync(uiMemoryPath(), 'utf8')) as UiMemory;
  } catch {
    return {};
  }
}

export function rememberUi(partial: Partial<UiMemory>): UiMemory {
  const cur = loadUiMemory();
  const next: UiMemory = { ...cur, ...partial };
  if (partial.root) {
    next.root = partial.root;
    next.recents = [partial.root, ...(cur.recents ?? []).filter((r) => r !== partial.root)].slice(0, 12);
  }
  if (partial.llm?.trim()) {
    next.llms = [partial.llm.trim(), ...(cur.llms ?? []).filter((x) => x !== partial.llm)].slice(0, 24);
  }
  if (partial.agent !== undefined && partial.llm !== undefined) {
    const map = { ...(cur.llmByAgent ?? {}) };
    if (partial.llm.trim() && partial.agent) map[partial.agent] = partial.llm.trim();
    else if (partial.agent) delete map[partial.agent];
    next.llmByAgent = map;
  }
  fs.mkdirSync(relayHome(), { recursive: true });
  fs.writeFileSync(uiMemoryPath(), JSON.stringify(next, null, 2) + '\n');
  return next;
}
