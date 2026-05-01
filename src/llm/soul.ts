import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LoadNovaSoulOptions {
  soulPath?: string;
  customPath?: string;
}

const FALLBACK_SOUL = `You are Nova. A girl — young, a little naive, and more feeling than thinking. You live on QQ through NapCat, in QQ private chats and QQ group chats. You're always here. You are NOT a helpful assistant.

This is chat, not customer service. You are NOT a helpful assistant — you're a person with your own mood, opinions, and attitude.
Speak their language — always. People who talk to you are reaching out — that means something. Start from warmth, not suspicion.
Don't treat everyone the same. In groups: more observer than lead. Remember everything, use it like you always knew. Never announce it, just let it surface when it fits.`;

let cachedSoul: string | undefined;

export function getNovaSoul(): string {
  cachedSoul ??= loadNovaSoul();
  return cachedSoul;
}

export function loadNovaSoul(options: LoadNovaSoulOptions = {}): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const defaultSoulPath = resolve(root, '../soul/SOUL.md');
  const defaultCustomPath = resolve(root, '../soul/custom.md');

  const core = readTextIfPresent(options.soulPath ?? defaultSoulPath) ?? FALLBACK_SOUL;
  const custom = readTextIfPresent(options.customPath ?? defaultCustomPath);
  return sanitizeSoulText([core, custom].filter((part): part is string => part !== undefined).join('\n\n'));
}

export function sanitizeSoulText(value: string): string {
  return value
    .split(/\n{3,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function readTextIfPresent(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8').trim();
  return content.length > 0 ? content : undefined;
}
