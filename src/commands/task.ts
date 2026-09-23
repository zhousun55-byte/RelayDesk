import { Command } from 'commander';
import { RelayError } from '../core/errors';
import { gateConfigured, gateText, runGate } from '../core/gate';
import { shortSha } from '../core/git';
import { setupProject } from '../core/project';
import { agentKind, agentLabel, requireAgent } from '../core/registry';
import { abandon } from '../ops/abandon';
import { openTask } from '../ops/context';
import { handoff } from '../ops/handoff';
import { merge } from '../ops/merge';
import { listCheckpoints, rollback } from '../ops/rollback';
import { startTask } from '../ops/start';
import { abortSync, syncMain } from '../ops/sync';
import { takeStray } from '../ops/take';
import { loadProjectView } from '../ops/view';
import { openApp, runCli } from '../ops/work';
import { c, info, localTime, notes, ok, warn } from './print';

export function initCommand(): Command {
  return new Command('init')
    .description('把当前文件夹设为接力项目（没有 git 会先建一个）')
    .action(() => {
      const r = setupProject(process.cwd());
      if (r.actions.length === 0) ok(`${r.root} 已经是接力项目了。`);
      else for (const a of r.actions) ok(a);
      info(`项目：${r.root}`);
      info('接下来：relay start "要做什么"，或者 relay ui 打开接力台。');
    });
}

export function startCommand(): Command {
  return new Command('start')
    .description('开始一个任务：建一个隔离副本，之后所有改动都在那里，正式文件夹不动')
    .argument('<要做什么...>', '一句话说清楚要做什么')
    .option('-a, --acceptance <标准>', '验收标准（怎样算做完）')
    .action((words: string[], opts: { acceptance?: string }) => {
      const r = startTask(process.cwd(), { task: words.join(' '), acceptance: opts.acceptance });
      notes(r.notes);
      ok(`任务开始：${r.title}`);
      info(`隔离副本：${r.worktree}`);
      info(`接力分支：${r.branch}（从 ${r.base} 开始）`);
      info('下一步：relay run <工人名>（relay workers list 看有哪些工人）');
    });
}

export function runCommand(): Command {
  return new Command('run')
    .alias('open')
    .alias('resume')
    .description('让一个工人上岗：终端工人在这里运行直到退出；桌面工人会打开它的窗口')
    .argument('<工人>', '工人名（relay workers list 查看）')
    .option('--model <模型>', '这一段用的模型（记进交接记录）')
    .option('--llm <模型>', '同 --model（旧写法）')
    .option('-f, --force', '强行接替：上一位没交接也上岗（会记下来）')
    .action(async (name: string, opts: { model?: string; llm?: string; force?: boolean }) => {
      const agent = requireAgent(name);
      const model = opts.model ?? opts.llm;
      const kind = agentKind(agent);
      if (kind === 'api') throw new RelayError(`「${agentLabel(agent)}」是模型接口，不能手动上岗；它能在全自动里干活（relay auto），也能审查、讨论（relay talk）。`, 'api-agent');
      if (kind === 'app') {
        const r = await openApp(process.cwd(), name, { model, force: opts.force });
        notes(r.notes);
        ok(r.reopened ? `又打开了一次 ${r.label}（还是同一段，不算换人）。` : `${r.label} 上岗了，已用它打开隔离副本。`);
        info(`隔离副本：${r.worktree}`);
        info(r.copied ? '上岗的那句话已复制到剪贴板，粘贴给它的 AI 对话框即可：' : '把这句话发给它的 AI 对话框：');
        info(c.bold(r.hint));
        info('它停手后，回到项目里执行 relay handoff（或在接力台点「交接」）。');
        return;
      }
      const code = await runCli(process.cwd(), name, { model, force: opts.force });
      console.log('');
      if (code === 0) ok(`${agentLabel(agent)} 退出了。接着执行 relay handoff 交接。`);
      else warn(`${agentLabel(agent)} 退出了（代码 ${code}）。有改动的话照样 relay handoff 交接。`);
    });
}

export function handoffCommand(): Command {
  return new Command('handoff')
    .description('交接：把改动存成检查点，审计、跑检查、写交接文档；当前工人下岗')
    .option('-m, --message <留言>', '留给下一位的话')
    .action(async (opts: { message?: string }) => {
      const r = await handoff(process.cwd(), { note: opts.message });
      ok(`${r.label} 交接完成。`);
      info(r.empty ? '这一段没有改动。' : `改动：${r.files} 个文件，+${r.added} −${r.removed}`);
      info(`检查点：${shortSha(r.checkpoint)}（可以退回到这里）`);
      if (r.gate) info(`检查：${!gateConfigured(r.gate) ? gateText(r.gate) : r.gate.status === 'pass' ? c.green(gateText(r.gate)) : c.red(gateText(r.gate))}`);
      info(`审计：${r.audit.path}${r.audit.status === 'ok' ? '（有模型阅读面）' : r.audit.note ? `（只有事实：${r.audit.note}）` : ''}`);
      notes(r.notes);
      info('下一步：relay run <下一位> 接着干，或 relay merge 合回正式文件夹。');
    });
}

export function statusCommand(): Command {
  return new Command('status')
    .description('看看现在怎么样了')
    .action(() => {
      const v = loadProjectView(process.cwd());
      if (!v.isGit || !v.hasConfig) {
        console.log(`${v.root} 还不是接力项目。relay init 设一下，或者直接 relay start "要做什么"。`);
        return;
      }
      if (v.configError) warn(v.configError);
      const t = v.task;
      if (!t) {
        if (v.taskError) warn(v.taskError);
        console.log('现在没有进行中的任务。relay start "要做什么" 开始一个。');
        if (v.past.length) {
          console.log('');
          console.log('以前的任务：');
          for (const p of v.past.slice(0, 5)) {
            const word = p.result === 'merged' ? '已合回' : p.result === 'abandoned' ? '已放弃' : '没做完';
            info(`${localTime(p.date)}  ${word}  ${p.title}`);
          }
        }
        return;
      }
      console.log(`${c.bold('任务')}：${t.title}`);
      console.log(`${c.bold('状态')}：${t.phaseText}`);
      if (t.worktreeExists) info(`隔离副本：${t.worktree}`);
      info(`接力分支：${t.branch}`);
      if (t.changes.length) {
        console.log('');
        console.log(`相对正式文件夹的改动（${t.totals.files} 个文件，+${t.totals.added} −${t.totals.removed}）：`);
        for (const f of t.changes.slice(0, 20)) info(`${f.status}  ${f.path}`);
        if (t.changes.length > 20) info(`…还有 ${t.changes.length - 20} 个`);
      }
      if (t.pending.length) warn(`还没交接：${t.pending.slice(0, 10).join('、')}${t.pending.length > 10 ? ' …' : ''}`);
      if (t.stray.length) warn(`正式文件夹在任务期间被改了：${t.stray.map((s) => s.path).join('、')}（relay take 可以收进任务）`);
      if (t.mainAhead) warn(`正式文件夹有 ${t.mainAhead} 个新提交（relay sync 可以同步进任务）`);
      if (t.gate) info(`上次检查：${gateText(t.gate)}`);
      if (t.timeline.length) {
        console.log('');
        console.log('经过：');
        for (const it of t.timeline.slice(-12)) info(`${localTime(it.ts)}  ${it.text}`);
      }
    });
}

export function mergeCommand(): Command {
  return new Command('merge')
    .description('合回：把任务的改动压成一个提交放进正式文件夹，隔离副本删除，接力分支保留')
    .option('-f, --force', '跳过拦截（检查没过、改了保护文件、还有没交接的改动）')
    .option('--keep-audits', '把审计报告也留进正式文件夹')
    .action((opts: { force?: boolean; keepAudits?: boolean }) => {
      const r = merge(process.cwd(), opts);
      notes(r.notes);
      ok(r.commit ? `合回完成：正式文件夹新提交 ${shortSha(r.commit)}（${r.files.length} 个文件）` : '任务已收尾（没有改动需要合回）。');
      info(`接力分支 ${r.branch} 保留备查（不需要了可以 git branch -D ${r.branch}）。`);
    });
}

export function abandonCommand(): Command {
  return new Command('abandon')
    .description('放弃任务：删掉隔离副本，正式文件夹不动，接力分支留底')
    .option('-f, --force', '桌面工人还没交接、或交接记录坏了时也放弃')
    .action((opts: { force?: boolean }) => {
      const r = abandon(process.cwd(), opts);
      notes(r.notes);
      ok('已放弃这个任务。');
      info(`接力分支 ${r.branch} 留底（彻底删除：git branch -D ${r.branch}）。`);
    });
}

export function rollbackCommand(): Command {
  return new Command('rollback')
    .description('退回到某个检查点（只动隔离副本；不改写历史，新记一笔）')
    .argument('[检查点]', '检查点编号（不填就列出可选的）')
    .action((sha: string | undefined) => {
      if (!sha) {
        const list = listCheckpoints(process.cwd());
        console.log('可以退回到：');
        for (const cp of list) info(`${shortSha(cp.sha)}  ${cp.ts ? localTime(cp.ts) : ''}  ${cp.label}${cp.agent.startsWith('(') ? '' : `（${agentLabel(cp.agent)}）`}`);
        info('用法：relay rollback <检查点>');
        return;
      }
      const r = rollback(process.cwd(), sha);
      ok(`已退回到 ${shortSha(r.to)}。没交接的改动已丢掉，正式文件夹没动。`);
    });
}

export function takeCommand(): Command {
  return new Command('take')
    .description('收进任务：任务期间正式文件夹里被改的文件（AI 开错了文件夹），挪进隔离副本')
    .argument('[文件...]', '只收这几个（默认全部）')
    .action((files: string[]) => {
      const r = takeStray(process.cwd(), files);
      if (r.taken.length) ok(`收进任务：${r.taken.join('、')}。正式文件夹已恢复原样。`);
      for (const s of r.skipped) warn(`${s.path}：${s.why}`);
      if (r.taken.length) info('记得交接（relay handoff），这些改动才算存下来。');
    });
}

export function syncCommand(): Command {
  return new Command('sync')
    .description('同步主线：把正式文件夹后来的提交合并进任务')
    .option('--abort', '撤销还没解决完的同步')
    .action((opts: { abort?: boolean }) => {
      if (opts.abort) {
        abortSync(process.cwd());
        ok('已撤销同步，隔离副本回到同步之前。');
        return;
      }
      const r = syncMain(process.cwd());
      if (r.status === 'up-to-date') ok('任务已经包含正式文件夹的全部提交，不用同步。');
      else if (r.status === 'merged') ok(`已同步到正式文件夹的 ${shortSha(r.main)}。`);
      else {
        warn(`有冲突：${r.conflicts.join('、')}。`);
        info('让一个工人上岗解决（上岗说明里写清楚了），解决后交接；或者 relay sync --abort 撤销。');
      }
    });
}

export function gateCommand(): Command {
  return new Command('gate')
    .description('现在就在隔离副本里跑一遍检查命令（不交接，不记账）')
    .action(async () => {
      const ctx = openTask(process.cwd());
      const r = await runGate(ctx.wt, ctx.cfg);
      if (!gateConfigured(r)) warn('这个项目没配置检查命令。在网页「设置」里填，或改 .relay/config.json 的 gate.command。');
      else if (r.status === 'pass') ok(`检查${gateText(r)}`);
      else warn(`检查${gateText(r)}`);
      if (r.detail) console.log(r.detail);
      if (r.status === 'fail') process.exitCode = 1;
    });
}
