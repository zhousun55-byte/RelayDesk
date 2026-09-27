#!/usr/bin/env node
import { Command } from 'commander';
import { detectCommand } from './commands/detect';
import { c } from './commands/print';
import { uiCommand } from './commands/ui';
import { errorMessage } from './core/errors';
import { VERSION } from './core/version';

/**
 * 网页版的入口：打开网页（桌面小程序、npm start 都走这里），外加网页在后台识别 AI 工具时用的 detect。
 * 在终端里用的命令和界面在终端版（另一个下载），两个版本读写同一份记录。
 */
const program = new Command();
program
  .name('relay')
  .description('接力台（网页版）：额度用完换谁接着做都不怕。在同一个文件夹里轮流用各家 AI，接力台记账、提醒复核、能退回；也能替你调度、全自动接力。')
  .version(VERSION, '-v, --version', '显示版本')
  .helpOption('-h, --help', '显示帮助')
  .addHelpCommand('help [命令]', '显示某个命令的帮助')
  .showHelpAfterError('（relay --help 查看全部命令）');

program.addCommand(uiCommand(), { isDefault: true });
program.addCommand(detectCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`${c.red('✗')} ${errorMessage(err)}`);
  process.exitCode = 1;
});
