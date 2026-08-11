import { readPackageVersion } from "../readPackageVersion.js";
import type { DaemonIdentity } from "../protocol/index.js";

export function getDaemonIdentity(
    environment: NodeJS.ProcessEnv = process.env,
    version: string = readPackageVersion(),
): DaemonIdentity {
    const developmentBuildId = environment.RIG_DEVELOPMENT_BUILD_ID?.trim();
    const globalDevelopmentVersion = environment.RIG_DAEMON_IDENTITY_VERSION?.trim();
    const identityVersion =
        environment.RIG_RUNTIME_MODE === "global-development" &&
        globalDevelopmentVersion !== undefined &&
        globalDevelopmentVersion.length > 0
            ? globalDevelopmentVersion
            : version;
    return {
        version: identityVersion,
        ...(developmentBuildId === undefined || developmentBuildId.length === 0
            ? {}
            : { developmentBuildId }),
    };
}
