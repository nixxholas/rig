import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    fetchInputSchema,
    fetchResultSchema,
    searchAgentIdSchema,
    searchPageSchema,
    searchProviderRequestSchema,
    searchQuerySchema,
} from "./Search.js";

/*
 * Context is an extension-bearing runtime object whose enumerable string surface is empty.
 * Keep the schema closed while preserving the real host-facing Context type.
 */
export const searchContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

/** Runtime shape of the host-injected search boundary. */
export const searchBackendSchema = Type.Object(
    {
        search: Type.Function(
            [searchContextSchema, searchAgentIdSchema, searchQuerySchema],
            Type.Promise(searchPageSchema),
        ),
        /**
         * Routes one ordinary vendor search tool through a host-owned provider implementation.
         * This is not a lifted server tool: the host performs one bounded search and returns data.
         */
        searchProvider: Type.Optional(
            Type.Function(
                [searchContextSchema, searchAgentIdSchema, searchProviderRequestSchema],
                Type.Promise(searchPageSchema),
            ),
        ),
        fetch: Type.Function(
            [searchContextSchema, searchAgentIdSchema, fetchInputSchema],
            Type.Promise(fetchResultSchema),
        ),
    },
    { additionalProperties: false },
);

/**
 * Host-owned search/fetch implementation; it owns network clients, indexes, and timeouts.
 * Search cursors are zero-based offsets, and a non-terminal page must advance by its visible
 * result count.
 */
export type SearchBackend = Static<typeof searchBackendSchema>;
