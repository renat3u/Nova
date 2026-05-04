import type { RelationshipVector } from '../world/relationship-vector';

export interface GroupProfile {
  groupId: string;
  groupName: string;
  topic: string | null;
  atmosphere: string | null;
  novaRole: string;
  memberHighlights: string[];
  crystallizedInterests: Record<string, CrystallizedInterest>;
  activeHours: number[];
  recentTopicDrift: string | null;
  updatedMs: number;
}

export interface CrystallizedInterest {
  /** 兴趣标签 */
  label: string;
  /** 置信度 [0,1] */
  confidence: number;
  /** 结晶时间戳 ms */
  crystallizedMs: number;
  /** 上次强化时间戳 ms */
  lastReinforcedMs: number;
}

/**
 * 群策略输入, 供 gate 使用。
 * 从 GroupProfile 和 ChannelAttrs 中提取结构化决策信号。
 */
export interface GroupPolicyInput {
  /** 群风险等级 */
  groupRiskLevel: string;
  /** 最近是否有群内活动 (24h 内) */
  recentlyActive: boolean;
  /** 是否是 directed 消息 (@Nova / 回复 Nova) */
  isDirected: boolean;
  /** 是否有白名单 QQ 上下文 */
  hasWhitelistContext: boolean;
  /** 白名单上下文相关的 QQ 号列表 */
  whitelistContextQQs: string[];
  /** Nova 在群内的角色 */
  novaRole: string;
  /** 群是否被配置禁用 */
  groupDisabled: boolean;
}

/** 成员高亮上限 */
export const MAX_MEMBER_HIGHLIGHTS = 50;

/** activeHours EMA 更新系数 (α = 0.1, 10-sample effective window) */
export const ACTIVE_HOURS_ALPHA = 0.1;

/** 群近期活跃窗口 (24h, ms) */
export const GROUP_RECENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 创建空白群组画像 */
export function createEmptyGroupProfile(
  groupId: string,
  groupName: string,
  novaRole = 'member',
  nowMs = Date.now(),
): GroupProfile {
  return {
    groupId,
    groupName,
    topic: null,
    atmosphere: null,
    novaRole,
    memberHighlights: [],
    crystallizedInterests: {},
    activeHours: new Array(24).fill(0) as number[],
    recentTopicDrift: null,
    updatedMs: nowMs,
  };
}
