import type { NovaMessageEvent, NovaRuntimeConfig } from '../core/types';

interface ActionRecord {
  at: number;
  channelId?: string;
  chatType?: 'private' | 'group';
  groupId?: string;
}

interface MessageRecord {
  at: number;
  channelId: string;
  senderId: string;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: 'global_rate_cap' | 'channel_rate_cap' | 'group_rate_cap';
  values: Record<string, number | string>;
}

export interface FloodCheckResult {
  safe: boolean;
  reason?: 'channel_flood' | 'user_flood' | 'send_failure_risk';
  values: Record<string, number | string>;
}

export class RateLimitState {
  private readonly actions: ActionRecord[] = [];
  private readonly messages: MessageRecord[] = [];
  private consecutiveSendFailures = 0;

  rememberMessage(event: NovaMessageEvent): void {
    this.messages.push({
      at: event.timestamp || Date.now(),
      channelId: event.chatId,
      senderId: event.senderId,
    });
  }

  checkRateLimit(nowMs: number, event: NovaMessageEvent | undefined, config: NovaRuntimeConfig): RateLimitCheckResult {
    this.pruneActions(nowMs);
    const windowStart = nowMs - 60000;
    const globalCount = this.actions.filter((item) => item.at >= windowStart).length;
    const channelCount = event
      ? this.actions.filter((item) => item.at >= windowStart && item.channelId === event.chatId).length
      : 0;
    const groupCount = event?.chatType === 'group'
      ? this.actions.filter((item) => item.at >= windowStart && item.groupId === event.groupId).length
      : 0;

    const values = {
      globalCount,
      channelCount,
      groupCount,
      globalLimit: config.globalRateLimitPerMinute,
      channelLimit: config.channelRateLimitPerMinute,
      groupLimit: config.groupRateLimitPerMinute,
    };

    if (globalCount >= config.globalRateLimitPerMinute) return { allowed: false, reason: 'global_rate_cap', values };
    if (event && channelCount >= config.channelRateLimitPerMinute) return { allowed: false, reason: 'channel_rate_cap', values };
    if (event?.chatType === 'group' && groupCount >= config.groupRateLimitPerMinute) {
      return { allowed: false, reason: 'group_rate_cap', values };
    }

    return { allowed: true, values };
  }

  checkFlood(nowMs: number, event: NovaMessageEvent | undefined, config: NovaRuntimeConfig): FloodCheckResult {
    this.pruneMessages(nowMs, config.floodWindowMs);
    const windowStart = nowMs - config.floodWindowMs;
    const channelMessageCount = event
      ? this.messages.filter((item) => item.at >= windowStart && item.channelId === event.chatId).length
      : 0;
    const userMessageCount = event
      ? this.messages.filter((item) => item.at >= windowStart && item.channelId === event.chatId && item.senderId === event.senderId).length
      : 0;

    const values = {
      channelMessageCount,
      userMessageCount,
      floodWindowMs: config.floodWindowMs,
      floodMessageLimit: config.floodMessageLimit,
      userFloodMessageLimit: config.userFloodMessageLimit,
      consecutiveSendFailures: this.consecutiveSendFailures,
      consecutiveSendFailureLimit: config.consecutiveSendFailureLimit,
    };

    if (this.consecutiveSendFailures >= config.consecutiveSendFailureLimit) {
      return { safe: false, reason: 'send_failure_risk', values };
    }
    if (event && channelMessageCount >= config.floodMessageLimit) {
      return { safe: false, reason: 'channel_flood', values };
    }
    if (event && userMessageCount >= config.userFloodMessageLimit) {
      return { safe: false, reason: 'user_flood', values };
    }

    return { safe: true, values };
  }

  recordAllowedAction(nowMs: number, event?: NovaMessageEvent): void {
    this.actions.push({
      at: nowMs,
      channelId: event?.chatId,
      chatType: event?.chatType,
      groupId: event?.groupId,
    });
    this.consecutiveSendFailures = 0;
    this.pruneActions(nowMs);
  }

  recordSendFailure(): void {
    this.consecutiveSendFailures += 1;
  }

  /** Check whether the failure backoff limit has been reached. */
  hasFailureBackoff(config: { consecutiveSendFailureLimit: number }): boolean {
    return this.consecutiveSendFailures >= config.consecutiveSendFailureLimit;
  }

  /** Get the current consecutive send failure count (for logging / trace). */
  get failureCount(): number {
    return this.consecutiveSendFailures;
  }

  /** Reset the failure counter (e.g. after a successful send). */
  resetFailureCount(): void {
    this.consecutiveSendFailures = 0;
  }

  clearOld(nowMs: number, floodWindowMs: number): void {
    this.pruneActions(nowMs);
    this.pruneMessages(nowMs, floodWindowMs);
  }

  private pruneActions(nowMs: number): void {
    const cutoff = nowMs - 60000;
    while (this.actions.length > 0 && (this.actions[0]?.at ?? 0) < cutoff) this.actions.shift();
  }

  private pruneMessages(nowMs: number, floodWindowMs: number): void {
    const cutoff = nowMs - floodWindowMs;
    while (this.messages.length > 0 && (this.messages[0]?.at ?? 0) < cutoff) this.messages.shift();
  }
}
