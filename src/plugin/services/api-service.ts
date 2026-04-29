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
    res.json({ code: 0, data: runtimeActions.length > 0 ? runtimeActions : fallbackActions });
  });

  ctx.router.getNoAuth('/silences', (req, res) => {
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
