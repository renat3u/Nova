import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NovaStandaloneState } from './standalone-state';
import { WebChatBridge } from './chat-bridge';
import { createApiRouter } from './api-routes';
import type { WebServerMessage } from './web-types';
import type { PressureSnapshot } from '../pressure/aggregate';

const PORT = process.env.NOVA_PORT ? parseInt(process.env.NOVA_PORT, 10) : 3721;
const CONFIG_PATH = process.env.NOVA_CONFIG_PATH ?? undefined;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const state = new NovaStandaloneState(CONFIG_PATH);
  const bridge = new WebChatBridge();

  // Start with ActExecutor wired in so ACT loop initializes properly
  await state.start(async (queuedAction, channel) => {
    const rt = state.getRuntime();
    if (!rt) {
      return { ok: false, actionType: 'send_text', targetId: queuedAction.candidate.targetId ?? '', error: 'no_runtime', messageId: undefined, createdMs: Date.now() };
    }
    return await bridge.executeAction(queuedAction, channel, rt);
  });

  const runtime = state.getRuntime();
  if (!runtime) {
    console.error('Failed to start NovaRuntime');
    process.exit(1);
  }

  // ── Express middleware ────────────────────────────────────────────────────
  app.use(express.json());

  // CORS — allow Dashboard access from anywhere
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // REST API
  app.use(createApiRouter(state));

  // Static files — Dashboard frontend
  const dashboardDir = path.resolve(__dirname, '../../dashboard');
  app.use(express.static(dashboardDir));

  // SPA fallback — serve index.html for any non-API route
  app.get('*', (_req: Request, res: Response) => {
    if (_req.path.startsWith('/api/')) {
      res.status(404).json({ code: -1, message: 'Not found' });
      return;
    }
    res.sendFile(path.join(dashboardDir, 'index.html'));
  });

  // ── WebSocket ────────────────────────────────────────────────────────────
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    // 使用服务端生成的 userId（每次启动新开 session），客户端可覆盖用户名
    const userId = state.sessionUserId;
    const username = url.searchParams.get('username') ?? state.sessionUsername;

    const session = bridge.registerSession(ws, userId, username);

    // 通知客户端 session 身份（userId 由服务端分配）
    bridge.sendToSession(session, {
      type: 'session_init',
      userId: state.sessionUserId,
      username: state.sessionUsername,
    });

    // 发送初始状态
    const currentRt = state.getRuntime();
    bridge.sendToSession(session, {
      type: 'status_update',
      data: currentRt?.status ?? { online: false, initialized: false, processedMessages: 0, sentActions: 0, silenceCount: 0 },
    });

    ws.on('message', async (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'chat_message' && typeof msg.text === 'string') {
          const rt = state.getRuntime();
          if (!rt?.isRunning) {
            bridge.sendToSession(session, { type: 'error', message: 'Nova 未就绪，请稍后再试' } as WebServerMessage);
            return;
          }
          const outputs = await bridge.handleUserMessage(
            session,
            msg.text,
            rt,
          );
          for (const output of outputs) {
            bridge.sendToSession(session, output);
          }
        }
      } catch (err) {
        bridge.sendToSession(session, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } as WebServerMessage);
      }
    });

    ws.on('close', () => {
      bridge.unregisterSession(session.userId);
    });

    ws.on('error', () => {
      bridge.unregisterSession(session.userId);
    });
  });

  // ── Periodic broadcasts ──────────────────────────────────────────────────
  const broadcastInterval = setInterval(() => {
    const rt = state.getRuntime();
    if (!rt?.isRunning) return;
    const snapshots = rt.getPressureSnapshots(2);
    if (snapshots.length > 0) {
      bridge.broadcastPressure(snapshots[0] as unknown as PressureSnapshot);
    }
    bridge.broadcastStatus(rt.status);

    // 广播最新 tick trace（Task 4.4: 启用实时 tick_trace 推送）
    const recentTraces = rt.getTickTraces(1);
    const latestTrace = recentTraces[0];
    if (latestTrace) {
      bridge.broadcastTickTrace(latestTrace);
    }
  }, 5000);
  broadcastInterval.unref?.();

  // ── Graceful shutdown ────────────────────────────────────────────────────
  function shutdown() {
    clearInterval(broadcastInterval);
    wss.close();
    server.close();
    state.stop().catch(console.error);
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── Start ────────────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`Nova Standalone Dashboard: http://localhost:${PORT}`);
    console.log(`Config: ${CONFIG_PATH ?? './nova-standalone-config.json'}`);
  });
}

main().catch((error) => {
  console.error('Nova Standalone failed to start:', error);
  process.exit(1);
});
