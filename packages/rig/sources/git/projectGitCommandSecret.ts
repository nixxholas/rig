import type { RuntimeCommandSecret } from "../secrets/index.js";
import { PROJECT_GIT_SECRET_ID } from "../secrets/types.js";
import type { GitCommandAuthentication } from "./GitCredentialBroker.js";

export { PROJECT_GIT_SECRET_ID };

export function projectGitCommandSecret(
    authentication: GitCommandAuthentication,
): RuntimeCommandSecret {
    return {
        activate: () => {
            const lease = authentication.activate();
            return {
                environment: lease.environment,
                release: lease.release,
            };
        },
        description:
            "Git access for this managed project through Rig's credential proxy. Select this only for commands that need the project origin.",
        environment: {},
        environmentVariables: [
            "GCM_INTERACTIVE",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_KEY_1",
            "GIT_CONFIG_VALUE_0",
            "GIT_CONFIG_VALUE_1",
            "GIT_TERMINAL_PROMPT",
        ],
        id: PROJECT_GIT_SECRET_ID,
        trustedLoopbackPorts: [authentication.loopbackPort],
    };
}
