// ─────────────────────────────────────────────────────────────────────────────
// OpenTelemetry 分散トレーシング SDK 初期化
//
// ・TracerProvider を一度だけ初期化して global に登録する
// ・OTLPTraceExporter (HTTP/protobuf) で Jaeger / Grafana Tempo へ送信
// ・OTel が disabled のときは NoOp Tracer が返るため計装コードは変更不要
//
// 使い方:
//   各モジュールは getTracer() でトレーサーを取得してスパンを生成する
// ─────────────────────────────────────────────────────────────────────────────
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter }                       from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes, defaultResource } from '@opentelemetry/resources';
import { trace, type Tracer }                      from '@opentelemetry/api';
import type { OtelConfig }                         from './config.ts';

let _provider: NodeTracerProvider | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// 初期化 — index.ts の main() 先頭で呼ぶ
// ─────────────────────────────────────────────────────────────────────────────
export function initTelemetry(config: OtelConfig): void {
  if (!config.enabled) return;

  // defaultResource() とアプリ固有属性をマージ
  const resource = {
    ...defaultResource(),
    ...resourceFromAttributes({
      'service.name':           config.serviceName,
      'service.version':        config.serviceVersion,
      'deployment.environment': config.environment,
    }),
  };

  const exporter = new OTLPTraceExporter({ url: config.otlpEndpoint });

  _provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  _provider.register();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracer 取得 — OTel 未初期化時は NoOp Tracer を返す (計装コードは変更不要)
// ─────────────────────────────────────────────────────────────────────────────
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// 終了処理 — graceful shutdown 時に呼ぶ (残留スパンをフラッシュ)
// ─────────────────────────────────────────────────────────────────────────────
export async function shutdownTelemetry(): Promise<void> {
  if (_provider) {
    await _provider.shutdown();
    _provider = undefined;
  }
}
