import fs from 'node:fs';
import path from 'node:path';

/**
 * 左边删掉的对话（任务）：不再列出，里面的棒也不再算待复核（ledger.ts 的 deletedStintIds）；账本、交接、快照都不动，撤销删除就恢复。
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
