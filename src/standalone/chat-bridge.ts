import type { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import type { NovaRuntime } from '../core/runtime';
import type { NovaMessageEvent } from '../core/types';
import type { QueuedAction } from '../act/action-queue';
import type { ChannelAttrs } from '../world/entities';
import type { SendResult } from '../act/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { NovaTickTrace } from '../trace/types';
import type { NovaRuntimeStatus } from '../core/runtime';
import type { WebUserSession, WebServerMessage } from './web-types';

function channelIdForUser(userId: string): string {
  const qqPart = userId.startsWith('qq:user:') ? userId.slice('qq:user:'.length) : userId;
  return `qq:private:${qqPart}`;
}

export class WebChatBridge {
  private sessions: Map<string, WebUserSession> = new Map();
  private userIdToSession: Map<string, WebUserSession> = new Map();

  registerSession(ws: WebSocket, userId?: string, username?: string): WebUserSession {
    // Reuse existing session if userId is known and has an active connection
    if (userId && this.userIdToSession.has(userId)) {
      const existing = this.userIdToSession.get(userId)!;
      // Update WS reference and username
      existing.ws = ws;
      existing.username = username ?? existing.username;
      this.sessions.set(userId, existing);
      return existing;
    }

    const finalUserId = userId ?? `qq:user:web_${uuid().replace(/-/g, '').slice(0, 16)}`;
    const session: WebUserSession = {
      userId: finalUserId,
      channelId: channelIdForUser(finalUserId),
      username: username ?? 'Anonymous',
      connectedAt: Date.now(),
      ws,
    };

    this.sessions.set(finalUserId, session);
    this.userIdToSession.set(finalUserId, session);
    return session;
  }

  unregisterSession(userId: string): void {
    this.sessions.delete(userId);
  }

  findSessionByUserId(userId: string): WebUserSession | undefined {
    return this.sessions.get(userId);
  }

  /** Handle an incoming chat message from the browser, funnel through NovaRuntime. */
  async handleUserMessage(
    session: WebUserSession,
    text: string,
    runtime: NovaRuntime,
  ): Promise<WebServerMessage[]> {
    const outputs: WebServerMessage[] = [];

    // Construct NovaMessageEvent
    const event: NovaMessageEvent = {
      id: uuid(),
      platform: 'qq',
      rawEvent: { text },
      messageId: `web:message:${uuid()}`,
      rawMessageId: uuid(),
      chatType: 'private',
      chatId: session.channelId,
      senderId: session.userId,
      senderQQ: session.userId,
      senderName: session.username,
      text,
      rawText: text,
      timestamp: Date.now(),
      isSelf: false,
      mentionedSelf: true,
      repliedToSelf: false,
      isDirected: true,
    };

    try {
      // 新架构：handleMessage 只推 buffer，不再当场回复
      // 回复由 ACT loop 异步处理，通过 ActExecutor → sendReplyToSession 推回 WebSocket
      await runtime.handleMessage(event);

      // 通知 thinking 开始（ACT loop 将在 LLM 生成完成后通过 sendReplyToSession 发送回复）
      outputs.push({ type: 'nova_thinking', active: true });
    } catch (err) {
      outputs.push({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return outputs;
  }

  /**
   * ActExecutor callback: called when ACT loop dequeues an action for execution.
   * Handles both reply (user message response) and proactive (Nova-initiated) actions.
   */
  async executeAction(
    queuedAction: QueuedAction,
    channel: ChannelAttrs | undefined,
    runtime: NovaRuntime,
  ): Promise<SendResult> {
    const isReply = queuedAction.kind === 'reply' && queuedAction.originalEvent;
    const targetId = queuedAction.candidate.targetId ?? '';

    // 辅助：向匹配 session 发送消息。
    // proactive 候选可能以 contact/user id 为 targetId（qq:user:*），而浏览器会话也有
    // private channel id（qq:private:*）。两者都要匹配；standalone 是单用户环境，
    // 如果没命中具体 target，则兜底广播给当前连接的页面，避免 action 已成功但 UI 不显示。
    const sendToMatchingSessions = (msg: WebServerMessage): number => {
      const targetIds = new Set<string>();
      if (targetId) {
        targetIds.add(targetId);
        if (targetId.startsWith('qq:user:')) {
          targetIds.add(channelIdForUser(targetId));
        }
      }
      if (channel?.id) {
        targetIds.add(channel.id);
      }

      let sent = 0;
      for (const session of this.sessions.values()) {
        if (targetIds.has(session.channelId) || targetIds.has(session.userId)) {
          this.sendToSession(session, msg);
          sent += 1;
        }
      }

      if (sent === 0 && this.sessions.size > 0) {
        for (const session of this.sessions.values()) {
          this.sendToSession(session, msg);
          sent += 1;
        }
      }

      return sent;
    };

    const text = isReply
      ? await runtime.buildReplyText(queuedAction)
      : await runtime.buildProactiveMessage(queuedAction, channel);

    if (!text) {
      // LLM 未配置或生成失败 → 告知前端停止 thinking，发送错误提示
      sendToMatchingSessions({ type: 'nova_thinking', active: false });
      sendToMatchingSessions({
        type: 'nova_reply',
        text: '（Nova 未配置 LLM，请在设置中填写 API 地址和密钥）',
        actionId: uuid(),
      });
      return {
        ok: false,
        actionType: 'send_text',
        targetId,
        error: 'text_generation_failed',
        messageId: undefined,
        createdMs: Date.now(),
      };
    }

    // 发送回复到前端
    sendToMatchingSessions({ type: 'nova_reply', text, actionId: uuid() });
    sendToMatchingSessions({ type: 'nova_thinking', active: false });

    return {
      ok: true,
      actionType: 'send_text',
      targetId: targetId || 'standalone',
      text,
      messageId: uuid(),
      createdMs: Date.now(),
    };
  }

  /** Broadcast pressure snapshot to all sessions. */
  broadcastPressure(snapshot: PressureSnapshot): void {
    const msg: WebServerMessage = { type: 'pressure_snapshot', data: snapshot };
    for (const session of this.sessions.values()) {
      this.sendToSession(session, msg);
    }
  }

  /** Broadcast tick trace to all sessions. */
  broadcastTickTrace(trace: NovaTickTrace): void {
    const msg: WebServerMessage = { type: 'tick_trace', data: trace };
    for (const session of this.sessions.values()) {
      this.sendToSession(session, msg);
    }
  }

  /** Broadcast status to all sessions. */
  broadcastStatus(status: NovaRuntimeStatus): void {
    const msg: WebServerMessage = { type: 'status_update', data: status };
    for (const session of this.sessions.values()) {
      this.sendToSession(session, msg);
    }
  }

  /** Get all connected user IDs. */
  getConnectedUserIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Send message to a specific session. */
  sendToSession(session: WebUserSession, msg: WebServerMessage): void {
    try {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(JSON.stringify(msg));
      }
    } catch {
      // Client disconnected; will be cleaned up on close event
    }
  }
}
