import { RelayError } from '../core/errors';
import { appendLedger, findStint, loadLedger, requireInit } from '../core/ledger';
import { restoreFile, restoreSnapshot, snapExists } from '../core/snap';
import { refreshBrief, relayBusy, track } from './track';

/**
 * 退回：把整个文件夹恢复成「第 N 棒之前」的样子。之后的棒作废（账本里还留着，标成已退回）。
 * 退回前先存一张快照，所以退回本身也能撤销。
 */

export interface RollbackResult {
  label: string;
  dropped: number[];
  files: number;
}

export function rollbackBefore(root: string, stintId: number): RollbackResult {
  let v = requireInit(root);
  if (relayBusy(v)) throw new RelayError('接力台正在调度一棒，先停下再退回。', 'busy');
  // 先把正在进行的那一棒记完（它的改动也会被退回，但账上要有）。
  track(root);
  v = loadLedger(root);
  if (v.open) throw new RelayError(`第 ${v.open.id} 棒还在进行中（有 AI 正在改文件）。等它停下，或者先让它交接。`, 'busy');
  const s = findStint(v, stintId);
  if (!s) throw new RelayError(`没有第 ${stintId} 棒。`, 'no-stint');
  if (s.rolledBack) throw new RelayError(`第 ${stintId} 棒已经被退回过了。`, 'already');
  if (!snapExists(root, s.from)) throw new RelayError(`第 ${stintId} 棒之前的快照找不到了。`, 'no-snap');
  const dropped = v.stints.filter((x) => x.id >= stintId && !x.rolledBack).map((x) => x.id);
  const label = `第 ${stintId} 棒之前`;
  const r = restoreSnapshot(root, s.from, `退回到${label}`);
  appendLedger(root, { type: 'rollback', ts: new Date().toISOString(), to: s.from, label, safety: r.safety, after: r.after, dropped });
  refreshBrief(root);
  return { label, dropped, files: r.files };
}

/** 撤销最近一次退回：恢复成退回前的样子，那几棒的改动回来。 */
export function undoRollback(root: string): RollbackResult {
  let v = requireInit(root);
  if (relayBusy(v)) throw new RelayError('接力台正在调度一棒，先停下再撤销。', 'busy');
  const last = v.lastRollback;
  if (!last || last.restored) throw new RelayError('最近没有可以撤销的退回。', 'no-rollback');
  track(root);
  v = loadLedger(root);
  if (v.open) throw new RelayError(`退回之后又有新的改动（第 ${v.open.id} 棒），不能直接撤销了。`, 'busy');
  const after = v.stints.filter((x) => !x.rolledBack && x.to && x.to !== last.after);
  if (after.some((x) => new Date(x.startedAt).getTime() > new Date(last.ts).getTime())) {
    throw new RelayError('退回之后又有人接着做了，不能直接撤销（会把后来的活也冲掉）。可以退回到具体某一棒之前。', 'moved-on');
  }
  const label = `撤销「退回到${last.label}」`;
  const r = restoreSnapshot(root, last.safety, label);
  appendLedger(root, { type: 'rollback', ts: new Date().toISOString(), to: last.safety, label: '退回之前', safety: r.safety, after: r.after, dropped: [], restored: last.dropped });
  refreshBrief(root);
  return { label, dropped: [], files: r.files };
}

/** 只把一个文件恢复成第 N 棒之前的样子（复核时觉得某个文件被改坏了）。 */
export function restoreFileBefore(root: string, stintId: number, file: string): void {
  const v = requireInit(root);
  const s = findStint(v, stintId);
  if (!s) throw new RelayError(`没有第 ${stintId} 棒。`, 'no-stint');
  restoreFile(root, s.from, file);
}
