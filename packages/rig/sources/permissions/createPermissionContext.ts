import { AsyncLocalStorage } from "node:async_hooks";

import type { PermissionContext } from "./PermissionContext.js";
import type { PermissionMode } from "./PermissionMode.js";

export function createPermissionContext(initialMode: PermissionMode): PermissionContext {
    const overrides = new AsyncLocalStorage<PermissionMode>();
    let configuredMode = initialMode;
    let revision = 0;
    return {
        get mode() {
            return overrides.getStore() ?? configuredMode;
        },
        get revision() {
            return revision;
        },
        runWithMode(mode, action) {
            try {
                return Promise.resolve(overrides.run(mode, action));
            } catch (error) {
                return Promise.reject(error);
            }
        },
        setMode(mode) {
            if (configuredMode === mode) return;
            configuredMode = mode;
            revision += 1;
        },
    };
}
