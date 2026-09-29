import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 技能（skill）：一个文件夹里一份 SKILL.md（开头 name、description，后面是做法）。各家工具各读各的地方，
 * 接力台把这个项目用得上的汇成一份：输入框打 / 能挑，任务或问话里写了 /技能名，发给 AI 的开工说明里就附上
 * 这个技能的说明——派给谁都照着做（接口成员读不到项目外面的文件，也能用上）。
 * 同名的只算一个：项目里的优先，再是 ~/.claude/skills、~/.agents/skills、~/.codex/skills。
 */

export interface SkillInfo {
  name: string;
  description: string;
  /** SKILL.md 的位置。 */
  path: string;
  /** 项目里的 / 这台电脑上的。 */
  from: 'project' | 'user';
}

function dirsOf(root: string): { dir: string; from: SkillInfo['from'] }[] {
  const h = os.homedir();
  return [
    { dir: path.join(root, '.claude', 'skills'), from: 'project' },
    { dir: path.join(root, '.agents', 'skills'), from: 'project' },
    { dir: path.join(h, '.claude', 'skills'), from: 'user' },
    { dir: path.join(h, '.agents', 'skills'), from: 'user' },
    { dir: path.join(h, '.codex', 'skills'), from: 'user' },
  ];
}

/** SKILL.md 开头 --- 里的一项（description 可能是 >- 接几行）。 */
function front(text: string, key: string): string {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i < 0) return '';
  let v = lines[i].slice(key.length + 1).trim();
  if (/^[>|][-+]?$/.test(v)) {
    const more: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) more.push(lines[j].trim());
    v = more.join(' ');
  }
  return v.replace(/^["']|["']$/g, '').trim();
}

export function listSkills(root: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const { dir, from } of dirsOf(root)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      if (n.startsWith('.') || n === 'synced') continue;
      const file = path.join(dir, n, 'SKILL.md');
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8').slice(0, 64 * 1024);
      } catch {
        continue;
      }
      const name = front(text, 'name') || n;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, description: front(text, 'description'), path: file, from });
    }
  }
  return out;
}

/** 文字里写了哪些技能：/技能名（行首或空白后面），名字在这个项目的技能里。 */
export function skillsIn(root: string, text: string, all = listSkills(root)): SkillInfo[] {
  const names = new Set([...text.matchAll(/(^|\s)\/([^\s/`'"，。、；：]+)/g)].map((m) => m[2]));
  return all.filter((s) => names.has(s.name));
}

/**
 * 附在开工说明后面的技能说明：每个技能的做法（SKILL.md 去掉开头那段，最多 12000 字），一共最多 30000 字。
 * 没写技能就是空的。
 */
export function skillNote(root: string, text: string): string {
  const used = skillsIn(root, text);
  if (!used.length) return '';
  let left = 30_000;
  const parts: string[] = [];
  for (const s of used) {
    let body = '';
    try {
      body = fs.readFileSync(s.path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    } catch {
      continue;
    }
    const take = Math.min(body.length, 12_000, left);
    if (take <= 0) break;
    left -= take;
    parts.push(`### 技能「${s.name}」（说明文件 ${s.path}）\n\n${body.slice(0, take)}${take < body.length ? '\n\n…（后面还有，需要时打开说明文件看）' : ''}`);
  }
  return parts.length ? `\n\n---\n这次要用到的技能（写了 /技能名）：照下面的做法做；你的工具里装了同名技能的，直接用它也行。\n\n${parts.join('\n\n')}` : '';
}
