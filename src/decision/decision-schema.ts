//
// Decision Agent schema — structured input/output types for the LLM decision layer.
//
// DecisionContext is the complete system-computed snapshot passed to the
// decision LLM.  DecisionAgentResponse is the strictly-typed JSON the LLM
// must return.  Neither is user-visible; both are internal to the gateway.
//

// ── Tick type ──────────────────────────────────────────────────────────────

export type DecisionTickReason = 'message' | 'scheduled';
export type DecisionScene = 'private' | 'group';

// ── Action type ────────────────────────────────────────────────────────────

export type DecisionActionType =
  | 'silence'
  | 'observe'
  | 'wait_reply'
  | 'reply'
  | 'ask'
  | 'proactive'
  | 'cool_down';

export const DECISION_ACTIONS: ReadonlySet<string> = new Set([
  'silence',
  'observe',
  'wait_reply',
  'reply',
  'ask',
  'proactive',
  'cool_down',
]);

export const TEXT_GENERATING_ACTIONS: ReadonlySet<string> = new Set([
  'reply',
  'ask',
  'proactive',
]);

export const NON_TEXT_ACTIONS: ReadonlySet<string> = new Set([
  'silence',
  'observe',
  'wait_reply',
  'cool_down',
]);

// ── Decision context ──────────────────────────────────────────────────────

export interface DecisionContext {
  tick: number;
  reason: DecisionTickReason;
  nowMs: number;
  scene: DecisionScene;

  event?: {
    id: string;
    messageId: string;
    chatType: 'private' | 'group';
    chatId: string;
    groupId?: string;
    groupName?: string;
    senderId: string;
    senderQQ: string;
    senderName?: string;
    text: string;
    isDirected: boolean;
    mentionedSelf: boolean;
    repliedToSelf: boolean;
    /** Contacts @-mentioned in this message that Nova knows. */
    mentionedContacts?: Array<{
      contactId: string;
      displayName: string;
      relationshipFact: string | null;
    }>;
    /** Stickers in this message, with descriptions. */
    stickers?: Array<{
      summary: string;
      emojiPackageId: number;
      emojiId: string;
    }>;
  };

  pressure: {
    p1: number;
    p2: number;
    p3: number;
    p4: number;
    p5: number;
    p6: number;
    p7: number;
    p8: number;
    pProspect: number;
    api: number;
    apiPeak: number;
    explanations: Record<string, string>;
    topContributors?: Array<{
      dimension: string;
      targetId: string;
      value: number;
      label?: string;
    }>;
  };

  mood?: {
    selfMood?: number;
    arousal?: number;
    label?: string;
  };

  voice: {
    selected: string;
    iausAction: string | null;
    probabilities: Record<string, number>;
    temperature: number;
  };

  desires: Array<{
    type: string;
    urgency: string;
    pressureValue: number;
    targetId: string | null;
    source: string;
    reason: string;
  }>;

  candidates: Array<{
    id: string;
    action: string;
    targetId: string | null;
    targetLabel?: string;
    scene?: 'private' | 'group';
    desireType?: string;
    urgency?: string;
    reason: string;
    iausScore?: {
      rawScore: number;
      compensatedScore?: number;
      effectiveScore?: number;
      postFairnessScore?: number;
      selectionScore?: number;
      legacyNetSocialValue?: number;
      deltaP: number;
      socialCost: number;
      netValue: number;
      considerations?: Record<string, number>;
      selectedProbability?: number;
      bottleneck?: string;
      scoringMode?: string;
      multipliers?: Record<string, number>;
    } | null;
    algorithmicGate?: {
      allow: boolean;
      level: string;
      reason: string;
      reasons: string[];
      values: Record<string, unknown>;
    };
  }>;

  relationship: {
    facts: string[];
    groupProfileSummary?: string | null;
    activeThreads?: string[];
    closenessLevel?: string;
    closenessScore?: number;
  };

  memory: {
    working: string[];
    longTerm: string[];
    upcomingEvents?: Array<{
      event: string;
      dateDescription: string;
    }>;
  };

  conversation: {
    recentMessages: Array<{
      senderName?: string;
      text: string;
      isNova?: boolean;
    }>;
    rhythmPattern?: string;
    speakingAlone?: boolean;
    afterward?: string;
    situationBriefing?: string[];
    /** Recently seen stickers in this channel (up to 8). */
    recentStickersInChannel?: Array<{
      summary: string;
      emojiPackageId: number;
      emojiId: string;
      seenCount: number;
      lastSeenMs: number;
    }>;
  };

  configHints: {
    maxReplyLength: number;
    gatewayMode: 'algorithmic' | 'agent';
    guardrails: 'off' | 'soft' | 'hard';
  };
}

// ── Decision agent response ───────────────────────────────────────────────

export interface DecisionAgentResponse {
  action: DecisionActionType;

  /** Candidate id from context.candidates, if choosing an existing candidate. */
  candidateId?: string;

  /** Required for reply / ask / proactive when candidateId is absent. */
  targetId?: string | null;

  /** Whether the system should call the normal responder LLM to generate text. */
  generateText: boolean;

  /** Optional direct instruction passed to responder prompt. */
  responderIntent?: string;

  /** Human-readable private reason for trace only. Never sent to QQ. */
  reason: string;

  /** 0-1 confidence. */
  confidence: number;

  /** Internal posture after this decision. */
  afterward?: 'done' | 'waiting_reply' | 'watching' | 'cooling_down';

  /** Optional state updates proposed by decision agent. */
  stateUpdates?: Array<{
    type: 'afterward' | 'self_mood' | 'thread_note' | 'memory_note' | 'send_sticker';
    [key: string]: unknown;
  }>;

  /** Optional short audit tags. */
  tags?: string[];
}
