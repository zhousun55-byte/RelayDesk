import { Command } from 'commander';
import { loadAutoSettings } from '../core/auto-settings';
import { detectAll, enableProvider, listMembers, loadDetected, resolveTeam, syncRegistry, type DetectReport } from '../core/detect';
import { augmentPath } from '../core/env';
import { RelayError } from '../core/errors';
import { inspectProject } from '../core/project';
import { autoLogTail, loadAutoState, startAuto, stopAllAuto, stopAuto, type AutoState, type AutoStep } from '../ops/auto';
import { c, info, localTime, ok, warn } from './print';

function mark(state: 'ok' | 'no' | 'unknown'): string {
  return state === 'ok' ? c.green('✓') : state === 'no' ? c.red('✗') : c.yellow('?');
}

export function printReport(r: DetectReport): void {
  console.log(c.bold('编程工具（harness，能自己改文件）'));
  if (!r.harnesses.length) info('一个都没找到。装好 Claude Code / Codex / Cursor Agent 等之一并登录，再识别一次。');
  for (const h of r.harnesses) {
    const model = h.model.label ?? h.model.model;
    const bits = [`${h.label} ${h.version}`];
    bits.push(model ? `模型 ${model}${h.model.via ? `（经 ${h.model.via}）` : ''}` : '模型：工具默认');
    if (h.model.effort) bits.push(`思考 ${h.model.effort}${h.model.efforts?.length ? `（可选 ${h.model.efforts.join('/')}）` : ''}`);
    bits.push(h.login.detail);
    if (h.tested !== 'yes') bits.push(h.tested === 'partial' ? '部分实测' : '没实测');
    if (!h.workLevels.includes('safe')) bits.push('只能在「完全放开」档干活');
    console.log(`  ${mark(h.login.state)} ${bits.join(' · ')}`);
    if (h.note) info(c.dim(`    ${h.note}`));
    if (h.login.state === 'no') info(c.dim(`    ${h.loginHint}`));
  }
  console.log(c.bold('模型接口（LLM）'));
  if (!r.providers.length) info('没找到配置好的密钥。');
  for (const p of r.providers) {
    const bits = [p.label, p.model ? `模型 ${p.model}` : '', p.detail].filter(Boolean);
    console.log(`  ${mark(p.state)} ${bits.join(' · ')}`);
    if (p.needsConsent) info(c.dim(`    同意使用：relay detect --use ${p.id}`));
  }
  if (r.unknownKeys.length) warn(`还有不认识的密钥：${r.unknownKeys.join('、')}（不知道接口地址，没用上；可以在设置里手动加成「接口」工人）`);
  if (r.apps.length) {
    console.log(c.bold('桌面 App（只能手动用）'));
    for (const a of r.apps) info(`${a.name}：${a.hint}`);
  }
}

export function printTeam(): void {
  const s = loadAutoSettings();
  const members = listMembers(s.level, loadDetected());
  const team = resolveTeam(members, s);
  const fmt = (l: typeof team.workers) => l.map((m) => `${m.label}${m.model ? `（${m.model}）` : ''}`).join(' → ') || '（没有）';
  console.log(c.bold(`全自动团队（${s.level === 'full' ? '完全放开' : '安全档'}，最多 ${s.maxRounds} 轮，${s.autoMerge ? '通过后自动合回' : '通过后等你合回'}）`));
  info(`干活：${fmt(team.workers)}`);
  info(`审查：${fmt(team.reviewers)}`);
  for (const p of team.problems) warn(p);
  const idle = members.filter((m) => !m.canWork && !m.canReview);
  for (const m of idle) info(c.dim(`${m.label}：${m.why ?? '不能用'}`));
}

export function detectCommand(): Command {
  return new Command('detect')
    .description('自动识别这台电脑上的 AI 编程工具和模型接口，并更新工人名单')
    .option('--offline', '不连网（不检查接口密钥能不能用）')
    .option('--use <编号>', '同意使用一个需要别的工具密钥的接口（如 mimocode:xiaomi-token-plan-cn）')
    .option('--json', '输出 JSON')
    .action(async (opts: { offline?: boolean; use?: string; json?: boolean }) => {
      augmentPath();
      const report = await detectAll({ network: !opts.offline });
      const changes = syncRegistry(report);
      if (opts.use) {
        const a = enableProvider(report, opts.use);
        changes.push(`启用了 ${a.label ?? a.name}（${a.api?.model}）。`);
      }
      if (opts.json) {
        console.log(JSON.stringify({ report, changes }, null, 2));
        return;
      }
      printReport(report);
      console.log('');
      if (changes.length) for (const ch of changes) ok(ch);
      else info('工人名单不用改。');
      console.log('');
      printTeam();
    });
}

const STATUS_WORDS: Record<AutoState['status'], string> = {
  running: '进行中',
  done: '完成',
  ready: '审查通过，等你合回',
  'needs-human': '需要你来看一下',
  failed: '没做成',
  stopped: '已停止',
};

function stepLine(st: AutoStep): string {
  const icon = st.status === 'ok' ? c.green('✓') : st.status === 'fail' ? c.red('✗') : st.status === 'skip' ? c.yellow('–') : c.yellow('…');
  return `${icon} ${st.label}${st.detail ? c.dim(`：${st.detail}`) : ''}`;
}

export function autoCommand(): Command {
  return new Command('auto')
    .description('全自动：开始任务 → AI 干活 → 另一个 AI 审查 → 要改就再来一轮 → 通过后合回。不写目标 = 接着跑当前任务')
    .argument('[要做什么...]', '一句话说清楚要做什么（有进行中的任务时不用写）')
    .option('-a, --acceptance <标准>', '验收标准（怎样算做完）')
    .option('--work <名字>', '干活的人，逗号分隔、按优先级（默认按设置 / 自动排）')
    .option('--review <名字>', '审查的人，逗号分隔（默认按设置 / 自动排）')
    .option('--rounds <n>', '最多改几轮')
    .option('--no-merge', '审查通过后不自动合回，等我确认')
    .option('--full', '完全放开（工具不再拦任何操作；默认是安全档）')
    .option('--timeout <分钟>', '干活一段最长多少分钟')
    .option('--status', '看看全自动现在怎么样了')
    .option('--stop', '叫停正在跑的全自动')
    .option('--team', '看看全自动会派谁')
    .action(async (words: string[], opts: { acceptance?: string; work?: string; review?: string; rounds?: string; merge: boolean; full?: boolean; timeout?: string; status?: boolean; stop?: boolean; team?: boolean }) => {
      augmentPath();
      const dir = process.cwd();
      const root = inspectProject(dir).root;
      if (opts.team) {
        printTeam();
        return;
      }
      if (opts.stop) {
        if (stopAuto(root)) ok('已经发出停止请求，正在干活的工具会被结束。');
        else info('现在没有在跑的全自动。');
        return;
      }
      if (opts.status) {
        const s = loadAutoState(root);
        if (!s) {
          info('这个项目还没跑过全自动。');
          return;
        }
        console.log(`${c.bold('全自动')}：${s.goal}（${STATUS_WORDS[s.status]}${s.interrupted ? '，被中断' : ''}）`);
        info(`开始于 ${localTime(s.startedAt)}，第 ${s.round} 轮 / 最多 ${s.maxRounds} 轮`);
        info(s.phase);
        for (const st of s.steps) info(stepLine(st));
        const tail = autoLogTail(s, 20);
        if (tail) {
          console.log('');
          console.log(c.dim(`— ${tail.label} 的日志（最后 20 行）—`));
          console.log(c.dim(tail.text));
        }
        return;
      }
      if (!loadDetected()) {
        info('第一次用全自动：先识别一下这台电脑上的 AI 工具……');
        syncRegistry(await detectAll({ network: true }));
      }
      const split = (v?: string) => (v ? v.split(/[,，\s]+/).filter(Boolean) : undefined);
      const rounds = opts.rounds !== undefined ? Number(opts.rounds) : undefined;
      if (rounds !== undefined && !Number.isInteger(rounds)) throw new RelayError('--rounds 要是整数。', 'bad-arg');
      const timeout = opts.timeout !== undefined ? Number(opts.timeout) : undefined;
      const printed = new Map<number, string>();
      const fmt = (l: AutoState['team']['workers']) => l.map((m) => `${m.label}${m.model ? `（${m.model}）` : ''}`).join(' → ');
      let headed = false;
      const show = (s: AutoState) => {
        if (!headed) {
          headed = true;
          ok(`全自动开始：${s.goal}`);
          info(`干活：${fmt(s.team.workers)}；审查：${fmt(s.team.reviewers)}；最多 ${s.maxRounds} 轮`);
          info(c.dim('按一次 Ctrl-C 停下（会等正在干活的工具收尾）；接力台网页里也能看进度。'));
        }
        for (const st of s.steps) {
          const line = stepLine(st);
          if (printed.get(st.n) === line) continue;
          const first = !printed.has(st.n);
          printed.set(st.n, line);
          if (first || st.status !== 'running') console.log(line);
        }
      };
      const { done } = startAuto(
        dir,
        {
          goal: words.join(' '),
          acceptance: opts.acceptance,
          workers: split(opts.work),
          reviewers: split(opts.review),
          ...(rounds !== undefined ? { maxRounds: rounds } : {}),
          ...(opts.merge === false ? { autoMerge: false } : {}),
          ...(opts.full ? { level: 'full' as const } : {}),
          ...(timeout !== undefined ? { workTimeoutMin: timeout } : {}),
        },
        { onUpdate: show, onLine: (l) => console.log(c.dim(`    │ ${l}`)) }
      );
      let interrupts = 0;
      const onSig = () => {
        interrupts++;
        if (interrupts === 1) {
          warn('正在停止……（再按一次立刻退出）');
          stopAuto(root);
        } else {
          stopAllAuto();
          setTimeout(() => process.exit(130), 300);
        }
      };
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);
      const end = await done;
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      console.log('');
      if (end.status === 'done' || end.status === 'ready') ok(end.result ?? STATUS_WORDS[end.status]);
      else warn(`${STATUS_WORDS[end.status]}：${end.result ?? ''}`);
      if (end.status !== 'done' && end.status !== 'ready') process.exitCode = 1;
    });
}
