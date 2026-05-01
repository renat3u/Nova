
// Ported from runtime/src/pressure/social-cost.ts — Brown-Levinson politeness theory.
//
// Four sub-components quantify the cost of disturbing someone:
//   C_dist  — social distance (reciprocity imbalance, tier gap, time interval)
//   C_power — power differential (group role, territory effects)
//   C_imp   — action intrusiveness (context sensitivity, action-type ordering)
//   C_temp  — temporal penalty (action density, action repetition)
//
// Adapted for Nova QQ runtime: field names, WorldModel API, and helper functions.

import type { WorldModel } from '../world/model';
import type { DunbarTier } from '../world/entities';
import { DUNBAR_TIER_THETA, contactIdForPrivateChannel, qqIdFromNodeId } from '../world/constants';
import { getActiveConversation } from '../world/queries';
import { elapsedS, readNodeMs } from './clock';

// ── Intrusiveness tables ───────────────────────────────────────────────────

/** Action type → intrusiveness score ∈ [0, 1] — private chat baseline. */
export const INTRUSIVENESS: Record<string, number> = {
  proactive_message: 1.0,
  send_message: 0.8,
  sociability: 0.8,
  reply: 0.6,
  diligence: 0.6,
  react: 0.3,
  curiosity: 0.3,
  mark_read: 0.1,
  caution: 0.1,
};

/** Group / supergroup action intrusiveness scores.
 *  Groups are shared spaces — most actions have lower intrusiveness than private.
 *  But public speech has content risk (N people see it), so proactive/send/sociability
 *  sit at 0.4 rather than near-zero. */
export const INTRUSIVENESS_GROUP: Record<string, number> = {
  proactive_message: 0.4,
  send_message: 0.4,
  sociability: 0.4,
  reply: 0.2,
  diligence: 0.2,
  react: 0.1,
  curiosity: 0.2,
  mark_read: 0.1,
  caution: 0.1,
};

/** Look up intrusiveness by action type and chat type. */
export function getIntrusiveness(action: string, chatType?: string): number {
  if (chatType === 'group') {
    return INTRUSIVENESS_GROUP[action] ?? INTRUSIVENESS[action] ?? 0.5;
  }
  return INTRUSIVENESS[action] ?? 0.5;
}

// ── Configuration ──────────────────────────────────────────────────────────

export interface SocialCostConfig {
  wDist: number;
  wPower: number;
  wImp: number;
  wTemp: number;
  alpha1: number;
  alpha2: number;
  alpha3: number;
  tauDist: number;
  beta1: number;
  beta2: number;
  gamma1: number;
  gamma2: number;
  delta1: number;
  delta2: number;
  lambdaC: number;
  lambda: number;
  window: number;
}

export const DEFAULT_SOCIAL_COST_CONFIG: SocialCostConfig = {
  wDist: 0.3,
  wPower: 0.1,
  wImp: 0.3,
  wTemp: 0.3,
  alpha1: 0.5,
  alpha2: 0.3,
  alpha3: 0.2,
  tauDist: 3600,
  beta1: 0.7,
  beta2: 0.3,
  gamma1: 0.5,
  gamma2: 0.5,
  delta1: 0.7,
  delta2: 0.3,
  lambdaC: 6.0,
  lambda: 1.5,
  window: 1800,
};

// ── Tier helpers ───────────────────────────────────────────────────────────

const TIER_MAX = 500;

const ROLE_RANK: Record<string, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  restricted: 1,
};
const RANK_MAX = 4;

// ── Sub-component: C_dist — social distance ────────────────────────────────

function cDist(
  novaSentWindow: number,
  contactRecvWindow: number,
  tier: number,
  tGap: number,
  cfg: SocialCostConfig,
  isGroup = false,
): number {
  const w = Math.max(cfg.window, 1);

  // Reciprocity imbalance: Nova sent too much vs contact sent too little.
  // Clamp to [0, 1] to prevent overflow from long-running sent/recv accumulators.
  // Group chats weaken this signal (×0.3) — group conversation doesn't require 1:1 balance.
  const reciprocityRaw = Math.min(1, Math.abs(novaSentWindow - contactRecvWindow) / w);
  const reciprocity = reciprocityRaw * (isGroup ? 0.3 : 1.0);

  // Tier distance: farther tier → greater social distance.
  // Groups weaken this (×0.4) — shared-space speaking threshold is lower than private outreach.
  const tierDist = (1 - tier / TIER_MAX) * (isGroup ? 0.4 : 1.0);

  // Time-gap sigmoid: long silence → greater distance.
  // Offset sigmoid so tGap=0 is near 0 rather than 0.5.
  // Per-tier τ_d = θ_c / 2 so the sigmoid midpoint aligns with each tier's cooling threshold.
  const thetaForTier = DUNBAR_TIER_THETA[tier as DunbarTier];
  const effectiveTauDist = thetaForTier != null ? thetaForTier / 2 : cfg.tauDist;
  const sigmoid =
    1 / (1 + Math.exp(-(tGap - 2 * effectiveTauDist) / Math.max(effectiveTauDist, 1)));

  return cfg.alpha1 * reciprocity + cfg.alpha2 * tierDist + cfg.alpha3 * sigmoid;
}

// ── Sub-component: C_power — power differential ────────────────────────────

function cPower(
  novaRank: number,
  targetRank: number,
  isTargetTerritory: boolean,
  cfg: SocialCostConfig,
): number {
  const rankDiff = Math.max(0, targetRank - novaRank) / RANK_MAX;
  const territory = isTargetTerritory ? 1 : 0;
  return cfg.beta1 * rankDiff + cfg.beta2 * territory;
}

// ── Sub-component: C_imp — action intrusiveness ─────────────────────────────

function cImp(
  actionType: string,
  contextSignal: number,
  cfg: SocialCostConfig,
  chatType?: string,
): number {
  const intrusivenessScore = getIntrusiveness(actionType, chatType);
  return cfg.gamma1 * contextSignal + cfg.gamma2 * intrusivenessScore;
}

// ── Sub-component: C_temp — temporal penalty ───────────────────────────────

function cTemp(
  actionDensity: number,
  maxSimilarity: number,
  cfg: SocialCostConfig,
  opponentLambda?: number,
  windowS: number = 1800,
): number {
  const densityPenalty = 1 - Math.exp(-actionDensity / Math.max(cfg.lambdaC, 0.01));

  // Asymmetry detection: if Nova's sending rate exceeds the contact's,
  // increase C_temp to suppress over-sending. If Nova is under-sending,
  // decrease C_temp to encourage replies.
  let adjustedDensity = densityPenalty;
  if (opponentLambda != null) {
    const novaRate = actionDensity / windowS;
    const maxRate = Math.max(novaRate, opponentLambda, 1e-12);
    const asymmetry = (novaRate - opponentLambda) / maxRate;
    adjustedDensity = densityPenalty * (1 + 0.3 * Math.max(-1, Math.min(1, asymmetry)));
  }

  return cfg.delta1 * adjustedDensity + cfg.delta2 * maxSimilarity;
}

function privateChannelIdForContact(contactId: string): string | null {
  if (!contactId.startsWith('qq:user:')) return null;
  return `qq:private:${qqIdFromNodeId(contactId)}`;
}

function resolveSocialCostTarget(
  G: WorldModel,
  targetId: string,
): { channelId: string | null; contactId: string | null } {
  if (!G.has(targetId)) return { channelId: null, contactId: null };

  const nodeType = G.getNodeType(targetId);
  if (nodeType === 'channel') {
    return { channelId: targetId, contactId: contactIdForPrivateChannel(targetId) };
  }
  if (nodeType === 'contact') {
    const channelId = privateChannelIdForContact(targetId);
    return {
      channelId: channelId && G.has(channelId) && G.getNodeType(channelId) === 'channel' ? channelId : null,
      contactId: targetId,
    };
  }
  return { channelId: null, contactId: null };
}

// ── Context signal extraction ──────────────────────────────────────────────

/**
 * Extract context signal C_ctx ∈ [0, 1] from the world graph.
 *
 * Derived from factual panel signals: grief / unanswered / endpoint scenarios
 * that indicate "now may not be a good time to disturb."
 */
function extractContextSignal(
  G: WorldModel,
  targetId: string,
  isGroup = false,
): number {
  const { channelId, contactId } = resolveSocialCostTarget(G, targetId);
  if (!channelId && !contactId) return 0.5;

  let signal = 0;
  let count = 0;

  // Risk level from group_risk_level on channel.
  if (channelId) {
    const channel = G.getChannel(channelId);
    const riskLevel = channel.group_risk_level ?? '';
    if (riskLevel === 'high') {
      signal += 0.8;
      count++;
    } else if (riskLevel === 'medium') {
      signal += 0.4;
      count++;
    } else if (riskLevel === 'low') {
      signal += 0.1;
      count++;
    }
  }

  // Conversation state: no active conversation → cold start, higher barrier.
  // Groups: no active conversation is normal (90-9-1 rule), cost is lower.
  if (channelId) {
    const activeConv = getActiveConversation(G, channelId);
    if (!activeConv) {
      let hasClosing = false;
      for (const convId of G.getEntitiesByType('conversation')) {
        const convAttrs = G.getConversation(convId);
        if (convAttrs.channel_id === channelId && convAttrs.state === 'closing') {
          hasClosing = true;
          break;
        }
      }
      if (hasClosing) {
        signal += 0.7;
        count++;
      } else {
        signal += isGroup ? 0.2 : 0.6;
        count++;
      }
    }
  } else if (!isGroup) {
    signal += 0.6;
    count++;
  }

  // Grief / sensitive state: detect negative mood from associated contact.
  if (contactId && G.has(contactId)) {
    const contact = G.getContact(contactId);
    // Nova contacts don't have mood_valence; skip this check.
    // Reserved for future mood tracking integration.
    void contact;
  }

  return count > 0 ? signal / count : 0.5;
}

// ── Similarity helper ──────────────────────────────────────────────────────

function maxSimilarity(actionType: string, recentActionTypes: string[]): number {
  for (const recent of recentActionTypes) {
    if (recent === actionType) return 1;
  }
  return 0;
}

// ── Main function ──────────────────────────────────────────────────────────

/**
 * Compute the social cost of executing an action against a target entity.
 *
 * Pure function: reads G + parameters, no side effects.
 *
 * @param G        — world graph (read-only)
 * @param targetId — target entity id (channel or contact)
 * @param actionType — action type (voice name or specific action)
 * @param nowMs    — current wall-clock time
 * @param recentActions — recent action records for temporal penalty
 * @param config   — social cost configuration
 * @param chatType — target chat type (default "private")
 * @returns social cost ∈ [0, ~1]
 */
export function computeSocialCost(
  G: WorldModel,
  targetId: string,
  actionType: string,
  nowMs: number,
  recentActions: Array<{ ms?: number; action: string }>,
  config: SocialCostConfig = DEFAULT_SOCIAL_COST_CONFIG,
  chatType?: string,
): number {
  const isGroup = chatType === 'group';
  const { channelId, contactId } = resolveSocialCostTarget(G, targetId);

  // ── C_dist: social distance ──
  let novaSentWindow = 0;
  let contactRecvWindow = 0;
  let tier: number = isGroup ? 150 : 50;

  if (channelId) {
    const channel = G.getChannel(channelId);
    // Nova's ChannelAttrs tracks contact_recv_window (messages received from contact).
    // nova_sent_window is not yet tracked separately; default to 0 for reciprocity
    // (no penalty when we can't measure the imbalance).
    contactRecvWindow = channel.contact_recv_window;
    tier = channel.tier_contact;
  }

  // Prefer contact tier if available.
  if (contactId && G.has(contactId)) {
    tier = G.getContact(contactId).tier;
  }

  // Time gap since last interaction.
  let lastInteractionMs = 0;
  if (channelId) {
    const novaMs = readNodeMs(G, channelId, 'last_nova_action_ms');
    const directedMs = readNodeMs(G, channelId, 'last_directed_ms');
    lastInteractionMs = Math.max(novaMs, directedMs);
  } else if (contactId) {
    const novaMs = readNodeMs(G, contactId, 'last_nova_action_ms');
    const directedMs = readNodeMs(G, contactId, 'last_directed_ms');
    lastInteractionMs = Math.max(novaMs, directedMs);
  }
  const tGap = elapsedS(nowMs, lastInteractionMs);

  const dist = cDist(novaSentWindow, contactRecvWindow, tier, tGap, config, isGroup);

  // ── C_power: power differential ──
  const novaRole = channelId
    ? String(G.getChannel(channelId).nova_role_in_group ?? 'member')
    : 'member';
  const novaRank: number = ROLE_RANK[novaRole] !== undefined ? ROLE_RANK[novaRole] : 2;
  const targetRank: number = 2; // ROLE_RANK.member
  let isTargetTerritory = false;

  if (isGroup && channelId) {
    // New member (< 7 days) in group → "intruder" territory cost.
    // Nova doesn't track join_ms on channels; skip territory check for now.
    isTargetTerritory = false;
  }

  const power = cPower(novaRank, targetRank, isTargetTerritory, config);

  // ── C_imp: action intrusiveness ──
  const contextSignal = extractContextSignal(G, targetId, isGroup);
  const imp = cImp(actionType, contextSignal, config, chatType);

  // ── C_temp: temporal penalty ──
  const windowStartMs = nowMs - config.window * 1000;
  const actionsInWindow = recentActions.filter(
    (a) => (a.ms ?? 0) > windowStartMs,
  );
  const actionDensity = actionsInWindow.length;
  const typesInWindow = actionsInWindow.map((a) => a.action);
  const maxSim = maxSimilarity(actionType, typesInWindow);

  // Opponent Hawkes λ for asymmetry detection.
  let opponentLambda: number | undefined;
  if (contactId && G.has(contactId)) {
    const contact = G.getContact(contactId);
    if (contact.hawkes_last_event_ms && contact.hawkes_last_event_ms > 0) {
      // Simplified: use carry as a rough intensity proxy.
      opponentLambda = contact.hawkes_carry > 0 ? contact.hawkes_carry : undefined;
    }
  }
  const temp = cTemp(actionDensity, maxSim, config, opponentLambda, config.window);

  // ── Weighted sum ──
  return config.wDist * dist + config.wPower * power + config.wImp * imp + config.wTemp * temp;
}
