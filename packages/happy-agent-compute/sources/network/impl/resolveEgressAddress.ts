import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Name resolution for a sandboxed workload, performed on the host.
 *
 * Resolution stays here rather than inside the sandbox because a name the policy allows must not
 * be pointed at an address it does not. The bound also matters: an unanswered lookup has to become
 * a refusal in bounded time instead of holding a connection open.
 */
export class NonPublicAddressError extends Error {}
export class DnsResolutionError extends Error {}

export function egressResolutionBlockedReason(
    error: unknown,
): "dns_resolution_failed" | "non_public_address" | undefined {
    if (error instanceof NonPublicAddressError) return "non_public_address";
    if (error instanceof DnsResolutionError) return "dns_resolution_failed";
    return undefined;
}

export function createBoundedEgressResolver(
    resolveAddress: (host: string) => Promise<string>,
    timeoutMs: number,
): (host: string) => Promise<string> {
    return async (host) => {
        let timeout: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                Promise.resolve()
                    .then(() => resolveAddress(host))
                    .catch((error: unknown) => {
                        if (error instanceof NonPublicAddressError) throw error;
                        throw new DnsResolutionError();
                    }),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => reject(new DnsResolutionError()), timeoutMs);
                    timeout.unref();
                }),
            ]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    };
}

export async function resolvePublicEgressAddress(host: string): Promise<string> {
    if (host === "localhost") throw new NonPublicAddressError();
    const addresses =
        isIP(host) === 0 ? await lookup(host, { all: true, verbatim: true }) : [{ address: host }];
    const publicAddress = addresses.find(({ address }) => !isNonPublicAddress(address));
    if (
        publicAddress === undefined ||
        addresses.some(({ address }) => isNonPublicAddress(address))
    ) {
        throw new NonPublicAddressError();
    }
    return publicAddress.address;
}

export async function resolveAnyEgressAddress(host: string): Promise<string> {
    if (host === "localhost") return "127.0.0.1";
    if (isIP(host) !== 0) return host;
    const address = await lookup(host, { verbatim: true });
    return address.address;
}

export function isNonPublicAddress(address: string): boolean {
    const addressKind = isIP(address);
    if (addressKind === 4) return isNonPublicIpv4(parseIpv4Octets(address));
    if (addressKind !== 6) return true;
    const words = parseIpv6Words(address);
    if (words === undefined) return true;
    if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
        return isNonPublicIpv4([
            (words[6]! >>> 8) & 0xff,
            words[6]! & 0xff,
            (words[7]! >>> 8) & 0xff,
            words[7]! & 0xff,
        ]);
    }
    return (
        (words[0]! & 0xfe00) === 0xfc00 ||
        (words[0]! & 0xffc0) === 0xfe80 ||
        (words[0]! & 0xff00) === 0xff00
    );
}

function isNonPublicIpv4(octets: readonly number[]): boolean {
    return (
        octets[0] === 0 ||
        octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
        (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
        (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
        (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
        (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
        (octets[0] ?? 0) >= 224
    );
}

function parseIpv4Octets(address: string): readonly number[] {
    return address.split(".").map(Number);
}

function parseIpv6Words(address: string): readonly number[] | undefined {
    let normalized = address.toLowerCase();
    if (normalized.includes(".")) {
        const separator = normalized.lastIndexOf(":");
        if (separator === -1) return undefined;
        const octets = parseIpv4Octets(normalized.slice(separator + 1));
        if (
            octets.length !== 4 ||
            octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) {
            return undefined;
        }
        normalized =
            `${normalized.slice(0, separator)}:` +
            `${((octets[0]! << 8) | octets[1]!).toString(16)}:` +
            `${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    }
    const halves = normalized.split("::");
    if (halves.length > 2) return undefined;
    const left = parseIpv6Half(halves[0] ?? "");
    const right = halves.length === 1 ? [] : parseIpv6Half(halves[1] ?? "");
    if (left === undefined || right === undefined) return undefined;
    if (halves.length === 1) return left.length === 8 ? left : undefined;
    const omitted = 8 - left.length - right.length;
    return omitted < 1 ? undefined : [...left, ...Array<number>(omitted).fill(0), ...right];
}

function parseIpv6Half(value: string): readonly number[] | undefined {
    if (value === "") return [];
    const segments = value.split(":");
    if (segments.some((segment) => !/^[\da-f]{1,4}$/u.test(segment))) return undefined;
    return segments.map((segment) => Number.parseInt(segment, 16));
}
