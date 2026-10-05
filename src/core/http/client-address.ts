import { BlockList, isIPv4, isIPv6 } from 'node:net';

const IPV4_MAPPED_PREFIX = '::ffff:';

/** `::ffff:192.0.2.1` -> `192.0.2.1`, so an IPv4 client matches IPv4 ranges whichever socket family it came in on. */
export function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  if (lower.startsWith(IPV4_MAPPED_PREFIX) && isIPv4(lower.slice(IPV4_MAPPED_PREFIX.length))) return lower.slice(IPV4_MAPPED_PREFIX.length);
  return lower;
}

export class InvalidCidrError extends Error {
  constructor(value: string) {
    super(`not a CIDR range: "${value}"`);
    this.name = 'InvalidCidrError';
  }
}

/** A set of IPv4/IPv6 CIDR ranges. Throws on a malformed range, so a bad config fails at boot. */
export class AddressRanges {
  private list = new BlockList();
  readonly size: number;

  constructor(cidrs: readonly string[]) {
    for (const cidr of cidrs) this.add(cidr);
    this.size = cidrs.length;
  }

  private add(cidr: string): void {
    const [network, prefixText, ...rest] = cidr.trim().split('/');
    const prefix = Number(prefixText);
    const type = isIPv4(network) ? 'ipv4' : isIPv6(network) ? 'ipv6' : undefined;
    const maxPrefix = type === 'ipv4' ? 32 : 128;
    if (!type || rest.length > 0 || !/^\d+$/.test(prefixText ?? '') || prefix > maxPrefix) throw new InvalidCidrError(cidr);
    this.list.addSubnet(network, prefix, type);
  }

  has(address: string | undefined): boolean {
    const normalized = normalizeAddress(address);
    if (!normalized) return false;
    if (isIPv4(normalized)) return this.list.check(normalized, 'ipv4');
    if (isIPv6(normalized)) return this.list.check(normalized, 'ipv6');
    return false;
  }
}

/** Loopback, private, carrier-grade NAT, link-local and unique-local ranges. */
export const NON_PUBLIC_RANGES = new AddressRanges([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]);
