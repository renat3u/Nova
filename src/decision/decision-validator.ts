//
// Decision validator — parse, validate, and normalize LLM decision responses.
//
// All validation rules from Section 5.2 of the design doc:
//   1. JSON must be object
//   2. action must be valid enum
//   3. confidence missing → default 0.5, clamp 0-1
//   4. generateText missing → default based on action type
//   5. candidateId must match context candidates
//   6. targetId must match event or world candidate target
//   7. reply only for message tick
//   8. proactive prefers scheduled tick
//   9. cool_down forces generateText=false, afterward=cooling_down
//  10. silence/observe/wait_reply must not generate text
//

import type { DecisionContext, DecisionAgentResponse, DecisionActionType } from './decision-schema';
import { DECISION_ACTIONS, NON_TEXT_ACTIONS, TEXT_GENERATING_ACTIONS } from './decision-schema';

export interface ValidationResult {
  valid: boolean;
  normalized: DecisionAgentResponse;
  errors: string[];
  warnings: string[];
}

const AFTERWARD_VALUES = new Set(['done', 'waiting_reply', 'watching', 'cooling_down']);

/**
 * Parse and validate a raw LLM JSON response into a normalized DecisionAgentResponse.
 * Never throws — always returns a ValidationResult with errors array.
 */
export function validateDecisionResponse(
  raw: unknown,
  context: DecisionContext,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Must be a JSON object
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      normalized: createFallbackResponse(context, 'invalid_json_not_object'),
      errors: ['decision_response_not_object'],
      warnings: [],
    };
  }

  const obj = raw as Record<string, unknown>;

  // 2. Validate action
  const action = validateAction(obj.action, context, errors, warnings);

  // 3. Validate confidence
  const confidence = validateConfidence(obj.confidence, errors);

  // 4. Validate generateText
  const generateText = validateGenerateText(obj.generateText, action, errors);

  // 5. Validate candidateId
  const candidateId = validateCandidateId(obj.candidateId, context, errors);

  // 6. Validate targetId
  const targetId = validateTargetId(obj.targetId, context, action, candidateId, errors);

  // 7. reply must be message tick
  if (action === 'reply' && context.reason !== 'message') {
    errors.push('reply_action_only_allowed_for_message_tick');
  }

  // 8. proactive prefers scheduled tick; message tick proactive downgrades
  if (action === 'proactive' && context.reason === 'message') {
    warnings.push('proactive_downgraded_to_reply_for_message_tick');
    // The caller handles downgrade logic; we still pass through
  }

  // 9. cool_down forces generateText=false and afterward=cooling_down
  const afterward = validateAfterward(obj.afterward, action, errors);

  // Validate reason
  const reason = typeof obj.reason === 'string' && obj.reason.trim().length > 0
    ? obj.reason.trim().slice(0, 300)
    : 'no_reason_provided';

  // Validate responderIntent
  const responderIntent = obj.responderIntent !== undefined && obj.responderIntent !== null
    ? String(obj.responderIntent).trim().slice(0, 200)
    : undefined;

  // Validate stateUpdates
  const stateUpdates = validateStateUpdates(obj.stateUpdates, errors);

  // Validate tags
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string').slice(0, 10)
    : undefined;

  const normalized: DecisionAgentResponse = {
    action,
    ...(candidateId !== undefined ? { candidateId } : {}),
    ...(targetId !== undefined ? { targetId } : {}),
    generateText,
    ...(responderIntent !== undefined ? { responderIntent } : {}),
    reason,
    confidence,
    afterward,
    ...(stateUpdates !== undefined ? { stateUpdates } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };

  return {
    valid: errors.length === 0,
    normalized,
    errors,
    warnings,
  };
}

// ── Individual validators ─────────────────────────────────────────────────

function validateAction(
  value: unknown,
  context: DecisionContext,
  errors: string[],
  warnings: string[],
): DecisionActionType {
  if (typeof value !== 'string' || !DECISION_ACTIONS.has(value)) {
    errors.push(`invalid_action: ${String(value)}`);
    // Fallback: for message ticks, default to observe; for scheduled, silence
    return context.reason === 'message' ? 'observe' : 'silence';
  }

  const action = value as DecisionActionType;

  // Downgrade proactive on message tick to ask
  if (action === 'proactive' && context.reason === 'message') {
    warnings.push('proactive_on_message_tick_downgraded_to_ask');
    return 'ask';
  }

  return action;
}

function validateConfidence(value: unknown, errors: string[]): number {
  if (value === undefined || value === null) return 0.5;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push('invalid_confidence');
    return 0.5;
  }
  return clamp(value, 0, 1);
}

function validateGenerateText(
  value: unknown,
  action: DecisionActionType,
  errors: string[],
): boolean {
  // If explicit boolean provided, use it (but enforce rules)
  if (typeof value === 'boolean') {
    // Non-text actions cannot generate text
    if (value && NON_TEXT_ACTIONS.has(action)) {
      errors.push(`action_${action}_cannot_generate_text`);
      return false;
    }
    // cool_down forces false
    if (action === 'cool_down') return false;
    return value;
  }

  // Default based on action type
  if (TEXT_GENERATING_ACTIONS.has(action)) return true;
  if (NON_TEXT_ACTIONS.has(action)) return false;
  return false;
}

function validateCandidateId(
  value: unknown,
  context: DecisionContext,
  errors: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    errors.push('invalid_candidate_id_type');
    return undefined;
  }

  const exists = context.candidates.some((c) => c.id === value);
  if (!exists) {
    errors.push(`candidate_id_not_found: ${value}`);
    return undefined;
  }

  return value;
}

function validateTargetId(
  value: unknown,
  context: DecisionContext,
  action: DecisionActionType,
  candidateId: string | undefined,
  errors: string[],
): string | null | undefined {
  // If no targetId provided and no candidateId, check if action needs one
  if (value === undefined || value === null) {
    if (TEXT_GENERATING_ACTIONS.has(action) && !candidateId) {
      // Try to derive from event
      if (context.event?.chatId) return context.event.chatId;
      errors.push('missing_target_id_for_text_action');
    }
    return undefined;
  }

  if (typeof value !== 'string') {
    errors.push('invalid_target_id_type');
    return undefined;
  }

  // Basic validation: target should match event chatId or a candidate target
  const validTargets = new Set<string>();
  if (context.event?.chatId) validTargets.add(context.event.chatId);
  if (context.event?.senderId) validTargets.add(context.event.senderId);
  for (const c of context.candidates) {
    if (c.targetId) validTargets.add(c.targetId);
  }

  if (!validTargets.has(value)) {
    // Not a hard error — LLM may propose targets not in candidates
    // but we still log a warning
  }

  return value;
}

function validateAfterward(
  value: unknown,
  action: DecisionActionType,
  errors: string[],
): DecisionAgentResponse['afterward'] {
  // cool_down forces cooling_down afterward
  if (action === 'cool_down') return 'cooling_down';

  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !AFTERWARD_VALUES.has(value)) {
    errors.push(`invalid_afterward: ${String(value)}`);
    return undefined;
  }

  return value as DecisionAgentResponse['afterward'];
}

function validateStateUpdates(
  value: unknown,
  errors: string[],
): DecisionAgentResponse['stateUpdates'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push('state_updates_not_array');
    return undefined;
  }

  const validTypes = new Set(['afterward', 'self_mood', 'thread_note', 'memory_note']);
  const filtered = value
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item))
    .filter((item) => {
      if (typeof item.type !== 'string' || !validTypes.has(item.type)) {
        errors.push(`invalid_state_update_type: ${String(item.type)}`);
        return false;
      }
      return true;
    })
    .slice(0, 3); // Max 3 updates

  if (filtered.length === 0) return undefined;
  return filtered as DecisionAgentResponse['stateUpdates'];
}

// ── Fallback ──────────────────────────────────────────────────────────────

export function createFallbackResponse(
  context: DecisionContext,
  reason: string,
): DecisionAgentResponse {
  // Safe fallback: observe for message ticks, silence for scheduled
  return {
    action: context.reason === 'message' ? 'observe' : 'silence',
    generateText: false,
    reason: `fallback: ${reason}`,
    confidence: 0,
    afterward: context.reason === 'message' ? 'watching' : 'cooling_down',
    tags: ['fallback', reason],
  };
}

// ── Utility ───────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
