import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { augmentPath } from '../core/env';
import { RelayError } from '../core/errors';
import { loadLedger, markReview, requireInit } from '../core/ledger';
import { BRIEF_REL, editTask, readTask, type TaskEdit } from '../core/notes';
import { untilText } from '../core/quota';
import { snapDiff, takeSnapshot } from '../core/snap';
import { goLogTail, loadGoState, startGo, stopAllGo, stopGo, type GoState } from '../ops/go';
import { initProject, newTask } from '../ops/init';
import { rollbackBefore, undoRollback } from '../ops/rollback';
import { refreshBrief, track } from '../ops/track';
import { statusLines } from '../ops/view';
import { c, info, ok, warn } from './print';

/** 从当前文件夹往上找接入过的项目（像 git 找 .git 一样）；找不到就是当前文件夹。 */
export function findRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.relay', 'journal.jsonl'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

function requireRoot(): string {
  const root = findRoot();
  requireInit(root);
  return root;
}

export function initCommand(): Command {
  return new Command('init')
    .description('接入当前文件夹：建 .relay/，在 AGENTS.md / CLAUDE.md 里写接力规矩，存第一张快照（可以重复执行）')
    .argument('[要做什么...]', '顺手写下任务')
    .action((words: string[]) => {
      const r = initProject(process.cwd(), { task: words.join(' ').trim() || undefined });
      if (r.already && !r.actions.length) ok(`已经接入过了：${r.root}`);
      else {
        ok(`${r.already ? '补好了' : '接入了'}：${r.root}`);
        for (const a of r.actions) info(`· ${a}`);
      }
      info('');
      info('现在在任何 AI 工具里打开这个文件夹，说「接着做」就行：它会先读 .relay/接力本.md。');
      info('接力台开着的时候（relay ui 或桌面「接力台」），会自动记账：存快照、认交接、提醒复核。');
    });
}

export function statusCommand(): Command {
  return new Command('status')
    .description('看看这个项目现在怎么样了（顺手对一次账）')
    .action(() => {
      const root = findRoot();
      if (loadLedger(root).init) track(root);
      for (const l of statusLines(root)) console.log(l);
      const g = loadGoState(root);
      if (g && (g.status === 'running' || g.status === 'waiting')) {
        console.log('');
        info(`接力台调度中：${g.phase}`);
      }
    });
}

export function taskCommand(): Command {
  return new Command('task')
    .description('写下新任务（旧任务存档）。不带话就显示当前任务')
    .argument('[要做什么...]', '一句话说清楚要做成什么样')
    .option('--step <steps...>', '顺手拆好的步骤（可以写好几个）')
    .option('--dispatch', '派活的任务（和网页「派活」页写的一样）：全自动时强模型先拆成小步，弱模型一棒做一步')
    .action((words: string[], opts: { step?: string[]; dispatch?: boolean }) => {
      const root = requireRoot();
      const text = words.join(' ').trim();
      if (!text) {
        console.log(fs.readFileSync(path.join(root, '.relay', '任务.md'), 'utf8'));
        return;
      }
      newTask(root, text, opts.step ?? [], opts.dispatch ? 'dispatch' : undefined);
      ok(`写好了：.relay/任务.md${opts.dispatch ? '（派活）' : ''}`);
    });
}

/** 结果本身就是一句「主语 + 结果：原因」（docs/设计说明.md「结果怎么说」），前面只加一个记号。 */
function printGo(s: GoState): void {
  console.log(`${s.status === 'done' ? c.green('✓') : s.status === 'failed' ? c.red('✗') : c.yellow('•')} ${s.result ?? s.phase}`);
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

async function runAndWait(root: string, opts: Parameters<typeof startGo>[1]): Promise<void> {
  augmentPath();
  let lastPhase = '';
  /** 终端关掉了（SIGHUP）：不再往里打字。 */
  let quiet = false;
  const { done } = startGo(root, opts, {
    onUpdate: (s) => {
      if (!quiet && s.phase !== lastPhase) {
        lastPhase = s.phase;
        info(c.dim(s.phase));
      }
    },
  });
  // Ctrl-C、kill、关掉终端窗口：都先叫停，等正在干活的工具结束、这一棒记好账再退（不然工具会接着改文件，没人记账）。
  const onSig = (sig: NodeJS.Signals) => {
    if (sig === 'SIGHUP') quiet = true;
    else warn(`收到${sig === 'SIGINT' ? ' Ctrl-C' : '停止信号'}：正在停下（正在干活的工具会被结束，改到一半的东西都留在文件夹里）……`);
    void stopAllGo();
  };
  for (const sig of STOP_SIGNALS) process.on(sig, onSig);
  for (const s of [process.stdout, process.stderr]) s.on('error', () => undefined);
  const s = await done;
  for (const sig of STOP_SIGNALS) process.off(sig, onSig);
  if (!quiet) printGo(s);
  if (s.status === 'failed') process.exitCode = 1;
}

export function goCommand(): Command {
  return new Command('go')
    .description('让一个 AI 接着做一棒（接力台替你调度）。不指定人就按顺序挑第一个有额度的')
    .argument('[谁]', '成员名，如 codex、claude、deepseek')
    .option('--full', '完全放开（工具不再拦任何操作；默认是安全档）')
    .option('--force', '在别的工具里干到一半的那一位已经停下了（额度用完、关掉了），直接换人')
    .action(async (who: string | undefined, opts: { full?: boolean; force?: boolean }) => {
      const root = requireRoot();
      await runAndWait(root, { mode: 'once', ...(who ? { who } : {}), ...(opts.full ? { settings: { level: 'full' } } : {}), ...(opts.force ? { force: true } : {}) });
    });
}

export function reviewCommand(): Command {
  return new Command('review')
    .description('请强模型复核所有待复核的棒（不指定人就挑第一个有额度的强模型）；--skip 标记某一棒不用复核')
    .argument('[谁]', '成员名')
    .option('--skip <棒号>', '标记这一棒不用复核（比如其实是你自己改的）')
    .option('--note <说明>', '和 --skip 一起用：为什么不用复核')
    .option('--need <棒号>', '撤销「不用复核」，改回待复核')
    .action(async (who: string | undefined, o: { skip?: string; note?: string; need?: string }) => {
      const root = requireRoot();
      if (o.skip || o.need) {
        const id = Number(o.skip ?? o.need);
        markReview(root, id, o.skip ? 'skip' : 'needed', o.note);
        refreshBrief(root);
        ok(o.skip ? `第 ${id} 棒已标记为不用复核` : `第 ${id} 棒已改回待复核`);
        return;
      }
      await runAndWait(root, { mode: 'once', kind: 'review', ...(who ? { who } : {}) });
    });
}

/** 改清单：打勾、去掉勾、加一步、删一步（和网页上点的一样）。不带参数就列出来。 */
export function stepCommand(): Command {
  const show = (root: string) => {
    const t = readTask(root);
    if (!t.items.length) info('清单是空的。');
    t.items.forEach((it, i) => info(`${String(i + 1).padStart(2)}. [${it.done ? 'x' : ' '}] ${it.text}${!it.done && it.note ? `\n       ${c.dim(it.note.replace(/\n/g, '\n       '))}` : ''}`));
  };
  const edit = (e: TaskEdit, said: string) => {
    const root = requireRoot();
    editTask(root, e);
    refreshBrief(root);
    ok(said);
    show(root);
  };
  const nth = (n: string) => {
    const i = Number(n);
    if (!Number.isInteger(i) || i < 1) throw new RelayError(`「${n}」不是第几步`, 'no-item');
    return i - 1;
  };
  const cmd = new Command('step').description('改任务清单：打勾、去掉勾、加一步、删一步。不带参数就列出来').action(() => show(requireRoot()));
  cmd.command('add').description('在最后加一步').argument('<这一步...>').action((w: string[]) => edit({ op: 'add', text: w.join(' ') }, '已加入清单'));
  cmd.command('done').description('第 N 步打勾').argument('<N>').action((n: string) => edit({ op: 'toggle', index: nth(n), done: true }, `第 ${n} 步已打勾`));
  cmd.command('undo').description('去掉第 N 步的勾').argument('<N>').action((n: string) => edit({ op: 'toggle', index: nth(n), done: false }, `第 ${n} 步已去掉勾`));
  cmd.command('remove').description('删掉第 N 步（连它下面的做法）').argument('<N>').action((n: string) => edit({ op: 'remove', index: nth(n) }, `第 ${n} 步已删掉`));
  return cmd;
}

export function autoCommand(): Command {
  return new Command('auto')
    .description('全自动：一直接力到任务清单全部打勾。额度用完换人，弱模型的活先请强模型复核，最后强模型终审')
    .argument('[要做什么...]', '顺手写下新任务（不写就接着做当前任务）')
    .option('--full', '完全放开（工具不再拦任何操作；默认是安全档）')
    .option('--max <棒数>', '最多接力几棒')
    .option('--no-wait', '都没额度了就停下，不等')
    .option('--no-final', '这一次清单打完不终审')
    .option('--dispatch', '这一次用派活：强模型拆成小步，弱模型一棒做一步，强模型每 3 棒复核一次（不写就看任务是不是用 --dispatch 写的）')
    .option('--relay', '这一次不用派活')
    .option('--force', '在别的工具里干到一半的那一位已经停下了（额度用完、关掉了），直接换人')
    .action(async (words: string[], opts: { full?: boolean; max?: string; wait: boolean; final: boolean; dispatch?: boolean; relay?: boolean; force?: boolean }) => {
      const root = requireRoot();
      const text = words.join(' ').trim();
      if (text) newTask(root, text, [], opts.dispatch ? 'dispatch' : undefined);
      await runAndWait(root, {
        mode: 'auto',
        ...(opts.force ? { force: true } : {}),
        ...(opts.dispatch ? { dispatch: true } : opts.relay ? { dispatch: false } : {}),
        settings: { ...(opts.full ? { level: 'full' } : {}), ...(opts.max ? { maxStints: Number(opts.max) } : {}), ...(opts.wait === false ? { waitForQuota: false } : {}), ...(opts.final === false ? { finalReview: false } : {}) },
      });
    });
}

export function stopCommand(): Command {
  return new Command('stop')
    .description('叫停接力台正在调度的活')
    .action(() => {
      const root = requireRoot();
      if (stopGo(root)) ok('已经叫停，正在干活的工具会被结束。');
      else info('现在没有在调度的活。');
    });
}

export function logCommand(): Command {
  return new Command('log')
    .description('看最近一次调度的日志')
    .action(() => {
      const root = requireRoot();
      const g = loadGoState(root);
      if (!g) {
        info('还没调度过。');
        return;
      }
      printGo(g);
      const tail = goLogTail(root, g, 80);
      if (tail) console.log(tail);
    });
}

export function diffCommand(): Command {
  return new Command('diff')
    .description('看第 N 棒改了什么（不写就看上一棒交接之后、还没人交接的改动）')
    .argument('[棒号]', '第几棒')
    .action((n: string | undefined) => {
      const root = requireRoot();
      const v = loadLedger(root);
      if (!n) {
        const now = takeSnapshot(root, '看改动').sha;
        const base = v.base ?? now;
        const d = snapDiff(root, base, now);
        console.log(d || '上一棒交接之后没有新的改动。');
        return;
      }
      const s = v.stints.find((x) => x.id === Number(n));
      if (!s) throw new RelayError(`没有第 ${n} 棒。`, 'no-stint');
      if (!s.to) throw new RelayError(`第 ${n} 棒还没结束。`, 'working');
      console.log(snapDiff(root, s.from, s.to) || '这一棒没有改文件。');
    });
}

export function rollbackCommand(): Command {
  return new Command('rollback')
    .description('退回到第 N 棒之前（整个文件夹恢复成那时的样子；之后的棒作废）。--undo 撤销最近一次退回')
    .argument('[棒号]', '第几棒')
    .option('--undo', '撤销最近一次退回')
    .action((n: string | undefined, opts: { undo?: boolean }) => {
      const root = requireRoot();
      if (opts.undo) {
        const r = undoRollback(root);
        ok(`${r.label}：恢复了 ${r.files} 个文件。`);
        return;
      }
      if (!n) throw new RelayError('要退回到第几棒之前？例如 relay rollback 7', 'no-stint');
      const r = rollbackBefore(root, Number(n));
      ok(`已退回到${r.label}：${r.files} 个文件恢复了，第 ${r.dropped.join('、')} 棒作废。想撤销：relay rollback --undo`);
      if (r.task.missing) warn('任务清单没跟着退回（旧账本里没存那时的清单）：对照代码看看哪些步骤其实没做完，把勾去掉。');
      else if (r.task.unchecked.length) info(`任务清单里这几步的勾去掉了：${r.task.unchecked.join('、')}`);
    });
}

export function briefCommand(): Command {
  return new Command('brief')
    .description('对一次账，然后打印接力本（给 AI 工具的钩子用）')
    .action(() => {
      const root = requireRoot();
      track(root);
      refreshBrief(root);
      process.stdout.write(fs.readFileSync(path.join(root, BRIEF_REL), 'utf8'));
    });
}

export function snapCommand(): Command {
  return new Command('snap')
    .description('马上对一次账（存快照、认交接、更新接力本）')
    .action(() => {
      const root = requireRoot();
      const r = track(root);
      const v = loadLedger(root);
      ok(r.changed ? '记好了。' : '没有新变化。');
      if (v.open) info(`第 ${v.open.id} 棒进行中：${v.open.who.label}`);
      const g = loadGoState(root);
      if (g?.waitingUntil) info(`在等额度：${untilText(g.waitingUntil)}`);
    });
}
