import { posix } from "node:path";

import type Dockerode from "dockerode";

import { runDockerExec } from "./runDockerExec.js";

/** What a prepared container offers a restricted command: the absolute path to its Bubblewrap. */
export interface PreparedDockerSandbox {
    bwrapPath: string;
}

/**
 * Confirms a container can host restricted commands, and locates its Bubblewrap.
 *
 * A restricted Docker command is only as safe as the image it runs in, so this fails closed with a
 * human-readable explanation when Bubblewrap or socat is missing, or when the nested namespaces
 * Bubblewrap needs are unavailable. The probe uses the exact private-`/proc`-over-tmpfs shape a
 * real command uses, so a container that passes here can actually run one.
 */
export async function prepareDockerSandbox(
    container: Dockerode.Container,
    options: { run?: typeof runDockerExec } = {},
): Promise<PreparedDockerSandbox> {
    const run = options.run ?? runDockerExec;
    const metadata = await run(container, [
        "/bin/sh",
        "-c",
        'bwrap=$(command -v bwrap) || exit 20; command -v socat >/dev/null || exit 22; readlink -f "$bwrap" || exit 21',
    ]);
    if (metadata.exitCode !== 0) throw dockerSandboxRequirementsError(metadata.stderr);

    const bwrapPath = metadata.stdout.toString("utf8").trim();
    if (!posix.isAbsolute(bwrapPath)) {
        throw dockerSandboxRequirementsError(metadata.stderr);
    }

    const probe = await run(container, [
        bwrapPath,
        "--new-session",
        "--die-with-parent",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--unshare-pid",
        "--unshare-user",
        "--tmpfs",
        "/proc",
        "--",
        "/bin/sh",
        "-c",
        ":",
    ]);
    if (probe.exitCode !== 0) throw dockerSandboxRequirementsError(probe.stderr);

    return { bwrapPath };
}

function dockerSandboxRequirementsError(stderr: Buffer): Error {
    const detail = stderr.toString("utf8").trim();
    return new Error(
        "Restricted Docker commands require Bubblewrap, socat, and nested user namespaces. Install bubblewrap and socat in the image; when connecting to an existing container, start it with '--security-opt seccomp=unconfined'." +
            (detail === "" ? "" : ` Docker reported: ${detail}`),
    );
}
