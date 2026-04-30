// ─────────────────────────────────────────────────────────────────────────────
// 構造化ロガー — JSON 形式で stdout/stderr へ出力
// 実運用では Fluentd / Datadog / CloudWatch 等が JSON ログを収集します。
// pino / winston を採用する場合はこのモジュールを差し替えてください。
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info (msg: string, data?: Record<string, unknown>): void;
  warn (msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** 追加のコンテキストを束ねた子ロガーを生成する */
  child(bindings: Record<string, unknown>): Logger;
}

function makeLogger(
  minLevel: LogLevel,
  service: string,
  bindings: Record<string, unknown>,
): Logger {
  const minRank = LEVEL_RANK[minLevel];

  function write(level: LogLevel, msg: string, data: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < minRank) return;
    const entry = JSON.stringify({
      ts:      new Date().toISOString(),
      level,
      service,
      ...bindings,
      msg,
      ...data,
    });
    (level === 'error' ? process.stderr : process.stdout).write(entry + '\n');
  }

  return {
    debug: (msg, data = {}) => write('debug', msg, data),
    info:  (msg, data = {}) => write('info',  msg, data),
    warn:  (msg, data = {}) => write('warn',  msg, data),
    error: (msg, data = {}) => write('error', msg, data),
    child: (extra)          => makeLogger(minLevel, service, { ...bindings, ...extra }),
  };
}

export function createLogger(level: LogLevel, service: string): Logger {
  return makeLogger(level, service, {});
}
