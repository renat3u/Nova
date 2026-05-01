import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIMENSION_DECAY,
  FAMILIARITY_INTERACTION_DELTA,
  INITIAL_RV,
  RV_VELOCITY_ALPHA,
  applyInteractionRelationshipUpdate,
  applyNovaActionRelationshipUpdate,
  decayRelationshipVector,
  renderRelationshipFacts,
} from './relationship-vector.js';
import type { ContactAttrs } from './entities.js';

const baseContact = (patch: Partial<ContactAttrs> = {}): ContactAttrs => ({
  id: 'qq:user:10001',
  entity_type: 'contact',
  platform: 'qq',
  qq: '10001',
  tier: 50,
  last_active_ms: 1_000,
  interaction_count: 1,
  relation_type: 'unknown',
  nova_initiated_count: 0,
  contact_initiated_count: 1,
  rv_familiarity: INITIAL_RV.familiarity,
  rv_trust: INITIAL_RV.trust,
  rv_affection: INITIAL_RV.affection,
  rv_attraction: INITIAL_RV.attraction,
  rv_respect: INITIAL_RV.respect,
  rv_familiarity_velocity: 0,
  rv_trust_velocity: 0,
  rv_affection_velocity: 0,
  rv_attraction_velocity: 0,
  rv_respect_velocity: 0,
  hawkes_carry: 0,
  ...patch,
});

test('relationship vector constants match Nova Step 04 specs', () => {
  assert.deepEqual(INITIAL_RV, {
    familiarity: 0,
    trust: 0.3,
    affection: 0,
    attraction: 0,
    respect: 0.3,
  });
  assert.deepEqual(DIMENSION_DECAY, {
    familiarity: 30 * 86400,
    trust: 60 * 86400,
    affection: 14 * 86400,
    attraction: 7 * 86400,
    respect: 45 * 86400,
  });
  assert.equal(RV_VELOCITY_ALPHA, 0.05);
  assert.equal(FAMILIARITY_INTERACTION_DELTA, 0.02);
});

test('new contact interaction initializes from INITIAL_RV and raises familiarity', () => {
  const patch = applyInteractionRelationshipUpdate({}, 1_000);
  assert.ok(patch.rv_familiarity > INITIAL_RV.familiarity);
  assert.ok(patch.rv_trust > INITIAL_RV.trust);
  assert.ok(patch.rv_affection > INITIAL_RV.affection);
  assert.equal(patch.rv_attraction, INITIAL_RV.attraction);
  assert.ok(patch.rv_respect > INITIAL_RV.respect);
  assert.ok(patch.rv_familiarity_velocity > 0);
});

test('repeated interactions increase familiarity with EMA velocity', () => {
  const first = applyInteractionRelationshipUpdate(baseContact(), 1_000);
  const second = applyInteractionRelationshipUpdate(baseContact({
    last_active_ms: 1_000,
    rv_familiarity: first.rv_familiarity,
    rv_familiarity_velocity: first.rv_familiarity_velocity,
  }), 2_000);

  assert.ok(second.rv_familiarity > first.rv_familiarity);
  assert.ok(second.rv_familiarity_velocity > 0);
});

test('relationship vector decays after long silence', () => {
  const decayed = decayRelationshipVector({
    familiarity: 0.8,
    trust: 0.8,
    affection: 0.8,
    attraction: 0.8,
    respect: 0.8,
  }, 30 * 86_400_000);

  assert.ok(decayed.familiarity < 0.8);
  assert.ok(decayed.affection < decayed.trust);
  assert.ok(decayed.attraction < decayed.affection);
});

test('proactive action writeback increments Nova initiated count and timestamp', () => {
  const updated = applyNovaActionRelationshipUpdate(baseContact(), 12_345, { proactive: true });
  assert.equal(updated.nova_initiated_count, 1);
  assert.equal(updated.last_proactive_outreach_ms, 12_345);
});

test('rendered relationship facts are natural and do not expose sensitive dimensions', () => {
  const fact = renderRelationshipFacts({
    familiarity: 0.55,
    trust: 0.5,
    affection: 0.4,
    attraction: 0.9,
    respect: 0.5,
  }, {
    familiarity: 0.03,
    trust: 0,
    affection: 0,
    attraction: 0,
    respect: 0,
  }, '秋');

  assert.ok(fact);
  assert.match(fact, /比较熟悉|互动正在变多/);
  assert.doesNotMatch(fact, /attraction|romantic|吸引|恋爱|暧昧/i);
});
