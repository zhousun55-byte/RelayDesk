const tty = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: string, s: string): string {
  return tty ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export const c = {
  green: (s: string) => paint('32', s),
  yellow: (s: string) => paint('33', s),
  red: (s: string) => paint('31', s),
  dim: (s: string) => paint('2', s),
  bold: (s: string) => paint('1', s),
};

export function ok(msg: string): void {
  console.log(`${c.green('✓')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${c.yellow('⚠')} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${msg}`);
}

export function notes(list: string[]): void {
  for (const n of list) warn(n);
}
