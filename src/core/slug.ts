import { randomBytes } from 'node:crypto';

/** 分支名只用标题里的英文词；一个都没有（全中文）就叫 task。 */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return s.length > 0 ? s : 'task';
}

/** 4 位十六进制，避免同名任务撞分支。 */
export function newId(): string {
  return randomBytes(2).toString('hex');
}

export function branchNameFor(title: string): { slug: string; id: string; branch: string } {
  const slug = slugify(title);
  const id = newId();
  return { slug, id, branch: `relay/${slug}-${id}` };
}
