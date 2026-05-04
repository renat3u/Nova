//
// DecisionContext builder — assembles the complete snapshot that the decision
// agent receives.  Aggregates world, memory, relationship, pressure, candidates,
// threads, and conversation state into a single DecisionContext.
//

import type { NovaMessageEvent, NovaRuntimeConfig } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { Desire } from '../engine/desire';
import type { ActionCandidate } from '../engine/tick-plan';
import type { WorldModel } from '../world/model';
import type { NovaWorldRepository } from '../world/repository';
import type { MemoryService } from '../memory/memory-service';
import { describeMood, type MoodTracker } from '../engine/mood';
import { readRV, computeCloseness, classifyCloseness } from '../world/relationship-vector';
import type { GateDecision } from '../gates/gates';
import type { DecisionContext } from './decision-schema';

export interface BuildDecisionContextParams {
  tick: number;
  reason: 'message' | 'scheduled';
  nowMs: number;
  event?: NovaMessageEvent;
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
  desires: Desire[];
  candidates: ActionCandidate[];
  world: WorldModel;
  repository: NovaWorldRepository;
  memoryService: MemoryService;
  moodTracker?: MoodTracker;
  config: NovaRuntimeConfig;
  algorithmicGateAudit?: GateDecision[];
  afterward?: string;
  situationBriefing?: string[];
  rhythmPattern?: string;
  speakingAlone?: boolean;
  groupProfileSummary?: string | null;
  activeThreads?: string[];
  relationshipFacts?: string[];
  /** Relationship facts for mentioned third-party contacts. Index-aligned with event.mentionedContactIds. */
  mentionedRelationshipFacts?: Map<string, string[]>;
  /** Recently seen stickers in the current channel, for sticker-aware decisions. */
  recentStickersInChannel?: Array<{
    summary: string;
    emojiPackageId: number;
    emojiId: string;
    seenCount: number;
    lastSeenMs: number;
  }>;
}

export function buildDecisionContext(params: BuildDecisionContextParams): DecisionContext {
  const scene: 'private' | 'group' = params.event
    ? params.event.chatType
    : params.candidates[0]?.scene ?? 'private';

  // Build pressure explanations
  const explanations = buildPressureExplanations(params.pressure);

  // Build top contributors
  const topContributors = buildTopContributors(params.pressure);

  // Build event context with mentioned contacts
  const mentionedContacts = params.event?.mentionedContactIds
    ?.map((contactId) => {
      if (!params.world.has(contactId) || params.world.getNodeType(contactId) !== 'contact') return null;
      const contact = params.world.getContact(contactId);
      const displayName = contact.name ?? contact.nickname ?? contactId;
      const facts = params.mentionedRelationshipFacts?.get(contactId) ?? [];
      return {
        contactId,
        displayName,
        relationshipFact: facts.length > 0 ? facts.join('; ') : null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const event = params.event ? buildEventContext(params.event, mentionedContacts) : undefined;

  // Build mood context
  const mood = params.moodTracker
    ? (() => {
        const current = params.moodTracker!.getCurrent();
        return {
          selfMood: current.valence,
          arousal: current.arousal,
          label: describeMood(current.valence),
        };
      })()
    : undefined;

  // Build candidates with IDs
  const candidates = params.candidates.map((c, i) => ({
    id: c.targetId ? `candidate_${i}_${c.action}_${c.targetId}` : `candidate_${i}_${c.action}`,
    action: c.action,
    targetId: c.targetId,
    targetLabel: c.targetId ? resolveTargetLabel(params.world, c.targetId) : undefined,
    scene: c.scene,
    desireType: c.desireType,
    urgency: c.urgency,
    reason: c.reason,
    iausScore: c.iausScore ? {
      rawScore: c.iausScore.rawScore,
      compensatedScore: c.iausScore.compensatedScore,
      effectiveScore: c.iausScore.effectiveScore,
      postFairnessScore: c.iausScore.postFairnessScore,
      selectionScore: c.iausScore.selectionScore,
      legacyNetSocialValue: c.iausScore.legacyNetSocialValue,
      deltaP: c.iausScore.deltaP,
      socialCost: c.iausScore.socialCost,
      netValue: c.iausScore.netValue,
      considerations: c.iausScore.considerations,
      selectedProbability: c.iausScore.selectedProbability,
      bottleneck: c.iausScore.bottleneck,
      scoringMode: c.iausScore.scoringMode,
      multipliers: c.iausScore.multipliers,
    } : null,
    algorithmicGate: params.algorithmicGateAudit?.[i] ? {
      allow: params.algorithmicGateAudit[i]!.allow,
      level: params.algorithmicGateAudit[i]!.level,
      reason: params.algorithmicGateAudit[i]!.reason,
      reasons: params.algorithmicGateAudit[i]!.reasons,
      values: params.algorithmicGateAudit[i]!.values,
    } : undefined,
  }));

  // Build memory
  const working = params.memoryService.getWorkingMemory(7).map((item) => item.content);
  const longTerm = params.memoryService.getRelevantFacts({ limit: 8 }).map((f) => f.content);

  // Upcoming events for this sender
  const upcomingEvents = params.event?.senderId
    ? params.repository.listUpcomingEvents(params.nowMs, 30 * 24 * 3600 * 1000)
        .filter((e) => e.targetId === params.event!.senderId)
        .map((e) => ({ event: e.event, dateDescription: e.dateDescription }))
        .slice(0, 3)
    : undefined;

  // Build recent messages
  const channelId = params.event?.chatId ?? params.candidates[0]?.targetId;
  const recentMessages = channelId
    ? params.repository.getRecentMessages(channelId, 12).map((msg) => ({
        senderName: msg.sender_id ? resolveContactQQ(params.world, msg.sender_id) : undefined,
        text: msg.text,
        isNova: false,
      }))
    : [];

  // Build relationship
  const relationshipFacts = params.relationshipFacts ?? [];
  const groupProfileSummary = params.groupProfileSummary ?? null;
  const activeThreads = params.activeThreads ?? (channelId
    ? params.repository.getActiveThreadsForChannel(channelId, params.nowMs, 3).map((t) => t.summary)
    : []);

  // Compute closeness level for the current sender (message tick) or primary target
  let closenessLevel: string | undefined;
  let closenessScore: number | undefined;
  const senderId = params.event?.senderId;
  if (senderId && params.world.has(senderId) && params.world.getNodeType(senderId) === 'contact') {
    const rv = readRV(params.world.getContact(senderId));
    closenessScore = computeCloseness(rv);
    closenessLevel = classifyCloseness(closenessScore);
  }

  return {
    tick: params.tick,
    reason: params.reason,
    nowMs: params.nowMs,
    scene,
    event,
    pressure: {
      p1: params.pressure.p1,
      p2: params.pressure.p2,
      p3: params.pressure.p3,
      p4: params.pressure.p4,
      p5: params.pressure.p5,
      p6: params.pressure.p6,
      p7: params.pressure.p7 ?? 0,
      p8: params.pressure.p8 ?? 0,
      pProspect: params.pressure.pProspect,
      api: params.pressure.api,
      apiPeak: params.pressure.apiPeak,
      explanations,
      ...(topContributors.length > 0 ? { topContributors } : {}),
    },
    mood,
    voice: {
      selected: params.voice.selected,
      iausAction: params.voice.iausAction,
      probabilities: params.voice.probabilities,
      temperature: params.voice.temperature,
    },
    desires: params.desires.map((d) => ({
      type: d.type,
      urgency: d.urgency,
      pressureValue: d.pressureValue,
      targetId: d.targetId,
      source: d.source,
      reason: d.reason,
    })),
    candidates,
    relationship: {
      facts: relationshipFacts,
      groupProfileSummary,
      activeThreads: activeThreads.length > 0 ? activeThreads.filter((t): t is NonNullable<typeof t> => t != null).map((t) => typeof t === 'string' ? t : (t as { summary?: string }).summary ?? String(t)) : undefined,
      ...(closenessLevel ? { closenessLevel, closenessScore } : {}),
    },
    memory: {
      working,
      longTerm,
      ...(upcomingEvents && upcomingEvents.length > 0 ? { upcomingEvents } : {}),
    },
    conversation: {
      recentMessages,
      rhythmPattern: params.rhythmPattern,
      speakingAlone: params.speakingAlone,
      afterward: params.afterward,
      situationBriefing: params.situationBriefing,
      ...(params.recentStickersInChannel && params.recentStickersInChannel.length > 0
        ? { recentStickersInChannel: params.recentStickersInChannel }
        : {}),
    },
    configHints: {
      maxReplyLength: params.config.maxReplyLength,
      gatewayMode: params.config.gatewayMode,
      guardrails: params.config.decisionGuardrails,
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildPressureExplanations(pressure: PressureSnapshot): Record<string, string> {
  return {
    p1: `P1 attention debt: ${pressure.p1.toFixed(3)} — accumulated unattended interaction pressure`,
    p2: `P2 information pressure: ${pressure.p2.toFixed(3)} — uncertainty / information gap`,
    p3: `P3 relationship cooling: ${pressure.p3.toFixed(3)} — relationship cooling over time`,
    p4: `P4 thread divergence: ${pressure.p4.toFixed(3)} — unfinished or drifting topic`,
    p5: `P5 response obligation: ${pressure.p5.toFixed(3)} — obligation to respond`,
    p6: `P6 curiosity: ${pressure.p6.toFixed(3)} — curiosity / exploration`,
    p7: `P7 loneliness: ${(pressure.p7 ?? 0).toFixed(3)} — inner loneliness from prolonged silence of close ones`,
    p8: `P8 fear of being forgotten: ${(pressure.p8 ?? 0).toFixed(3)} — anxiety when outreach goes unanswered`,
    pProspect: `P_prospect: ${pressure.pProspect.toFixed(3)} — expected future pressure if Nova does nothing`,
    api: `API: ${pressure.api.toFixed(3)} (peak: ${pressure.apiPeak.toFixed(3)}) — aggregate inner pressure`,
  };
}

function buildTopContributors(pressure: PressureSnapshot): Array<{
  dimension: string;
  targetId: string;
  value: number;
  label?: string;
}> {
  const contributors: Array<{ dimension: string; targetId: string; value: number; label?: string }> = [];
  if (!pressure.contributions) return contributors;

  const dims = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'] as const;
  for (const dim of dims) {
    const entries = pressure.contributions[dim];
    if (!entries) continue;
    // Find the entry with the maximum value for this dimension
    let maxEntry: { targetId: string; value: number; label?: string } | null = null;
    for (const [targetId, value] of Object.entries(entries)) {
      if (typeof value !== 'number') continue;
      if (!maxEntry || value > maxEntry.value) {
        maxEntry = { targetId, value };
      }
    }
    if (maxEntry && maxEntry.value > 0.01) {
      contributors.push({
        dimension: dim,
        targetId: maxEntry.targetId,
        value: maxEntry.value,
        label: maxEntry.label,
      });
    }
  }

  return contributors;
}

function buildEventContext(
  event: NovaMessageEvent,
  mentionedContacts?: Array<{ contactId: string; displayName: string; relationshipFact: string | null }>,
): DecisionContext['event'] {
  const stickerCtx = event.stickers && event.stickers.length > 0
    ? event.stickers.map((s) => ({
        summary: s.summary ?? '',
        emojiPackageId: s.emojiPackageId,
        emojiId: s.emojiId,
      }))
    : undefined;

  return {
    id: event.id,
    messageId: event.messageId,
    chatType: event.chatType,
    chatId: event.chatId,
    groupId: event.groupId,
    groupName: event.groupName,
    senderId: event.senderId,
    senderQQ: event.senderQQ,
    senderName: event.senderName,
    text: event.text,
    isDirected: event.isDirected,
    mentionedSelf: event.mentionedSelf,
    repliedToSelf: event.repliedToSelf,
    ...(mentionedContacts && mentionedContacts.length > 0 ? { mentionedContacts } : {}),
    ...(stickerCtx ? { stickers: stickerCtx } : {}),
  };
}

function resolveTargetLabel(world: WorldModel, targetId: string): string {
  if (!world.has(targetId)) return targetId;
  const nodeType = world.getNodeType(targetId);
  if (nodeType === 'contact') {
    const contact = world.getContact(targetId);
    return contact.name ?? contact.nickname ?? contact.qq;
  }
  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    return channel.title ?? channel.group_name ?? targetId;
  }
  return targetId;
}

function resolveContactQQ(world: WorldModel, senderId: string): string | undefined {
  if (!world.has(senderId)) return undefined;
  if (world.getNodeType(senderId) === 'contact') {
    return world.getContact(senderId).qq;
  }
  return undefined;
}
