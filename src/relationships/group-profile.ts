import type { NovaMessageEvent } from '../core/types';
import type { ContactAttrs } from '../world/entities';
import { readRV, type RelationshipVector } from '../world/relationship-vector';
import type {
  GroupProfile,
  GroupPolicyInput,
  MemberHighlight,
} from './types';
import {
  ACTIVE_HOURS_ALPHA,
  createEmptyGroupProfile,
  GROUP_RECENT_ACTIVE_WINDOW_MS,
  MAX_MEMBER_HIGHLIGHTS,
} from './types';

/**
 * EMA 更新 24 小时活跃度分布。
 * 当消息时间戳落在某小时槽位时, 对该槽位做 EMA 更新。
 */
export function updateActiveHours(
  activeHours: number[],
  timestampMs: number,
): number[] {
  const hour = new Date(timestampMs).getHours();
  const next = activeHours.slice();
  const current = next[hour] ?? 0;
  next[hour] = current + ACTIVE_HOURS_ALPHA * (1 - current);
  return next;
}

/**
 * 根据群消息事件更新 GroupProfile。
 * 规则驱动: activeHours, 基础群信息, 成员高亮。
 * topic / atmosphere / recentTopicDrift 由后续 memory/diary 或 LLM 摘要补充。
 */
export function updateGroupProfileFromMessage(
  previous: GroupProfile | null,
  event: NovaMessageEvent,
  contact: ContactAttrs,
  nowMs: number,
): GroupProfile {
  const prevGroupName: string = previous?.groupName ?? '';
  const prevNovaRole: string = previous?.novaRole ?? 'member';
  const base: GroupProfile = previous ?? createEmptyGroupProfile(
    event.groupId ?? event.chatId,
    event.groupName ?? prevGroupName,
    prevNovaRole,
    nowMs,
  );

  const activeHours = updateActiveHours(base.activeHours, event.timestamp);
  const memberHighlights = upsertMemberHighlight(
    base.memberHighlights,
    event,
    contact,
    readRV(contact),
  );

  return {
    ...base,
    groupId: event.groupId ?? base.groupId,
    groupName: event.groupName ?? base.groupName,
    activeHours,
    memberHighlights,
    updatedMs: nowMs,
  };
}

/**
 * 更新或创建群成员高亮条目。
 * 按价值排序后取前 MAX_MEMBER_HIGHLIGHTS 条。
 */
export function upsertMemberHighlight(
  existing: MemberHighlight[],
  event: NovaMessageEvent,
  contact: ContactAttrs,
  rv: RelationshipVector,
): MemberHighlight[] {
  const groupId = event.groupId ?? event.chatId;
  const previous = existing.find((item) => item.contactId === contact.id);

  const groupsSeen = new Set<string>(previous?.groupsSeenIn ?? []);
  groupsSeen.add(groupId);

  const updated: MemberHighlight = {
    contactId: contact.id,
    qq: contact.qq,
    displayName: event.senderName ?? contact.nickname ?? contact.name ?? contact.qq,
    groupsSeenIn: Array.from(groupsSeen),
    lastSeenInGroupMs: event.timestamp,
    directedCount: (previous?.directedCount ?? 0) + (event.isDirected ? 1 : 0),
    replyCount: (previous?.replyCount ?? 0) + (event.repliedToSelf ? 1 : 0),
    relationshipVector: rv,
  };

  const next = existing.filter((item) => item.contactId !== contact.id);
  next.push(updated);

  return next
    .sort((a, b) => highlightScore(b) - highlightScore(a))
    .slice(0, MAX_MEMBER_HIGHLIGHTS);
}

/**
 * 计算成员高亮排序分值。
 * 最近出现 > directed > reply, 各有权重。
 */
function highlightScore(item: MemberHighlight): number {
  const lastSeen = item.lastSeenInGroupMs;
  const directed = item.directedCount;
  const replies = item.replyCount;
  return lastSeen + directed * 10_000_000 + replies * 10_000_000;
}

/**
 * 生成群画像自然语言摘要, 供 prompt builder 注入。
 * 规则驱动, 不依赖 LLM。
 * topic / atmosphere 为 null 时不生成描述, 后续可由 LLM 摘要补充。
 */
export function generateGroupProfileSummary(profile: GroupProfile | null): string | null {
  if (!profile) return null;

  const parts: string[] = [];

  // 群名
  if (profile.groupName) {
    parts.push(`这个群叫「${profile.groupName}」。`);
  }

  // 主题
  if (profile.topic) {
    parts.push(`群话题: ${profile.topic}。`);
  }

  // 氛围
  if (profile.atmosphere) {
    parts.push(`群氛围: ${profile.atmosphere}。`);
  }

  // Nova 角色
  if (profile.novaRole && profile.novaRole !== 'member') {
    parts.push(`你在群里的角色是: ${profile.novaRole}。`);
  }

  // 活跃时段
  const peakHours = describeActiveHours(profile.activeHours);
  if (peakHours) {
    parts.push(`群活跃时段: ${peakHours}。`);
  }

  // 近期话题漂移
  if (profile.recentTopicDrift) {
    parts.push(`近期话题似乎有变化: ${profile.recentTopicDrift}。`);
  }

  // 关键成员 (最多提 3 个高频 @Nova 的成员)
  const topDirected = profile.memberHighlights
    .filter((m) => m.directedCount > 0)
    .slice(0, 3);
  if (topDirected.length > 0) {
    const names = topDirected.map((m) => m.displayName).join('、');
    parts.push(`群里经常和你互动的成员有: ${names}。`);
  }

  // 结晶兴趣
  const interests = Object.values(profile.crystallizedInterests ?? {});
  if (interests.length > 0) {
    const interestLabels = interests
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3)
      .map((i) => i.label)
      .join('、');
    parts.push(`这个群大家对以下话题比较感兴趣: ${interestLabels}。`);
  }

  return parts.length > 0 ? parts.join('') : null;
}

/**
 * 描述活跃时段分布。
 * 找出连续活跃的时段并返回中文描述。
 */
function describeActiveHours(activeHours: number[]): string | null {
  const threshold = 0.15;
  const activeSlots: number[] = [];
  for (let i = 0; i < activeHours.length; i++) {
    if ((activeHours[i] ?? 0) >= threshold) activeSlots.push(i);
  }
  if (activeSlots.length === 0) return null;

  // 找连续区间
  const ranges: Array<{ start: number; end: number }> = [];
  const firstSlot = activeSlots[0];
  if (firstSlot === undefined) return null;
  let rangeStart = firstSlot;
  let prev = firstSlot;
  for (let i = 1; i < activeSlots.length; i++) {
    const slot = activeSlots[i];
    if (slot === undefined) continue;
    if (slot === prev + 1) {
      prev = slot;
    } else {
      ranges.push({ start: rangeStart, end: prev });
      rangeStart = slot;
      prev = slot;
    }
  }
  ranges.push({ start: rangeStart, end: prev });

  if (ranges.length === 0) return null;

  return ranges
    .map((r) => (r.start === r.end ? `${r.start}点` : `${r.start}-${r.end + 1}点`))
    .join('、');
}

/**
 * 从 GroupProfile 构建群策略输入, 供 gate 使用。
 */
export function buildGroupPolicyInput(params: {
  profile: GroupProfile | null;
  isDirected: boolean;
  groupRiskLevel: string;
  novaRole: string;
  groupDisabled: boolean;
  proactiveWhitelistQQ: string[];
  nowMs: number;
}): GroupPolicyInput {
  const { profile, isDirected, groupRiskLevel, novaRole, groupDisabled, proactiveWhitelistQQ, nowMs } = params;

  // 检查最近活动
  const recentlyActive = profile !== null
    && (nowMs - profile.updatedMs) < GROUP_RECENT_ACTIVE_WINDOW_MS;

  // 检查白名单上下文: 是否有白名单 QQ 在高亮成员中
  const whitelistQQs = new Set(proactiveWhitelistQQ);
  const whitelistContextQQs: string[] = [];
  if (profile && whitelistQQs.size > 0) {
    for (const member of profile.memberHighlights) {
      if (whitelistQQs.has(member.qq)) {
        whitelistContextQQs.push(member.qq);
      }
    }
  }

  const hasWhitelistContext = whitelistContextQQs.length > 0;

  return {
    groupRiskLevel,
    recentlyActive,
    isDirected,
    hasWhitelistContext,
    whitelistContextQQs,
    novaRole,
    groupDisabled,
  };
}
