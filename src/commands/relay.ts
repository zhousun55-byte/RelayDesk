import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { augmentPath } from '../core/env';
import { RelayError } from '../core/errors';
import { loadLedger, requireInit } from '../core/ledger';
import { BRIEF_REL } from '../core/notes';
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
    .action((words: string[], opts: { step?: string[] }) => {
      const root = requireRoot();
      const text = words.join(' ').trim();
      if (!text) {
        console.log(fs.readFileSync(path.join(root, '.relay', '任务.md'), 'utf8'));
        return;
      }
      newTask(root, text, opts.step ?? []);
      ok('写好了：.relay/任务.md');
    });
}

function printGo(s: GoState): void {
  const word: Record<GoState['status'], string> = { running: '进行中', waiting: '在等额度', done: '完成', stopped: '已停止', 'needs-human': '需要你看一下', failed: '没做成' };
  console.log(`${s.status === 'done' ? c.green('✓') : s.status === 'failed' ? c.red('✗') : c.yellow('•')} ${word[s.status]}：${s.result ?? s.phase}`);
}

async function runAndWait(root: string, opts: Parameters<typeof startGo>[1]): Promise<void> {
  augmentPath();
  let lastPhase = '';
  const { done } = startGo(root, opts, {
    onUpdate: (s) => {
      if (s.phase !== lastPhase) {
        lastPhase = s.phase;
        info(c.dim(s.phase));
      }
    },
  });
  const onSig = () => {
    warn('收到 Ctrl-C：正在停下（正在干活的工具会被结束，改到一半的东西都留在文件夹里）……');
    stopAllGo();
  };
  process.once('SIGINT', onSig);
  const s = await done;
  process.off('SIGINT', onSig);
  printGo(s);
  if (s.status === 'failed') process.exitCode = 1;
}

export function goCommand(): Command {
  return new Command('go')
    .description('让一个 AI 接着做一棒（接力台替你调度）。不指定人就按顺序挑第一个有额度的')
    .argument('[谁]', '成员名，如 codex、claude、deepseek')
    .option('--full', '完全放开（工具不再拦任何操作；默认是安全档）')
    .action(async (who: string | undefined, opts: { full?: boolean }) => {
      const root = requireRoot();
      await runAndWait(root, { mode: 'once', ...(who ? { who } : {}), ...(opts.full ? { settings: { level: 'full' } } : {}) });
    });
}

export function reviewCommand(): Command {
  return new Command('review')
    .description('请强模型复核所有待复核的棒（不指定人就挑第一个有额度的强模型）')
    .argument('[谁]', '成员名')
    .action(async (who: string | undefined) => {
      const root = requireRoot();
      await runAndWait(root, { mode: 'once', kind: 'review', ...(who ? { who } : {}) });
    });
}

export function autoCommand(): Command {
  return new Command('auto')
    .description('全自动：一直接力到任务清单全部打勾。额度用完换人，弱模型的活先请强模型复核，最后强模型终审')
    .argument('[要做什么...]', '顺手写下新任务（不写就接着做当前任务）')
    .option('--full', '完全放开（工具不再拦任何操作；默认是安全档）')
    .option('--max <棒数>', '最多接力几棒')
    .option('--no-wait', '都没额度了就停下，不等')
    .action(async (words: string[], opts: { full?: boolean; max?: string; wait: boolean }) => {
      const root = requireRoot();
      const text = words.join(' ').trim();
      if (text) newTask(root, text);
      await runAndWait(root, {
        mode: 'auto',
        settings: { ...(opts.full ? { level: 'full' } : {}), ...(opts.max ? { maxStints: Number(opts.max) } : {}), ...(opts.wait === false ? { waitForQuota: false } : {}) },
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
