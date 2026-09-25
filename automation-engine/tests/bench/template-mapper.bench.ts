/**
 * Template mapper micro-benchmarks:  npm run bench:mapper
 * Numbers depend on the machine; run them on the target host.
 */
import { bench, describe } from 'vitest';
import { compileTemplate, compileValue, renderTemplate, renderValue } from '../../src/mapper/template-mapper.js';

const context = {
  trigger: {
    body: {
      id: 'post-1001',
      title: 'Shipping a sub-30ms automation engine',
      excerpt: '<p>How we replaced a SaaS automation tool with <b>Fastify</b>, BullMQ &amp; Redis.</p>',
      image: 'https://example.com/cover.jpg',
      url: 'https://blog.example.com/posts/sub-30ms',
      author: { name: 'Alex Doe', profile: { handle: '@alex' } },
      tags: [{ name: 'node' }, { name: 'performance' }],
      telegram_chat_id: '-1001234567890',
    },
    headers: { authorization: 'Bearer abc', 'user-agent': 'blog/1.0' },
    query: { id: '42' },
  },
  steps: {},
  workflow: { id: 'wf', name: 'bench' },
  execution: { id: 'exec', attempt: 1 },
};

const simpleConfig = compileValue({
  chatId: '{{trigger.body.telegram_chat_id}}',
  photo: '{{trigger.body.image}}',
  caption: '{{trigger.body.title}}',
});

const richConfig = compileValue({
  chatId: '{{trigger.body.telegram_chat_id}}',
  photo: '{{trigger.body.image}}',
  parseMode: 'HTML',
  caption:
    '<b>{{trigger.body.title | escape_html}}</b>\n{{trigger.body.excerpt | strip_html | truncate:700 | escape_html}}\n\n✍️ {{trigger.body.author.name | default:"Editorial" | escape_html}}\n<a href="{{trigger.body.url | escape_html}}">Read more</a>',
});

const single = compileTemplate('{{trigger.body.author.profile.handle}}');
const source = 'New post: {{trigger.body.title}} by {{trigger.body.author.name}} ({{trigger.query.id}})';

describe('template mapper', () => {
  bench('render single nested expression (pre-compiled)', () => {
    renderTemplate(single, context);
  });

  bench('render 3-field Telegram config (pre-compiled)', () => {
    renderValue(simpleConfig, context);
  });

  bench('render rich HTML caption config with filters (pre-compiled)', () => {
    renderValue(richConfig, context);
  });

  bench('render string template (cached compile)', () => {
    renderTemplate(source, context);
  });

  bench('compile + render (no cache)', () => {
    renderTemplate(compileTemplate(source), context);
  });
});
