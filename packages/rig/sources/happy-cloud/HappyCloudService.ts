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
import type { TX } from "../persistence/Transaction.js";

export interface HappyCloudServiceContract {
    apply(command: HappyCloudCommand): Promise<HappyCloudCommandResponse>;
    getProfile(): Promise<HappyCloudProfileCiphertextResponse | undefined>;
    getSessionBlob(sessionId: string): Promise<HappyCloudSessionBlobResponse | undefined>;
    status(): Promise<HappyCloudStatus>;
}

export interface HappyCloudPersistence {
    query<T>(operation: (tx: TX) => Promise<T>): Promise<T>;
    transaction<T>(operation: (tx: TX) => Promise<T>): Promise<T>;
}

export interface HappyCloudServiceOptions {
    now?: () => number;
    persistence: HappyCloudPersistence;
    publish?: (event: HappyCloudChangedEvent) => void | Promise<void>;
}

export class HappyCloudService implements HappyCloudServiceContract {
    readonly #createEventId = createEventIdFactory();
    readonly #now: () => number;
    readonly #persistence: HappyCloudPersistence;
    readonly #publish: ((event: HappyCloudChangedEvent) => void | Promise<void>) | undefined;

    constructor(options: HappyCloudServiceOptions) {
        this.#now = options.now ?? Date.now;
        this.#persistence = options.persistence;
        this.#publish = options.publish;
    }

    async apply(command: HappyCloudCommand): Promise<HappyCloudCommandResponse> {
        return await this.#persistence.transaction(async (tx) => {
            const createdAt = this.#now();
            const previous = await queryHappyCloudStatus(tx);
            const response = await happyCloudApplyCommand(tx, command, createdAt);
            if (response.status.version > previous.version) {
                await this.#publish?.({
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

    async getProfile(): Promise<HappyCloudProfileCiphertextResponse | undefined> {
        return this.#persistence.query(async (tx) => queryHappyCloudProfile(tx));
    }

    async getSessionBlob(sessionId: string): Promise<HappyCloudSessionBlobResponse | undefined> {
        return this.#persistence.query(async (tx) => queryHappyCloudSessionBlob(tx, sessionId));
    }

    async status(): Promise<HappyCloudStatus> {
        return this.#persistence.query(async (tx) => queryHappyCloudStatus(tx));
    }
}
