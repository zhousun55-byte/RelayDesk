import fs from 'node:fs';
import path from 'node:path';

/**
 * 左边删掉的对话（任务）：只是不再列出，账本、交接、快照都不动（账本只追加，退回、验收照样按它算）。
 * 记在 .relay/hidden.json，按这段对话开始的时间认（换任务那一刻，第一段是接入的时候）。
 */

function file(root: string): string {
  return path.join(root, '.relay', 'hidden.json');
}

export function hiddenThreads(root: string): Set<string> {
  try {
    const j = JSON.parse(fs.readFileSync(file(root), 'utf8')) as { threads?: unknown };
    return new Set(Array.isArray(j.threads) ? j.threads.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function setThreadHidden(root: string, key: string, hidden: boolean): void {
  const all = hiddenThreads(root);
  if (hidden) all.add(key);
  else all.delete(key);
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  fs.writeFileSync(file(root), JSON.stringify({ threads: [...all] }, null, 2) + '\n');
}
