import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Type } from "@sinclair/typebox";

import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

const textDocumentSchema = Type.Object(
    { instructions: Type.String({ maxLength: 256 * 1024 }) },
    { additionalProperties: false },
);
const securityDocumentSchema = Type.Object(
    { policy: Type.String({ maxLength: 32 * 1024 }) },
    { additionalProperties: false },
);
const daemonConfigSchema = Type.Object(
    {
        p2p: Type.Optional(
            Type.Object(
                { name: Type.String({ minLength: 1, maxLength: 128 }) },
                {
                    additionalProperties: false,
                },
            ),
        ),
        settings: Type.Object(
            {
                durableGlobalEventQueue: Type.Boolean(),
                inferenceMaxRetries: Type.Integer({ minimum: 0, maximum: 20 }),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

export function createConfigRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("configuration", [
        {
            method: "GET",
            path: "/v0/config",
            handle: async ({ dependencies, response }) => {
                sendJson(response, 200, { config: readConfig(dependencies) });
            },
        },
        {
            method: "PATCH",
            path: "/v0/config",
            handle: async ({ request }) => {
                await readValidatedBody(request, daemonConfigSchema);
                throw new AgentHttpError(409, "This daemon cannot change its settings at runtime.");
            },
        },
        {
            method: "GET",
            path: "/v0/config/instructions",
            handle: async ({ dependencies, response }) => {
                sendJson(response, 200, {
                    instructions: await readDocument(
                        dependencies.configuration?.instructionsPath ??
                            join(dependencies.agent.agentHome, "AGENTS.md"),
                        256 * 1024,
                    ),
                });
            },
        },
        {
            method: "PUT",
            path: "/v0/config/instructions",
            handle: async ({ dependencies, request, response }) => {
                const body = await readValidatedBody(request, textDocumentSchema);
                const path =
                    dependencies.configuration?.instructionsPath ??
                    join(dependencies.agent.agentHome, "AGENTS.md");
                await writeDocument(path, body.instructions, 256 * 1024);
                sendJson(response, 200, {
                    instructions: await readDocument(path, 256 * 1024),
                });
                dependencies.agent.modules.events.append({
                    agentId: dependencies.agent.agent.id,
                    payload: { bytes: Buffer.byteLength(body.instructions, "utf8") },
                    type: "config.instructions_changed",
                });
            },
        },
        {
            method: "GET",
            path: "/v0/config/security",
            handle: async ({ dependencies, response }) => {
                sendJson(response, 200, {
                    policy: await readDocument(
                        dependencies.configuration?.securityPath ??
                            join(dependencies.agent.agentHome, "AGENTS_SECURITY.md"),
                        32 * 1024,
                    ),
                });
            },
        },
        {
            method: "PUT",
            path: "/v0/config/security",
            handle: async ({ dependencies, request, response }) => {
                const body = await readValidatedBody(request, securityDocumentSchema);
                const path =
                    dependencies.configuration?.securityPath ??
                    join(dependencies.agent.agentHome, "AGENTS_SECURITY.md");
                await writeDocument(path, body.policy, 32 * 1024);
                sendJson(response, 200, {
                    policy: await readDocument(path, 32 * 1024),
                });
                dependencies.agent.modules.events.append({
                    agentId: dependencies.agent.agent.id,
                    payload: { bytes: Buffer.byteLength(body.policy, "utf8") },
                    type: "config.security_changed",
                });
            },
        },
    ]);
}

function readConfig(dependencies: {
    readonly agent: { readonly agentHome: string };
    readonly configuration?: {
        readonly p2pName?: string;
        readonly inferenceMaxRetries?: number;
        readonly durableGlobalEventQueue?: boolean;
    };
}): {
    readonly p2p: { readonly name: string; readonly role: "primary" };
    readonly settings: {
        readonly durableGlobalEventQueue: boolean;
        readonly inferenceMaxRetries: number;
    };
} {
    return {
        p2p: {
            name: dependencies.configuration?.p2pName ?? "Happy Agent",
            role: "primary",
        },
        settings: {
            durableGlobalEventQueue: dependencies.configuration?.durableGlobalEventQueue ?? false,
            inferenceMaxRetries: dependencies.configuration?.inferenceMaxRetries ?? 0,
        },
    };
}

async function readDocument(path: string, maxBytes: number): Promise<string> {
    try {
        const data = await readFile(path);
        if (data.byteLength > maxBytes) {
            throw new AgentHttpError(409, "The configured document exceeds its size limit.");
        }
        return data.toString("utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
    }
}

async function writeDocument(path: string, value: string, maxBytes: number): Promise<void> {
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
        throw new AgentHttpError(400, "The configured document exceeds its size limit.");
    }
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, path);
        await chmod(path, 0o600);
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
}
