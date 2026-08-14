import {
    type ManagedNetworkInterceptor,
    type ManagedNetworkPolicy,
    type ManagedNetworkProxyHandle,
    shouldBypassManagedProxyForLoopback,
    validateManagedNetworkLoopbackPorts,
} from "./ManagedNetworkPolicy.js";
import {
    startLinuxManagedNetworkBridge,
    type LinuxManagedNetworkBridge,
} from "./startLinuxManagedNetworkBridge.js";
import { startManagedNetworkProxy } from "./startManagedNetworkProxy.js";
import { runCleanupSteps } from "../sandbox/impl/runCleanupSteps.js";

export interface SandboxedProcessNetwork {
    readonly sandboxOptions: {
        networkAllowLocalBinding?: boolean;
        networkAllowedLoopbackPorts?: readonly number[];
        networkUnixProxySockets?: {
            authenticationToken: string;
            http: string;
            loopback?: readonly { path: string; port: number }[];
            socks: string;
        };
    };
    readonly proxy?: ManagedNetworkProxyHandle;
    close(): Promise<void>;
    withProxyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

export async function startSandboxedProcessNetwork(
    policy: ManagedNetworkPolicy | undefined,
    options: { networkInterceptor?: ManagedNetworkInterceptor } = {},
): Promise<SandboxedProcessNetwork | undefined> {
    if (policy === undefined) return undefined;
    if (process.platform !== "darwin" && process.platform !== "linux")
        throw new Error("Managed network access is currently supported only on macOS and Linux.");
    if (
        (policy.allowedDomains?.length ?? 0) === 0 &&
        (policy.allowedLoopbackPorts?.length ?? 0) === 0 &&
        policy.allowLocalBinding !== true
    ) {
        return undefined;
    }
    validateManagedNetworkLoopbackPorts(policy.allowedLoopbackPorts ?? []);
    if (
        (policy.allowedDomains?.length ?? 0) === 0 &&
        (policy.allowedLoopbackPorts?.length ?? 0) === 0
    ) {
        return {
            sandboxOptions: networkSandboxOptions(policy),
            close: async () => {},
            withProxyEnvironment(environment) {
                return environment;
            },
        };
    }
    // The interceptor is only forwarded when present, because exact optional properties reject an
    // explicit `networkInterceptor: undefined`.
    const proxy = await startManagedNetworkProxy(
        policy,
        options.networkInterceptor === undefined
            ? {}
            : { networkInterceptor: options.networkInterceptor },
    );
    try {
        const bridge =
            process.platform === "linux"
                ? await startLinuxManagedNetworkBridge(
                      proxy,
                      policy.allowedLoopbackPorts === undefined
                          ? {}
                          : { loopbackPorts: policy.allowedLoopbackPorts },
                  )
                : undefined;
        return {
            sandboxOptions: networkSandboxOptions(policy, proxy, bridge),
            proxy,
            async close() {
                await runCleanupSteps("managed network", [
                    ...(bridge === undefined ? [] : [() => bridge.close()]),
                    () => proxy.close(),
                ]);
            },
            withProxyEnvironment(environment) {
                return withManagedNetworkProxy(environment, proxy, bridge, policy);
            },
        };
    } catch (error) {
        await proxy.close();
        throw error;
    }
}

function networkSandboxOptions(
    policy: ManagedNetworkPolicy | undefined,
    proxy?: ManagedNetworkProxyHandle,
    bridge?: LinuxManagedNetworkBridge,
): SandboxedProcessNetwork["sandboxOptions"] {
    const ports = [
        ...(policy?.allowedLoopbackPorts ?? []),
        ...(proxy === undefined ? [] : [proxy.port, proxy.socksPort]),
    ];
    return {
        ...(process.platform === "darwin" && policy?.allowLocalBinding === true
            ? { networkAllowLocalBinding: true }
            : {}),
        ...(ports.length === 0 ? {} : { networkAllowedLoopbackPorts: [...new Set(ports)] }),
        ...(bridge === undefined
            ? {}
            : {
                  networkUnixProxySockets: {
                      authenticationToken: bridge.authenticationToken,
                      http: bridge.httpSocketPath,
                      loopback: bridge.loopbackSockets,
                      socks: bridge.socksSocketPath,
                  },
              }),
    };
}

function withManagedNetworkProxy(
    environment: NodeJS.ProcessEnv,
    proxy: ManagedNetworkProxyHandle | undefined,
    bridge: LinuxManagedNetworkBridge | undefined,
    policy: ManagedNetworkPolicy | undefined,
): NodeJS.ProcessEnv {
    if (proxy === undefined) return environment;
    const url =
        bridge === undefined ? `http://127.0.0.1:${String(proxy.port)}` : "http://127.0.0.1:3128";
    const socksUrl =
        bridge === undefined
            ? `socks5h://127.0.0.1:${String(proxy.socksPort)}`
            : "socks5h://127.0.0.1:1080";
    const noProxy = shouldBypassManagedProxyForLoopback(policy, process.platform === "linux")
        ? "localhost,127.0.0.1,::1"
        : "";
    return {
        ...environment,
        ALL_PROXY: socksUrl,
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: noProxy,
        all_proxy: socksUrl,
        http_proxy: url,
        https_proxy: url,
        no_proxy: noProxy,
    };
}
