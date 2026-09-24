import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch, type RequestInit, type Response } from 'undici';
import ipaddr from 'ipaddr.js';
export interface NetworkOptions {
  allowPrivateNetwork?: boolean;
}
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function assertNetworkTarget(input: string, allowPrivateNetwork = false): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (
    !allowPrivateNetwork &&
    (host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      (isIP(host) && !isPublicAddress(host)))
  )
    throw new Error(
      'Private or reserved network destination blocked. Use allowPrivateNetwork or --allow-private-network only for trusted local targets.',
    );
  return url;
}
export const publicLookup: typeof lookup = ((
  hostname: string,
  options: unknown,
  callback: (...args: unknown[]) => void,
) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address.address))) {
      callback(new Error('DNS resolved to a private or reserved network destination'));
      return;
    }
    const settings =
      typeof options === 'object' && options !== null
        ? (options as {
            all?: boolean;
            family?: number;
          })
        : { family: typeof options === 'number' ? options : 0 };
    const candidates = settings.family
      ? addresses.filter((address) => address.family === settings.family)
      : addresses;
    if (!candidates.length) {
      callback(new Error('No permitted DNS address for the requested family'));
      return;
    }
    if (settings.all) callback(null, candidates);
    else callback(null, candidates[0]!.address, candidates[0]!.family);
  });
}) as typeof lookup;
const publicDispatcher = new Agent({ connect: { lookup: publicLookup }, connections: 8 });
export async function networkFetch(
  url: string,
  options: RequestInit = {},
  allowPrivateNetwork = false,
): Promise<Response> {
  assertNetworkTarget(url, allowPrivateNetwork);
  return fetch(url, {
    ...options,
    redirect: 'manual',
    dispatcher: allowPrivateNetwork ? undefined : publicDispatcher,
  });
}
export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error(`Response exceeds ${limit} bytes`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  }
  return Buffer.concat(chunks);
}
