/** Managed network policy and command-scoped proxy lifecycle. */

export {
    loadProjectManagedNetworkPolicy,
    toManagedNetworkPolicy,
    type ManagedNetworkConfig,
} from "./loadProjectManagedNetworkPolicy.js";
export {
    managedNetworkHttpRequestSchema,
    managedNetworkRequestCompletionSchema,
    MANAGED_NETWORK_MAX_BODY_BYTES,
    shouldApplyManagedNetworkPolicy,
    shouldBypassManagedProxyForLoopback,
    validateManagedNetworkLoopbackPorts,
    withTrustedLoopbackPorts,
    type ManagedNetworkBlockedRequest,
    type ManagedNetworkHttpRequest,
    type ManagedNetworkInterceptor,
    type ManagedNetworkPolicy,
    type ManagedNetworkProxyHandle,
    type ManagedNetworkRequestCompletion,
    type ManagedNetworkRule,
    type ManagedNetworkTunnel,
} from "./ManagedNetworkPolicy.js";
export {
    startLinuxManagedNetworkBridge,
    type LinuxManagedNetworkBridge,
} from "./startLinuxManagedNetworkBridge.js";
export { startManagedNetworkProxy } from "./startManagedNetworkProxy.js";
export { isNonPublicAddress } from "./impl/resolveEgressAddress.js";
export {
    startSandboxedProcessNetwork,
    type SandboxedProcessNetwork,
} from "./startSandboxedProcessNetwork.js";
export { startUnifiedEgressProxy } from "./startUnifiedEgressProxy.js";
export {
    parseUnifiedEgressCommandPolicy,
    unifiedEgressCommandPolicySchema,
    type UnifiedEgressCommand,
    type UnifiedEgressCommandPolicy,
    type UnifiedEgressDenial,
    type UnifiedEgressDenialReason,
    type UnifiedEgressProxy,
} from "./UnifiedEgressProxy.js";

export { formatManagedNetworkDenial } from "./impl/formatManagedNetworkDenial.js";
export { MANAGED_NETWORK_SOCAT_PREFLIGHT } from "./impl/managedNetworkSocatPreflight.js";
