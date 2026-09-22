import fs from 'node:fs';
import path from 'node:path';

/** 群聊和题目写在项目里，但不进主线，也不挡 merge。 */
export const SIDE_PATHS = ['.relay/talk.jsonl', '.relay/talk.md', '.relay/title.txt', '.relay/attach'];

const MARKER = '# relay-side';

export function isSidePath(file: string): boolean {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (f === '.relay/attach' || f.startsWith('.relay/attach/')) return true;
  return SIDE_PATHS.includes(f);
}

/** porcelain 里去掉群聊文件。剩下的才算挡住合回。 */
export function blockingMainStatus(porcelain: string): string {
  return porcelain
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => {
      if (line.trim() === '') return false;
      let file = line.slice(3);
      if (file.includes(' -> ')) file = file.split(' -> ').pop() ?? file;
      return !isSidePath(file.trim());
    })
    .join('\n');
}

export function ensureRelayGitignore(root: string): void {
  const p = path.join(root, '.gitignore');
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (cur.includes(MARKER)) return;
  const block = `${MARKER}\n.relay/talk.jsonl\n.relay/talk.md\n.relay/title.txt\n.relay/attach/\n`;
  const prefix = cur.length > 0 && !cur.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(p, `${prefix}${cur.length > 0 ? '\n' : ''}${block}`);
}
