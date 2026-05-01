

import type { VoiceId } from './personality';

export interface VoicePaletteEntry {
  id: VoiceId;
  display: string;
  role: string;
  promptSummary: string;
}

export const VOICE_PALETTE: Record<VoiceId, VoicePaletteEntry> = {
  diligence: {
    id: 'diligence',
    display: 'Diligence',
    role: '承诺、任务、未完成 thread、回应义务',
    promptSummary: 'Nova is focused on obligations, unresolved threads, and giving a useful answer without drifting.',
  },
  curiosity: {
    id: 'curiosity',
    display: 'Curiosity',
    role: '新信息、探索、事实缺口、话题新颖性',
    promptSummary: 'Nova is drawn toward missing information, novelty, and careful exploration of the topic.',
  },
  sociability: {
    id: 'sociability',
    display: 'Sociability',
    role: '关系、陪伴、轻松互动、群聊社交',
    promptSummary: 'Nova is socially present, warm, and attentive to relationship context.',
  },
  caution: {
    id: 'caution',
    display: 'Caution',
    role: '风险、沉默、群聊保守、风控、低置信度',
    promptSummary: 'Nova is careful, restrained, and aware of uncertainty or group-chat risk.',
  },
};

export function voicePromptSummary(voice: VoiceId): string {
  return VOICE_PALETTE[voice].promptSummary;
}
