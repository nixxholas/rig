import type { SlotScope } from "../protocol/SlotProtocol.js";
import type { Webapp } from "../protocol/WebappProtocol.js";

/** Human-readable rejection shared by write-time slot validation and open-time resolution. */
export function describeWebappScopeNotAllowed(webapp: Webapp, scope: SlotScope): string {
    const allowed =
        webapp.allowedScopes.length === 1
            ? `the ${webapp.allowedScopes[0]} scope`
            : `the ${formatList(webapp.allowedScopes)} scopes`;
    return `The webapp ${JSON.stringify(webapp.name)} does not allow the ${scope} scope. It allows only ${allowed}.`;
}

function formatList(values: readonly string[]): string {
    if (values.length === 2) return `${values[0]} and ${values[1]}`;
    return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
