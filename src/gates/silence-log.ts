import type { SilenceLevel } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { SilenceLogRecord } from '../world/entities';
import type { GateContext, GateDecision } from './gates';

export function buildSilenceLogEntry(input: {
  tick: number;
  targetId: string;
  decision: GateDecision;
  context: GateContext;
}): SilenceLogRecord {
  return {
    tick: input.tick,
    target_id: input.targetId,
    level: input.decision.level,
    reason: input.decision.reason,
    created_ms: input.context.nowMs,
    values: {
      ...input.decision.values,
      reasons: input.decision.reasons,
      pressure: pressureValues(input.context.pressure),
      voice: voiceValues(input.context.voice),
      eventId: input.context.event?.id,
      messageId: input.context.event?.messageId,
      channelId: input.context.event?.chatId ?? input.context.channel?.id,
      chatType: input.context.event?.chatType ?? input.context.channel?.chat_type,
      senderId: input.context.event?.senderId,
      directed: input.context.event?.isDirected,
      reason: input.context.reason,
    },
  };
}

function pressureValues(pressure: PressureSnapshot): Record<string, number> {
  return {
    tick: pressure.tick,
    createdMs: pressure.createdMs,
    p1: pressure.p1,
    p2: pressure.p2,
    p3: pressure.p3,
    p4: pressure.p4,
    p5: pressure.p5,
    p6: pressure.p6,
    pProspect: pressure.pProspect,
    api: pressure.api,
    apiPeak: pressure.apiPeak,
  };
}

function voiceValues(voice: VoiceSelectionResult): Record<string, unknown> {
  return {
    selected: voice.selected,
    temperature: voice.temperature,
    probabilities: voice.probabilities,
    loudness: voice.loudness,
    fatigue: voice.fatigue,
    reasons: voice.reasons,
  };
}

export type { SilenceLevel };
