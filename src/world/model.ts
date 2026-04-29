import { edgeKey } from './constants';
import type {
  AgentAttrs,
  ChannelAttrs,
  ContactAttrs,
  ConversationAttrs,
  EdgeCategory,
  EdgeData,
  FactAttrs,
  MessageAttrs,
  NodeAttrsMap,
  NodeEntry,
  NodeType,
  ThreadAttrs,
  WorldEdge,
} from './entities';

type MutableNodeAttrs<T extends NodeType> = Partial<Omit<NodeAttrsMap[T], 'id' | 'entity_type'>>;

export class WorldModel {
  private readonly nodes = new Map<string, NodeEntry>();
  private readonly edges = new Map<string, WorldEdge>();

  addAgent(id: string, attrs: MutableNodeAttrs<'agent'>): void {
    this.nodes.set(id, { type: 'agent', attrs: { id, entity_type: 'agent', ...attrs } as AgentAttrs });
  }

  addContact(id: string, attrs: MutableNodeAttrs<'contact'>): void {
    this.nodes.set(id, { type: 'contact', attrs: { id, entity_type: 'contact', ...attrs } as ContactAttrs });
  }

  addChannel(id: string, attrs: MutableNodeAttrs<'channel'>): void {
    this.nodes.set(id, { type: 'channel', attrs: { id, entity_type: 'channel', ...attrs } as ChannelAttrs });
  }

  addFact(id: string, attrs: MutableNodeAttrs<'fact'>): void {
    this.nodes.set(id, { type: 'fact', attrs: { id, entity_type: 'fact', ...attrs } as FactAttrs });
  }

  addThread(id: string, attrs: MutableNodeAttrs<'thread'>): void {
    this.nodes.set(id, { type: 'thread', attrs: { id, entity_type: 'thread', ...attrs } as ThreadAttrs });
  }

  addConversation(id: string, attrs: MutableNodeAttrs<'conversation'>): void {
    this.nodes.set(id, { type: 'conversation', attrs: { id, entity_type: 'conversation', ...attrs } as ConversationAttrs });
  }

  addMessage(id: string, attrs: MutableNodeAttrs<'message'>): void {
    this.nodes.set(id, { type: 'message', attrs: { id, entity_type: 'message', ...attrs } as MessageAttrs });
  }

  updateContact(id: string, patch: MutableNodeAttrs<'contact'>): void {
    Object.assign(this.expect(id, 'contact').attrs, patch);
  }

  updateChannel(id: string, patch: MutableNodeAttrs<'channel'>): void {
    Object.assign(this.expect(id, 'channel').attrs, patch);
  }

  updateFact(id: string, patch: MutableNodeAttrs<'fact'>): void {
    Object.assign(this.expect(id, 'fact').attrs, patch);
  }

  updateThread(id: string, patch: MutableNodeAttrs<'thread'>): void {
    Object.assign(this.expect(id, 'thread').attrs, patch);
  }

  updateConversation(id: string, patch: MutableNodeAttrs<'conversation'>): void {
    Object.assign(this.expect(id, 'conversation').attrs, patch);
  }

  getEntitiesByType(type: NodeType): string[] {
    const result: string[] = [];
    for (const [id, entry] of this.nodes) {
      if (entry.type === type) result.push(id);
    }
    return result;
  }

  getContact(id: string): ContactAttrs {
    return { ...this.expect(id, 'contact').attrs };
  }

  getChannel(id: string): ChannelAttrs {
    return { ...this.expect(id, 'channel').attrs };
  }

  getFact(id: string): FactAttrs {
    return { ...this.expect(id, 'fact').attrs };
  }

  getThread(id: string): ThreadAttrs {
    return { ...this.expect(id, 'thread').attrs };
  }

  getConversation(id: string): ConversationAttrs {
    return { ...this.expect(id, 'conversation').attrs };
  }

  getMessage(id: string): MessageAttrs {
    return { ...this.expect(id, 'message').attrs };
  }

  getDynamic(id: string, key: string): unknown {
    return (this.nodes.get(id)?.attrs as Record<string, unknown> | undefined)?.[key];
  }

  getGraphAgeMs(nowMs: number): number {
    let earliest = nowMs;
    let found = false;
    for (const entry of this.nodes.values()) {
      const attrs = entry.attrs as unknown as Record<string, unknown>;
      for (const key of ['created_ms', 'last_active_ms', 'last_activity_ms', 'timestamp']) {
        const value = attrs[key];
        if (typeof value === 'number' && value > 0) {
          earliest = Math.min(earliest, value);
          found = true;
        }
      }
    }
    return found ? Math.max(0, nowMs - earliest) : 0;
  }

  allNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  allEdges(): WorldEdge[] {
    return Array.from(this.edges.values()).map((edge) => ({
      ...edge,
      attrs: { ...edge.attrs },
    }));
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  getNodeType(id: string): NodeType | undefined {
    return this.nodes.get(id)?.type;
  }

  addRelation(
    src: string,
    category: EdgeCategory,
    dst: string,
    attrs: Record<string, unknown> = {},
    weight = 1,
  ): void {
    this.edges.set(edgeKey(src, dst, category), {
      src,
      dst,
      category,
      weight,
      attrs: { ...attrs },
    });
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }

  private expect<T extends NodeType>(id: string, type: T): Extract<NodeEntry, { type: T }> {
    const entry = this.nodes.get(id);
    if (!entry) throw new Error(`Nova WorldModel node not found: ${id}`);
    if (entry.type !== type) throw new Error(`Nova WorldModel node ${id} is ${entry.type}, expected ${type}`);
    return entry as Extract<NodeEntry, { type: T }>;
  }
}

export type { EdgeData };
