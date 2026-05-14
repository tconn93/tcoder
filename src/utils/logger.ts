import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAppDataDir } from './shell.ts';
import { LOGS_DIR } from '../constants/common.ts';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  silent?: boolean;
  fileLogging?: boolean;
  onLog?: (entry: LogEntry) => void;
}

export class Logger {
  private level: LogLevel;
  private prefix: string;
  private silent: boolean;
  private fileLogging: boolean;
  private logFilePath: string | null = null;
  private history: LogEntry[] = [];
  private maxHistory: number;
  private listeners: Array<(entry: LogEntry) => void> = [];

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.prefix = options.prefix ?? '';
    this.silent = options.silent ?? false;
    this.fileLogging = options.fileLogging ?? false;
    this.maxHistory = 1000;

    if (options.onLog) {
      this.listeners.push(options.onLog);
    }
  }

  private getLogFilePath(): string | null {
    if (!this.fileLogging) return null;
    if (this.logFilePath) return this.logFilePath;
    try {
      const logsDir = resolve(getAppDataDir(), LOGS_DIR);
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }
      const date = new Date().toISOString().slice(0, 10);
      this.logFilePath = resolve(logsDir, `tcoder-${date}.log`);
      return this.logFilePath;
    } catch {
      return null;
    }
  }

  private writeToFile(entry: LogEntry, formatted: string): void {
    const filePath = this.getLogFilePath();
    if (!filePath) return;
    try {
      appendFileSync(filePath, `${formatted}\n`, 'utf-8');
    } catch {
      // Best-effort file logging; suppress errors to avoid feedback loops
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, context);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  getHistory(): LogEntry[] {
    return [...this.history];
  }

  getRecent(limit = 50): LogEntry[] {
    return this.history.slice(-limit);
  }

  clearHistory(): void {
    this.history = [];
  }

  onLog(listener: (entry: LogEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level < this.level) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: Date.now(),
      context,
    };

    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    const levelPrefix = this.getLevelPrefix(level);
    const prefixStr = this.prefix ? `[${this.prefix}] ` : '';
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    const ts = new Date(entry.timestamp).toISOString();
    const formatted = `${ts} ${levelPrefix} ${prefixStr}${message}${contextStr}`;

    this.writeToFile(entry, formatted);

    if (!this.silent) {
      if (level >= LogLevel.ERROR) {
        process.stderr.write(`${formatted}\n`);
      } else {
        process.stdout.write(`${formatted}\n`);
      }
    }

    for (const listener of this.listeners) {
      listener(entry);
    }
  }

  private getLevelPrefix(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return '[DEBUG]';
      case LogLevel.INFO: return '[INFO]';
      case LogLevel.WARN: return '[WARN]';
      case LogLevel.ERROR: return '[ERROR]';
      default: return '[LOG]';
    }
  }
}

let defaultLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = new Logger({ silent: true, fileLogging: true });
  }
  return defaultLogger;
}

export function setLogger(logger: Logger): void {
  defaultLogger = logger;
}

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}
