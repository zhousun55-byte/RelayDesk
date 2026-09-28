import fs from 'node:fs';
import path from 'node:path';
import { relayConfigPath } from '../core/config';
import { RelayError } from '../core/errors';
import { ledgerPath, requireInit } from '../core/ledger';
import { HANDOFF_DIR, REVIEW_DIR, TASK_REL } from '../core/notes';
import { isInside } from '../core/paths';
import { redactSecrets } from '../core/redact';

/**
 * 脱敏导出：任务、交接、复核结论、账本、配置复制到一个空文件夹，像密钥的都抹成 [REDACTED]。
 * .relay 默认不进 git；想让别人看这件事是怎么接力做完的，导出一份再给出去，不用改 .gitignore。
 * 快照、日志、给复核准备的改动（*.diff）、群聊记录不导出：里面是整段代码和原话，抹不干净。
 */
export function exportRecords(root: string, dest: string): { dir: string; files: string[] } {
  requireInit(root);
  const dir = path.resolve(dest);
  if (isInside(path.join(root, '.relay'), dir)) throw new RelayError('不能导出到 .relay 里面。', 'bad-dest');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new RelayError(`「${dir}」里已经有东西了，换一个空文件夹。`, 'bad-dest');
  const md = (rel: string) => {
    try {
      return fs
        .readdirSync(path.join(root, rel))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => `${rel}/${f}`);
    } catch {
      return [];
    }
  };
  const picks = [TASK_REL, path.relative(root, relayConfigPath(root)), path.relative(root, ledgerPath(root)), ...md(HANDOFF_DIR), ...md(REVIEW_DIR)];
  const files: string[] = [];
  for (const rel of picks) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const out = rel.replace(/^\.relay\//, '');
    fs.mkdirSync(path.dirname(path.join(dir, out)), { recursive: true });
    fs.writeFileSync(path.join(dir, out), redactSecrets(fs.readFileSync(src, 'utf8')));
    files.push(out);
  }
  return { dir, files };
}
