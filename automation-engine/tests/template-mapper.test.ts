import { describe, expect, it } from 'vitest';
import {
  compileTemplate,
  compileValue,
  escapeMarkdownV2,
  isTruthy,
  parsePath,
  renderString,
  renderTemplate,
  renderValue,
  TemplateResolutionError,
  TemplateSyntaxError,
  truncate,
} from '../src/mapper/template-mapper.js';

const context = {
  trigger: {
    body: {
      title: 'Hello <World> & "friends"',
      author: { name: 'Alex', profile: { handle: '@alex' } },
      tags: ['go', 'node'],
      items: [{ name: 'first' }, { name: 'second' }],
      count: 3,
      published: true,
      nothing: null,
      empty: '',
      'key with space': 'spaced',
      telegram_chat_id: -1001234567890,
    },
    headers: { authorization: 'Bearer abc', 'x-event-type': 'post.published' },
    query: { id: '42', tags: ['a', 'b'] },
  },
  steps: { announce: { output: { messageId: 99 } } },
  workflow: { id: 'wf-1', name: 'Test' },
  execution: { id: 'exec-1', attempt: 1 },
};

describe('template mapper: variable resolution', () => {
  it('resolves the documented paths', () => {
    expect(renderTemplate('{{trigger.body.title}}', context)).toBe('Hello <World> & "friends"');
    expect(renderTemplate('{{trigger.body.author.name}}', context)).toBe('Alex');
    expect(renderTemplate('{{trigger.headers.authorization}}', context)).toBe('Bearer abc');
    expect(renderTemplate('{{trigger.query.id}}', context)).toBe('42');
  });

  it('resolves deeply nested properties, array indexes and quoted keys', () => {
    expect(renderTemplate('{{trigger.body.author.profile.handle}}', context)).toBe('@alex');
    expect(renderTemplate('{{trigger.body.items[1].name}}', context)).toBe('second');
    expect(renderTemplate('{{trigger.body.items.0.name}}', context)).toBe('first');
    expect(renderTemplate('{{trigger.body["key with space"]}}', context)).toBe('spaced');
    expect(renderTemplate("{{trigger.headers['x-event-type']}}", context)).toBe('post.published');
    expect(renderTemplate('{{trigger.headers.x-event-type}}', context)).toBe('post.published');
    expect(renderTemplate('{{steps.announce.output.messageId}}', context)).toBe(99);
  });

  it('tolerates whitespace inside braces', () => {
    expect(renderTemplate('{{   trigger.body.author.name   }}', context)).toBe('Alex');
  });

  it('interpolates multiple expressions into a string', () => {
    expect(renderTemplate('New post: {{trigger.body.title}} by {{trigger.body.author.name}} ({{trigger.body.count}})', context)).toBe(
      'New post: Hello <World> & "friends" by Alex (3)',
    );
  });

  it('preserves the type of single-expression templates', () => {
    expect(renderTemplate('{{trigger.body.count}}', context)).toBe(3);
    expect(renderTemplate('{{trigger.body.published}}', context)).toBe(true);
    expect(renderTemplate('{{trigger.body.telegram_chat_id}}', context)).toBe(-1001234567890);
    expect(renderTemplate('{{trigger.body.tags}}', context)).toEqual(['go', 'node']);
    expect(renderTemplate('{{trigger.body.author}}', context)).toEqual({ name: 'Alex', profile: { handle: '@alex' } });
  });

  it('stringifies objects inside mixed templates', () => {
    expect(renderString('tags={{trigger.body.tags}}', context)).toBe('tags=["go","node"]');
  });
});

describe('template mapper: missing and null values', () => {
  it('renders missing and null values as empty strings in lenient mode', () => {
    expect(renderTemplate('[{{trigger.body.missing}}]', context)).toBe('[]');
    expect(renderTemplate('[{{trigger.body.nothing}}]', context)).toBe('[]');
    expect(renderTemplate('[{{trigger.body.author.missing.deeper}}]', context)).toBe('[]');
    expect(renderTemplate('[{{trigger.body.items[10].name}}]', context)).toBe('[]');
    expect(renderTemplate('[{{trigger.body.title.length}}]', context)).toBe('[]');
  });

  it('returns undefined for a missing single expression', () => {
    expect(renderTemplate('{{trigger.body.missing}}', context)).toBeUndefined();
    expect(renderTemplate('{{trigger.body.nothing}}', context)).toBeNull();
  });

  it('throws TemplateResolutionError for missing paths in strict mode', () => {
    expect(() => renderTemplate('{{trigger.body.missing}}', context, { strict: true })).toThrow(TemplateResolutionError);
    try {
      renderTemplate('x {{trigger.body.author.missing}}', context, { strict: true });
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateResolutionError);
      expect((err as TemplateResolutionError).expression).toBe('trigger.body.author.missing');
      expect((err as TemplateResolutionError).retryable).toBe(false);
    }
  });

  it('null is a found value, so strict mode accepts it', () => {
    expect(renderTemplate('[{{trigger.body.nothing}}]', context, { strict: true })).toBe('[]');
  });

  it('the default filter covers missing, null and empty values, even in strict mode', () => {
    expect(renderTemplate('{{trigger.body.missing | default:"Untitled"}}', context, { strict: true })).toBe('Untitled');
    expect(renderTemplate('{{trigger.body.nothing | default:"n/a"}}', context)).toBe('n/a');
    expect(renderTemplate('{{trigger.body.empty | default:"empty"}}', context)).toBe('empty');
    expect(renderTemplate('{{trigger.body.count | default:0}}', context)).toBe(3);
  });

  it('omits object keys whose template resolves to nothing', () => {
    const compiled = compileValue({ chatId: '{{trigger.body.telegram_chat_id}}', caption: '{{trigger.body.missing}}', literalNull: null });
    expect(renderValue(compiled, context)).toEqual({ chatId: -1001234567890, literalNull: null });
  });
});

describe('template mapper: filters', () => {
  it('escapes HTML and MarkdownV2', () => {
    expect(renderTemplate('{{trigger.body.title | escape_html}}', context)).toBe('Hello &lt;World&gt; &amp; &quot;friends&quot;');
    expect(escapeMarkdownV2('a_b*c.d!')).toBe('a\\_b\\*c\\.d\\!');
  });

  it('truncates by code points without splitting surrogate pairs', () => {
    expect(truncate('😀😀😀😀😀', 3)).toBe('😀😀…');
    expect(renderTemplate('{{trigger.body.title | truncate:8}}', context)).toBe('Hello <…');
    expect(renderTemplate('{{trigger.body.title | truncate:8, "..."}}', context)).toBe('Hello...');
    expect(truncate('short', 10)).toBe('short');
  });

  it('chains filters left to right', () => {
    const tpl = '{{trigger.body.missing | default:"<b>x</b>" | strip_html | upper}}';
    expect(renderTemplate(tpl, context)).toBe('X');
    expect(renderTemplate('{{trigger.body.tags | join:" / "}}', context)).toBe('go / node');
    expect(renderTemplate('{{trigger.query.id | number}}', context)).toBe(42);
    expect(renderTemplate('{{trigger.body.author | json}}', context)).toBe('{"name":"Alex","profile":{"handle":"@alex"}}');
    expect(renderTemplate('{{trigger.body.title | url_encode}}', context)).toBe('Hello%20%3CWorld%3E%20%26%20%22friends%22');
  });

  it('supports pipes and braces inside quoted filter arguments', () => {
    expect(renderTemplate('{{trigger.body.missing | default:"a | b }} c"}}', context)).toBe('a | b }} c');
  });
});

describe('template mapper: syntax and safety', () => {
  it('supports escaped braces', () => {
    expect(renderTemplate('literal \\{{not a var}} and {{trigger.body.count}}', context)).toBe('literal {{not a var}} and 3');
  });

  it('rejects prototype access at compile time', () => {
    expect(() => compileTemplate('{{trigger.__proto__.polluted}}')).toThrow(TemplateSyntaxError);
    expect(() => compileTemplate('{{trigger.body.constructor}}')).toThrow(TemplateSyntaxError);
    expect(() => compileTemplate('{{trigger["prototype"]}}')).toThrow(TemplateSyntaxError);
    expect(() => compileValue(JSON.parse('{"__proto__": "x"}'))).toThrow(TemplateSyntaxError);
  });

  it('does not resolve inherited properties', () => {
    expect(renderTemplate('[{{trigger.body.hasOwnProperty}}]', context)).toBe('[]');
    expect(renderTemplate('[{{trigger.body.toString}}]', context)).toBe('[]');
  });

  it('only allows known roots, so process/env/globals are unreachable', () => {
    expect(() => compileTemplate('{{process.env.SECRET}}')).toThrow(/Unknown root/);
    expect(() => compileTemplate('{{globalThis.x}}')).toThrow(TemplateSyntaxError);
  });

  it('never evaluates code', () => {
    expect(() => compileTemplate('{{trigger.body.title + 1}}')).toThrow(TemplateSyntaxError);
    expect(() => compileTemplate('{{ (() => 1)() }}')).toThrow(TemplateSyntaxError);
    expect(() => compileTemplate("{{trigger.body.title | constructor:'return 1'}}")).toThrow(/Unknown filter/);
  });

  it('reports predictable syntax errors', () => {
    expect(() => compileTemplate('{{trigger.body.title')).toThrow(/Unclosed/);
    expect(() => compileTemplate('{{}}')).toThrow(/Empty expression/);
    expect(() => compileTemplate('{{trigger.body.title | truncate}}')).toThrow(/expects 1-2 argument/);
    expect(() => compileTemplate('{{trigger.body.title | truncate:"x"}}')).toThrow(/positive integer/);
    expect(() => compileTemplate('{{trigger.body.title | default:unquoted}}')).toThrow(/must be quoted/);
    expect(() => compileTemplate('{{trigger.body.items[x]}}')).toThrow(/Invalid index/);
  });

  it('parses paths into typed segments', () => {
    expect(parsePath('trigger.body.items[2]["a b"].c')).toEqual(['trigger', 'body', 'items', 2, 'a b', 'c']);
  });

  it('marks templates made of a single expression as type-preserving', () => {
    expect(compileTemplate('{{trigger.body.count}}').single).not.toBeNull();
    expect(compileTemplate(' {{trigger.body.count}}').single).toBeNull();
  });
});

describe('isTruthy', () => {
  it.each([
    [undefined, false],
    [null, false],
    [false, false],
    [0, false],
    ['', false],
    ['  false ', false],
    ['0', false],
    [[], false],
    [{}, false],
    ['yes', true],
    [1, true],
    [['x'], true],
    [{ a: 1 }, true],
  ])('isTruthy(%j) === %s', (value, expected) => {
    expect(isTruthy(value)).toBe(expected);
  });
});

describe('http_url filter', () => {
  it.each([
    ['https://blogger.googleusercontent.com/img/b/x.jpg', 'https://blogger.googleusercontent.com/img/b/x.jpg'],
    ['  http://example.com/a.png  ', 'http://example.com/a.png'],
    ['//blogger.googleusercontent.com/img/x.jpg', 'https://blogger.googleusercontent.com/img/x.jpg'],
    ['', undefined],
    ['   ', undefined],
    ['not-a-url', undefined],
    ['/relative/path.jpg', undefined],
    ['ftp://example.com/a.jpg', undefined],
    ['javascript:alert(1)', undefined],
    ['http://localhost/a.jpg', undefined],
    [null, undefined],
    [42, undefined],
  ])('http_url(%j) -> %j', (image, expected) => {
    expect(renderTemplate('{{trigger.body.image | http_url}}', { trigger: { body: { image } } })).toBe(expected);
  });
});

