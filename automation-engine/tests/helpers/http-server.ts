import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
  json: Record<string, unknown> | null;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  connections: number;
  setHandler(handler: Handler): void;
  close(): Promise<void>;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Local HTTP server with a swappable handler, used as a fake Telegram API. */
export async function startTestServer(initial: Handler): Promise<TestServer> {
  let handler = initial;
  const requests: RecordedRequest[] = [];
  const state = { connections: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      const recorded: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, json: parsed };
      requests.push(recorded);
      void Promise.resolve(handler(recorded, res)).catch(() => {
        if (!res.headersSent) json(res, 500, { ok: false });
      });
    });
  });
  server.on('connection', () => state.connections++);
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get connections() {
      return state.connections;
    },
    setHandler(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function telegramOk(res: ServerResponse, chatId: number | string = 42, messageId = 1): void {
  json(res, 200, { ok: true, result: { message_id: messageId, date: 1_700_000_000, chat: { id: Number(chatId), type: 'private' } } });
}
