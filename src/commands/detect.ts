import { Command } from 'commander';
import { loadAutoSettings } from '../core/auto-settings';
import { detectAll, enableProvider, syncRegistry, type DetectReport } from '../core/detect';
import { augmentPath } from '../core/env';
import { allMembers, orderMembers, type MemberInfo } from '../core/members';
import { untilText } from '../core/quota';
import { c, info, ok, warn } from './print';

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
  if (r.unknownKeys.length) warn(`还有不认识的密钥：${r.unknownKeys.join('、')}（不知道接口地址，没用上；可以在设置里手动加成「接口」成员）`);
  if (r.apps.length) {
    console.log(c.bold('桌面程序（你自己打开它接着做，接力台记账）'));
    for (const a of r.apps) info(`${a.name}：${a.hint}`);
  }
}

export function printTeam(): void {
  const s = loadAutoSettings();
  const list = orderMembers(allMembers(s.level), s.order);
  const fmt = (m: MemberInfo) => `${m.label}${m.model ? `（${m.model}）` : ''}`;
  console.log(c.bold(`成员（${s.level === 'full' ? '完全放开' : '安全档'}；派活按这个顺序，额度用完的跳过）`));
  for (const m of list) {
    const tag = m.tier === 'strong' ? c.green('强') : c.yellow('弱');
    const can = m.canWork ? (m.cooling ? c.yellow(`额度用完，${untilText(m.cooling)}`) : '接力台能调度') : c.dim(m.why ?? '不能调度');
    info(`${tag} ${fmt(m)} · ${can}`);
  }
}

export function detectCommand(): Command {
  return new Command('detect')
    .description('自动识别这台电脑上的 AI 编程工具和模型接口，并更新成员名单')
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
      else info('成员名单不用改');
      console.log('');
      printTeam();
    });
}
