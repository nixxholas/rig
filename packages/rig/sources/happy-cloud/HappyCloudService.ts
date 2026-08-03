import type {
    HappyCloudCommand,
    HappyCloudCommandResponse,
    HappyCloudProfileCiphertextResponse,
    HappyCloudSessionBlobResponse,
    HappyCloudStatus,
} from "../protocol/HappyCloudProtocol.js";
import { openSessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { migrateSessionDatabase } from "../persistence/database/migrateSessionDatabase.js";
import { happyCloudApplyCommand } from "../persistence/happy-cloud/happyCloudApplyCommand.js";
import { queryHappyCloudProfile } from "../persistence/happy-cloud/queryHappyCloudProfile.js";
import { queryHappyCloudSessionBlob } from "../persistence/happy-cloud/queryHappyCloudSessionBlob.js";
import { queryHappyCloudStatus } from "../persistence/happy-cloud/queryHappyCloudStatus.js";

export interface HappyCloudServiceContract {
    apply(command: HappyCloudCommand): HappyCloudCommandResponse;
    getProfile(): HappyCloudProfileCiphertextResponse | undefined;
    getSessionBlob(sessionId: string): HappyCloudSessionBlobResponse | undefined;
    status(): HappyCloudStatus;
}

export class HappyCloudService implements HappyCloudServiceContract {
    readonly #client: ReturnType<typeof openSessionDatabase>["client"];
    readonly #database: ReturnType<typeof openSessionDatabase>["database"];
    readonly #now: () => number;
    #status: HappyCloudStatus;

    constructor(databasePath: string, now: () => number = Date.now) {
        const opened = openSessionDatabase(databasePath);
        this.#client = opened.client;
        this.#database = opened.database;
        this.#now = now;
        migrateSessionDatabase(this.#database);
        this.#status = queryHappyCloudStatus(this.#database);
    }

    apply(command: HappyCloudCommand): HappyCloudCommandResponse {
        const response = happyCloudApplyCommand(this.#database, command, this.#now());
        // A delayed duplicate returns its original receipt, while the live
        // singleton must stay at the newest database state.
        this.#status = queryHappyCloudStatus(this.#database);
        return response;
    }

    close(): void {
        this.#client.close();
    }

    getProfile(): HappyCloudProfileCiphertextResponse | undefined {
        return queryHappyCloudProfile(this.#database);
    }

    getSessionBlob(sessionId: string): HappyCloudSessionBlobResponse | undefined {
        return queryHappyCloudSessionBlob(this.#database, sessionId);
    }

    status(): HappyCloudStatus {
        return this.#status;
    }
}
