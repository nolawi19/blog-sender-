import type { Config } from '../config.js';
import type { Logger } from '../observability/logger.js';
import { createHttpDriver } from './http/http-driver.js';
import { DriverRegistry } from './integration-driver.js';
import { createTelegramDriver, TelegramClient } from './telegram/telegram-driver.js';

export type IntegrationConfig = Pick<
  Config,
  | 'TELEGRAM_API_BASE_URL'
  | 'TELEGRAM_BOT_TOKEN'
  | 'TELEGRAM_POOL_CONNECTIONS'
  | 'TELEGRAM_WARMUP_CONNECTIONS'
  | 'TELEGRAM_KEEP_WARM_INTERVAL_MS'
  | 'TELEGRAM_INLINE_RETRIES'
  | 'TELEGRAM_RATE_LIMIT_GLOBAL_PER_SEC'
  | 'TELEGRAM_RATE_LIMIT_PER_CHAT_PER_SEC'
  | 'TELEGRAM_RATE_LIMIT_PER_CHAT_BURST'
  | 'TELEGRAM_RATE_LIMIT_MAX_WAIT_MS'
  | 'HTTP_TIMEOUT_MS'
  | 'HTTP_KEEPALIVE_TIMEOUT_MS'
  | 'HTTP_ALLOW_PRIVATE_NETWORKS'
>;

/**
 * Wires every built-in integration into a registry. To add Discord, Slack,
 * Email or WhatsApp: implement an IntegrationDriver next to the Telegram one and
 * register it here. Nothing else in the worker or the engine changes.
 */
export function createDefaultRegistry(config: IntegrationConfig, logger: Logger): DriverRegistry {
  const telegram = new TelegramClient({
    baseUrl: config.TELEGRAM_API_BASE_URL,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    connections: config.TELEGRAM_POOL_CONNECTIONS,
    keepAliveTimeoutMs: config.HTTP_KEEPALIVE_TIMEOUT_MS,
    inlineRetries: config.TELEGRAM_INLINE_RETRIES,
    rateLimit: {
      globalPerSec: config.TELEGRAM_RATE_LIMIT_GLOBAL_PER_SEC,
      perChatPerSec: config.TELEGRAM_RATE_LIMIT_PER_CHAT_PER_SEC,
      perChatBurst: config.TELEGRAM_RATE_LIMIT_PER_CHAT_BURST,
      maxWaitMs: config.TELEGRAM_RATE_LIMIT_MAX_WAIT_MS,
    },
    warmupConnections: config.TELEGRAM_WARMUP_CONNECTIONS,
    keepWarmIntervalMs: config.TELEGRAM_KEEP_WARM_INTERVAL_MS,
    logger: logger.child({ integration: 'telegram' }),
  });

  return new DriverRegistry()
    .register(createTelegramDriver(telegram, { defaultBotToken: config.TELEGRAM_BOT_TOKEN }))
    .register(
      createHttpDriver({
        timeoutMs: config.HTTP_TIMEOUT_MS,
        keepAliveTimeoutMs: config.HTTP_KEEPALIVE_TIMEOUT_MS,
        allowPrivateNetworks: config.HTTP_ALLOW_PRIVATE_NETWORKS,
      }),
    );
}
