
//
// Nova Step 11: Action queue / Act loop 行动闭环.
//
// The ActLoop is the dequeue-and-execute side of the proactive action pipeline.
// Scheduled ticks enqueue candidates; the ActLoop dequeues them, re-verifies
// that they are still safe to send, executes them through the plugin bridge,
// records the result, and manages the engagement lifecycle.
//
// Flow:
//   ActionQueue (pending)
//    → ActLoop.tick()
//    → pre-send gate re-check
//    → execute via callback (plugin bridge)
//    → recordActionResult (DB + world update)
//    → engagement create / update
//    → queue mark done / failed
//
// Key constraints:
//   - NEVER send directly from scheduled tick — always go through the queue.
//   - Re-check gates before sending (state may have changed since enqueue).
//   - Do not retry on failure (the next scheduled tick will produce fresh candidates).
//   - Respect MAX_CONCURRENT_ENGAGEMENTS.
//   - Failed sends count toward the failure limit (rate-limit backoff).

import type { NovaLogger } from '../core/logger';
import type { NovaRuntimeConfig } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { GateDecision } from '../gates/gates';
import {
  evaluateProactiveEnabledGate,
  evaluateWhitelistGate,
  evaluateQQRisk,
  SILENCE_REASONS,
} from '../gates/gates';
import type { RateLimitState } from '../gates/rate-limit';
import type { ChannelAttrs } from '../world/entities';
import type { NovaWorldRepository } from '../world/repository';
import type { WorldModel } from '../world/model';
import { qqIdFromNodeId } from '../world/constants';
import { ActionQueue, type QueuedAction } from './action-queue';
import { EngagementSM, MAX_CONCURRENT_ENGAGEMENTS, SWITCH_COST_MS, type EngagementRecord } from './engagement';
import type { SendResult } from './types';

// ── ActLoop context ────────────────────────────────────────────────────────

export interface ActLoopContext {
  actionQueue: ActionQueue;
  world: WorldModel;
  repository: NovaWorldRepository;
  config: NovaRuntimeConfig;
  rateLimit: RateLimitState;
  logger: NovaLogger;
}

// ── Act executor ───────────────────────────────────────────────────────────

/**
 * Callback signature for executing a queued action through the plugin bridge.
 *
 * The ActLoop is core logic and does not know about NapCat / OneBot.
 * The plugin layer provides this callback, which sends the actual QQ message
 * and returns a SendResult.
 */
export type ActExecutor = (action: QueuedAction, channel: ChannelAttrs | undefined) => Promise<SendResult>;

// ── ActLoop result ─────────────────────────────────────────────────────────

export interface ActLoopTickResult {
  /** Whether any action was processed this tick. */
  processed: boolean;
  /** The action that was processed, if any. */
  action?: QueuedAction;
  /** Result of execution. */
  status: 'idle' | 'executed' | 'gate_denied' | 'send_failed' | 'queue_empty';
  /** Gate decision if the action was denied at pre-send check. */
  gateDecision?: GateDecision;
  /** Send result if execution was attempted. */
  sendResult?: SendResult;
  /** Engagement record if one was created or updated. */
  engagement?: EngagementRecord;
  /** Error message if something went wrong. */
  error?: string;
}

// ── ActLoop ────────────────────────────────────────────────────────────────

export class ActLoop {
  private lastSwitchMs = 0;

  /**
   * Process one action from the queue.
   *
   * Called periodically (e.g. by the scheduler).  Each tick processes at most
   * one action.  Returns a detailed result for logging / trace.
   */
  async tick(
    ctx: ActLoopContext,
    execute: ActExecutor,
    nowMs: number = Date.now(),
    _pressure?: PressureSnapshot,
    _voice?: VoiceSelectionResult,
  ): Promise<ActLoopTickResult> {
    // 1. Check whether we can process anything at all.
    if (ctx.actionQueue.pendingCount === 0) {
      return { processed: false, status: 'queue_empty' };
    }

    // 2. Dequeue the next ready action.
    const queued = ctx.actionQueue.dequeue();
    if (!queued) {
      return { processed: false, status: 'queue_empty' };
    }

    // 3. Pre-send gate re-check (configurable via enablePreSendGuardrails).
    //    State may have changed between enqueue and dequeue (config hot-reload,
    //    cooldown expiration, rate-limit window, etc.).
    //    Default: false for agent gateway (guardrails off).
    const candidate = queued.candidate;
    if (ctx.config.enablePreSendGuardrails) {
      const preSendGate = evaluatePreSendGates(ctx, candidate.targetId, candidate.scene, nowMs);
      if (!preSendGate.allow) {
        // Gate denied — mark as failed and record silence.
        ctx.actionQueue.markFailed(queued.id, preSendGate.reason, nowMs);
        ctx.repository.recordSilence({
          tick: queued.tick,
          target_id: candidate.targetId ?? 'act-loop',
          level: preSendGate.level === 'none' ? 'normal' : preSendGate.level,
          reason: `pre_send_${preSendGate.reason}`,
          values: {
            ...preSendGate.values,
            queueId: queued.id,
            originalAction: candidate.action,
            note: 'pre-send gate re-check denied a queued action; state changed between enqueue and dequeue',
          },
          created_ms: nowMs,
        });

        ctx.logger.info('Nova ActLoop pre-send gate denied queued action', {
          queueId: queued.id,
          action: candidate.action,
          targetId: candidate.targetId,
          gateReason: preSendGate.reason,
        });

        // When the failure backoff is triggered, clear all remaining pending.
        if (preSendGate.reason === SILENCE_REASONS.SEND_FAILURE_RISK) {
          const cleared = ctx.actionQueue.clearQueuedCount();
          if (cleared > 0) {
            ctx.repository.recordSilence({
              tick: queued.tick,
              target_id: 'act-loop',
              level: 'safety',
              reason: SILENCE_REASONS.QUEUE_CLEARED_FAILURE_LIMIT,
              values: {
                clearedCount: cleared,
                triggerQueueId: queued.id,
                note: 'cleared remaining pending actions in queue after pre-send failure backoff triggered',
              },
              created_ms: nowMs,
            });
            ctx.logger.warn('Nova ActLoop cleared pending queue on failure backoff', {
              clearedCount: cleared,
              triggerQueueId: queued.id,
            });
          }
        }

        return {
          processed: true,
          action: queued,
          status: 'gate_denied',
          gateDecision: preSendGate,
        };
      }
    }

    // 4. Mark as executing and enforce switch cost.
    ctx.actionQueue.markExecuting(queued.id, nowMs);
    this.enforceSwitchCost(nowMs);

    // 5. Resolve the target channel for the executor.
    const channel = candidate.targetId
      ? resolveChannel(ctx.world, candidate.targetId)
      : undefined;

    // 6. Execute through the plugin bridge.
    let sendResult: SendResult;
    try {
      sendResult = await execute(queued, channel);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      ctx.actionQueue.markFailed(queued.id, errorMsg, nowMs);
      ctx.rateLimit.recordSendFailure();

      ctx.logger.warn('Nova ActLoop execution threw', {
        queueId: queued.id,
        action: candidate.action,
        targetId: candidate.targetId,
        error: errorMsg,
      });

      return {
        processed: true,
        action: queued,
        status: 'send_failed',
        error: errorMsg,
      };
    }

    // 7. Record the result.
    if (sendResult.ok) {
      ctx.actionQueue.markDone(queued.id, nowMs);
      ctx.rateLimit.recordAllowedAction(nowMs);

      // Update world state for the successful send (with thread beat context).
      ctx.repository.markNovaAction(sendResult.targetId, nowMs, {
        proactive: true,
        text: sendResult.text,
        desireType: candidate.desireType,
        urgency: candidate.urgency,
      });

      // Record the action in the persistent log.
      ctx.repository.recordAction({
        tick: queued.tick,
        action_type: 'proactive_send_text',
        target_id: sendResult.targetId,
        text: sendResult.text ?? '',
        status: 'success',
        created_ms: nowMs,
      });

      // Create or update engagement.
      const contactId = resolveContactId(ctx.world, candidate.targetId);
      const engagement = EngagementSM.create({
        channelId: sendResult.targetId,
        contactId,
        kind: 'proactive_action',
        proactiveActionId: queued.id,
        nowMs,
      });

      ctx.logger.info('Nova ActLoop executed proactive action', {
        queueId: queued.id,
        tick: queued.tick,
        action: candidate.action,
        targetId: sendResult.targetId,
        desireType: candidate.desireType,
        scene: candidate.scene,
        messageId: sendResult.messageId,
        engagementState: engagement.state,
      });

      return {
        processed: true,
        action: queued,
        status: 'executed',
        sendResult,
        engagement,
      };
    }

    // Send failed.
    ctx.actionQueue.markFailed(queued.id, sendResult.error ?? 'send_failed', nowMs);
    ctx.rateLimit.recordSendFailure();

    ctx.repository.recordAction({
      tick: queued.tick,
      action_type: 'proactive_send_text',
      target_id: sendResult.targetId,
      text: sendResult.text ?? '',
      status: 'failed',
      error: sendResult.error ?? 'unknown send failure',
      created_ms: nowMs,
    });

    ctx.logger.warn('Nova ActLoop send failed', {
      queueId: queued.id,
      action: candidate.action,
      targetId: candidate.targetId,
      error: sendResult.error,
    });

    return {
      processed: true,
      action: queued,
      status: 'send_failed',
      sendResult,
      error: sendResult.error,
    };
  }

  /**
   * Enforce minimum time between action executions.
   * Returns the delay in ms that was waited (0 if no wait needed).
   */
  private enforceSwitchCost(nowMs: number): number {
    const elapsed = nowMs - this.lastSwitchMs;
    this.lastSwitchMs = nowMs;
    return elapsed < SWITCH_COST_MS ? 0 : 0; // Non-blocking — we track but don't sleep.
  }
}

// ── Pre-send gate re-check ─────────────────────────────────────────────────

/**
 * Re-check critical gates before executing a queued action.
 *
 * Between enqueue and dequeue, runtime state may have changed:
 *   - proactiveEnabled could have been turned off (config hot-reload)
 *   - whitelist could have been modified
 *   - cooldown could have been triggered by a message reply
 *   - failure limit could have been reached
 *
 * This is a lightweight re-check of the most important gates;
 * it does not re-run the full candidate gate chain (IAUS, social value, etc.)
 * since those were already validated at enqueue time and the pressure snapshot
 * is still valid.
 */
function evaluatePreSendGates(
  ctx: ActLoopContext,
  targetId: string | null,
  scene: 'private' | 'group' | undefined,
  nowMs: number,
): GateDecision {
  // 1. Proactive enabled — master switch.
  const proactiveGate = evaluateProactiveEnabledGate(ctx.config);
  if (proactiveGate) return proactiveGate;

  // 2. Scheduled actions enabled.
  if (!ctx.config.enableScheduledActions) {
    return {
      allow: false,
      level: 'hard',
      reason: SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED,
      reasons: [SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED],
      values: { enableScheduledActions: false },
    };
  }

  // 3. Whitelist re-check for private targets.
  if (scene === 'private' && targetId) {
    const contactQQ = resolveTargetQQForPreSend(ctx.world, targetId);
    const whitelistGate = evaluateWhitelistGate(
      targetId,
      contactQQ,
      ctx.config.proactiveWhitelistQQ,
    );
    if (whitelistGate) return whitelistGate;
  }

  // 4. Consecutive send failure backoff.
  if (ctx.rateLimit.hasFailureBackoff(ctx.config)) {
    return {
      allow: false,
      level: 'safety',
      reason: SILENCE_REASONS.SEND_FAILURE_RISK,
      reasons: [SILENCE_REASONS.SEND_FAILURE_RISK],
      values: {
        note: 'consecutive send failure limit reached; backing off',
      },
    };
  }

  // 5. QQ risk (rate limit / flood check, without a message event).
  const qqRisk = evaluateQQRisk({
    nowMs,
    reason: 'scheduled',
    pressure: {
      p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0,
      p7: 0, p8: 0,
      pProspect: 0, api: 0, apiPeak: 0,
      tick: 0, createdMs: nowMs, contributions: {},
    },
    voice: {
      selected: 'diligence' as const,
      iausAction: 'diligence' as const,
      loudness: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
      fatigue: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
      probabilities: { diligence: 1, curiosity: 0, sociability: 0, caution: 0 },
      temperature: 1,
      reasons: [],
    },
    config: ctx.config,
    rateLimit: ctx.rateLimit,
  });
  if (!qqRisk.pass) {
    return {
      allow: false,
      level: qqRisk.level,
      reason: qqRisk.reason,
      reasons: [qqRisk.reason],
      values: qqRisk.values,
    };
  }

  // 6. Per-channel active cooling check.
  if (targetId && ctx.world.has(targetId) && ctx.world.getNodeType(targetId) === 'channel') {
    const channel = ctx.world.getChannel(targetId);
    const lastActionMs = channel.last_nova_action_ms;
    if (lastActionMs !== undefined && lastActionMs > 0) {
      const cooldownMs = channel.chat_type === 'group'
        ? ctx.config.groupCooldownMs
        : ctx.config.privateCooldownMs;
      const elapsedMs = nowMs - lastActionMs;
      if (elapsedMs < cooldownMs) {
        return {
          allow: false,
          level: 'hard',
          reason: SILENCE_REASONS.ACTIVE_COOLING,
          reasons: [SILENCE_REASONS.ACTIVE_COOLING],
          values: {
            elapsedMs,
            cooldownMs,
            lastNovaActionMs: lastActionMs,
            note: 'cooldown re-check at pre-send: state changed since enqueue',
          },
        };
      }
    }
  }

  return {
    allow: true,
    level: 'none',
    reason: SILENCE_REASONS.ALLOWED,
    reasons: [SILENCE_REASONS.ALLOWED],
    values: { note: 'pre-send gate re-check passed' },
  };
}

// ── Build NovaAction from QueuedAction ─────────────────────────────────────

/**
 * Convert a QueuedAction into the plugin-executable format used by sendText().
 * The caller (plugin layer) uses this to construct the actual send_text target
 * and text before calling into the NapCat bridge.
 */
export function queuedActionToSendTarget(queued: QueuedAction, channel: ChannelAttrs | undefined) {
  const candidate = queued.candidate;
  const targetId = candidate.targetId ?? '';
  const scene = candidate.scene ?? (channel?.chat_type ?? 'private');

  if (scene === 'group') {
    const groupId = channel?.group_id ?? qqIdFromNodeId(targetId);
    return {
      chatType: 'group' as const,
      groupId,
      channelId: channel?.id ?? targetId,
      userId: undefined,
    };
  }

  const userId = channel?.chat_type === 'private'
    ? qqIdFromNodeId(channel.id)
    : targetId.startsWith('qq:user:')
      ? qqIdFromNodeId(targetId)
      : targetId.startsWith('qq:private:')
        ? qqIdFromNodeId(targetId)
        : undefined;
  const channelId = channel?.chat_type === 'private'
    ? channel.id
    : userId
      ? `qq:private:${userId}`
      : targetId;
  return {
    chatType: 'private' as const,
    userId,
    channelId,
    groupId: undefined,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveChannel(world: WorldModel, targetId: string): ChannelAttrs | undefined {
  if (!world.has(targetId)) return undefined;
  if (world.getNodeType(targetId) === 'channel') return world.getChannel(targetId);
  return undefined;
}

function resolveContactId(world: WorldModel, targetId: string | null): string | null {
  if (!targetId) return null;
  if (!world.has(targetId)) return null;

  const nodeType = world.getNodeType(targetId);
  if (nodeType === 'contact') return targetId;

  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    if (channel.chat_type === 'private') {
      const contactId = `qq:user:${qqIdFromNodeId(targetId)}`;
      if (world.has(contactId) && world.getNodeType(contactId) === 'contact') {
        return contactId;
      }
    }
  }

  return null;
}

function resolveTargetQQForPreSend(world: WorldModel, targetId: string): string | null {
  if (!world.has(targetId)) return null;
  const nodeType = world.getNodeType(targetId);

  if (nodeType === 'contact') {
    return world.getContact(targetId).qq;
  }

  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    if (channel.chat_type === 'private') {
      return qqIdFromNodeId(targetId);
    }
    return null;
  }

  return null;
}

// ── Re-export for convenience ──────────────────────────────────────────────

export { MAX_CONCURRENT_ENGAGEMENTS };
export { EngagementSM } from './engagement';
export type { EngagementRecord } from './engagement';
