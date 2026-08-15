import type {
    ManagedNetworkPolicy,
    ManagedNetworkRule,
} from "../agent/context/ManagedNetworkPolicy.js";
import type { WorkletPermissions } from "../protocol/WorkletProtocol.js";
import { WorkletInvalidError } from "./WorkletInvalidError.js";

/** What a bare host in a manifest means, matching the port every HTTPS API is reached on. */
const IMPLIED_HOST_PORT = 443;
const HOST_PATTERN =
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/iu;

/** The declared permissions, turned into the terms the sandbox and the network proxy speak. */
export interface WorkletSandboxPermissions {
    fullDiskAccess: boolean;
    fullNetworkAccess: boolean;
    /** Present only for a worklet that named specific hosts. */
    networkPolicy?: ManagedNetworkPolicy;
    /** Absolute paths, besides the worklet's own `Data` folder, it may write. */
    writablePaths: readonly string[];
}

/**
 * Translates a manifest's permissions into what the launcher enforces, refusing anything it
 * cannot enforce faithfully.
 *
 * This runs when a worklet is installed as well as when it starts, so a manifest that asks for
 * something unenforceable is refused at the point a person is reviewing the install rather than
 * silently becoming a worklet that fails to launch later.
 */
export function resolveWorkletPermissions(
    permissions: WorkletPermissions,
    _options: { environment?: NodeJS.ProcessEnv; homeDirectory?: string } = {},
): WorkletSandboxPermissions {
    const { network } = permissions;
    return {
        fullDiskAccess: false,
        fullNetworkAccess: false,
        ...(network === "none"
            ? {}
            : {
                  networkPolicy: {
                      allowedDomains: network.hosts.map((host) => parseNetworkHost(host)),
                  } satisfies ManagedNetworkPolicy,
              }),
        writablePaths: [],
    };
}

/** `api.github.com`, `api.github.com:8080`, or `*.github.com`, and nothing else. */
function parseNetworkHost(declared: string): ManagedNetworkRule {
    const host = declared.trim();
    const separator = host.lastIndexOf(":");
    const domain = separator === -1 ? host : host.slice(0, separator);
    const port = separator === -1 ? IMPLIED_HOST_PORT : Number(host.slice(separator + 1));
    if (!HOST_PATTERN.test(domain)) {
        throw new WorkletInvalidError(
            `The worklet asks to reach ${JSON.stringify(declared)}, which is not a host name. Write a host such as "api.github.com", optionally with a port and a leading "*." for subdomains.`,
        );
    }
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new WorkletInvalidError(
            `The worklet asks to reach ${JSON.stringify(declared)}, which is not a valid port.`,
        );
    }
    return { domain, ports: [port] };
}
