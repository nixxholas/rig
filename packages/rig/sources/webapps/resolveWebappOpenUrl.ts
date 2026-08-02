import type { ResolveWebappOpenRequest, WebappContext } from "../protocol/WebappProtocol.js";
import type { WebappContextTokenStore } from "./WebappContextTokenStore.js";

export const WEBAPP_CONTEXT_QUERY_PARAMETER = "rigContext";

/** Resolves one client open action into the current static version plus its context capability. */
export function resolveWebappOpenUrl(
    webapp: string,
    request: ResolveWebappOpenRequest,
    context: WebappContext,
    tokens: WebappContextTokenStore,
): string {
    const segments = (request.path ?? "")
        .split("/")
        .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
        .map(encodeURIComponent);
    const parameters = new URLSearchParams(request.query);
    parameters.set(WEBAPP_CONTEXT_QUERY_PARAMETER, tokens.mint(context));
    return `/webapps/${encodeURIComponent(webapp)}/files/${segments.join("/")}?${parameters.toString()}`;
}
