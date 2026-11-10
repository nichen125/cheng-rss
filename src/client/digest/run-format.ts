// 简报生成进度的人话化（纯函数）。
//
// 简报页和配置页都要显示"现在到哪一步了"，两处各写一份就会在某次
// 改动里分叉 —— 一处把 clustering 说成"聚类"、另一处说成"归纳事件"，
// 用户看到的是同一件事的两个名字。所以放在这里共用。
//
// 纯字符串处理、不碰 DOM 也不碰 React：能在 Node 里直接 import 验证。
import type { DigestRunPhase, DigestRunStatus } from '../api.ts';

/**
 * 阶段名。
 *
 * 不用「准备 → 聚类 → 生成 → 保存」这套机器词：用户要看到的是
 * "这件事现在在做哪一步"，clustering/generating 对他没有意义。
 */
const PHASE_LABEL: Record<DigestRunPhase, string> = {
  prepare: '整理最近的条目',
  clustering: '归纳事件',
  generating: '写简报',
  saving: '落库',
};

/**
 * 未知阶段也要说话：宁可显示原始值，也不显示空白 —— 空白看起来像卡住了。
 * 排队中的那一刻还没有 phase，说"排队"比说"准备"准确。
 */
export function phaseLabel(
  phase: DigestRunPhase | string | null | undefined,
  status?: DigestRunStatus | string | null,
): string {
  if (status === 'queued') return '排队中';
  const known = phase ? PHASE_LABEL[phase as DigestRunPhase] : undefined;
  if (known) return known;
  return phase ? String(phase) : '进行中';
}

/**
 * 用时的人类写法。
 *
 * 不留毫秒位：这个数字每 2 秒才刷新一次，毫秒只会跳动。
 * 超过一小时加小时位 —— 生成卡到这个程度时用户要的是"已经多久了"。
 */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}
