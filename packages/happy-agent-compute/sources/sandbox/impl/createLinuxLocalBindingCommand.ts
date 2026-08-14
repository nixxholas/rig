import { endianness } from "node:os";

import { quoteShellArgument } from "./quoteShellArgument.js";

const FILTER_PATH = "/tmp/agent-compute-local-binding.bpf";
const SECCOMP_FILTER_FD = 3;

/**
 * Runs one command behind a bind/listen seccomp filter after its unfiltered network bridge has
 * started.
 *
 * The nested PID namespace prevents the filtered workload from taking over the parent shell or
 * socat helpers to escape the filter. Its filesystem view begins read-only and reopens only the
 * paths already writable in the outer Bubblewrap sandbox.
 */
export function createLinuxLocalBindingCommand(options: {
    bwrapPath: string;
    command: string;
    commandCwd: string;
    shell: string;
    writablePaths: readonly string[];
}): string {
    const filter = createLocalBindingSeccompFilter();
    const encodedFilter = [...filter]
        .map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`)
        .join("");
    const writablePaths = [...new Set(["/tmp", ...options.writablePaths])].filter(
        (path) => path !== "/" && path !== "/dev" && path !== "/proc",
    );
    const innerArguments = [
        options.bwrapPath,
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        ...writablePaths.flatMap((path) => ["--bind", path, path]),
        "--tmpfs",
        "/proc",
        "--remount-ro",
        "/proc",
        "--seccomp",
        String(SECCOMP_FILTER_FD),
        "--chdir",
        options.commandCwd,
        "--",
        options.shell,
        "-lc",
        options.command,
    ];
    return [
        `printf %b ${quoteShellArgument(encodedFilter)} > ${quoteShellArgument(FILTER_PATH)}`,
        `exec ${String(SECCOMP_FILTER_FD)}<${quoteShellArgument(FILTER_PATH)}`,
        innerArguments.map(quoteShellArgument).join(" "),
    ].join("\n");
}

function createLocalBindingSeccompFilter(): Buffer {
    if (endianness() !== "LE") {
        throw new Error("Linux local-binding isolation supports only little-endian systems.");
    }
    const architecture = linuxSeccompArchitecture();
    return Buffer.concat([
        instruction(0x20, 0, 0, 4), // Load seccomp_data.arch.
        instruction(0x15, 1, 0, architecture.auditArchitecture),
        instruction(0x06, 0, 0, 0x80000000), // Kill an unexpected architecture.
        instruction(0x20, 0, 0, 0), // Load seccomp_data.nr.
        instruction(0x15, 0, 1, architecture.bindSystemCall),
        instruction(0x06, 0, 0, 0x00050001), // Return EPERM.
        instruction(0x15, 0, 1, architecture.listenSystemCall),
        instruction(0x06, 0, 0, 0x00050001), // Return EPERM.
        instruction(0x06, 0, 0, 0x7fff0000), // Allow every other system call.
    ]);
}

function linuxSeccompArchitecture(): {
    auditArchitecture: number;
    bindSystemCall: number;
    listenSystemCall: number;
} {
    if (process.arch === "x64") {
        return {
            auditArchitecture: 0xc000003e,
            bindSystemCall: 49,
            listenSystemCall: 50,
        };
    }
    if (process.arch === "arm64") {
        return {
            auditArchitecture: 0xc00000b7,
            bindSystemCall: 200,
            listenSystemCall: 201,
        };
    }
    throw new Error(
        `Linux local-binding isolation is not available on architecture ${process.arch}.`,
    );
}

function instruction(code: number, jumpTrue: number, jumpFalse: number, value: number): Buffer {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt16LE(code, 0);
    buffer.writeUInt8(jumpTrue, 2);
    buffer.writeUInt8(jumpFalse, 3);
    buffer.writeUInt32LE(value, 4);
    return buffer;
}
