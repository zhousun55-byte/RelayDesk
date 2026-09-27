import path from 'node:path';
import { Command } from 'commander';
import { readTask } from '../core/notes';
import { loadGoState } from '../ops/go';
import { statusLines } from '../ops/view';
import { c } from './print';
import { findRoot } from './relay';

/** 终端里一行占几格：汉字、全角符号、表情两格。 */
function cells(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f300;
    n += wide ? 2 : 1;
  }
  return n;
}

/** 超出终端宽度的截掉，末尾写「…」（不折行，免得整屏往上滚）。 */
function fit(s: string, cols: number): string {
  if (cells(s) <= cols) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const w = cells(ch);
    if (n + w > cols - 1) break;
    out += ch;
    n += w;
  }
  return `${out}…`;
}

/** 一屏：状态（和 relay status 一样）中间插上清单，下一步下面写做法；调度中写它在干什么。 */
function frame(root: string): { text: string; dim?: boolean; bold?: boolean }[] {
  const d = new Date();
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const [head, ...rest] = statusLines(root);
  const out: { text: string; dim?: boolean; bold?: boolean }[] = [{ text: `接力台 · ${path.basename(root)} · ${clock}`, bold: true }, { text: '' }, { text: head }];
  const task = readTask(root);
  const next = task.items.findIndex((it) => !it.done);
  task.items.forEach((it, i) => {
    out.push({ text: `  ${it.done ? '✓' : i === next ? '→' : '·'} ${i + 1}. ${it.text}`, dim: it.done });
    if (i === next && it.note) for (const l of it.note.split('\n')) out.push({ text: `       ${l}`, dim: true });
  });
  out.push({ text: '' }, ...rest.map((text) => ({ text })));
  const g = loadGoState(root);
  if (g && (g.status === 'running' || g.status === 'waiting')) out.push({ text: '' }, { text: `调度：${g.phase}` });
  return out;
}

export function watchCommand(): Command {
  return new Command('watch')
    .description('一直开着看进度：任务、清单、谁在做、最近几棒，每 2 秒刷新（Ctrl-C 退出；只看不改）')
    .option('--once', '只打印一次就退出')
    .action(async (o: { once?: boolean }) => {
      const root = findRoot();
      const render = (cols: number) =>
        frame(root)
          .map((l) => {
            const t = fit(l.text, cols);
            return l.bold ? c.bold(t) : l.dim ? c.dim(t) : t;
          })
          .join('\n');
      if (o.once || !process.stdout.isTTY) {
        console.log(render(Infinity));
        return;
      }
      let last = '';
      const draw = () => {
        const text = render(process.stdout.columns || 80);
        if (text === last) return;
        last = text;
        process.stdout.write(`\u001b[H\u001b[2J${text}\n`);
      };
      process.stdout.write('\u001b[?25l');
      draw();
      const timer = setInterval(draw, 2000);
      process.stdout.on('resize', () => {
        last = '';
        draw();
      });
      const quit = () => {
        clearInterval(timer);
        process.stdout.write('\u001b[?25h\n');
        process.exit(0);
      };
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
      await new Promise(() => undefined);
    });
}
