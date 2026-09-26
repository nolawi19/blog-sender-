import { TemplateError } from '../errors.js';

/**
 * Safe, allocation-light template engine for {{path | filter:arg}} expressions.
 *
 * - No eval / Function / dynamic code: expressions are parsed once into path
 *   segments and a fixed list of whitelisted filters.
 * - Compile once, render many: workflows are compiled when loaded, so rendering
 *   is a single pass over pre-parsed parts with plain property lookups.
 * - Own-property lookups only; `__proto__`, `prototype` and `constructor` are
 *   rejected at compile time, so templates cannot reach object prototypes.
 * - A template that is exactly one expression keeps the value's type
 *   (number, boolean, object); anything else renders to a string.
 * - Missing and null values render as empty strings (and are omitted from
 *   object configs) unless `strict` mode is on, which throws
 *   TemplateResolutionError for missing paths without a `default` filter.
 */

export type PathSegment = string | number;
export type FilterArg = string | number | boolean | null;
export type TemplateContext = Readonly<Record<string, unknown>>;
export type FilterFn = (value: unknown, args: readonly FilterArg[]) => unknown;

export interface FilterSpec {
  minArgs: number;
  maxArgs: number;
  fn: FilterFn;
  validate?: (args: readonly FilterArg[]) => string | null;
}

export interface FilterCall {
  readonly name: string;
  readonly args: readonly FilterArg[];
  readonly fn: FilterFn;
}

export interface Expression {
  readonly source: string;
  readonly path: readonly PathSegment[];
  readonly filters: readonly FilterCall[];
  readonly hasDefault: boolean;
}

export interface CompiledTemplate {
  readonly source: string;
  readonly parts: ReadonlyArray<string | Expression>;
  /** Set when the whole template is exactly one expression (type-preserving). */
  readonly single: Expression | null;
}

export type CompiledValue =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'template'; readonly template: CompiledTemplate }
  | { readonly kind: 'array'; readonly items: readonly CompiledValue[] }
  | { readonly kind: 'object'; readonly entries: ReadonlyArray<readonly [string, CompiledValue]> };

export interface RenderOptions {
  strict?: boolean;
}

export class TemplateSyntaxError extends TemplateError {
  constructor(message: string, readonly template: string) {
    super(message, { code: 'TEMPLATE_SYNTAX_ERROR', details: { template: template.slice(0, 200) } });
  }
}

export class TemplateResolutionError extends TemplateError {
  constructor(readonly expression: string) {
    super(`Template value "${expression}" is missing`, { code: 'TEMPLATE_MISSING_VALUE', details: { expression } });
  }
}

export const MAX_TEMPLATE_LENGTH = 65_536;
export const MAX_OUTPUT_LENGTH = 1_048_576;
export const MAX_PATH_DEPTH = 32;
const MAX_CONFIG_DEPTH = 32;

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
export const ALLOWED_ROOTS: ReadonlySet<string> = new Set(['trigger', 'steps', 'workflow', 'execution']);

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function toText(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'undefined':
      return '';
    case 'object':
      if (value === null) return '';
      if (value instanceof Date) return value.toISOString();
      return JSON.stringify(value);
    default:
      return '';
  }
}

const FALSY_STRINGS: ReadonlySet<string> = new Set(['', 'false', '0', 'null', 'undefined']);

/** Truthiness used by `runIf`. Empty strings, "false", "0", empty arrays/objects are falsy. */
export function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return !FALSY_STRINGS.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export function escapeHtml(text: string): string {
  return /[&<>"]/.test(text) ? text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c) : text;
}

/** Escapes Telegram MarkdownV2 special characters. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
export function stripHtml(text: string): string {
  return text
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncates to at most `max` code points (never splits a surrogate pair), suffix included. */
export function truncate(text: string, max: number, suffix = '…'): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const suffixLen = Array.from(suffix).length;
  if (max <= suffixLen) return chars.slice(0, max).join('');
  return chars.slice(0, max - suffixLen).join('').trimEnd() + suffix;
}

// ---------------------------------------------------------------------------
// Filters (fixed registry; extend with registerFilter)
// ---------------------------------------------------------------------------

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '';

/**
 * Returns the value as an absolute http(s) URL, or undefined when it is empty or
 * not a usable URL. Protocol-relative URLs (//host/path) are upgraded to https.
 */
export function toHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let candidate = value.trim();
  if (candidate === '') return undefined;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.') ? candidate : undefined;
  } catch {
    return undefined;
  }
}

const filters = new Map<string, FilterSpec>([
  ['default', { minArgs: 1, maxArgs: 1, fn: (v, [d]) => (isEmpty(v) ? d : v) }],
  ['escape_html', { minArgs: 0, maxArgs: 0, fn: (v) => escapeHtml(toText(v)) }],
  ['escape_markdown', { minArgs: 0, maxArgs: 0, fn: (v) => escapeMarkdownV2(toText(v)) }],
  ['strip_html', { minArgs: 0, maxArgs: 0, fn: (v) => stripHtml(toText(v)) }],
  [
    'truncate',
    {
      minArgs: 1,
      maxArgs: 2,
      fn: (v, [n, suffix]) => truncate(toText(v), n as number, typeof suffix === 'string' ? suffix : '…'),
      validate: ([n, suffix]) =>
        typeof n !== 'number' || !Number.isInteger(n) || n < 1
          ? 'truncate expects a positive integer length'
          : suffix !== undefined && typeof suffix !== 'string'
            ? 'truncate suffix must be a string'
            : null,
    },
  ],
  ['upper', { minArgs: 0, maxArgs: 0, fn: (v) => toText(v).toUpperCase() }],
  ['lower', { minArgs: 0, maxArgs: 0, fn: (v) => toText(v).toLowerCase() }],
  ['trim', { minArgs: 0, maxArgs: 0, fn: (v) => toText(v).trim() }],
  ['json', { minArgs: 0, maxArgs: 0, fn: (v) => JSON.stringify(v ?? null) }],
  ['url_encode', { minArgs: 0, maxArgs: 0, fn: (v) => encodeURIComponent(toText(v)) }],
  [
    'join',
    { minArgs: 0, maxArgs: 1, fn: (v, [sep]) => (Array.isArray(v) ? v.map(toText).join(typeof sep === 'string' ? sep : ', ') : toText(v)) },
  ],
  ['first', { minArgs: 0, maxArgs: 0, fn: (v) => (Array.isArray(v) ? v[0] : v) }],
  ['string', { minArgs: 0, maxArgs: 0, fn: (v) => toText(v) }],
  [
    'number',
    {
      minArgs: 0,
      maxArgs: 0,
      fn: (v) => {
        if (isEmpty(v)) return undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : undefined;
      },
    },
  ],
  ['not', { minArgs: 0, maxArgs: 0, fn: (v) => !isTruthy(v) }],
  ['http_url', { minArgs: 0, maxArgs: 0, fn: (v) => toHttpUrl(v) }],
]);

export function registerFilter(name: string, spec: FilterSpec): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid filter name "${name}"`);
  filters.set(name, spec);
}

export function listFilters(): string[] {
  return [...filters.keys()];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Finds the index of `}}` closing an expression, ignoring braces inside quotes. */
function findClose(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '}' && source[i + 1] === '}') {
      return i;
    }
  }
  return -1;
}

/** Splits on `separator` outside quotes. */
function splitTopLevel(input: string, separator: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === separator) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

function unquote(raw: string, template: string): string {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote || raw.length < 2) {
    throw new TemplateSyntaxError(`Invalid string literal ${raw}`, template);
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i] as string;
    if (c === '\\') {
      const next = raw[++i];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '');
    } else {
      out += c;
    }
  }
  return out;
}

function parseArg(raw: string, template: string): FilterArg {
  const trimmed = raw.trim();
  if (trimmed === '') throw new TemplateSyntaxError('Empty filter argument', template);
  if (trimmed[0] === '"' || trimmed[0] === "'") return unquote(trimmed, template);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  throw new TemplateSyntaxError(`Invalid filter argument "${trimmed}" (strings must be quoted)`, template);
}

const IDENT = /[A-Za-z0-9_$-]+/y;

export function parsePath(input: string, template = input): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;
  const readIdent = (): string => {
    IDENT.lastIndex = i;
    const m = IDENT.exec(input);
    if (!m) throw new TemplateSyntaxError(`Invalid path "${input}" at position ${i}`, template);
    i = IDENT.lastIndex;
    return m[0];
  };

  const root = readIdent();
  if (!ALLOWED_ROOTS.has(root)) {
    throw new TemplateSyntaxError(`Unknown root "${root}" (allowed: ${[...ALLOWED_ROOTS].join(', ')})`, template);
  }
  segments.push(root);

  while (i < input.length) {
    const c = input[i];
    if (c === '.') {
      i++;
      segments.push(readIdent());
    } else if (c === '[') {
      i++;
      const q = input[i];
      if (q === '"' || q === "'") {
        let end = i + 1;
        while (end < input.length && input[end] !== q) end += input[end] === '\\' ? 2 : 1;
        if (end >= input.length) throw new TemplateSyntaxError(`Unterminated string in path "${input}"`, template);
        segments.push(unquote(input.slice(i, end + 1), template));
        i = end + 1;
      } else {
        const m = /^\d+/.exec(input.slice(i));
        if (!m) throw new TemplateSyntaxError(`Invalid index in path "${input}"`, template);
        segments.push(Number(m[0]));
        i += m[0].length;
      }
      if (input[i] !== ']') throw new TemplateSyntaxError(`Missing "]" in path "${input}"`, template);
      i++;
    } else {
      throw new TemplateSyntaxError(`Unexpected "${c}" in path "${input}"`, template);
    }
    if (segments.length > MAX_PATH_DEPTH) throw new TemplateSyntaxError(`Path "${input}" is too deep`, template);
  }

  for (const s of segments) {
    if (typeof s === 'string' && FORBIDDEN_SEGMENTS.has(s)) {
      throw new TemplateSyntaxError(`Path segment "${s}" is not allowed`, template);
    }
  }
  return segments;
}

function parseExpression(raw: string, template: string): Expression {
  const source = raw.trim();
  if (source === '') throw new TemplateSyntaxError('Empty expression "{{}}"', template);
  const [pathPart, ...filterParts] = splitTopLevel(source, '|');
  const path = parsePath((pathPart ?? '').trim(), template);

  const calls: FilterCall[] = [];
  let hasDefault = false;
  for (const part of filterParts) {
    const trimmed = part.trim();
    const colon = trimmed.indexOf(':');
    const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
    const spec = filters.get(name);
    if (!spec) throw new TemplateSyntaxError(`Unknown filter "${name}"`, template);
    const args = colon === -1 ? [] : splitTopLevel(trimmed.slice(colon + 1), ',').map((a) => parseArg(a, template));
    if (args.length < spec.minArgs || args.length > spec.maxArgs) {
      throw new TemplateSyntaxError(`Filter "${name}" expects ${spec.minArgs}-${spec.maxArgs} argument(s), got ${args.length}`, template);
    }
    const problem = spec.validate?.(args);
    if (problem) throw new TemplateSyntaxError(problem, template);
    if (name === 'default') hasDefault = true;
    calls.push({ name, args, fn: spec.fn });
  }
  return { source, path, filters: calls, hasDefault };
}

export function compileTemplate(source: string): CompiledTemplate {
  if (source.length > MAX_TEMPLATE_LENGTH) throw new TemplateSyntaxError('Template is too long', source);
  const parts: Array<string | Expression> = [];
  let literal = '';
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{{', i);
    if (open === -1) {
      literal += source.slice(i);
      break;
    }
    if (open > 0 && source[open - 1] === '\\') {
      literal += source.slice(i, open - 1) + '{{';
      i = open + 2;
      continue;
    }
    literal += source.slice(i, open);
    const close = findClose(source, open + 2);
    if (close === -1) throw new TemplateSyntaxError(`Unclosed "{{" at position ${open}`, source);
    if (literal) {
      parts.push(literal);
      literal = '';
    }
    parts.push(parseExpression(source.slice(open + 2, close), source));
    i = close + 2;
  }
  if (literal) parts.push(literal);
  const only = parts.length === 1 ? parts[0] : undefined;
  return { source, parts, single: only !== undefined && typeof only !== 'string' ? only : null };
}

const templateCache = new Map<string, CompiledTemplate>();
const TEMPLATE_CACHE_LIMIT = 5_000;

/** compileTemplate with a bounded cache, for ad-hoc strings rendered repeatedly. */
export function compileTemplateCached(source: string): CompiledTemplate {
  const hit = templateCache.get(source);
  if (hit) return hit;
  const compiled = compileTemplate(source);
  if (templateCache.size >= TEMPLATE_CACHE_LIMIT) {
    const oldest = templateCache.keys().next();
    if (!oldest.done) templateCache.delete(oldest.value);
  }
  templateCache.set(source, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type Resolution = { found: true; value: unknown } | { found: false; value: undefined };
const NOT_FOUND: Resolution = { found: false, value: undefined };

export function resolvePath(context: TemplateContext, path: readonly PathSegment[]): Resolution {
  let current: unknown = context;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return NOT_FOUND;
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return NOT_FOUND;
      current = current[segment];
    } else {
      if (!Object.hasOwn(current, segment)) return NOT_FOUND;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

function evaluate(expr: Expression, context: TemplateContext, options: RenderOptions | undefined): unknown {
  const resolved = resolvePath(context, expr.path);
  if (!resolved.found && options?.strict && !expr.hasDefault) throw new TemplateResolutionError(expr.source);
  let value = resolved.value;
  for (const f of expr.filters) value = f.fn(value, f.args);
  return value;
}

/** Renders a template. Single-expression templates return the raw typed value. */
export function renderTemplate(template: CompiledTemplate | string, context: TemplateContext, options?: RenderOptions): unknown {
  const tpl = typeof template === 'string' ? compileTemplateCached(template) : template;
  if (tpl.single) return evaluate(tpl.single, context, options);
  let out = '';
  for (const part of tpl.parts) {
    out += typeof part === 'string' ? part : toText(evaluate(part, context, options));
  }
  if (out.length > MAX_OUTPUT_LENGTH) {
    throw new TemplateError('Rendered template exceeds the maximum output size', { code: 'TEMPLATE_OUTPUT_TOO_LARGE' });
  }
  return out;
}

export function renderString(template: CompiledTemplate | string, context: TemplateContext, options?: RenderOptions): string {
  return toText(renderTemplate(template, context, options));
}

/** Pre-compiles every string inside a JSON-like config tree. */
export function compileValue(value: unknown, depth = 0): CompiledValue {
  if (depth > MAX_CONFIG_DEPTH) throw new TemplateSyntaxError('Configuration is nested too deeply', '');
  if (typeof value === 'string') {
    return value.includes('{{') ? { kind: 'template', template: compileTemplate(value) } : { kind: 'literal', value };
  }
  if (Array.isArray(value)) return { kind: 'array', items: value.map((v) => compileValue(v, depth + 1)) };
  if (value !== null && typeof value === 'object') {
    const entries: Array<readonly [string, CompiledValue]> = [];
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_SEGMENTS.has(key)) throw new TemplateSyntaxError(`Configuration key "${key}" is not allowed`, key);
      entries.push([key, compileValue(v, depth + 1)] as const);
    }
    return { kind: 'object', entries };
  }
  return { kind: 'literal', value };
}

/**
 * Renders a compiled config tree. Object keys whose template resolves to a
 * missing or null value are omitted, so optional fields disappear instead of
 * being sent as "" or null. Literal nulls written in the config are kept.
 */
export function renderValue(compiled: CompiledValue, context: TemplateContext, options?: RenderOptions): unknown {
  switch (compiled.kind) {
    case 'literal':
      return compiled.value;
    case 'template':
      return renderTemplate(compiled.template, context, options);
    case 'array':
      return compiled.items.map((item) => renderValue(item, context, options) ?? null);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of compiled.entries) {
        const rendered = renderValue(item, context, options);
        if (rendered === undefined || (rendered === null && item.kind === 'template')) continue;
        out[key] = rendered;
      }
      return out;
    }
  }
}
