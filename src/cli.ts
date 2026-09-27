#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { detectCommand } from './commands/detect';
import { doctorCommand } from './commands/doctor';
import { c } from './commands/print';
import {
  autoCommand,
  briefCommand,
  diffCommand,
  goCommand,
  initCommand,
  logCommand,
  reviewCommand,
  rollbackCommand,
  snapCommand,
  statusCommand,
  stepCommand,
  stopCommand,
  taskCommand,
} from './commands/relay';
import { configCommand, settingsCommand } from './commands/settings';
import { chatCommand, talkCommand, voteCommand } from './commands/talk';
import { watchCommand } from './commands/watch';
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
  .description('接力台：额度用完换谁接着做都不怕。在同一个文件夹里轮流用各家 AI，接力台记账、提醒复核、能退回；也能替你调度、全自动接力。')
  .version(version(), '-v, --version', '显示版本')
  .helpOption('-h, --help', '显示帮助')
  .addHelpCommand('help [命令]', '显示某个命令的帮助')
  .showHelpAfterError('（relay --help 查看全部命令）');

program.addCommand(uiCommand(), { isDefault: true });
program.addCommand(initCommand());
program.addCommand(statusCommand());
program.addCommand(watchCommand());
program.addCommand(taskCommand());
program.addCommand(stepCommand());
program.addCommand(goCommand());
program.addCommand(autoCommand());
program.addCommand(reviewCommand());
program.addCommand(stopCommand());
program.addCommand(logCommand());
program.addCommand(diffCommand());
program.addCommand(rollbackCommand());
program.addCommand(snapCommand());
program.addCommand(briefCommand());
program.addCommand(talkCommand());
program.addCommand(voteCommand());
program.addCommand(chatCommand());
program.addCommand(detectCommand());
program.addCommand(workersCommand());
program.addCommand(settingsCommand());
program.addCommand(configCommand());
program.addCommand(doctorCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`${c.red('✗')} ${errorMessage(err)}`);
  process.exitCode = 1;
});
