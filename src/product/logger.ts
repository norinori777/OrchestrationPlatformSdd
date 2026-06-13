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

const VECTOR_LOG_URL = process.env.VECTOR_LOG_URL ?? 'http://localhost:9001';

async function sendToVector(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(VECTOR_LOG_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Vector が一時的に利用できない場合でも、アプリ本体の処理を止めない。
  }
}

function makeLogger(
  minLevel: LogLevel,
  service: string,
  bindings: Record<string, unknown>,
): Logger {
  const minRank = LEVEL_RANK[minLevel];

  function write(level: LogLevel, msg: string, data: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < minRank) return;
    void sendToVector({
      ts:      new Date().toISOString(),
      level,
      service,
      ...bindings,
      msg,
      ...data,
    });
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
