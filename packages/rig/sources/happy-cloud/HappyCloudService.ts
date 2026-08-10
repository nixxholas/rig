import type {
    HappyCloudCommand,
    HappyCloudCommandResponse,
    HappyCloudProfileCiphertextResponse,
    HappyCloudSessionBlobResponse,
    HappyCloudStatus,
    HappyCloudChangedEvent,
} from "../protocol/HappyCloudProtocol.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import { happyCloudApplyCommand } from "../persistence/happy-cloud/happyCloudApplyCommand.js";
import { queryHappyCloudProfile } from "../persistence/happy-cloud/queryHappyCloudProfile.js";
import { queryHappyCloudSessionBlob } from "../persistence/happy-cloud/queryHappyCloudSessionBlob.js";
import { queryHappyCloudStatus } from "../persistence/happy-cloud/queryHappyCloudStatus.js";
import type { Context } from "@steve.kite/stdlib";

export interface HappyCloudServiceContract {
    apply(ctx: Context, command: HappyCloudCommand): Promise<HappyCloudCommandResponse>;
    getProfile(ctx: Context): Promise<HappyCloudProfileCiphertextResponse | undefined>;
    getSessionBlob(
        ctx: Context,
        sessionId: string,
    ): Promise<HappyCloudSessionBlobResponse | undefined>;
    status(ctx: Context): Promise<HappyCloudStatus>;
}

export interface HappyCloudPersistence {
    query<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
    transaction<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
}

export interface HappyCloudServiceOptions {
    now?: () => number;
    persistence: HappyCloudPersistence;
    publish?: (ctx: Context, event: HappyCloudChangedEvent) => void | Promise<void>;
}

export class HappyCloudService implements HappyCloudServiceContract {
    readonly #createEventId = createEventIdFactory();
    readonly #now: () => number;
    readonly #persistence: HappyCloudPersistence;
    readonly #publish:
        | ((ctx: Context, event: HappyCloudChangedEvent) => void | Promise<void>)
        | undefined;

    constructor(options: HappyCloudServiceOptions) {
        this.#now = options.now ?? Date.now;
        this.#persistence = options.persistence;
        this.#publish = options.publish;
    }

    async apply(ctx: Context, command: HappyCloudCommand): Promise<HappyCloudCommandResponse> {
        return await this.#persistence.transaction(ctx, async (ctx) => {
            const createdAt = this.#now();
            const previous = await queryHappyCloudStatus(ctx);
            const response = await happyCloudApplyCommand(ctx, command, createdAt);
            if (response.status.version > previous.version) {
                await this.#publish?.(ctx, {
                    createdAt,
                    data: {
                        mutationId: command.mutationId,
                        version: response.status.version,
                    },
                    id: this.#createEventId(),
                    type: "happy_cloud_changed",
                });
            }
            return response;
        });
    }

    async getProfile(ctx: Context): Promise<HappyCloudProfileCiphertextResponse | undefined> {
        return this.#persistence.query(ctx, queryHappyCloudProfile);
    }

    async getSessionBlob(
        ctx: Context,
        sessionId: string,
    ): Promise<HappyCloudSessionBlobResponse | undefined> {
        return this.#persistence.query(ctx, async (ctx) =>
            queryHappyCloudSessionBlob(ctx, sessionId),
        );
    }

    async status(ctx: Context): Promise<HappyCloudStatus> {
        return this.#persistence.query(ctx, queryHappyCloudStatus);
    }
}
