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
