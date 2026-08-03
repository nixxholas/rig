import {
    happyComputePreparationEventSchema,
    type HappyComputeEventSubscription,
    type HappyComputePreparationEvent,
} from "./computeTypes.js";
import { openHappyPluginEventStream } from "./openHappyPluginEventStream.js";
import type { HappyMcpTransport } from "./startHappyMcpServer.js";

export async function subscribeHappyComputePreparation(
    handler: (event: HappyComputePreparationEvent) => void | Promise<void>,
    transport: HappyMcpTransport,
): Promise<HappyComputeEventSubscription> {
    let closing = false;
    let failure: string | undefined;
    let status: HappyComputeEventSubscription["status"] = "connected";
    const stream = await openHappyPluginEventStream({
        eventSchema: happyComputePreparationEventSchema,
        label: "compute preparation",
        onEvent: (event) =>
            Promise.resolve()
                .then(() => handler(event))
                .catch((error: unknown) => {
                    warn(`The Happy compute event subscriber failed. ${errorToMessage(error)}`);
                }),
        path: "/compute/events",
        socketPath: transport.socketPath,
        token: transport.token,
    });
    void stream.closed.then((error) => {
        status = "closed";
        if (closing) return;
        failure = error.message;
        warn(`The Happy compute preparation stream closed. ${error.message}`);
    });
    return {
        get failure() {
            return failure;
        },
        get status() {
            return status;
        },
        async close() {
            if (closing) return;
            closing = true;
            status = "closed";
            stream.close();
            await stream.closed;
        },
    };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Plugin logging is diagnostic and cannot fail compute event delivery.
    }
}
