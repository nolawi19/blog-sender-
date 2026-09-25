import type { Logger } from '../observability/logger.js';

type Handler = () => Promise<void> | void;

export interface ShutdownOptions {
  logger: Logger;
  timeoutMs: number;
  exit?: (code: number) => void;
}

/**
 * Coordinates graceful shutdown. Handlers run in reverse registration order
 * (LIFO): the component started last (e.g. the HTTP server or the BullMQ worker)
 * stops first, and shared resources (Redis, PostgreSQL) close last. A handler
 * failure is logged and does not prevent the remaining handlers from running.
 * If everything does not finish within `timeoutMs`, the process is force-exited.
 */
export class ShutdownManager {
  private readonly handlers: Array<{ name: string; fn: Handler }> = [];
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly exit: (code: number) => void;
  private running: Promise<void> | null = null;
  private listening = false;

  constructor(options: ShutdownOptions) {
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs;
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  get isShuttingDown(): boolean {
    return this.running !== null;
  }

  register(name: string, fn: Handler): void {
    this.handlers.push({ name, fn });
  }

  listen(signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): void {
    if (this.listening) return;
    this.listening = true;
    for (const signal of signals) {
      process.once(signal, () => {
        void this.shutdown(`signal:${signal}`, 0);
      });
    }
    process.on('uncaughtException', (err) => {
      this.logger.fatal({ err }, 'uncaught exception');
      void this.shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.fatal({ err: reason }, 'unhandled promise rejection');
      void this.shutdown('unhandledRejection', 1);
    });
  }

  shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.running) return this.running;
    this.logger.info({ reason }, 'graceful shutdown started');

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
      timer.unref();
    });

    const work = (async (): Promise<number> => {
      let code = exitCode;
      for (const { name, fn } of [...this.handlers].reverse()) {
        const started = performance.now();
        try {
          await fn();
          this.logger.info({ component: name, ms: Math.round(performance.now() - started) }, 'component stopped');
        } catch (err) {
          code = code === 0 ? 1 : code;
          this.logger.error({ err, component: name }, 'component failed to stop cleanly');
        }
      }
      return code;
    })();

    this.running = Promise.race([work, timeout]).then((result) => {
      if (timer) clearTimeout(timer);
      if (result === 'timeout') {
        this.logger.error({ timeoutMs: this.timeoutMs }, 'graceful shutdown timed out, forcing exit');
        this.logger.flush?.();
        this.exit(1);
        return;
      }
      this.logger.info({ exitCode: result }, 'graceful shutdown complete');
      this.logger.flush?.();
      this.exit(result);
    });
    return this.running;
  }
}
