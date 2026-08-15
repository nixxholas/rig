import { dirname, join, resolve } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { readTokenIfPresent } from "./ensureLocalProtocolServer.js";
import { ProtocolHttpClient } from "./ProtocolHttpClient.js";

const connectHappyAgentProtocolServerOptionsSchema = Type.Object(
    {
        agentHome: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        socketPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        tokenPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    },
    { additionalProperties: false },
);

export type ConnectHappyAgentProtocolServerOptions = Static<
    typeof connectHappyAgentProtocolServerOptionsSchema
>;

export interface HappyAgentProtocolServerConnection {
    readonly client: ProtocolHttpClient;
    readonly socketPath: string;
    readonly token: string;
    readonly tokenPath: string;
}

/**
 * Connects Rig's protocol client to a running Happy Agent daemon.
 *
 * Happy Agent mounts its Rig-compatible surface below `/v0`, while retaining the same private
 * Unix-socket and adjacent bearer-token mechanics as Rig's local daemon.
 */
export async function connectHappyAgentProtocolServer(
    options: ConnectHappyAgentProtocolServerOptions,
): Promise<HappyAgentProtocolServerConnection> {
    if (!Value.Check(connectHappyAgentProtocolServerOptionsSchema, options)) {
        throw new Error("Happy Agent connection paths are invalid.");
    }
    if (options.agentHome === undefined && options.socketPath === undefined) {
        throw new Error("Happy Agent connection requires an agent home or socket path.");
    }

    const socketSource =
        options.socketPath ??
        (options.agentHome === undefined ? undefined : join(options.agentHome, "server.sock"));
    if (socketSource === undefined) {
        throw new Error("Happy Agent connection requires an agent home or socket path.");
    }
    const socketPath = resolve(socketSource);
    const tokenPath = resolve(
        options.tokenPath ??
            (options.agentHome === undefined
                ? join(dirname(socketPath), "token")
                : join(options.agentHome, "token")),
    );
    const token = await readTokenIfPresent(tokenPath);
    if (token === undefined || token.length === 0) {
        throw new Error(`Happy Agent has no readable bearer token at '${tokenPath}'.`);
    }
    const client = new ProtocolHttpClient({
        pathPrefix: "/v0",
        socketPath,
        token,
    });
    await client.health();
    return { client, socketPath, token, tokenPath };
}
