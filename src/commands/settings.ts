import { Command } from 'commander';
import { defaultAutoSettings, loadAutoSettings, saveAutoSettings, type AutoSettings } from '../core/auto-settings';
import { loadRelayConfig, saveRelayConfig } from '../core/config';
import { requireInit } from '../core/ledger';
import { refreshBrief } from '../ops/track';
import { info, ok } from './print';
import { findRoot } from './relay';

/** 运行设置（~/.relay/auto.json，网页「设置 → 运行」）：不带选项就显示。 */
export function settingsCommand(): Command {
  return new Command('settings')
    .description('运行设置（全机通用，和网页「设置 → 运行」是同一份）。不带选项就显示现在的')
    .option('--level <档位>', 'safe（只在项目里）| full（不限制）')
    .option('--order <名字>', '派活顺序，逗号分隔的成员名')
    .option('--max <棒数>', '全自动最多接力几棒')
    .option('--stint-min <分钟>', '每一棒最长多少分钟')
    .option('--review-min <分钟>', '复核、终审一棒最长多少分钟')
    .option('--wait', '都没额度时等最早恢复的那一位')
    .option('--no-wait', '都没额度时停下')
    .option('--final', '清单全部打勾后请强模型终审')
    .option('--no-final', '不终审')
    .option('--lead <名字>', '派活谁来指挥（拆步骤、终审）：成员名；写 - 是不指定（强模型按顺序）')
    .option('--parallel <步数>', '派活时标了「可以同时做」的几步最多几步同时做（1 = 一步一步做）')
    .option('--side-review', '边做边复核：派活时指挥的同时只看不改地复核做完的几步')
    .option('--no-side-review', '不边做边复核')
    .option('--escalate', '卡住的那一步交给指挥')
    .option('--no-escalate', '卡住了就停在这一步')
    .option('--same-thread', '接着同一段对话：同一位成员下一棒顺着它上一棒在工具里的那段话说')
    .option('--no-same-thread', '每棒另起一段对话（token 用得少）')
    .option('--show-sessions', '接力页左边列出这个文件夹里在各家工具里开过的对话')
    .option('--no-show-sessions', '不列')
    .option('--lang <语言>', 'zh | en：en 时请 AI 用英文写交接、复核和回答（网页上换语言会自动改）')
    .option('--reset', '恢复默认设置（原来的文件读不出来时，先留一份 auto.json.broken）')
    .action((o: { level?: string; order?: string; max?: string; stintMin?: string; reviewMin?: string; wait?: boolean; final?: boolean; lang?: string; lead?: string; parallel?: string; sideReview?: boolean; escalate?: boolean; sameThread?: boolean; showSessions?: boolean; reset?: boolean }) => {
      const patch: Partial<Record<keyof AutoSettings, unknown>> = {};
      if (o.level !== undefined) patch.level = o.level;
      if (o.order !== undefined) patch.order = o.order;
      if (o.max !== undefined) patch.maxStints = o.max;
      if (o.stintMin !== undefined) patch.stintTimeoutMin = o.stintMin;
      if (o.reviewMin !== undefined) patch.reviewTimeoutMin = o.reviewMin;
      if (o.wait !== undefined) patch.waitForQuota = o.wait;
      if (o.final !== undefined) patch.finalReview = o.final;
      if (o.lang !== undefined) patch.lang = o.lang;
      if (o.lead !== undefined) patch.lead = o.lead === '-' ? '' : o.lead;
      if (o.parallel !== undefined) patch.parallel = o.parallel;
      // 网页「设置 → 运行」里的四个开关：命令行也能看、能改（以前只有网页能改）
      for (const k of ['sideReview', 'escalate', 'sameThread', 'showSessions'] as const) if (o[k] !== undefined) patch[k] = o[k];
      const changed = !!o.reset || Object.keys(patch).length > 0;
      const s = changed ? saveAutoSettings({ ...(o.reset ? defaultAutoSettings() : loadAutoSettings()), ...patch }) : loadAutoSettings();
      if (changed) ok('已保存');
      info(`权限：${s.level === 'full' ? '不限制' : '只在项目里'}`);
      info(`派活顺序：${s.order.length ? s.order.join('、') : '强的在前、编程工具在前'}`);
      info(`每一棒最长：${s.stintTimeoutMin} 分钟；复核、终审最长：${s.reviewTimeoutMin} 分钟；全自动最多接力：${s.maxStints} 棒`);
      info(`额度用完时等恢复：${s.waitForQuota ? '等' : '不等'}；做完后终审：${s.finalReview ? '终审' : '不终审'}`);
      info(`派活谁来指挥：${s.lead || '强模型按顺序'}；同时做几步：${s.parallel}`);
      info(`边做边复核：${s.sideReview ? '开' : '关'}；卡住的那一步交给指挥：${s.escalate ? '开' : '关'}`);
      info(`接着同一段对话：${s.sameThread ? '开' : '关'}；列出工具里的对话：${s.showSessions ? '开' : '关'}`);
      info(`AI 写字用的语言：${s.lang === 'en' ? '英文' : '中文'}`);
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
