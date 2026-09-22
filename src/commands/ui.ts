import { Command } from 'commander';
import { defaultUiRoot, listenUi, openInBrowser, rememberRoot } from '../ui/server';
import { resolveProjectRoot } from '../core/board';

export function uiCommand(): Command {
  const cmd = new Command('ui');
  cmd.description('打开接力台网页：用按钮开始、交接、合回，不用记命令');
  cmd.argument('[folder]', '项目文件夹（默认当前目录或上次打开的）');
  cmd.option('-p, --port <n>', '端口', '7388');
  cmd.option('--no-open', '只启动、不自动打开浏览器');
  cmd.action(async (folder: string | undefined, opts: { port: string; open: boolean }) => {
    const root = resolveProjectRoot(defaultUiRoot(folder));
    rememberRoot(root);
    const { url } = await listenUi(Number(opts.port) || 7388);
    const page = `${url}?root=${encodeURIComponent(root)}`;
    console.log(`接力台：${page}`);
    console.log('关掉这个终端窗口，网页也会停。');
    if (opts.open !== false) openInBrowser(page);
  });
  return cmd;
}
