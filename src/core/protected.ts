/**
 * 保护路径的简易通配：** 跨目录，* 不跨目录，? 单个字符。
 * 以 / 结尾的写法（如 config/）表示整个目录。
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++; // "**/" 也匹配零层目录
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchProtected(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const res = patterns.filter((p) => p.trim()).map(globToRegExp);
  return files.filter((f) => res.some((re) => re.test(f)));
}
