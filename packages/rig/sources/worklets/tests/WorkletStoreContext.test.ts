import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { WorkletManager } from "../WorkletManager.js";
import { WorkletStore } from "../WorkletStore.js";
import { WorkletToolRegistry } from "../WorkletToolRegistry.js";

describe("WorkletStore context", () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    it("starts the manager from a worker context without a database scope", async () => {
        const root = createTestRootContext().named("worklet-store-caller");
        const opened = await openSessionDatabase(root, ":memory:");
        await migrateSessionDatabase(opened.ctx);
        const store = new WorkletStore({ database: opened.database });
        const manager = new WorkletManager({
            publish: () => undefined,
            registry: new WorkletToolRegistry(),
            store,
        });
        cleanups.push(async () => {
            await manager.close(root);
            await opened.database.close(opened.ctx);
        });

        await expect(manager.start(root)).resolves.toBeUndefined();
        await expect(manager.catalog(root)).resolves.toMatchObject({ worklets: [] });
    });
});
