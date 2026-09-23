#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { autoCommand, detectCommand } from './commands/auto';
import { doctorCommand } from './commands/doctor';
import { c } from './commands/print';
import { talkCommand } from './commands/talk';
import {
  abandonCommand,
  gateCommand,
  handoffCommand,
  initCommand,
  mergeCommand,
  rollbackCommand,
  runCommand,
  startCommand,
  statusCommand,
  syncCommand,
  takeCommand,
} from './commands/task';
import { uiCommand } from './commands/ui';
import { workersCommand } from './commands/workers';
import { errorMessage } from './core/errors';

function version(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '?';
  }
}

const program = new Command();
program
  .name('relay')
  .description('接力台：让几个 AI 轮流在同一件事上干活。全自动：relay auto "要做什么"（AI 干活 → 另一个 AI 审查 → 通过后合回）。')
  .version(version(), '-v, --version', '显示版本')
  .helpOption('-h, --help', '显示帮助')
  .addHelpCommand('help [命令]', '显示某个命令的帮助')
  .showHelpAfterError('（relay --help 查看全部命令）');

program.addCommand(uiCommand());
program.addCommand(autoCommand());
program.addCommand(detectCommand());
program.addCommand(initCommand());
program.addCommand(startCommand());
program.addCommand(runCommand());
program.addCommand(handoffCommand());
program.addCommand(statusCommand());
program.addCommand(mergeCommand());
program.addCommand(abandonCommand());
program.addCommand(rollbackCommand());
program.addCommand(takeCommand());
program.addCommand(syncCommand());
program.addCommand(gateCommand());
program.addCommand(talkCommand());
program.addCommand(workersCommand());
program.addCommand(doctorCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`${c.red('✗')} ${errorMessage(err)}`);
  process.exitCode = 1;
});
