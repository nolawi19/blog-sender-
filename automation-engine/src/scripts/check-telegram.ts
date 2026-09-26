/**
 * Verifies the Telegram side of the pipeline without printing any secret.
 *
 *   docker compose exec worker node dist/scripts/check-telegram.js              (read-only checks)
 *   docker compose exec worker node dist/scripts/check-telegram.js --send-test  (also sends one message)
 *
 * Checks, in order:
 *   1. TELEGRAM_BOT_TOKEN is set and accepted by Telegram (getMe)
 *   2. TELEGRAM_CHANNEL_ID is set and resolves to a chat of type "channel" (getChat)
 *   3. the bot is an administrator of that channel with "Post messages" (getChatMember)
 *   4. with --send-test: a real sendMessage to the channel succeeds
 * Exits with code 1 if any check fails.
 */
import { loadConfig } from '../config.js';
import { AppError, classifyError } from '../errors.js';
import { TelegramClient } from '../integrations/telegram/telegram-driver.js';
import { createLogger } from '../observability/logger.js';

type Status = 'PASS' | 'FAIL' | 'WARN';

function describe(err: unknown): string {
  const e = classifyError(err);
  const description = e instanceof AppError ? e.details?.['description'] : undefined;
  const hint = e instanceof AppError ? e.details?.['hint'] : undefined;
  return [`${e.code}: ${typeof description === 'string' ? description : e.message}`, typeof hint === 'string' ? `-> ${hint}` : ''].filter(Boolean).join('  ');
}

interface ChatInfo {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface ChatMember {
  status: string;
  can_post_messages?: boolean;
}

export interface TelegramCheckOptions {
  token: string | undefined;
  channel: string | undefined;
  client: TelegramClient;
  sendTest: boolean;
  write: (line: string) => void;
}

/** Runs the checks; returns true when nothing failed. Never writes the token. */
export async function runTelegramChecks(options: TelegramCheckOptions): Promise<boolean> {
  const { token, channel, client } = options;
  let ok = true;
  const report = (status: Status, check: string, detail: string): void => {
    if (status === 'FAIL') ok = false;
    options.write(`${status.padEnd(4)}  ${check.padEnd(22)} ${detail}`);
  };

  report(token ? 'PASS' : 'FAIL', 'TELEGRAM_BOT_TOKEN', token ? 'SET' : 'MISSING (add it to .env)');
  report(channel ? 'PASS' : 'FAIL', 'TELEGRAM_CHANNEL_ID', channel ? 'SET' : 'MISSING (add @channelusername or the -100... channel ID to .env)');
  if (!token) return false;

  let botId: number | null = null;
  try {
    const me = await client.call<{ id: number; username?: string }>(token, 'getMe', {});
    botId = me.id;
    report('PASS', 'bot token valid', `bot @${me.username ?? me.id}`);
  } catch (err) {
    report('FAIL', 'bot token valid', describe(err));
  }
  if (!channel || botId === null) return false;

  let chat: ChatInfo | null = null;
  try {
    chat = await client.call<ChatInfo>(token, 'getChat', { chat_id: channel });
    const name = `"${chat.title ?? ''}"${chat.username ? ` (@${chat.username})` : ''} id ${chat.id}`;
    if (chat.type === 'channel') report('PASS', 'destination is channel', name);
    else if (chat.type === 'private') report('FAIL', 'destination is channel', `${name} is a PERSONAL chat, not a channel`);
    else report('FAIL', 'destination is channel', `${name} is a ${chat.type}, not a channel`);
  } catch (err) {
    report('FAIL', 'destination is channel', describe(err));
  }
  if (!chat) return false;

  try {
    const member = await client.call<ChatMember>(token, 'getChatMember', { chat_id: channel, user_id: botId });
    if (member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false)) {
      report('PASS', 'bot can post', `bot is ${member.status}${member.can_post_messages ? ' with "Post messages"' : ''}`);
    } else if (member.status === 'administrator') {
      report('FAIL', 'bot can post', 'bot is an administrator WITHOUT "Post messages": enable it in the channel admin settings');
    } else {
      report('FAIL', 'bot can post', `bot status is "${member.status}": add the bot as a channel administrator with "Post messages"`);
    }
  } catch (err) {
    report('FAIL', 'bot can post', describe(err));
  }

  if (options.sendTest) {
    try {
      const message = await client.sendMessage(token, {
        chatId: channel,
        text: `✅ Automation engine test message (${new Date().toISOString()}). You can delete this.`,
      });
      report('PASS', 'test message sent', `message_id ${message.message_id}`);
    } catch (err) {
      report('FAIL', 'test message sent', describe(err));
    }
  }
  return ok;
}

async function main(): Promise<boolean> {
  const config = loadConfig();
  const client = new TelegramClient({
    baseUrl: config.TELEGRAM_API_BASE_URL,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    connections: 1,
    keepAliveTimeoutMs: 5_000,
    inlineRetries: 0,
    rateLimit: { globalPerSec: 30, perChatPerSec: 30, perChatBurst: 30, maxWaitMs: 2_000 },
    warmupConnections: 0,
    keepWarmIntervalMs: 0,
    logger: createLogger({ level: 'silent', service: 'check-telegram' }),
  });
  try {
    return await runTelegramChecks({
      token: config.TELEGRAM_BOT_TOKEN,
      channel: config.TELEGRAM_CHANNEL_ID,
      client,
      sendTest: process.argv.includes('--send-test'),
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    await client.close();
  }
}

// Run only when executed directly (tests import runTelegramChecks).
if (process.argv[1] && /check-telegram\.(js|ts)$/.test(process.argv[1])) {
  main()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err: unknown) => {
      process.stderr.write(`check-telegram failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
