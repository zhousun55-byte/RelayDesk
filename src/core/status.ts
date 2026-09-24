/**
 * 解析 git 的 -z 输出（快照之间的改动）。必须用 -z：路径原样，中文、空格都不转义。
 */

export interface FileChange {
  path: string;
  /** A 新增 / M 修改 / D 删除 / R 改名 / T 类型变化 */
  status: string;
  orig?: string;
  /** 二进制文件为 null。 */
  added: number | null;
  removed: number | null;
}

export function statusWord(code: string): string {
  if (code === '??' || code.includes('A')) return '新增';
  if (code.includes('D')) return '删除';
  if (code.includes('R')) return '改名';
  if (code.includes('U')) return '冲突';
  return '修改';
}

export function parseNameStatusZ(raw: string): { status: string; path: string; orig?: string }[] {
  const parts = raw.split('\0').filter((x, i, arr) => !(x === '' && i === arr.length - 1));
  const out: { status: string; path: string; orig?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const letter = s[0];
    if (letter === 'R' || letter === 'C') {
      out.push({ status: letter, orig: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      out.push({ status: letter, path: parts[i + 1] });
      i += 1;
    }
  }
  return out.filter((x) => x.path);
}

export function parseNumstatZ(raw: string): Map<string, { added: number | null; removed: number | null }> {
  const map = new Map<string, { added: number | null; removed: number | null }>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const m = s.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    let p = m[3];
    if (p === '') {
      // 改名：接下来两个字段是 原路径、新路径
      p = parts[i + 2] ?? '';
      i += 2;
    }
    if (p) map.set(p, { added, removed });
  }
  return map;
}

export function sumChanges(files: FileChange[]): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { files: files.length, added, removed };
}
