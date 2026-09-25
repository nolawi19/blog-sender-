import { describe, expect, it } from 'vitest';
import { CredentialCipher } from '../src/security/credentials.js';
import { WorkflowLoader, type EndpointRow, type WorkflowRepository, type WorkflowRow } from '../src/workflows/workflow-loader.js';
import { BOT_TOKEN, silentLogger } from './helpers/fixtures.js';

const cipher = new CredentialCipher(Buffer.alloc(32, 3));

function endpointRow(overrides: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: 'ep-1',
    slug: 'blog',
    userId: 'u-1',
    source: 'blog',
    authType: 'BEARER',
    tokenHash: 'a'.repeat(64),
    hmacSecretEncrypted: null,
    defaultEventType: 'post.published',
    idempotencyField: 'post.id',
    dedupeByPayloadHash: true,
    isActive: true,
    ...overrides,
  };
}

function workflowRow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: 'wf-1',
    name: 'Blog to Telegram',
    userId: 'u-1',
    endpointId: 'ep-1',
    triggerEvent: 'post.published',
    version: 1,
    status: 'ACTIVE',
    steps: [
      {
        id: 'st-1',
        key: 'announce',
        position: 0,
        type: 'telegram.sendPhoto',
        config: { chatId: '{{trigger.body.telegram_chat_id}}', photo: '{{trigger.body.image}}', caption: '{{trigger.body.title}}' },
        runIf: null,
        timeoutMs: null,
        credential: { id: 'cr-1', name: 'bot', provider: 'telegram', encryptedData: cipher.encryptJson({ botToken: BOT_TOKEN }) },
      },
    ],
    ...overrides,
  };
}

class FakeRepository implements WorkflowRepository {
  endpoints: EndpointRow[] = [endpointRow()];
  workflows: WorkflowRow[] = [workflowRow()];
  slugQueries = 0;
  async loadAll() {
    return { endpoints: this.endpoints, workflows: this.workflows };
  }
  async loadEndpointBySlug(slug: string) {
    this.slugQueries++;
    const endpoint = this.endpoints.find((e) => e.slug === slug);
    return endpoint ? { endpoint, workflows: this.workflows.filter((w) => w.endpointId === endpoint.id) } : null;
  }
  async loadWorkflow(id: string) {
    return this.workflows.find((w) => w.id === id) ?? null;
  }
}

function loader(repo: FakeRepository, decrypt = true): WorkflowLoader {
  return new WorkflowLoader({ repository: repo, cipher, logger: silentLogger(), refreshIntervalMs: 60_000, decryptStepCredentials: decrypt, negativeCacheTtlMs: 1_000 });
}

describe('WorkflowLoader', () => {
  it('builds an in-memory snapshot with compiled steps and decrypted credentials', async () => {
    const repo = new FakeRepository();
    const l = loader(repo);
    await l.reload();
    expect(l.isReady()).toBe(true);
    const endpoint = l.getEndpoint('blog')!;
    expect(endpoint.idempotencyPath).toEqual(['post', 'id']);
    const [workflow] = l.workflowsFor(endpoint.id, 'post.published');
    expect(workflow?.steps[0]?.config.kind).toBe('object');
    expect(workflow?.steps[0]?.credential?.data).toEqual({ botToken: BOT_TOKEN });
    l.stop();
  });

  it('does not decrypt integration credentials in the gateway', async () => {
    const l = loader(new FakeRepository(), false);
    await l.reload();
    expect(l.workflowsFor('ep-1', 'post.published')[0]?.steps[0]?.credential).toBeNull();
  });

  it('routes by exact event type and wildcard', async () => {
    const repo = new FakeRepository();
    repo.workflows.push(workflowRow({ id: 'wf-all', name: 'audit', triggerEvent: '*' }));
    const l = loader(repo);
    await l.reload();
    expect(l.workflowsFor('ep-1', 'post.published').map((w) => w.id)).toEqual(['wf-1', 'wf-all']);
    expect(l.workflowsFor('ep-1', 'post.deleted').map((w) => w.id)).toEqual(['wf-all']);
    expect(l.workflowsFor('unknown', 'post.published')).toEqual([]);
  });

  it('skips workflows with invalid templates instead of failing the snapshot', async () => {
    const repo = new FakeRepository();
    const bad = workflowRow({ id: 'wf-bad', name: 'bad' });
    bad.steps[0]!.config = { caption: '{{trigger.body.title' };
    repo.workflows.push(bad);
    const l = loader(repo);
    await l.reload();
    expect(l.workflowsFor('ep-1', 'post.published').map((w) => w.id)).toEqual(['wf-1']);
    await expect(l.resolveWorkflow('wf-bad', 1)).rejects.toThrow(/Unclosed/);
  });

  it('loads unknown endpoints on demand and negatively caches misses', async () => {
    const repo = new FakeRepository();
    const l = loader(repo);
    await l.reload();
    repo.endpoints.push(endpointRow({ id: 'ep-2', slug: 'news' }));
    expect(l.getEndpoint('news')).toBeUndefined();
    expect((await l.resolveEndpoint('news'))?.id).toBe('ep-2');
    expect(l.getEndpoint('news')?.id).toBe('ep-2');

    const before = repo.slugQueries;
    expect(await l.resolveEndpoint('ghost')).toBeUndefined();
    expect(await l.resolveEndpoint('ghost')).toBeUndefined();
    expect(repo.slugQueries - before).toBe(1);
  });

  it('caps cache-miss database lookups so random slugs cannot flood PostgreSQL', async () => {
    const repo = new FakeRepository();
    const l = new WorkflowLoader({ repository: repo, cipher, logger: silentLogger(), refreshIntervalMs: 60_000, decryptStepCredentials: false, missLookupsPerSec: 5 });
    await l.reload();
    for (let i = 0; i < 50; i++) await l.resolveEndpoint(`random-${i}`);
    expect(repo.slugQueries).toBeLessThanOrEqual(6);
  });

  it('reloads a workflow from the database when a job carries a newer version', async () => {
    const repo = new FakeRepository();
    const l = loader(repo);
    await l.reload();
    repo.workflows[0] = workflowRow({ version: 2 });
    const workflow = await l.resolveWorkflow('wf-1', 2);
    expect(workflow?.version).toBe(2);
    expect(l.workflowsFor('ep-1', 'post.published')).toHaveLength(1);
  });

  it('coalesces concurrent reloads', async () => {
    const repo = new FakeRepository();
    let calls = 0;
    const original = repo.loadAll.bind(repo);
    repo.loadAll = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return original();
    };
    const l = loader(repo);
    await Promise.all([l.reload(), l.reload(), l.reload(), l.reload()]);
    expect(calls).toBe(2);
  });
});
