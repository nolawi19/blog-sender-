import { createServer, type Server } from 'node:http';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

export interface HealthServerOptions {
  port: number;
  host: string;
  metrics: Metrics;
  logger: Logger;
  readiness: () => Promise<{ ready: boolean; checks: Record<string, boolean> }>;
}

/** Minimal HTTP server for the worker: /health, /ready, /metrics, /metrics/latency. */
export async function startHealthServer(options: HealthServerOptions): Promise<{ server: Server; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const send = (status: number, body: string, contentType = 'application/json'): void => {
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
      res.end(body);
    };
    const route = async (): Promise<void> => {
      switch (req.url?.split('?')[0]) {
        case '/health':
          return send(200, JSON.stringify({ status: 'ok', uptimeSec: Math.round(process.uptime()) }));
        case '/ready': {
          const report = await options.readiness();
          return send(report.ready ? 200 : 503, JSON.stringify({ status: report.ready ? 'ready' : 'not_ready', checks: report.checks }));
        }
        case '/metrics':
          return send(200, await options.metrics.prometheus(), options.metrics.contentType);
        case '/metrics/latency':
          return send(200, JSON.stringify(await options.metrics.latencySnapshot()));
        default:
          return send(404, JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
      }
    };
    route().catch((err: unknown) => {
      options.logger.error({ err }, 'health server request failed');
      if (!res.headersSent) send(500, JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } }));
    });
  });
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  options.logger.info({ port: options.port }, 'worker health/metrics server listening');

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
}
