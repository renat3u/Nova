export interface DirectedState {
  rememberNovaAction(channelId: string, senderId?: string, now?: number): void;
  isContinuation(channelId: string, senderId: string, now?: number): boolean;
  clear(): void;
}

export interface DirectedOptions {
  continuationWindowMs?: number;
}

interface LastNovaAction {
  at: number;
  senderId?: string;
}

const DEFAULT_CONTINUATION_WINDOW_MS = 5 * 60 * 1000;

export class InMemoryDirectedState implements DirectedState {
  private readonly continuationWindowMs: number;
  private readonly lastNovaActionByChannel = new Map<string, LastNovaAction>();

  constructor(options: DirectedOptions = {}) {
    this.continuationWindowMs = options.continuationWindowMs ?? DEFAULT_CONTINUATION_WINDOW_MS;
  }

  rememberNovaAction(channelId: string, senderId?: string, now = Date.now()): void {
    this.lastNovaActionByChannel.set(channelId, { at: now, senderId });
  }

  isContinuation(channelId: string, senderId: string, now = Date.now()): boolean {
    const last = this.lastNovaActionByChannel.get(channelId);
    if (!last) return false;
    if (now - last.at > this.continuationWindowMs) return false;
    return last.senderId === undefined || last.senderId === senderId;
  }

  clear(): void {
    this.lastNovaActionByChannel.clear();
  }
}

export interface DirectedInput {
  chatType: 'private' | 'group';
  chatId: string;
  senderId: string;
  mentionedSelf: boolean;
  repliedToSelf: boolean;
  timestamp: number;
}

export function determineDirected(input: DirectedInput, state: DirectedState): boolean {
  if (input.chatType === 'private') return true;
  if (input.mentionedSelf || input.repliedToSelf) return true;
  return state.isContinuation(input.chatId, input.senderId, input.timestamp);
}
