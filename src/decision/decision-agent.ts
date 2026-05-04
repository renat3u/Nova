//
// Decision Agent — unified entry point for LLM-driven behavior decisions.
//
// Wraps the decision client, context builder, and validator into a single
// call that the evolve layer can use without knowing internal details.
//
// This is the "B. LLM Decision Layer" from the architecture doc.
// It receives a system-computed DecisionContext, calls the configured
// decision LLM, validates the response, and returns a normalized
// DecisionAgentResponse.
//

import type { DecisionAgentConfig } from '../core/types';
import type { DecisionContext, DecisionAgentResponse } from './decision-schema';
import { OpenAICompatibleDecisionClient } from './decision-client';
import { createFallbackResponse } from './decision-validator';

export interface DecisionAgent {
  /** Decide what Nova should do given the full system snapshot. */
  decide(context: DecisionContext): Promise<DecisionAgentResponse>;
}

/**
 * Create a decision agent from the given config.
 *
 * The agent handles:
 *   - config validation (disabled / missing config → fallback)
 *   - LLM call with timeout
 *   - JSON parse + schema validation
 *   - failMode fallback on error
 */
export function createDecisionAgent(config: DecisionAgentConfig): DecisionAgent {
  const client = new OpenAICompatibleDecisionClient(config);

  return {
    async decide(context: DecisionContext): Promise<DecisionAgentResponse> {
      try {
        return await client.decide(context);
      } catch {
        return createFallbackResponse(context, 'agent_unexpected_error');
      }
    },
  };
}
