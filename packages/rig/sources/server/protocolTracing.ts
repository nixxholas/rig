const LONG_RUNNING_PROTOCOL_ROUTES = new Set([
    "global-events-stream",
    "live-events-stream",
    "stream",
]);

/** Long-lived event streams have no useful request duration and must not occupy trace storage. */
export function shouldTraceProtocolRoute(routeName: string): boolean {
    const operation = routeName.startsWith("peer.") ? routeName.slice("peer.".length) : routeName;
    return !LONG_RUNNING_PROTOCOL_ROUTES.has(operation);
}
