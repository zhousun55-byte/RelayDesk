import { Command } from 'commander';
import { RelayError } from '../core/errors';
import { requireRepoRoot } from '../core/git';
import { canTalk, loadRegistry } from '../core/registry';
import { archiveTalk, readTalk, say, type TalkContext } from '../core/talk';
import { loadProjectView } from '../ops/view';
import { c, localTime, ok } from './print';

export function talkContext(root: string): () => TalkContext {
  return () => {
    const v = loadProjectView(root);
    return { task: v.task ? { title: v.task.title, phaseText: v.task.phaseText, changes: v.task.changes.map((f) => f.path) } : null };
  };
}

export function talkCommand(): Command {
  return new Command('talk')
    .description('讨论：问一句，请几个 AI 依次回答（不改文件）。不带话就显示最近的记录')
    .argument('[话...]', '要说的话')
    .option('--ask <工人>', '请谁回答，逗号分隔（默认：所有能讨论的工人）')
    .option('--clear', '清空讨论（旧记录改名存档）')
    .action(async (words: string[], opts: { ask?: string; clear?: boolean }) => {
      const root = requireRepoRoot(process.cwd());
      if (opts.clear) {
        const to = archiveTalk(root);
        ok(to ? `讨论已清空，旧记录存档在 ${to}` : '本来就没有讨论记录。');
        return;
      }
      const text = words.join(' ').trim();
      if (!text) {
        const rows = readTalk(root, 20);
        if (rows.length === 0) console.log('还没有讨论。relay talk "你的问题" --ask claude,deepseek');
        for (const r of rows) console.log(`${c.dim(localTime(r.ts))} ${c.bold(r.who)}：${r.text}\n`);
        return;
      }
      const ask = opts.ask
        ? opts.ask.split(/[,，\s]+/).filter(Boolean)
        : loadRegistry().agents.filter(canTalk).map((a) => a.name);
      if (ask.length === 0) throw new RelayError('没有能参加讨论的工人。在设置里给工人填「讨论命令」，或添加一个 API 模型。', 'no-speaker');
      const before = readTalk(root, 100000).length;
      const r = say(root, text, ask, talkContext(root));
      console.log(c.dim(`请 ${r.queued.join('、')} 依次回答，稍等……`));
      await r.done;
      for (const row of readTalk(root, 100000).slice(before + 1)) {
        console.log(`\n${c.bold(row.who)}：${row.text}`);
      }
    });
}
