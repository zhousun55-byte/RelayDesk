import { BRIEF_REL, reviewDiffFileFor, reviewFileFor, TASK_REL, VERDICT_CHOICES } from './notes';
import { snapGit } from './snap';

/**
 * 接力台调度一棒时给 AI 的第一句话。要短：细节都在接力本和 AGENTS.md / CLAUDE.md 的规矩里，
 * 这里只说「你是谁、这一棒做什么、交接写在哪」。
 */

export interface StintPromptInput {
  id: number;
  /** Codex · gpt-6 */
  label: string;
  handoff: string;
  gateCommand: string;
}

/** 强模型拆解时在这一步下面写的标记：和相邻几步互不依赖、改的文件不重叠（接力台会请几位同时做）。 */
export const PARALLEL_MARK = '可以同时做';

const ALONE = '没有人会回答你的问题，也不用等人确认：自己判断，直接做。';

export function workPrompt(i: StintPromptInput): string {
  return [
    `你是「接力台」派来接着做这个项目的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    `1. 先完整读 \`${BRIEF_REL}\`（任务、进度、上一棒留的话、待复核的改动都在里面），再按 AGENTS.md / CLAUDE.md 里的「接力规矩」做。`,
    `2. 这一棒的交接写在 \`${i.handoff}\`：现在就建（格式见接力本），边做边记。`,
    `3. 把任务往前推：能做完就做完；做不完就做完一个完整的小块再收工。每做完一步在 \`${TASK_REL}\` 里打勾。`,
    '4. 收工前把交接写完整，状态写「已交接」（整个任务都做完了写「全部完成」；做不下去写「卡住了」并写清楚卡在哪）。',
    ...(i.gateCommand ? [`5. 收工前跑一遍检查：\`${i.gateCommand}\`。`] : []),
  ].join('\n');
}

/** 派活：强模型把任务拆成弱模型一棒做得完的小步，只写清单，不写代码。清单要短：写成逐字的规格，拆解就和直接做一样费。 */
export function planPrompt(i: StintPromptInput): string {
  return [
    `你是「接力台」派来拆解任务的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    '这个任务之后交给弱模型一棒一步地做，你负责拆：',
    `1. 先读 \`${BRIEF_REL}\` 和 \`${TASK_REL}\`，再读和任务有关的代码，想清楚整件事怎么做。`,
    `2. 把 \`${TASK_REL}\`「进度」里的清单改写成一步步的小步：每步一个弱模型一棒做得完、做完能验证（大约改一两个文件）。已经打勾的保留原样。`,
    '3. 每步一行 `- [ ] …`；下面缩进几行写清楚：改哪些文件、要有哪些函数（写签名）和行为、要注意的边界、怎么验证。只写要求，不写逐字的期望输出、整段模板和一条条测试用例（测试由弱模型按要求自己写）；几行要点就够，不用数字数、反复压缩。',
    `   相邻的几步互不依赖（不用等对方的结果、改的文件也不重叠）时，在这几步下面各加一行「${PARALLEL_MARK}」：接力台会请几位同时做，快很多。要用到前面某步结果的，不要加。`,
    '   「约定」里只写用户要的和项目本身的限制。不要把你自己这个工具做不到的事（比如你不能联网、不能跑命令）写成约定或步骤要求：接手的成员可能做得到。要查资料、要最新数据的，就写成步骤让做的人去查（能联网就联网核实，写明出处）。',
    '4. 不要自己把活干一遍：项目里外都不写实现代码、不试跑（也不去试库函数怎么用）。代码留给弱模型写，最后由强模型终审把关。',
    `5. 清单想好了一次写进 \`${TASK_REL}\`，不要一步一步地追加；你只改这个文件，不改代码、不建别的文件。交接写在 \`${i.handoff}\`：「做了什么」写拆成了几步，状态写「已交接」。`,
  ].join('\n');
}

/** 派活：弱模型只做清单里的一步（强模型拆好的，做法写在这一步下面）。 */
export function stepPrompt(i: StintPromptInput & { step: { index: number; text: string }; together?: number[] }): string {
  return [
    `你是「接力台」派来接着做这个项目的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    `这一棒只做任务清单里的第 ${i.step.index} 步：「${i.step.text}」。怎么改、怎么验证写在 \`${TASK_REL}\` 里这一步下面，照着做。`,
    '',
    `你就是上面这一位：交接第一行照写「${i.label}」，不要写成别的工具或模型。这是派活：复核由指挥的那位在清单做完后一起做，接力本里「先复核」一节跳过，不复核别的棒。`,
    '',
    `1. 先读 \`${BRIEF_REL}\`（任务、上一棒留的话都在里面），再看 \`${TASK_REL}\` 里这一步。别的只看做这一步要用的；要对齐已有的写法，看一份就够。`,
    `2. 只做这一步，不做后面的步骤。文件一次写完整，写完不用再读回来核对；做完在 \`${TASK_REL}\` 里把它打勾。`,
    ...(i.together?.length ? [`   第 ${i.together.join('、')} 步正由别人同时在做：只改这一步要改的文件，别的步骤的文件一个都不要动（动了会合不回去）；清单里只给这一步打勾。`] : []),
    '3. 照写的做不通、或者缺信息，就停下：交接状态写「卡住了」，写清楚卡在哪。不要自己换做法。',
    `4. 交接写在 \`${i.handoff}\`，状态写「已交接」，三五行写清做了什么、留了什么就够。`,
    ...(i.gateCommand ? [`5. 收工前跑一遍检查：\`${i.gateCommand}\`。`] : []),
  ].join('\n');
}

export interface ReviewPromptInput extends StintPromptInput {
  targets: { id: number; label: string; tierWord: string }[];
}

export function reviewPrompt(i: ReviewPromptInput): string {
  const list = i.targets.map((t) => `第 ${t.id} 棒（${t.label}，${t.tierWord}）`).join('、');
  return [
    `你是「接力台」派来复核的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    `要复核的是：${list}。它们的交接、真实改动和复核方法都写在 \`${BRIEF_REL}\` 的「先复核」一节里。`,
    '',
    '1. 逐棒对照它的交接看真实改动：说做了的真做了吗？有没有没说的改动？有没有改错、改坏、偷工减料？',
    `2. ${i.gateCommand ? `跑检查：\`${i.gateCommand}\`；` : ''}能运行的就实际运行一下，确认功能真的能用。`,
    '3. 发现问题直接改好（就在这个文件夹里改）。改得太乱的文件可以恢复成它改之前的样子（接力本里有命令）。',
    `4. 每一棒写一份结论：${i.targets.map((t) => `\`${reviewFileFor(t.id)}\``).join('、')}（格式见接力本）。「结论」一行只写：${VERDICT_CHOICES.join(' / ')}。没实际跑过检查、验证不了就写「证据不足」，问题没修完写「有问题，还没修」——不要写「应该没问题」。`,
    `5. 这一棒只复核和修问题，不做新功能；复核这件事不用写进任务清单（接力台自己记着）。你自己的交接写在 \`${i.handoff}\`，状态写「已交接」。`,
  ].join('\n');
}

/** 边做边复核只能写的三种结论（只看不改，没有「已修好」「已退回」）。 */
export const SIDE_VERDICTS = ['没问题', '有问题，还没修', '证据不足'] as const;

export interface SideReviewTarget {
  id: number;
  label: string;
  handoff?: string;
  /** 派活：这一棒做的是清单第几步、原话。 */
  step?: { index: number; text: string };
}

/**
 * 派活时边做边复核：干活的人在同一个文件夹里接着做下一步，复核的人只看不改（改了会撞车），
 * 结论写在回答里，接力台按「=== 第 N 棒 ===」切开，存成每一棒的复核文件。
 */
export function sideReviewPrompt(i: { label: string; targets: SideReviewTarget[] }): string {
  const one = (t: SideReviewTarget) =>
    `- 第 ${t.id} 棒（${t.label}${t.step ? `，清单第 ${t.step.index} 步：${t.step.text.split('\n')[0].slice(0, 80)}` : ''}）：真实改动 \`${reviewDiffFileFor(t.id)}\`${t.handoff ? `，它的交接 \`${t.handoff}\`` : ''}`;
  return [
    `你是「接力台」派来边做边复核的：${i.label}。${ALONE}`,
    '',
    '这一棒只看不改：别人正在同一个文件夹里接着做下一步，你改文件会和它撞车。发现的问题写清楚，交给干活的人照着改。',
    '',
    '要复核的：',
    ...i.targets.map(one),
    '',
    `1. 任务原文和约定见 \`${TASK_REL}\`。以真实改动（.diff）为准：工作区里的文件可能已经有下一步的改动，不算这几棒的。`,
    '2. 逐棒对照：说做了的真做了吗？有没有没说的改动？有没有改错、偷工减料、和任务原文对不上的地方？',
    `3. 回答只写结论，按下面的格式，每棒一段（接力台会原样存成复核文件）。「结论」一行只写：${SIDE_VERDICTS.join(' / ')}。`,
    '',
    ...i.targets.flatMap((t) => [`=== 第 ${t.id} 棒 ===`, `- 结论：`, '## 它说的和实际对不对得上', '- ', '## 发现的问题和该怎么改（没有就写「无」）', '- ', '']),
  ].join('\n');
}

/** 把边做边复核的回答按「=== 第 N 棒 ===」切开；只有一棒、又没写分隔的，整段算它的。 */
export function splitSideReview(text: string, ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  const marks = [...text.matchAll(/^\s*={2,}\s*第\s*(\d+)\s*棒\s*={2,}\s*$/gm)];
  marks.forEach((m, k) => {
    const id = Number(m[1]);
    if (!ids.includes(id) || out.has(id)) return;
    const body = text.slice(m.index! + m[0].length, marks[k + 1]?.index ?? text.length).trim();
    if (body) out.set(id, body);
  });
  if (!marks.length && ids.length === 1 && text.trim()) out.set(ids[0], text.trim());
  return out;
}

export interface FinalPromptInput extends StintPromptInput {
  from: string;
  to: string;
  reviewFile: string;
  /** 派活：最后一批还没复核的棒（编号），并进终审一起复核。 */
  targets?: number[];
}

export function finalPrompt(i: FinalPromptInput): string {
  return [
    `你是「接力台」派来做终审的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    `任务清单已经全部打勾。请把整件事从头到尾过一遍，确认真的做完、做对了：`,
    '',
    ...(i.targets?.length
      ? [
          `这几棒还没复核，由你一起复核：${i.targets.map((n) => `第 ${n} 棒`).join('、')}。不用逐棒读交接、逐棒写结论：看全部改动和现在的代码就行，结论只写下面第 5 条那一份，接力台会把它记到这几棒上。清单下面的做法是拆解的人写的，和任务原文对不上、或者照做会出错（比如该转义的没转义）时，以任务原文为准，直接改好。`,
          '',
        ]
      : []),
    `1. 任务、进度和约定见 \`${TASK_REL}\`；接力的经过见 \`${BRIEF_REL}\`。`,
    `2. 这件事的全部改动：\`${snapGit()} diff ${i.from.slice(0, 10)} ${i.to.slice(0, 10)}\`。`,
    `3. 对照任务逐条确认；${i.gateCommand ? `跑检查 \`${i.gateCommand}\`；` : ''}能运行的就实际运行一下。`,
    '4. 发现问题直接修好。',
    `5. 结论写到 \`${i.reviewFile}\`（格式同复核，「结论」一行只写：${VERDICT_CHOICES.join(' / ')}；接力台只认「没问题」「有问题，已修好」算终审通过）。交接写在 \`${i.handoff}\`。确认整件事没问题就把状态写「全部完成」，还有问题没修完就在任务清单里补上没做的步骤（终审这件事不用写进清单）。`,
  ].join('\n');
}
