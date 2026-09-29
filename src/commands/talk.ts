import readline from 'node:readline';
import { Command } from 'commander';
import { RelayError } from '../core/errors';
import { loadLedger, requireInit } from '../core/ledger';
import { readTask, taskProgress } from '../core/notes';
import { canTalk, findAgent, loadRegistry } from '../core/registry';
import { archiveTalk, checkSpeakers, readTalk, resumeTalk, say, speakerName, talkPath, talkSessions, type TalkContext, type TalkRow } from '../core/talk';
import { adoptOption, castHumanVote, readVotes, startVote, type Vote } from '../core/vote';
import { refreshBrief } from '../ops/track';
import { c, info, ok } from './print';
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

const nameOf = (n: string) => {
  const a = findAgent(n);
  return a ? speakerName(a) : n;
};

function rowText(r: TalkRow): string {
  if (r.kind === 'system' || r.error) return c.dim(r.text);
  return `${c.bold(r.kind === 'human' ? '我' : r.who)}：${r.text}`;
}

/** 一次投票：每个方案几票、谁出的（投完才揭晓），每一票的理由。 */
function voteText(v: Vote): string {
  const done = v.status === 'done';
  const out = [c.bold(`投票：${v.question}`) + c.dim(done ? '' : v.status === 'proposing' ? '（出方案中）' : '（投票中）')];
  if (v.error) out.push(c.red(v.error));
  for (const o of v.options) {
    const n = v.counts?.[o.key] ?? 0;
    const by = done && o.author !== 'human' ? ` · ${o.authorLabel} 出的` : o.author === 'human' ? ' · 我列的' : '';
    out.push(`${c.bold(`方案 ${o.key}`)}（${n} 票${done && v.leaders?.includes(o.key) ? '，最多' : ''}${v.adopted?.key === o.key ? '，已采纳' : ''}）${by}\n${o.text}`);
  }
  if (v.noOption?.length) out.push(c.dim(`没出方案：${v.noOption.map((x) => `${x.voterLabel}（${x.why}）`).join('、')}`));
  if (done) for (const b of v.ballots) out.push(c.dim(`${b.voterLabel}：${b.choice ? `投 ${b.choice}` : `弃权（${b.void ?? ''}）`}${b.reason ? ` · ${b.reason}` : ''}`));
  if (done && v.leaders && v.leaders.length > 1) out.push(`平票：${v.leaders.join('、')}`);
  return out.join('\n');
}

/** 正在用的那段群聊里最近一次投票。 */
function latestVote(root: string): Vote {
  const v = readVotes(talkPath(root)).at(-1);
  if (!v) throw new RelayError('这段群聊里还没有投票。', 'no-vote');
  return v;
}

/** 你投一票 / 采纳一个方案（最近一次投票）。 */
function castOrAdopt(root: string, what: 'cast' | 'adopt', key: string, reason?: string): Vote {
  const k = key.trim().toUpperCase();
  const v = latestVote(root);
  if (what === 'cast') return castHumanVote(root, v.id, k, reason);
  const next = adoptOption(root, v.id, k);
  if (loadLedger(root).init) refreshBrief(root);
  return next;
}

export function talkCommand(): Command {
  return new Command('talk')
    .description('群聊：问一句，请几个 AI 回答（只说话、不改文件）。不带话就显示最近的记录')
    .argument('[话...]', '要说的话')
    .option('--ask <名字>', '请谁回答，逗号分隔（默认：所有能参加群聊的）')
    .option('--solo', '对比：同时问，互相看不到别人的回答，回答并排放')
    .option('--clear', '新群聊（正在用的这段存档）')
    .option('--list', '列出存档的群聊')
    .option('--resume <序号>', '接着一段存档的群聊（--list 里的序号，或者它的名字）')
    .action(async (words: string[], opts: { ask?: string; solo?: boolean; clear?: boolean; list?: boolean; resume?: string }) => {
      const root = findRoot();
      if (opts.clear) {
        const to = archiveTalk(root);
        ok(to ? `已开始新群聊，原来那段存档为 ${to}` : '已开始新群聊');
        return;
      }
      if (opts.list || opts.resume) {
        const list = talkSessions(root);
        if (opts.resume) {
          const n = Number(opts.resume);
          const id = Number.isInteger(n) && n >= 1 ? list[n - 1]?.id : opts.resume;
          if (!id) throw new RelayError(`没有第 ${opts.resume} 段群聊。`, 'no-talk');
          resumeTalk(root, id);
          ok(`已接着「${list.find((x) => x.id === id)?.title ?? id}」`);
          return;
        }
        if (!list.length) info('还没有存档的群聊。');
        list.forEach((x, i) => info(`${String(i + 1).padStart(2)}. ${x.title} ${c.dim(`${x.at.slice(0, 16).replace('T', ' ')}${x.busy ? ' · 还在说' : ''}`)}`));
        return;
      }
      const text = words.join(' ').trim();
      if (!text) {
        const rows = readTalk(root, 20);
        if (rows.length === 0) info('还没有群聊。');
        for (const r of rows) console.log(`${rowText(r)}\n`);
        return;
      }
      const before = readTalk(root, 100000).length;
      const r = say(root, text, speakers(opts.ask), talkContext(root), opts.solo ? 'solo' : 'turn');
      console.log(c.dim(`请 ${r.queued.map(nameOf).join('、')} ${opts.solo ? '同时回答（对比）' : '依次回答'}……`));
      await r.done;
      for (const row of readTalk(root, 100000).slice(before + 1)) console.log(`\n${rowText(row)}`);
    });
}

export function voteCommand(): Command {
  return new Command('vote')
    .description('投票：几个 AI 各出方案（或你列选项），匿名投票，一个 AI 一票不分强弱。不带问题就显示最近一次')
    .argument('[问题...]', '要大家拿主意的问题')
    .option('--ask <名字>', '谁来投票，逗号分隔（默认：所有能参加群聊的）')
    .option('--option <options...>', '你列的选项（两个以上直接投；只列一个，AI 先各出一个方案，你的一起参加）')
    .option('--cast <方案>', '你也投一票（最近一次投票；再投就是改票）')
    .option('--reason <理由>', '和 --cast 一起用')
    .option('--adopt <方案>', '采纳最近一次投票里的这个方案：写进任务的「约定」')
    .action(async (words: string[], opts: { ask?: string; option?: string[]; cast?: string; reason?: string; adopt?: string }) => {
      const root = findRoot();
      if (opts.cast || opts.adopt) {
        const v = castOrAdopt(root, opts.cast ? 'cast' : 'adopt', (opts.cast ?? opts.adopt)!, opts.reason);
        ok(opts.cast ? `已投方案 ${opts.cast.toUpperCase()}` : `已采纳方案 ${opts.adopt!.toUpperCase()}，写进了任务的「约定」`);
        console.log(voteText(v));
        return;
      }
      const q = words.join(' ').trim();
      if (!q) {
        console.log(voteText(latestVote(root)));
        return;
      }
      const { done } = startVote(root, { question: q, voters: speakers(opts.ask), options: opts.option, context: talkContext(root) });
      console.log(c.dim((opts.option?.length ?? 0) >= 2 ? '大家在投票……' : '大家在各自出方案、然后投票……'));
      console.log(voteText(await done));
    });
}

const CHAT_HELP = [
  '直接打字：讨论（轮流回答，后面的看得到前面的）',
  '/对比 话：同时回答，互相看不到',
  '/投票 问题 | 选项 | 选项：投票（不列选项就请 AI 各出方案）',
  '/投 A 理由、/采纳 A：最近一次投票',
  '/新群聊、/成员 名字 名字、/帮助、/退出',
].join('\n');

/**
 * 终端里的连续群聊：打一句发一句，回答来了就打出来（网页上别人说的也会出现）。
 * 回答在这个进程里问；退出时等这一轮说完。
 */
export function chatCommand(): Command {
  return new Command('chat')
    .description('在终端里连续群聊：直接打字是讨论；/对比、/投票、/投、/采纳、/新群聊、/成员、/退出（/帮助 看写法）')
    .option('--ask <名字>', '请谁回答，逗号分隔（默认：所有能参加群聊的）')
    .action(async (o: { ask?: string }) => {
      const root = findRoot();
      requireInit(root);
      let ask = checkSpeakers(speakers(o.ask));
      const tty = !!process.stdout.isTTY;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: tty ? c.dim('› ') : '' });
      let closed = false;
      /** 打一段话，不打断你正在打的字（清掉提示行，打完再把提示和你打到一半的字放回来）。 */
      const say_ = (text: string) => {
        if (tty && !closed) {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
        }
        console.log(text);
        if (!closed) rl.prompt(true);
      };
      /** 这里打的话（终端已经显示过，不再打一遍）。 */
      const mine = new Set<string>();
      let rows = readTalk(root, 100000);
      let seen = rows.length;
      const printed = new Map(readVotes(talkPath(root)).map((v) => [v.id, v.status]));
      for (const r of rows.slice(-10)) console.log(`${rowText(r)}\n`);
      console.log(c.dim(`和 ${ask.map(nameOf).join('、')} 群聊（/帮助 看写法）`));
      const flush = () => {
        rows = readTalk(root, 100000);
        for (const r of rows.slice(seen)) if (!mine.has(r.ts)) say_(`${rowText(r)}\n`);
        seen = rows.length;
        for (const v of readVotes(talkPath(root))) {
          if (printed.get(v.id) === v.status) continue;
          printed.set(v.id, v.status);
          if (v.status === 'done') say_(`${voteText(v)}\n`);
        }
      };
      const poll = setInterval(flush, 600);
      const running = new Set<Promise<unknown>>();
      const track = (p: Promise<unknown>) => {
        running.add(p);
        void p.catch(() => undefined).finally(() => running.delete(p));
      };
      const handle = (line: string) => {
        const t = line.trim();
        if (!t) return;
        const [cmd, ...restWords] = t.split(/\s+/);
        const rest = t.slice(cmd.length).trim();
        if (!t.startsWith('/')) {
          const r = say(root, t, ask, talkContext(root), 'turn');
          mine.add(r.row.ts);
          track(r.done);
          return;
        }
        switch (cmd) {
          case '/对比': {
            if (!rest) throw new RelayError('/对比 后面写要问的话', 'empty');
            const r = say(root, rest, ask, talkContext(root), 'solo');
            mine.add(r.row.ts);
            say_(c.dim(`请 ${r.queued.map(nameOf).join('、')} 同时回答……`));
            track(r.done);
            return;
          }
          case '/投票': {
            const [question, ...options] = rest.split(/\s*[|｜]\s*/).filter(Boolean);
            if (!question) throw new RelayError('/投票 后面写问题', 'empty');
            track(startVote(root, { question, voters: ask, options, context: talkContext(root) }).done);
            say_(c.dim(options.length >= 2 ? '大家在投票……' : '大家在各自出方案、然后投票……'));
            return;
          }
          case '/投':
          case '/采纳': {
            if (!restWords[0]) throw new RelayError(`${cmd} 后面写方案的字母`, 'empty');
            const v = castOrAdopt(root, cmd === '/投' ? 'cast' : 'adopt', restWords[0], restWords.slice(1).join(' '));
            printed.set(v.id, v.status);
            say_(`${cmd === '/投' ? `已投方案 ${restWords[0].toUpperCase()}` : `已采纳方案 ${restWords[0].toUpperCase()}，写进了任务的「约定」`}\n${voteText(v)}\n`);
            return;
          }
          case '/新群聊': {
            archiveTalk(root);
            seen = 0;
            say_('已开始新群聊');
            return;
          }
          case '/成员': {
            if (restWords.length) ask = checkSpeakers(restWords.flatMap((w) => w.split(/[,，]/)).filter(Boolean));
            say_(`群聊成员：${ask.map(nameOf).join('、')}`);
            return;
          }
          case '/帮助':
            say_(CHAT_HELP);
            return;
          case '/退出':
          case '/exit':
            rl.close();
            return;
          default:
            throw new RelayError(`不认识 ${cmd}（/帮助 看写法）`, 'bad-command');
        }
      };
      rl.on('line', (line) => {
        try {
          handle(line);
        } catch (e) {
          say_(c.red(e instanceof Error ? e.message : String(e)));
        }
        if (!closed) rl.prompt();
      });
      rl.prompt();
      await new Promise<void>((resolve) =>
        rl.on('close', () => {
          closed = true;
          resolve();
        })
      );
      // 退出前等这一轮说完，把回答打出来
      if (running.size) console.log(c.dim('等这一轮说完……'));
      while (running.size) await Promise.all([...running]);
      clearInterval(poll);
      flush();
    });
}
