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
    apply(command: HappyCloudCommand): HappyCloudCommandResponse;
    getProfile(): HappyCloudProfileCiphertextResponse | undefined;
    getSessionBlob(sessionId: string): HappyCloudSessionBlobResponse | undefined;
    status(): HappyCloudStatus;
}

export interface HappyCloudPersistence {
    query<T>(operation: (tx: TX) => T): T;
    transaction<T>(operation: (tx: TX) => T): T;
}

export interface HappyCloudServiceOptions {
    now?: () => number;
    persistence: HappyCloudPersistence;
    publish?: (event: HappyCloudChangedEvent) => void;
}

export class HappyCloudService implements HappyCloudServiceContract {
    readonly #createEventId = createEventIdFactory();
    readonly #now: () => number;
    readonly #persistence: HappyCloudPersistence;
    readonly #publish: ((event: HappyCloudChangedEvent) => void) | undefined;

    constructor(options: HappyCloudServiceOptions) {
        this.#now = options.now ?? Date.now;
        this.#persistence = options.persistence;
        this.#publish = options.publish;
    }

    apply(command: HappyCloudCommand): HappyCloudCommandResponse {
        return this.#persistence.transaction((tx) => {
            const createdAt = this.#now();
            const previous = queryHappyCloudStatus(tx);
            const response = happyCloudApplyCommand(tx, command, createdAt);
            if (response.status.version > previous.version) {
                this.#publish?.({
                    createdAt,
                    data: { mutationId: command.mutationId, version: response.status.version },
                    id: this.#createEventId(),
                    type: "happy_cloud_changed",
                });
            }
            return response;
        });
    }

    getProfile(): HappyCloudProfileCiphertextResponse | undefined {
        return this.#persistence.query(queryHappyCloudProfile);
    }

    getSessionBlob(sessionId: string): HappyCloudSessionBlobResponse | undefined {
        return this.#persistence.query((tx) => queryHappyCloudSessionBlob(tx, sessionId));
    }

    status(): HappyCloudStatus {
        return this.#persistence.query(queryHappyCloudStatus);
    }
}
