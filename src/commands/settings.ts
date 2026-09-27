import { Command } from 'commander';
import { loadAutoSettings, saveAutoSettings, type AutoSettings } from '../core/auto-settings';
import { loadRelayConfig, saveRelayConfig } from '../core/config';
import { requireInit } from '../core/ledger';
import { refreshBrief } from '../ops/track';
import { info, ok } from './print';
import { findRoot } from './relay';

/** 调度设置（~/.relay/auto.json，网页「设置 → 调度」）：不带选项就显示。 */
export function settingsCommand(): Command {
  return new Command('settings')
    .description('调度设置（全机通用，和网页「设置 → 调度」是同一份）。不带选项就显示现在的')
    .option('--level <档位>', 'safe（安全）| full（完全放开）')
    .option('--order <名字>', '派活顺序，逗号分隔的成员名')
    .option('--max <棒数>', '全自动最多接力几棒')
    .option('--stint-min <分钟>', '干活一棒最长多少分钟')
    .option('--review-min <分钟>', '复核、终审一棒最长多少分钟')
    .option('--wait', '都没额度时等最早恢复的那一位')
    .option('--no-wait', '都没额度时停下')
    .option('--final', '清单全部打勾后请强模型终审')
    .option('--no-final', '不终审')
    .action((o: { level?: string; order?: string; max?: string; stintMin?: string; reviewMin?: string; wait?: boolean; final?: boolean }) => {
      const patch: Partial<Record<keyof AutoSettings, unknown>> = {};
      if (o.level !== undefined) patch.level = o.level;
      if (o.order !== undefined) patch.order = o.order;
      if (o.max !== undefined) patch.maxStints = o.max;
      if (o.stintMin !== undefined) patch.stintTimeoutMin = o.stintMin;
      if (o.reviewMin !== undefined) patch.reviewTimeoutMin = o.reviewMin;
      if (o.wait !== undefined) patch.waitForQuota = o.wait;
      if (o.final !== undefined) patch.finalReview = o.final;
      const changed = Object.keys(patch).length > 0;
      const s = changed ? saveAutoSettings({ ...loadAutoSettings(), ...patch }) : loadAutoSettings();
      if (changed) ok('已保存');
      info(`权限：${s.level === 'full' ? '完全放开' : '安全'}`);
      info(`派活顺序：${s.order.length ? s.order.join('、') : '强的在前、编程工具在前'}`);
      info(`一棒上限：${s.stintTimeoutMin} 分钟；复核上限：${s.reviewTimeoutMin} 分钟；全自动上限：${s.maxStints} 棒`);
      info(`等额度恢复：${s.waitForQuota ? '等' : '不等'}；做完后终审：${s.finalReview ? '终审' : '不终审'}`);
    });
}

/** 项目设置（.relay/config.json，网页「设置 → 项目」）：检查命令、不许改的文件。 */
export function configCommand(): Command {
  return new Command('config')
    .description('项目设置：检查命令、不许改的文件（和网页「设置 → 项目」是同一份）。不带选项就显示现在的')
    .option('--gate <命令>', '检查命令（每一棒之后跑，比如 npm test）')
    .option('--no-gate', '不跑检查')
    .option('--protect <路径>', '不许改的文件，逗号分隔（可以写通配，比如 a.txt,config/*.json）')
    .option('--no-protect', '没有不许改的文件')
    .action((o: { gate?: string | false; protect?: string | false }) => {
      const root = findRoot();
      requireInit(root);
      const cfg = loadRelayConfig(root);
      const changed = o.gate !== undefined || o.protect !== undefined;
      if (o.gate !== undefined) cfg.gate.command = o.gate || '';
      if (o.protect !== undefined) cfg.protectedPaths = o.protect ? o.protect.split(/[,，]/) : [];
      const now = changed ? saveRelayConfig(root, cfg) : cfg;
      if (changed) {
        refreshBrief(root);
        ok('已保存');
      }
      info(`检查命令：${now.gate.command || '没有'}`);
      info(`不许改的文件：${now.protectedPaths.length ? now.protectedPaths.join('、') : '没有'}`);
    });
}
