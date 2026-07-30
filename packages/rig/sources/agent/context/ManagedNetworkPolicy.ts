export interface ManagedNetworkRule {
    domain: string;
    ports?: readonly number[];
}

export interface ManagedNetworkPolicy {
    allowedDomains?: readonly ManagedNetworkRule[];
    allowedLoopbackPorts?: readonly number[];
    deniedDomains?: readonly ManagedNetworkRule[];
}

export interface ManagedNetworkProxyHandle {
    close(): Promise<void>;
    port: number;
    socksPort: number;
}
