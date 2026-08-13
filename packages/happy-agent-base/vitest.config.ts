import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Only the suite counts. Scratch files under `.context/` are notes and throwaway
        // harnesses, and must never join a run.
        include: ["tests/**/*.test.ts"],
    },
});
