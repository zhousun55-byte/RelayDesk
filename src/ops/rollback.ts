import { RelayError } from '../core/errors';
import { appendLedger, findStint, loadLedger, requireInit, type Stint } from '../core/ledger';
import { readTaskCopy, restoreTaskChecks, saveTaskCopy } from '../core/notes';
import { restoreSnapshot, snapExists } from '../core/snap';
import { withLock } from './lock';
import { markRollback, recoverRollback, refreshBrief, track, type RollbackStart } from './track';

/**
 * 退回：把整个文件夹恢复成「第 N 棒之前」的样子。之后的棒作废（账本里还留着，标成已退回）。
 * 退回前先存一张快照，所以退回本身也能撤销。
 * 任务清单不在快照里（.relay/ 不进快照）：按「第 N 棒开始前」存的那份清单改回打勾，
 * 不然代码退回去了、清单还全打着勾，全自动会以为活已经干完了。
 * 退回时拿着调度锁（检查完到恢复完之间不会有一棒开工，lock.ts）；动文件前记一笔，做到一半停了下次对账补记进账本（track.ts 的 recoverRollback）。
 */

export interface RollbackResult {
  label: string;
  dropped: number[];
  files: number;
  /** 任务清单：取消了哪些勾、重新勾上了哪些；missing = 找不到那时的清单（旧账本），清单没动。 */
  task: { unchecked: string[]; checked: string[]; missing: boolean };
  /** 恢复完和目标对不上的文件（删不掉、写不回去）。 */
  left: string[];
}

/** 第 N 棒开始前的任务清单：它自己记的；没记（旧账本、自己在工具里干的）就用它前面最近一棒结束时的。 */
function taskBeforeOf(stints: Stint[], s: Stint): string | undefined {
  if (s.taskBefore) return s.taskBefore;
  return [...stints].reverse().find((x) => x.id < s.id && !x.rolledBack && x.taskAfter)?.taskAfter;
}

/**
 * 退回和撤销退回共用：记一笔「要动文件了」→ 恢复成 ev.to 那张 → 清单的勾按 old 改回 → 记账本 → 删掉记号。
 * 恢复出错就马上按现在的样子补记（之后能撤销），再报错。task 是账本里清单那一项除了结果以外的部分。
 */
function restore(root: string, message: string, ev: Omit<RollbackStart, 'safety' | 'task'>, task: { from?: string; before?: string }, old: string | null) {
  let mark: ReturnType<typeof markRollback> | null = null;
  let r: ReturnType<typeof restoreSnapshot>;
  try {
    r = restoreSnapshot(root, ev.to, message, (safety) => (mark = markRollback(root, { ...ev, safety, task: { ...task, unchecked: [], checked: [] } })));
  } catch (e) {
    (mark as ReturnType<typeof markRollback> | null)?.drop();
    recoverRollback(root);
    throw e;
  }
  const t = old !== null ? restoreTaskChecks(root, old) : { unchecked: [], checked: [] };
  const taskAfter = saveTaskCopy(root);
  appendLedger(root, {
    ...ev,
    type: 'rollback',
    safety: r.safety,
    after: r.after,
    ...(r.left.length ? { left: r.left } : {}),
    task: { ...task, ...(taskAfter ? { after: taskAfter } : {}), unchecked: t.unchecked, checked: t.checked, ...(old === null ? { missing: true } : {}) },
  });
  (mark as ReturnType<typeof markRollback> | null)?.done();
  refreshBrief(root);
  return { files: r.files, task: { ...t, missing: old === null }, left: r.left };
}

/** 先把正在进行的那一棒记完（它的改动也会被退回，但账上要有）；还有 AI 在改文件就不动。 */
function settled(root: string, why: (id: number) => string) {
  track(root);
  const v = loadLedger(root);
  if (v.open) throw new RelayError(why(v.open.id), 'busy');
  return v;
}

export function rollbackBefore(root: string, stintId: number): RollbackResult {
  requireInit(root);
  return withLock(root, () => {
    const v = settled(root, (id) => `第 ${id} 棒还在进行中，有 AI 正在改文件`);
    const s = findStint(v, stintId);
    if (!s) throw new RelayError(`没有第 ${stintId} 棒。`, 'no-stint');
    if (s.rolledBack) throw new RelayError(`第 ${stintId} 棒已经被退回过了。`, 'already');
    if (!snapExists(root, s.from)) throw new RelayError(`第 ${stintId} 棒之前的快照找不到了。`, 'no-snap');
    const dropped = v.stints.filter((x) => x.id >= stintId && !x.rolledBack).map((x) => x.id);
    const label = `第 ${stintId} 棒之前`;
    const ref = taskBeforeOf(v.stints, s);
    const before = saveTaskCopy(root);
    const r = restore(root, `退回到${label}`, { ts: new Date().toISOString(), to: s.from, label, dropped }, { ...(ref ? { from: ref } : {}), ...(before ? { before } : {}) }, readTaskCopy(root, ref));
    return { label, dropped, ...r };
  });
}

/** 撤销最近一次退回：恢复成退回前的样子，那几棒的改动回来，任务清单的勾也回来。 */
export function undoRollback(root: string): RollbackResult {
  requireInit(root);
  return withLock(root, () => {
    recoverRollback(root); // 上次退回做到一半停了的，先补记上，撤销的就是它
    const last = loadLedger(root).lastRollback;
    if (!last || last.restored) throw new RelayError('最近没有可以撤销的退回', 'no-rollback');
    const v = settled(root, (id) => `退回之后又有新的改动（第 ${id} 棒），不能直接撤销了。`);
    const after = v.stints.filter((x) => !x.rolledBack && x.to && x.to !== last.after);
    if (after.some((x) => new Date(x.startedAt).getTime() > new Date(last.ts).getTime())) {
      throw new RelayError('退回之后又有人接着做了，撤销会冲掉后来的改动', 'moved-on');
    }
    const label = `撤销「退回到${last.label}」`;
    const r = restore(root, label, { ts: new Date().toISOString(), to: last.safety, label: '退回之前', dropped: [], restored: last.dropped }, {}, readTaskCopy(root, last.task?.before));
    return { label, dropped: [], ...r };
  });
}
