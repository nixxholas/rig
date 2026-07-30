import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const execFileAsync = promisify(execFile);
const running = new Set<Gym>();
const containers = new Set<string>();
const images = new Set<string>();
const networks = new Set<string>();
const networkAttachments = new Set<string>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
    await Promise.all(
        [...networkAttachments].map((attachment) => {
            const [network, container] = attachment.split("\0");
            return execFileAsync("docker", [
                "network",
                "disconnect",
                "--force",
                network ?? "",
                container ?? "",
            ]).catch(() => undefined);
        }),
    );
    networkAttachments.clear();
    await Promise.all(
        [...containers].map((container) =>
            execFileAsync("docker", ["rm", "--force", container]).catch(() => undefined),
        ),
    );
    containers.clear();
    await Promise.all(
        [...images].map((image) =>
            execFileAsync("docker", ["image", "rm", "--force", image]).catch(() => undefined),
        ),
    );
    images.clear();
    await Promise.all(
        [...networks].map((network) =>
            execFileAsync("docker", ["network", "rm", network]).catch(() => undefined),
        ),
    );
    networks.clear();
});

describe("Docker managed networking", () => {
    it("reaches an allowed HTTP service through the proxy while direct egress stays isolated", async () => {
        const id = randomUUID();
        const suffix = id.replaceAll("-", "").slice(0, 12);
        const network = `rig-managed-network-${suffix}`;
        const serviceContainer = `rig-managed-service-${suffix}`;
        const targetContainer = `rig-managed-target-${suffix}`;
        const targetImage = await createNonRootImage(suffix);
        const allowedDomain = `allowed-${suffix}.example`;
        const octets = Buffer.from(id.replaceAll("-", "").slice(0, 4), "hex");
        const serviceAddress = `23.${String(64 + ((octets[0] ?? 0) % 128))}.${String(octets[1] ?? 0)}.10`;
        const subnet = serviceAddress.replace(/\.10$/u, ".0/24");
        const port = 18_080;

        await execFileAsync("docker", ["network", "create", "--subnet", subnet, network]);
        networks.add(network);
        await execFileAsync("docker", [
            "run",
            "--detach",
            "--name",
            serviceContainer,
            "--network",
            network,
            "--ip",
            serviceAddress,
            "--entrypoint",
            "node",
            "rig-gym:local",
            "--input-type=module",
            "--eval",
            `import { createServer } from "node:http"; createServer((_request, response) => response.end("docker-managed-network-ok")).listen(${String(port)}, "0.0.0.0");`,
        ]);
        containers.add(serviceContainer);

        const commandScript = `
import { readdir } from "node:fs/promises";
import { connect } from "node:net";

const privateTmpEntries = await readdir("/tmp");
const pidFileVisible = privateTmpEntries.some((name) => name.startsWith("rig-exec-"));
const userId = process.getuid?.();
const allowed = await fetch("http://${allowedDomain}:${String(port)}/allowed");
const allowedBody = await allowed.text();
const direct = await new Promise((resolve) => {
    const socket = connect({ host: "${serviceAddress}", port: ${String(port)} });
    const timer = setTimeout(() => {
        socket.destroy();
        resolve("blocked");
    }, 500);
    socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve("connected");
    });
    socket.once("error", () => {
        clearTimeout(timer);
        resolve("blocked");
    });
});
console.log(JSON.stringify({
    allowedBody,
    allowedStatus: allowed.status,
    direct,
    pidFileVisible,
    userId,
}));
`;
        const deniedCommandScript = `
import { connect } from "node:net";

await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 3128 });
    socket.once("connect", () => {
        socket.end("GET http://blocked-${suffix}.example:${String(port)}/denied HTTP/1.1\\r\\nHost: blocked-${suffix}.example:${String(port)}\\r\\nConnection: close\\r\\n\\r\\n");
    });
    socket.once("error", reject);
    socket.once("close", resolve);
});
`;
        const gym = await createGym({
            args: [
                "--docker-image",
                targetImage,
                "--docker-name",
                targetContainer,
                "--docker-workdir",
                "/workspace",
            ],
            dockerSocket: true,
            files: {
                "rig.toml": `[network]\nallowed_domains = ["${allowedDomain}"]\nallowed_ports = [${String(port)}]\n`,
            },
            inference(request, callIndex) {
                const lastMessage = request.context.messages.at(-1);
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "true" },
                                id: "initialize-docker-target",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    if (
                        lastMessage !== undefined &&
                        "isError" in lastMessage &&
                        lastMessage.isError === true
                    ) {
                        throw new Error(
                            `Docker target initialization failed: ${messageText(lastMessage)}`,
                        );
                    }
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    return {
                        content: [{ text: "DOCKER_TARGET_INITIALIZED", type: "text" }],
                    };
                }
                if (callIndex === 2) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: `node --input-type=module --eval ${shellQuote(commandScript)}`,
                                },
                                id: "exercise-docker-managed-network",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 3) {
                    if (
                        lastMessage !== undefined &&
                        "isError" in lastMessage &&
                        lastMessage.isError === true
                    ) {
                        throw new Error(
                            `Docker managed-network command failed: ${messageText(lastMessage)}`,
                        );
                    }
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    const result = messageText(lastMessage);
                    expect(result).toContain('"allowedBody":"docker-managed-network-ok"');
                    expect(result).toContain('"allowedStatus":200');
                    expect(result).toContain('"direct":"blocked"');
                    expect(result).toContain('"pidFileVisible":false');
                    expect(result).toContain('"userId":12345');
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: `node --input-type=module --eval ${shellQuote(deniedCommandScript)}`,
                                },
                                id: "exercise-docker-managed-network-denial",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                expect(callIndex).toBe(4);
                if (
                    lastMessage === undefined ||
                    !("isError" in lastMessage) ||
                    lastMessage.isError !== true
                ) {
                    throw new Error(
                        `Docker network denial unexpectedly succeeded: ${messageText(lastMessage)}`,
                    );
                }
                expect(messageText(lastMessage)).toContain(
                    `Network access to blocked-${suffix}.example:${String(port)} was denied by Rig's sandbox network policy`,
                );
                expect(messageText(lastMessage)).toContain(
                    "removing them cannot grant direct network access",
                );
                return {
                    content: [{ text: "DOCKER_MANAGED_NETWORK_COMPLETE", type: "text" }],
                };
            },
            mode: "docker",
            mountWorkspaceIntoDockerSession: true,
            permissionMode: "workspace_write",
        });
        running.add(gym);
        containers.add(targetContainer);

        await execFileAsync("docker", ["network", "connect", network, gym.dockerContainerName]);
        networkAttachments.add(`${network}\0${gym.dockerContainerName}`);
        await execFileAsync("docker", [
            "exec",
            "--user",
            "0",
            gym.dockerContainerName,
            "/bin/sh",
            "-c",
            'printf "%s\\t%s\\n" "$1" "$2" >> /etc/hosts',
            "rig",
            serviceAddress,
            allowedDomain,
        ]);

        submit(gym, "Initialize the Docker execution target.");
        await gym.terminal.waitForText("DOCKER_TARGET_INITIALIZED", 40_000);
        await execFileAsync("docker", ["network", "connect", network, targetContainer]);
        networkAttachments.add(`${network}\0${targetContainer}`);
        await expect(
            execFileAsync("docker", [
                "exec",
                targetContainer,
                "node",
                "--input-type=module",
                "--eval",
                `const response = await fetch("http://${serviceAddress}:${String(port)}"); if (!response.ok) process.exit(1);`,
            ]),
        ).resolves.toBeDefined();

        submit(gym, "Exercise the allowed, denied, direct, and bridge Docker network paths.");
        await gym.terminal.waitForText("DOCKER_MANAGED_NETWORK_COMPLETE", 40_000);

        await expect(readdir(`${gym.workspacePath}/.rig-network`)).resolves.toEqual([]);
    }, 120_000);

    it("prevents a concurrent restricted command from replacing another command's bridge", async () => {
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const targetContainer = `rig-managed-replacement-${suffix}`;
        const gym = await createGym({
            args: [
                "--docker-image",
                "rig-gym:local",
                "--docker-name",
                targetContainer,
                "--docker-workdir",
                "/workspace",
            ],
            dockerSocket: true,
            files: {
                "rig.toml": '[network]\nallowed_domains = ["example.com"]\n',
            },
            inference(request, callIndex) {
                const lastMessage = request.context.messages.at(-1);
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "sleep 20", yield_time_ms: 100 },
                                id: "keep-owner-bridge-live",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    expect(messageText(lastMessage)).toMatch(
                        /Process running with session ID \d+/u,
                    );
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: [
                                        "set -eu",
                                        'count=$(find .rig-network -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d " ")',
                                        '[ "$count" -ge 2 ] || { echo "missing concurrent bridge: $count" >&2; exit 1; }',
                                        "socket=$(find .rig-network -type s -name http.sock | head -n 1)",
                                        '[ -n "$socket" ] || { echo "missing bridge socket" >&2; exit 1; }',
                                        'if mv "$socket" "$socket.moved" 2>/dev/null; then echo "bridge replacement succeeded" >&2; exit 1; fi',
                                        'echo "CONCURRENT_REPLACEMENT_BLOCKED:$count"',
                                    ].join("\n"),
                                },
                                id: "attempt-concurrent-bridge-replacement",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                expect(callIndex).toBe(2);
                expect(lastMessage).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                expect(messageText(lastMessage)).toContain("CONCURRENT_REPLACEMENT_BLOCKED:");
                return {
                    content: [{ text: "CONCURRENT_BRIDGE_REPLACEMENT_BLOCKED", type: "text" }],
                };
            },
            mode: "docker",
            mountWorkspaceIntoDockerSession: true,
            permissionMode: "workspace_write",
        });
        running.add(gym);
        containers.add(targetContainer);

        submit(gym, "Verify concurrent managed-network bridge isolation.");
        await gym.terminal.waitForText("CONCURRENT_BRIDGE_REPLACEMENT_BLOCKED", 40_000);
    }, 120_000);

    it("prevents a concurrent restricted command from creating policy for the next command", async () => {
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const targetContainer = `rig-config-mask-${suffix}`;
        const gym = await createGym({
            args: [
                "--docker-image",
                "rig-gym:local",
                "--docker-name",
                targetContainer,
                "--docker-workdir",
                "/workspace",
            ],
            dockerSocket: true,
            inference(request, callIndex) {
                const lastMessage = request.context.messages.at(-1);
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: [
                                        "while :; do",
                                        "  { printf '[network]\\nallowed_domains = [\"example.com\"]\\n' > rig.toml; } 2>/dev/null || true",
                                        "  sleep 0.01",
                                        "done",
                                    ].join("\n"),
                                    yield_time_ms: 100,
                                },
                                id: "attempt-concurrent-policy-creation",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    expect(messageText(lastMessage)).toMatch(
                        /Process running with session ID \d+/u,
                    );
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: 'test ! -s rig.toml && echo "CONCURRENT_CONFIG_MASKED"',
                                },
                                id: "read-policy-during-concurrent-creation",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                expect(callIndex).toBe(2);
                expect(lastMessage).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                expect(messageText(lastMessage)).toContain("CONCURRENT_CONFIG_MASKED");
                return {
                    content: [{ text: "CONCURRENT_CONFIG_CREATION_BLOCKED", type: "text" }],
                };
            },
            mode: "docker",
            mountWorkspaceIntoDockerSession: true,
            permissionMode: "workspace_write",
        });
        running.add(gym);
        containers.add(targetContainer);

        submit(gym, "Verify that a background command cannot create network policy.");
        await gym.terminal.waitForText("CONCURRENT_CONFIG_CREATION_BLOCKED", 40_000);

        await gym.dispose();
        running.delete(gym);
        await expect(access(`${gym.workspacePath}/rig.toml`)).rejects.toMatchObject({
            code: "ENOENT",
        });
    }, 120_000);

    it("revalidates a bridge root replaced by a symlink after an earlier command", async () => {
        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const targetContainer = `rig-bridge-revalidate-${suffix}`;
        const gym = await createGym({
            args: [
                "--docker-image",
                "rig-gym:local",
                "--docker-name",
                targetContainer,
                "--docker-workdir",
                "/workspace",
            ],
            dockerSocket: true,
            inference(request, callIndex) {
                const lastMessage = request.context.messages.at(-1);
                if (callIndex === 0 || callIndex === 2) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "true" },
                                id: callIndex === 0 ? "prime-bridge-root" : "reuse-bridge-root",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    expect(lastMessage).toMatchObject({
                        isError: false,
                        role: "toolResult",
                        toolName: "exec_command",
                    });
                    return { content: [{ text: "BRIDGE_ROOT_PRIMED", type: "text" }] };
                }
                expect(callIndex).toBe(3);
                expect(lastMessage).toMatchObject({
                    isError: true,
                    role: "toolResult",
                    toolName: "exec_command",
                });
                expect(messageText(lastMessage)).toContain(
                    "Docker managed network bridge root must be a real directory",
                );
                return { content: [{ text: "BRIDGE_ROOT_REVALIDATED", type: "text" }] };
            },
            mode: "docker",
            mountWorkspaceIntoDockerSession: true,
            permissionMode: "workspace_write",
        });
        running.add(gym);
        containers.add(targetContainer);

        submit(gym, "Prime the protected Docker bridge root.");
        await gym.terminal.waitForText("BRIDGE_ROOT_PRIMED", 40_000);
        await execFileAsync("docker", [
            "exec",
            "--user",
            "0",
            targetContainer,
            "/bin/sh",
            "-c",
            "rm -rf /workspace/.rig-network && ln -s /tmp /workspace/.rig-network",
        ]);

        submit(gym, "Verify the protected Docker bridge root again.");
        await gym.terminal.waitForText("BRIDGE_ROOT_REVALIDATED", 40_000);
        const { stdout } = await execFileAsync("docker", [
            "exec",
            "--user",
            "0",
            targetContainer,
            "/bin/sh",
            "-c",
            "find /tmp -maxdepth 1 -name '.config-*' -print",
        ]);
        expect(stdout).toBe("");
    }, 120_000);
});

function messageText(message: { content: unknown } | undefined): string {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter(
            (block): block is { text: string; type: "text" } =>
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "text" &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function submit(gym: Gym, message: string): void {
    gym.terminal.type(message);
    gym.terminal.press("enter");
}

async function createNonRootImage(suffix: string): Promise<string> {
    const seed = `rig-non-root-seed-${suffix}`;
    const image = `rig-gym-non-root:${suffix}`;
    await execFileAsync("docker", ["create", "--name", seed, "rig-gym:local"]);
    containers.add(seed);
    try {
        await execFileAsync("docker", ["commit", "--change", "USER 12345:12345", seed, image]);
        images.add(image);
        return image;
    } finally {
        await execFileAsync("docker", ["rm", "--force", seed]).catch(() => undefined);
        containers.delete(seed);
    }
}
