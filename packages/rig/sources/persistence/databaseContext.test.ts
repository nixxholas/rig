import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";

import type { DatabaseScope } from "./Transaction.js";

it("reuses the tx extension and SQL namespace when the module is evaluated again", async () => {
    const first = await import("./databaseContext.js");
    const database = {} as DatabaseScope;
    const firstScoped = first.withDatabase(createRootContext(), database);
    expect(firstScoped.tx).toBe(database);

    vi.resetModules();
    const reloaded = await import("./databaseContext.js");
    const reloadedScoped = reloaded.withDatabase(createRootContext(), database);

    expect(reloadedScoped.tx).toBe(database);
    expect(first.getDatabaseScope(reloadedScoped)).toBe(database);
});
