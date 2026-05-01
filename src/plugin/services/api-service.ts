import type { NapCatPluginContext } from '../types';
import { novaPluginState } from '../state';
import type { NovaPluginConfig } from '../types';

export interface NovaStatusResponse {
  online: boolean;
  initialized: boolean;
  selfId?: string;
  startedAt?: number;
  processedMessages: number;
  sentActions: number;
  silenceCount: number;
  lastTickAt?: number;
  lastError?: string;
  queue?: {
    pending: number;
    total: number;
    executing: number;
    done: number;
    failed: number;
  };
  activeEngagements?: number;
  lastEvolve?: Record<string, unknown>;
  lastPressure?: Record<string, unknown>;
  lastActionTrace?: Record<string, unknown>;
}

export function registerApiRoutes(ctx: NapCatPluginContext): void {
  ctx.router.getNoAuth('/status', (_req, res) => {
    res.json({ code: 0, data: buildStatusResponse() });
  });

  ctx.router.getNoAuth('/actions', (req, res) => {
    const limit = readLimit(req.params.limit);
    const runtimeActions = novaPluginState.runtime?.getRecentActions(limit) ?? [];
    const fallbackActions = runtimeActions.length > 0 ? [] : novaPluginState.actionLog.list(limit).map((entry) => ({
      id: entry.id,
      tick: entry.tick,
      actionType: entry.actionType,
      targetId: entry.targetId,
      text: entry.text ?? '',
      status: entry.status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      createdMs: entry.createdMs,
    }));
    // Step 18: 附带最近一次 action trace 的 reasoning 和 voice 信息
    const lastActionTrace = novaPluginState.runtime?.lastActionTrace;
    res.json({
      code: 0,
      data: runtimeActions.length > 0 ? runtimeActions : fallbackActions,
      ...(lastActionTrace ? {
        _trace: {
          reasoning: lastActionTrace.reasoning,
          voice: lastActionTrace.voice,
          engagementOutcome: lastActionTrace.engagementOutcome,
        },
      } : {}),
    });
  });

  ctx.router.getNoAuth('/silences', (req, res) => {
    const limit = readLimit(req.params.limit);
    res.json({ code: 0, data: novaPluginState.runtime?.getRecentSilences(limit) ?? [] });
  });

  // ── Step 18: Trace 可观测性 API ──────────────────────────────────────────

  ctx.router.getNoAuth('/traces/ticks', (req, res) => {
    const limit = readLimit(req.params.limit);
    const reason = req.params.reason === 'message' || req.params.reason === 'scheduled'
      ? req.params.reason as 'message' | 'scheduled'
      : undefined;
    const traces = novaPluginState.runtime?.getTickTraces(limit, reason) ?? [];
    res.json({ code: 0, data: traces });
  });

  ctx.router.getNoAuth('/traces/proactive', (req, res) => {
    const limit = readLimit(req.params.limit);
    const summaries = novaPluginState.runtime?.getProactiveTraceSummaries(limit) ?? [];
    res.json({ code: 0, data: summaries });
  });

  ctx.router.getNoAuth('/traces/actions', (req, res) => {
    const limit = readLimit(req.params.limit);
    res.json({ code: 0, data: novaPluginState.runtime?.getActionTraces(limit) ?? [] });
  });

  ctx.router.getNoAuth('/traces/deliberations', (req, res) => {
    const limit = readLimit(req.params.limit);
    const reason = req.params.reason === 'message' || req.params.reason === 'scheduled'
      ? req.params.reason as 'message' | 'scheduled'
      : undefined;
    res.json({ code: 0, data: novaPluginState.runtime?.getDeliberationTraces(limit, reason) ?? [] });
  });

  ctx.router.getNoAuth('/traces/silences', (req, res) => {
    const limit = readLimit(req.params.limit);
    res.json({ code: 0, data: novaPluginState.runtime?.getRecentSilences(limit) ?? [] });
  });

  ctx.router.getNoAuth('/pressure', (req, res) => {
    const limit = readLimit(req.params.limit ?? req.params.n);
    res.json({ code: 0, data: novaPluginState.runtime?.getPressureSnapshots(limit) ?? [] });
  });

  ctx.router.getNoAuth('/groups', (_req, res) => {
    res.json({ code: 0, data: listGroups() });
  });

  ctx.router.getNoAuth('/groups/:groupId', (req, res) => {
    const groupId = req.params.groupId;
    if (!groupId) {
      res.status(400).json({ code: -1, message: 'groupId is required' });
      return;
    }
    res.json({ code: 0, data: getGroup(groupId) });
  });

  ctx.router.postNoAuth('/groups/:groupId', (req, res) => {
    const groupId = req.params.groupId;
    if (!groupId) {
      res.status(400).json({ code: -1, message: 'groupId is required' });
      return;
    }

    const enabled = readEnabled(req.body);
    if (enabled === undefined) {
      res.status(400).json({ code: -1, message: 'enabled boolean is required' });
      return;
    }

    novaPluginState.updateGroupConfig(groupId, { enabled });
    res.json({ code: 0, data: getGroup(groupId) });
  });

  ctx.router.getNoAuth('/queue', (_req, res) => {
    const runtime = novaPluginState.runtime;
    if (!runtime) {
      res.json({ code: 0, data: [] });
      return;
    }
    const queueList = runtime.actionQueue.list().map((item) => ({
      id: item.id,
      tick: item.tick,
      action: item.candidate.action,
      targetId: item.candidate.targetId,
      scene: item.candidate.scene,
      desireType: item.candidate.desireType,
      urgency: item.candidate.urgency,
      status: item.status,
      promptContextSummary: item.promptContextSummary,
      enqueuedMs: item.enqueuedMs,
      startedMs: item.startedMs,
      completedMs: item.completedMs,
      error: item.error,
    }));
    res.json({ code: 0, data: queueList });
  });

  ctx.router.getNoAuth('/config', (_req, res) => {
    res.json({ code: 0, data: sanitizeConfig(novaPluginState.config) });
  });

  ctx.router.postNoAuth('/config', (req, res) => {
    try {
      const nextConfig = novaPluginState.updateConfig(req.body);
      ctx.logger.info('Nova config saved through API');
      res.json({ code: 0, data: sanitizeConfig(nextConfig) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error('Nova config API save failed:', error);
      res.status(500).json({ code: -1, message });
    }
  });
}

function buildStatusResponse(): NovaStatusResponse {
  const runtimeStatus = novaPluginState.runtime?.status;
  if (runtimeStatus) {
    return {
      ...runtimeStatus,
      initialized: novaPluginState.initialized && runtimeStatus.initialized,
      ...(novaPluginState.lastError === undefined ? {} : { lastError: novaPluginState.lastError }),
    };
  }

  return {
    online: false,
    initialized: novaPluginState.initialized,
    ...(novaPluginState.selfId === undefined ? {} : { selfId: novaPluginState.selfId }),
    ...(novaPluginState.startedAt === undefined ? {} : { startedAt: novaPluginState.startedAt }),
    processedMessages: novaPluginState.stats.processedMessages,
    sentActions: novaPluginState.actionLog.countSentSuccess(),
    silenceCount: novaPluginState.actionLog.countSilence(),
    ...(novaPluginState.lastError === undefined ? {} : { lastError: novaPluginState.lastError }),
  };
}

function listGroups(): Array<{ groupId: string; channelId?: string; title?: string; enabled: boolean }> {
  const seen = new Map<string, { groupId: string; channelId?: string; title?: string; enabled: boolean }>();

  for (const group of novaPluginState.runtime?.getSeenGroupChannels() ?? []) {
    seen.set(group.groupId, group);
  }

  for (const [groupId, groupConfig] of Object.entries(novaPluginState.config.enabledGroups)) {
    const existing = seen.get(groupId);
    seen.set(groupId, {
      groupId,
      ...(existing?.channelId === undefined ? {} : { channelId: existing.channelId }),
      ...(existing?.title === undefined ? {} : { title: existing.title }),
      enabled: groupConfig.enabled,
    });
  }

  return Array.from(seen.values()).sort((a, b) => a.groupId.localeCompare(b.groupId));
}

function getGroup(groupId: string): { groupId: string; channelId?: string; title?: string; enabled: boolean } {
  return listGroups().find((group) => group.groupId === groupId) ?? {
    groupId,
    enabled: novaPluginState.isGroupEnabled(groupId),
  };
}

function sanitizeConfig(config: NovaPluginConfig): Omit<NovaPluginConfig, 'llmApiKey'> & { llmApiKeyConfigured: boolean } {
  const { llmApiKey, ...rest } = config;
  return {
    ...rest,
    llmApiKeyConfigured: llmApiKey.trim().length > 0,
  };
}

function readLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(0, Math.min(500, Math.trunc(parsed)));
}

function readEnabled(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.enabled === 'boolean' ? value.enabled : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
