import type { ResolveAppletOpenRequest, AppletContext } from "../protocol/AppletProtocol.js";
import type { AppletContextTokenStore } from "./AppletContextTokenStore.js";

export const APPLET_CONTEXT_QUERY_PARAMETER = "rigContext";

/** Resolves one client open action into the current static version plus its context capability. */
export function resolveAppletOpenUrl(
    applet: string,
    request: ResolveAppletOpenRequest,
    context: AppletContext,
    tokens: AppletContextTokenStore,
): string {
    const segments = (request.path ?? "")
        .split("/")
        .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
        .map(encodeURIComponent);
    const parameters = new URLSearchParams(request.query);
    parameters.set(APPLET_CONTEXT_QUERY_PARAMETER, tokens.mint(context));
    return `/applets/${encodeURIComponent(applet)}/files/${segments.join("/")}?${parameters.toString()}`;
}
