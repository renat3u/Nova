import fs from 'node:fs';
import path from 'node:path';

export type NovaLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface NovaLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export const noopLogger: NovaLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class NovaFileLogger implements NovaLogger {
  private readonly filePath: string;

  constructor(logDir: string, private readonly mirror?: NovaLogger) {
    this.filePath = path.join(logDir, 'nova.log');
    fs.mkdirSync(logDir, { recursive: true });
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
    this.mirror?.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
    this.mirror?.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
    this.mirror?.warn(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
    this.mirror?.error(message, ...args);
  }

  get path(): string {
    return this.filePath;
  }

  private write(level: NovaLogLevel, message: string, args: unknown[]): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      args: args.map(safeSerialize),
    });
    fs.appendFileSync(this.filePath, `${line}\n`, 'utf-8');
  }
}

function safeSerialize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogText(value.message),
      stack: value.stack ? sanitizeLogText(value.stack).slice(0, 2000) : undefined,
    };
  }

  if (typeof value === 'string') return sanitizeLogText(value);
  if (value === null || typeof value !== 'object') return value;

  try {
    return JSON.parse(sanitizeLogText(JSON.stringify(value))) as unknown;
  } catch {
    return sanitizeLogText(String(value));
  }
}

function sanitizeLogText(value: string): string {
  return value.replace(/(api[-_ ]?key|authorization|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[redacted]');
}
