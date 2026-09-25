import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { promisify } from 'node:util';
import { Agent } from 'undici';
import { ValidationError } from '../errors.js';

/**
 * SSRF protection for user-configurable outbound HTTP actions.
 *
 * Two layers:
 *  1. `assertSafeUrl` rejects non-HTTP(S) schemes, embedded credentials and hosts
 *     that resolve to private, loopback, link-local, metadata or reserved ranges.
 *  2. `createSsrfSafeAgent` re-validates the resolved address at connect time,
 *     so a DNS record that changes between check and connect (DNS rebinding)
 *     cannot redirect the request to an internal address.
 */

const blocked = new BlockList();
const IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const IPV6_RANGES: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of IPV4_RANGES) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of IPV6_RANGES) blocked.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms must be checked as IPv4.
    const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped?.[1] && hexMapped[2]) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return blocked.check(lower, 'ipv6');
  }
  return true; // Not an IP at all: treat as unsafe.
}

const lookupAll = promisify(dnsLookup) as unknown as (
  hostname: string,
  options: { all: true; verbatim: boolean },
) => Promise<LookupAddress[]>;

export interface SsrfOptions {
  allowPrivateNetworks?: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

export async function assertSafeUrl(rawUrl: string, options: SsrfOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`URL scheme "${url.protocol}" is not allowed`);
  }
  if (url.username || url.password) throw new ValidationError('Credentials in URLs are not allowed');
  if (options.allowPrivateNetworks) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new ValidationError('Destination host is not allowed');
  }
  const addresses = isIP(host)
    ? [host]
    : await (options.resolve ?? (async (h) => (await lookupAll(h, { all: true, verbatim: true })).map((a) => a.address)))(host);
  if (addresses.length === 0) throw new ValidationError('Destination host did not resolve');
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new ValidationError('Destination resolves to a private or reserved address');
  }
  return url;
}

/** DNS lookup used at connect time; refuses to hand a private address to the socket. */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = addresses as unknown as LookupAddress[];
    const unsafe = list.find((a) => isPrivateAddress(a.address));
    if (unsafe || list.length === 0) {
      const blockedErr = Object.assign(new Error(`SSRF protection: ${hostname} resolves to a blocked address`), {
        code: 'ESSRFBLOCKED',
      });
      callback(blockedErr, '', 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    } else {
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    }
  });
};

export function createSsrfSafeAgent(options: { allowPrivateNetworks: boolean; keepAliveTimeoutMs: number; timeoutMs: number }): Agent {
  return new Agent({
    keepAliveTimeout: options.keepAliveTimeoutMs,
    keepAliveMaxTimeout: options.keepAliveTimeoutMs * 10,
    headersTimeout: options.timeoutMs,
    bodyTimeout: options.timeoutMs,
    connections: 64,
    connect: options.allowPrivateNetworks ? { timeout: options.timeoutMs } : { timeout: options.timeoutMs, lookup: safeLookup },
  });
}
