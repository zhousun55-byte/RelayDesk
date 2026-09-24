import { Command } from 'commander';
import { RelayError } from '../core/errors';
import { loadLedger } from '../core/ledger';
import { readTask, taskProgress } from '../core/notes';
import { canTalk, loadRegistry } from '../core/registry';
import { archiveTalk, readTalk, say, type TalkContext } from '../core/talk';
import { startVote } from '../core/vote';
import { c } from './print';
import { findRoot } from './relay';

/** 群聊时给 AI 的项目背景：当前任务和进度。 */
export function talkContext(root: string): () => TalkContext {
  return () => {
    const t = readTask(root);
    if (t.empty) return { task: null };
    const p = taskProgress(t);
    const v = loadLedger(root);
    const last = [...v.stints].reverse().find((s) => s.status !== 'working');
    const phase = `进度 ${p.done}/${p.total}${last ? `；最近一棒：第 ${last.id} 棒 ${last.who.label}${last.summary ? `（${last.summary}）` : ''}` : ''}`;
    return { task: { title: t.title, phaseText: phase, changes: [] } };
  };
}

function speakers(opt?: string): string[] {
  const ask = opt ? opt.split(/[,，\s]+/).filter(Boolean) : loadRegistry().agents.filter(canTalk).map((a) => a.name);
  if (ask.length === 0) throw new RelayError('没有能参加群聊的 AI。先 relay detect 识别一下，或在设置里添加。', 'no-speaker');
  return ask;
}

export function talkCommand(): Command {
  return new Command('talk')
    .description('群聊：问一句，请几个 AI 回答（只说话、不改文件）。不带话就显示最近的记录')
    .argument('[话...]', '要说的话')
    .option('--ask <名字>', '请谁回答，逗号分隔（默认：所有能参加群聊的）')
    .option('--solo', '各自先想：同时问，互相看不到别人的回答')
    .option('--clear', '清空群聊（旧记录改名存档）')
    .action(async (words: string[], opts: { ask?: string; solo?: boolean; clear?: boolean }) => {
      const root = findRoot();
      if (opts.clear) {
        const to = archiveTalk(root);
        console.log(to ? `群聊已清空，旧记录存档在 ${to}` : '本来就没有群聊记录。');
        return;
      }
      const text = words.join(' ').trim();
      if (!text) {
        const rows = readTalk(root, 20);
        if (rows.length === 0) console.log('还没有群聊。relay talk "你的问题" --ask claude,deepseek');
        for (const r of rows) console.log(`${c.bold(r.who)}：${r.text}\n`);
        return;
      }
      const before = readTalk(root, 100000).length;
      const r = say(root, text, speakers(opts.ask), talkContext(root), opts.solo ? 'solo' : 'turn');
      console.log(c.dim(`请 ${r.queued.join('、')} ${opts.solo ? '各自先想' : '依次回答'}，稍等……`));
      await r.done;
      for (const row of readTalk(root, 100000).slice(before + 1)) console.log(`\n${c.bold(row.who)}：${row.text}`);
    });
}

export function voteCommand(): Command {
  return new Command('vote')
    .description('投票：几个 AI 各出方案（或你列选项），匿名投票，一个 AI 一票不分强弱')
    .argument('<问题...>', '要大家拿主意的问题')
    .option('--ask <名字>', '谁来投票，逗号分隔（默认：所有能参加群聊的）')
    .option('--option <options...>', '你自己列的选项（不写就请 AI 各自出方案）')
    .action(async (words: string[], opts: { ask?: string; option?: string[] }) => {
      const root = findRoot();
      const { done } = startVote(root, { question: words.join(' '), voters: speakers(opts.ask), options: opts.option, context: talkContext(root) });
      console.log(c.dim(opts.option?.length ? '大家在投票，稍等……' : '大家在各自出方案、然后投票，稍等……'));
      const v = await done;
      if (v.error) console.log(c.red(v.error));
      for (const o of v.options) {
        const n = v.counts?.[o.key] ?? 0;
        console.log(`\n${c.bold(`方案 ${o.key}`)}（${n} 票${v.leaders?.includes(o.key) ? '，最多' : ''}）· ${o.authorLabel} 出的\n${o.text}`);
      }
      console.log('');
      for (const b of v.ballots) console.log(`${b.voterLabel}：${b.choice ? `投 ${b.choice}` : `弃权（${b.void ?? ''}）`}${b.reason ? ` —— ${b.reason}` : ''}`);
      if (v.leaders && v.leaders.length > 1) console.log(c.yellow(`\n平票：${v.leaders.join('、')}。在网页里由你来定。`));
    });
}
