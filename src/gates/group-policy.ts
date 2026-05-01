import type { NovaMessageEvent, NovaRuntimeConfig, SilenceLevel } from '../core/types';
import type { ChannelAttrs } from '../world/entities';
import { buildGroupPolicyInput } from '../relationships/group-profile';
import type { GroupProfile } from '../relationships/types';

export interface GroupPolicyDecision {
  allow: boolean;
  level: Exclude<SilenceLevel, 'none'>;
  reason: string;
  values: Record<string, unknown>;
}

export interface GroupPolicyEvaluateParams {
  event?: NovaMessageEvent;
  channel?: ChannelAttrs;
  profile?: GroupProfile | null;
  config: NovaRuntimeConfig;
  nowMs: number;
}

/**
 * 评估群聊策略门控。
 *
 * 群聊主动发言比私聊更保守, 必须同时满足:
 * 1. 全局主动行为开启 (proactiveEnabled)
 * 2. 群聊功能开启
 * 3. 群配置未禁用
 * 4. group policy 通过 (群风险 / 最近活跃 / 白名单上下文)
 * 5. 非 directed 消息在 replyInGroupOnlyWhenMentioned 模式下沉默
 */
export function evaluateGroupPolicy(params: GroupPolicyEvaluateParams): GroupPolicyDecision | null {
  const { event, channel, config } = params;
  const chatType = event?.chatType ?? channel?.chat_type;
  if (chatType !== 'group') return null;

  const directed = event?.isDirected === true;
  const mentionedSelf = event?.mentionedSelf === true;
  const repliedToSelf = event?.repliedToSelf === true;

  // 定向消息 (@ / 回复 Nova) 不阻止
  if (directed || mentionedSelf || repliedToSelf) return null;

  // replyInGroupOnlyWhenMentioned: 非定向群聊消息默认沉默
  if (config.replyInGroupOnlyWhenMentioned) {
    return {
      allow: false,
      level: 'normal',
      reason: 'group_observe_only',
      values: {
        replyInGroupOnlyWhenMentioned: config.replyInGroupOnlyWhenMentioned,
        directed,
        mentionedSelf,
        repliedToSelf,
      },
    };
  }

  return null;
}

/**
 * 评估群聊主动发言策略。
 * 用于 scheduled tick 产生的 proactive action candidate 在群聊中的判断。
 * 比 evaluateGroupPolicy 更严格, 包含风险/白名单/活跃度检查。
 *
 * 声部感知: 当 selectedVoice 为 caution 时, 群聊主动发言一律沉默。
 * caution 不是 IAUS action 类型, 不应产生群聊主动候选。
 */
export function evaluateGroupProactivePolicy(params: {
  groupId: string;
  profile: GroupProfile | null;
  channel?: ChannelAttrs;
  config: NovaRuntimeConfig;
  nowMs: number;
  isDirectedToNova?: boolean;
  /** 当前选中的声部, 用于 caution 感知门控。 */
  selectedVoice?: string;
}): GroupPolicyDecision | null {
  const { groupId, profile, channel, config, nowMs, isDirectedToNova, selectedVoice } = params;

  // 主动发言总开关
  if (!config.proactiveEnabled) {
    return {
      allow: false,
      level: 'hard',
      reason: 'proactive_disabled',
      values: { proactiveEnabled: false },
    };
  }

  // scheduled actions 开关
  if (!config.enableScheduledActions) {
    return {
      allow: false,
      level: 'hard',
      reason: 'scheduled_actions_disabled',
      values: { enableScheduledActions: false },
    };
  }

  // 群配置未禁用
  const groupConfig = config.enabledGroups[groupId];
  if (groupConfig && groupConfig.enabled === false) {
    return {
      allow: false,
      level: 'hard',
      reason: 'group_disabled',
      values: { groupId, enabled: false },
    };
  }

  // 声部感知门控: caution 在群聊中从不主动发言。
  // caution 通过 gates / social cost / prompt 约束起作用, 而不是作为 IAUS action。
  if (selectedVoice === 'caution') {
    return {
      allow: false,
      level: 'normal',
      reason: 'caution_group_proactive_silence',
      values: {
        groupId,
        selectedVoice: 'caution',
        note: 'caution is not an IAUS action type; group proactive silence enforced',
      },
    };
  }

  // 群风险等级: 高风险群不允许主动发言
  const riskLevel: string = channel?.group_risk_level ?? (profile?.novaRole === 'observer' ? 'high' : 'normal');
  if (riskLevel === 'high' || riskLevel === 'restricted') {
    return {
      allow: false,
      level: 'safety',
      reason: 'group_high_risk',
      values: { groupId, groupRiskLevel: riskLevel },
    };
  }

  // 构建策略输入
  const policyInput = buildGroupPolicyInput({
    profile,
    isDirected: isDirectedToNova ?? false,
    groupRiskLevel: riskLevel,
    novaRole: profile?.novaRole ?? channel?.nova_role_in_group ?? 'member',
    groupDisabled: groupConfig?.enabled === false,
    proactiveWhitelistQQ: config.proactiveWhitelistQQ,
    nowMs,
  });

  // 群最近无活动: 沉默 (不主动打扰沉寂群)
  if (!policyInput.recentlyActive) {
    return {
      allow: false,
      level: 'normal',
      reason: 'group_inactive',
      values: {
        groupId,
        lastActivityMs: profile?.updatedMs,
        windowMs: nowMs - (profile?.updatedMs ?? 0),
      },
    };
  }

  // 白名单上下文: 如果没有白名单成员在该群活跃, 不允许群聊主动发言
  const whitelist = config.proactiveWhitelistQQ;
  if (whitelist && whitelist.length > 0 && !isDirectedToNova) {
    if (!policyInput.hasWhitelistContext) {
      return {
        allow: false,
        level: 'normal',
        reason: 'group_proactive_whitelist_context_missing',
        values: {
          groupId,
          proactiveWhitelistQQ: whitelist,
          whitelistContextQQs: policyInput.whitelistContextQQs,
        },
      };
    }
  }

  return null;
}
