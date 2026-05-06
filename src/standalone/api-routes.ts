import fs from 'node:fs';
import os from 'node:os';
import { Router, type Request, type Response } from 'express';
import type { NovaStandaloneState } from './standalone-state';
import type { NovaRuntime } from '../core/runtime';
import type { NovaActionTrace } from '../trace/types';

function readLimit(value: unknown): number {
  if (value === undefined || value === null) return 50;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(0, Math.min(500, Math.trunc(parsed)));
}

function ok(data: unknown) {
  return { code: 0, data };
}

function err(message: string, code = -1) {
  return { code, message };
}

export function createApiRouter(state: NovaStandaloneState): Router {
  const router = Router();

  // Helper to get runtime
  const rt = (): NovaRuntime | null => state.getRuntime();

  // ── Status ───────────────────────────────────────────────────────────────
  router.get('/api/status', (_req: Request, res: Response) => {
    const runtime = rt();
    if (runtime) {
      const status = runtime.status;
      const allItems = runtime.actionQueue.list();
      let executing = 0;
      let done = 0;
      let failed = 0;
      for (const item of allItems) {
        if (item.status === 'executing') executing++;
        else if (item.status === 'done') done++;
        else if (item.status === 'failed') failed++;
      }
      res.json(ok({
        ...status,
        queue: {
          pending: runtime.actionQueue.pendingCount,
          total: runtime.actionQueue.size,
          executing,
          done,
          failed,
        },
        activeEngagements: 0,
        lastPressure: runtime.getPressureSnapshots(1)[0] ?? null,
        lastActionTrace: serializeActionTrace(runtime.lastActionTrace),
      }));
    } else {
      res.json(ok({
        online: false,
        initialized: state.isRunning,
        processedMessages: 0,
        sentActions: 0,
        silenceCount: 0,
      }));
    }
  });

  // ── Session ──────────────────────────────────────────────────────────────
  router.post('/api/session/reset', async (_req: Request, res: Response) => {
    try {
      const newUserId = await state.resetSession();
      res.json(ok({ userId: newUserId, username: state.sessionUsername }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json(err(message));
    }
  });

  // ── Core 启动/停止 ────────────────────────────────────────────────────────
  router.post('/api/core/start', async (_req: Request, res: Response) => {
    try {
      if (state.isRunning) {
        res.json(ok({ started: false, message: 'Core 已在运行中' }));
        return;
      }
      await state.startCore();
      res.json(ok({ started: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json(err(message));
    }
  });

  router.post('/api/core/stop', async (_req: Request, res: Response) => {
    try {
      if (!state.isRunning) {
        res.json(ok({ stopped: false, message: 'Core 未在运行' }));
        return;
      }
      await state.stopCore();
      res.json(ok({ stopped: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json(err(message));
    }
  });

  // ── 自动停止状态查询 ──────────────────────────────────────────────────────
  router.get('/api/core/auto-stop', (_req: Request, res: Response) => {
    const config = state.getConfig();
    const runtime = rt();
    res.json(ok({
      autoStopAfterTick: config.autoStopAfterTick ?? 0,
      currentTick: (runtime as any)?.clock?.tick ?? 0,
      remaining: Math.max(0, (config.autoStopAfterTick ?? 0) - ((runtime as any)?.clock?.tick ?? 0)),
    }));
  });

  // ── System ───────────────────────────────────────────────────────────────
  router.get('/api/system', (_req: Request, res: Response) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg();
    const processMem = process.memoryUsage();

    res.json(ok({
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadAvg1m: loadAvg[0],
      loadAvg5m: loadAvg[1],
      loadAvg15m: loadAvg[2],
      memoryTotal: totalMem,
      memoryFree: freeMem,
      memoryUsed: usedMem,
      memoryUsagePct: (usedMem / totalMem * 100),
      processHeapMB: Math.round(processMem.heapUsed / 1024 / 1024 * 100) / 100,
      processRssMB: Math.round(processMem.rss / 1024 / 1024 * 100) / 100,
      systemUptime: os.uptime(),
      processUptime: process.uptime(),
      nodeVersion: process.version,
    }));
  });

  // ── Pressure ─────────────────────────────────────────────────────────────
  router.get('/api/pressure', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit ?? req.query.n);
    res.json(ok(rt()?.getPressureSnapshots(limit) ?? []));
  });

  // ── Pressure 值覆盖查询/设置 ──────────────────────────────────────────────
  router.get('/api/pressure/overrides', (_req: Request, res: Response) => {
    const runtime = rt();
    if (!runtime) {
      res.json(ok({}));
      return;
    }
    const latestSnapshot = runtime.getPressureSnapshots(1)[0];
    const overrides = runtime.runtimeConfig.pressureValueOverrides ?? {};
    res.json(ok({
      p1: { value: latestSnapshot?.p1 ?? 0, overridden: overrides.p1 != null, overrideValue: overrides.p1 ?? null },
      p2: { value: latestSnapshot?.p2 ?? 0, overridden: overrides.p2 != null, overrideValue: overrides.p2 ?? null },
      p3: { value: latestSnapshot?.p3 ?? 0, overridden: overrides.p3 != null, overrideValue: overrides.p3 ?? null },
      p4: { value: latestSnapshot?.p4 ?? 0, overridden: overrides.p4 != null, overrideValue: overrides.p4 ?? null },
      p5: { value: latestSnapshot?.p5 ?? 0, overridden: overrides.p5 != null, overrideValue: overrides.p5 ?? null },
      p6: { value: latestSnapshot?.p6 ?? 0, overridden: overrides.p6 != null, overrideValue: overrides.p6 ?? null },
      p7: { value: latestSnapshot?.p7 ?? 0, overridden: overrides.p7 != null, overrideValue: overrides.p7 ?? null },
      p8: { value: latestSnapshot?.p8 ?? 0, overridden: overrides.p8 != null, overrideValue: overrides.p8 ?? null },
    }));
  });

  router.post('/api/pressure/overrides', (req: Request, res: Response) => {
    const patch = req.body ?? {};
    const config = state.getConfig();
    const current = config.pressureValueOverrides ?? {};
    const updated: Record<string, number | null> = { ...current };
    for (const key of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']) {
      if (key in patch) {
        updated[key] = patch[key]; // null 表示取消覆盖
      }
    }
    state.updateConfig({ pressureValueOverrides: updated });
    res.json(ok(updated));
  });

  // ── Tick traces ──────────────────────────────────────────────────────────
  router.get('/api/traces/ticks', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    const reason = req.query.reason === 'message' || req.query.reason === 'scheduled'
      ? req.query.reason as 'message' | 'scheduled'
      : undefined;
    res.json(ok(rt()?.getTickTraces(limit, reason) ?? []));
  });

  // ── Action traces ────────────────────────────────────────────────────────
  router.get('/api/traces/actions', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    res.json(ok(rt()?.getActionTraces(limit) ?? []));
  });

  // ── Deliberation traces ──────────────────────────────────────────────────
  router.get('/api/traces/deliberations', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    const reason = req.query.reason === 'message' || req.query.reason === 'scheduled'
      ? req.query.reason as 'message' | 'scheduled'
      : undefined;
    res.json(ok(rt()?.getDeliberationTraces(limit, reason) ?? []));
  });

  // ── Silence traces ───────────────────────────────────────────────────────
  router.get('/api/traces/silences', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    res.json(ok(rt()?.getRecentSilences(limit) ?? []));
  });

  // ── Proactive traces ─────────────────────────────────────────────────────
  router.get('/api/traces/proactive', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    res.json(ok(rt()?.getProactiveTraceSummaries(limit) ?? []));
  });

  // ── Actions ──────────────────────────────────────────────────────────────
  router.get('/api/actions', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    const actions = rt()?.getRecentActions(limit) ?? [];
    res.json(ok(actions));
  });

  // ── Silences ─────────────────────────────────────────────────────────────
  router.get('/api/silences', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    res.json(ok(rt()?.getRecentSilences(limit) ?? []));
  });

  // ── Queue ────────────────────────────────────────────────────────────────
  router.get('/api/queue', (_req: Request, res: Response) => {
    const runtime = rt();
    if (!runtime) {
      res.json(ok([]));
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
    res.json(ok(queueList));
  });

  // ── Logs ─────────────────────────────────────────────────────────────────
  router.get('/api/logs', (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit ?? '200');
    const logPath = state.logPath;

    try {
      if (!fs.existsSync(logPath)) {
        res.json(ok([]));
        return;
      }

      const raw = fs.readFileSync(logPath, 'utf-8');
      const lines = raw.trim().split('\n').filter((l) => l.length > 0);

      // Return last N lines, parsed as JSON
      const recent = lines.slice(-limit);
      const entries = recent.map((line) => {
        try {
          const parsed = JSON.parse(line);
          return {
            ts: parsed.ts ?? null,
            level: parsed.level ?? 'debug',
            message: parsed.message ?? '',
            args: Array.isArray(parsed.args) ? parsed.args : [],
          };
        } catch {
          return { ts: null, level: 'debug', message: line, args: [] };
        }
      });

      res.json(ok(entries));
    } catch {
      res.json(ok([]));
    }
  });

  // ── Config ───────────────────────────────────────────────────────────────
  router.get('/api/config', (_req: Request, res: Response) => {
    res.json(ok(state.sanitizedConfig()));
  });

  router.post('/api/config', (req: Request, res: Response) => {
    try {
      state.updateConfig(req.body);
      res.json(ok(state.sanitizedConfig()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json(err(message));
    }
  });

  return router;
}

function serializeActionTrace(trace: NovaActionTrace | null): Record<string, unknown> | null {
  if (!trace) return null;
  return {
    tick: trace.tick,
    actionType: trace.actionType,
    targetId: trace.targetId,
    text: trace.text ? (trace.text.length > 200 ? trace.text.slice(0, 200) + '…' : trace.text) : undefined,
    voice: trace.voice,
    reasoning: trace.reasoning,
    status: trace.status,
    engagementOutcome: trace.engagementOutcome,
    llmStateWritebackSummary: trace.llmStateWritebackSummary,
    createdMs: trace.createdMs,
  };
}
