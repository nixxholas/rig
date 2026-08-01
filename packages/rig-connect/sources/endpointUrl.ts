export function endpointUrl(endpoint: string, path: string): string {
    const base = new URL(endpoint);
    const endpointQuery = base.search.slice(1);
    base.search = "";
    base.hash = "";
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const url = new URL(path.replace(/^\/+/u, ""), base);
    if (endpointQuery.length > 0) {
        url.search =
            url.search.length === 0 ? endpointQuery : `${url.search.slice(1)}&${endpointQuery}`;
    }
    return url.toString();
}
