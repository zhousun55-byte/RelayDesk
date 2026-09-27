import { BRIEF_REL, reviewFileFor, TASK_REL, VERDICT_CHOICES } from './notes';
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

/** 派活：强模型把任务拆成弱模型一棒做得完的小步，只写清单，不写代码。 */
export function planPrompt(i: StintPromptInput): string {
  return [
    `你是「接力台」派来拆解任务的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    '这个任务之后交给弱模型一棒一步地做，你负责拆：',
    `1. 先读 \`${BRIEF_REL}\` 和 \`${TASK_REL}\`，再读和任务有关的代码，想清楚整件事怎么做。`,
    `2. 把 \`${TASK_REL}\`「进度」里的清单改写成一步步的小步：每步一个弱模型一棒做得完、做完能验证（大约改一两个文件）。已经打勾的保留原样。`,
    '3. 每步一行 `- [ ] …`；下面缩进写清楚：改哪些文件、具体怎么改、怎么验证（跑什么命令、看到什么算对）。弱模型只照你写的做，要写具体，不写「优化一下」这种话。',
    `4. 你只改 \`${TASK_REL}\`，不改代码、不建别的文件。交接写在 \`${i.handoff}\`：「做了什么」写拆成了几步，状态写「已交接」。`,
  ].join('\n');
}

/** 派活：弱模型只做清单里的一步（强模型拆好的，做法写在这一步下面）。 */
export function stepPrompt(i: StintPromptInput & { step: { index: number; text: string } }): string {
  return [
    `你是「接力台」派来接着做这个项目的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    `这一棒只做任务清单里的第 ${i.step.index} 步：「${i.step.text}」。怎么改、怎么验证写在 \`${TASK_REL}\` 里这一步下面，照着做。`,
    '',
    `1. 先读 \`${BRIEF_REL}\`（任务、上一棒留的话都在里面），再看 \`${TASK_REL}\` 里这一步。`,
    `2. 只做这一步，不做后面的步骤；做完在 \`${TASK_REL}\` 里把它打勾。`,
    '3. 照写的做不通、或者缺信息，就停下：交接状态写「卡住了」，写清楚卡在哪。不要自己换做法。',
    `4. 交接写在 \`${i.handoff}\`，状态写「已交接」。`,
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

export interface FinalPromptInput extends StintPromptInput {
  from: string;
  to: string;
  reviewFile: string;
}

export function finalPrompt(i: FinalPromptInput): string {
  return [
    `你是「接力台」派来做终审的第 ${i.id} 棒：${i.label}。${ALONE}`,
    '',
    `任务清单已经全部打勾。请把整件事从头到尾过一遍，确认真的做完、做对了：`,
    '',
    `1. 任务、进度和约定见 \`${TASK_REL}\`；接力的经过见 \`${BRIEF_REL}\`。`,
    `2. 这件事的全部改动：\`${snapGit()} diff ${i.from.slice(0, 10)} ${i.to.slice(0, 10)}\`。`,
    `3. 对照任务逐条确认；${i.gateCommand ? `跑检查 \`${i.gateCommand}\`；` : ''}能运行的就实际运行一下。`,
    '4. 发现问题直接修好。',
    `5. 结论写到 \`${i.reviewFile}\`（格式同复核，「结论」一行只写：${VERDICT_CHOICES.join(' / ')}；接力台只认「没问题」「有问题，已修好」算终审通过）。交接写在 \`${i.handoff}\`。确认整件事没问题就把状态写「全部完成」，还有问题没修完就在任务清单里补上没做的步骤（终审这件事不用写进清单）。`,
  ].join('\n');
}
