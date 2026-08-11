/**
 * Protocol handlers return after a stream's finite bootstrap and do not await the connection
 * lifetime. Tracing every handler therefore records setup work without retaining a span for SSE.
 */
export function shouldTraceProtocolRoute(_routeName: string): boolean {
    return true;
}
