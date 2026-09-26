/**
 * Mock Telegram Bot API for local testing and benchmarks (no real messages sent).
 *
 *   MOCK_TELEGRAM_PORT=8081 MOCK_LATENCY_MS=40 npm run mock:telegram
 *   then run the worker with TELEGRAM_API_BASE_URL=http://localhost:8081
 *
 * Env:
 *   MOCK_LATENCY_MS       artificial response latency (simulates the real API RTT)
 *   MOCK_ERROR_RATE       0..1 probability of a 500 response
 *   MOCK_RATE_LIMIT_RATE  0..1 probability of a 429 with retry_after=1
 *   MOCK_FAIL_FIRST       respond 500 to the first N requests (retry testing)
 *   MOCK_BOT_NOT_ADMIN=1  simulate a bot that was not added to the channel
 *
 * Like the real API, sendPhoto is rejected with 400 when the photo is not a URL
 * ("wrong file identifier/HTTP URL specified") or its host cannot be reached
 * (hosts under the reserved .invalid TLD: "failed to get HTTP URL content").
 * GET /requests returns the last 50 calls (method, chat_id, photo, text) without tokens.
 */
import { createServer, type IncomingMessage } from 'node:http';

const port = Number(process.env['MOCK_TELEGRAM_PORT'] ?? 8081);
const latencyMs = Number(process.env['MOCK_LATENCY_MS'] ?? 0);
const errorRate = Number(process.env['MOCK_ERROR_RATE'] ?? 0);
const rateLimitRate = Number(process.env['MOCK_RATE_LIMIT_RATE'] ?? 0);
let failFirst = Number(process.env['MOCK_FAIL_FIRST'] ?? 0);

const TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
const stats = { requests: 0, ok: 0, errors: 0, rateLimited: 0, byMethod: {} as Record<string, number>, connections: 0 };
let messageId = 1;
const recent: Array<{ at: string; method: string; chat_id: unknown; photo?: unknown; text?: string }> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
    return;
  }
  if (req.url === '/stats') return send(200, stats);
  if (req.url === '/requests') return send(200, recent);
  if (req.url === '/stats/reset' && req.method === 'POST') {
    Object.assign(stats, { requests: 0, ok: 0, errors: 0, rateLimited: 0, byMethod: {} });
    return send(200, stats);
  }

  const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? '');
  if (!match || req.method !== 'POST') return send(404, { ok: false, error_code: 404, description: 'Not Found' });
  const [, token = '', method = ''] = match;
  const raw = await readBody(req);
  stats.requests++;
  stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;

  if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
  if (!TOKEN.test(token)) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
  if (failFirst > 0) {
    failFirst--;
    stats.errors++;
    return send(500, { ok: false, error_code: 500, description: 'Internal Server Error (MOCK_FAIL_FIRST)' });
  }
  if (Math.random() < rateLimitRate) {
    stats.rateLimited++;
    return send(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
  }
  if (Math.random() < errorRate) {
    stats.errors++;
    return send(500, { ok: false, error_code: 500, description: 'Internal Server Error (mock)' });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return send(400, { ok: false, error_code: 400, description: 'Bad Request: invalid JSON' });
  }
  const text = String(body['text'] ?? body['caption'] ?? '');
  recent.push({ at: new Date().toISOString(), method, chat_id: body['chat_id'], ...(method === 'sendPhoto' ? { photo: body['photo'] } : {}), text: text.slice(0, 200) });
  if (recent.length > 50) recent.shift();
  if (method === 'getMe') return send(200, { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Mock bot', username: 'mock_automation_bot' } });
  if (body['chat_id'] === undefined || body['chat_id'] === '') return send(400, { ok: false, error_code: 400, description: 'Bad Request: chat_id is empty' });
  // Like Telegram: @username and -100... IDs are channels here, positive IDs are personal chats.
  const chatRef = String(body['chat_id']);
  const isChannel = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chatRef) || /^-100\d+$/.test(chatRef);
  if (method === 'getChat') {
    if (isChannel) return send(200, { ok: true, result: { id: -1001234567890, type: 'channel', title: 'Mock channel', ...(chatRef.startsWith('@') ? { username: chatRef.slice(1) } : {}) } });
    if (/^\d+$/.test(chatRef)) return send(200, { ok: true, result: { id: Number(chatRef), type: 'private', first_name: 'Someone' } });
    return send(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
  }
  if (method === 'getChatMember') {
    if (process.env['MOCK_BOT_NOT_ADMIN'] === '1') return send(200, { ok: true, result: { status: 'left', user: { id: body['user_id'] } } });
    return send(200, { ok: true, result: { status: 'administrator', can_post_messages: true, user: { id: body['user_id'] } } });
  }
  if (process.env['MOCK_BOT_NOT_ADMIN'] === '1' && isChannel) {
    return send(403, { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the channel chat' });
  }
  if (method === 'sendPhoto' && !body['photo']) return send(400, { ok: false, error_code: 400, description: 'Bad Request: there is no photo in the request' });
  if (method === 'sendPhoto') {
    let host = '';
    try {
      host = new URL(String(body['photo'])).hostname;
    } catch {
      return send(400, { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' });
    }
    if (host.endsWith('.invalid')) return send(400, { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' });
  }
  if (method === 'sendMessage' && !body['text']) return send(400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' });

  stats.ok++;
  const chatId = Number(body['chat_id']);
  send(200, {
    ok: true,
    result: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number.isFinite(chatId) ? chatId : 0, type: 'private' },
      ...(method === 'sendPhoto' ? { caption: body['caption'] } : { text: body['text'] }),
    },
  });
});

server.on('connection', () => stats.connections++);
server.keepAliveTimeout = 120_000;
server.listen(port, '0.0.0.0', () => process.stdout.write(`mock telegram listening on :${port} (latency ${latencyMs} ms)\n`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
