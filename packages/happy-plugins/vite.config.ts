import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "happy-plugins": path.resolve(packageRoot, "sources/index.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
    },
});
