#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { agentsCommand } from './commands/agents';
import { startCommand } from './commands/start';
import { runCommand } from './commands/run';
import { openCommand } from './commands/open';
import { handoffCommand } from './commands/handoff';
import { statusCommand } from './commands/status';
import { mergeCommand } from './commands/merge';
import { rollbackCommand } from './commands/rollback';
import { abandonCommand } from './commands/abandon';
import { auditCommand } from './commands/audit';
import { gateCommand } from './commands/gate';
import { doctorCommand } from './commands/doctor';
import { uiCommand } from './commands/ui';

const program = new Command();

program
  .name('relay')
  .description('换人干活的命令：start → run/open → handoff → merge')
  .version('0.2.0');

program.addCommand(initCommand());
program.addCommand(agentsCommand());
program.addCommand(startCommand());
program.addCommand(runCommand()); // resume 是 run 的别名
program.addCommand(openCommand()); // App 客人通道（kind=app）
program.addCommand(handoffCommand());
program.addCommand(statusCommand());
program.addCommand(mergeCommand());
program.addCommand(rollbackCommand());
program.addCommand(abandonCommand());
program.addCommand(auditCommand());
program.addCommand(gateCommand());
program.addCommand(doctorCommand());
program.addCommand(uiCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`relay: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
