import type { Socket } from "node:net";

export const PLUGIN_DOCKER_BRIDGE_HANDSHAKE_TIMEOUT_MS = 30_000;

export function armPluginDockerBridgeHandshakeTimeout(
    socket: Pick<Socket, "destroy" | "setTimeout">,
    timeoutMs = PLUGIN_DOCKER_BRIDGE_HANDSHAKE_TIMEOUT_MS,
): () => void {
    let established = false;
    socket.setTimeout(timeoutMs, () => {
        if (!established) socket.destroy();
    });
    return () => {
        established = true;
        socket.setTimeout(0);
    };
}
