import { Type, type Static } from "@sinclair/typebox";

import type { EventId } from "./EventId.js";

export const webappVersionSchema = Type.Object(
    {
        version: Type.Integer({ minimum: 1 }),
        changeDescription: Type.String({ description: "What changed in this import." }),
        createdAt: Type.Number(),
    },
    { additionalProperties: false },
);

export type WebappVersion = Static<typeof webappVersionSchema>;

/**
 * A webapp is created by importing a source folder; no agent writes into the webapp data folder
 * directly. Each import lands in its own version directory (`v1`, `v2`, ...), one version is
 * current, and rig serves the current version's static files with `index.html` as the entry point.
 */
export const webappSchema = Type.Object(
    {
        name: Type.String({ description: "Human-readable kebab-case webapp name." }),
        description: Type.String({ description: "What the webapp is." }),
        purpose: Type.String({ description: "Why the webapp exists." }),
        authorSessionId: Type.String({
            description: "The session of the agent that created the webapp.",
        }),
        sourceDescription: Type.Optional(
            Type.String({
                description: "Where the sources live, such as the project and folder.",
            }),
        ),
        currentVersion: Type.Integer({ minimum: 1 }),
        versions: Type.Array(webappVersionSchema),
        createdAt: Type.Number(),
        updatedAt: Type.Number(),
    },
    { additionalProperties: false },
);

export type Webapp = Static<typeof webappSchema>;

export const createWebappRequestSchema = Type.Object(
    {
        name: Type.String({ description: "Human-readable kebab-case webapp name." }),
        description: Type.String({ description: "What the webapp is." }),
        purpose: Type.String({ description: "Why the webapp exists." }),
        authorSessionId: Type.String(),
        path: Type.String({ description: "Absolute path of the source folder to import." }),
        sourceDescription: Type.Optional(
            Type.String({
                description: "Where the sources live, such as the project and folder.",
            }),
        ),
    },
    { additionalProperties: false },
);

export type CreateWebappRequest = Static<typeof createWebappRequestSchema>;

export const updateWebappRequestSchema = Type.Object(
    {
        path: Type.String({ description: "Absolute path of the source folder to import." }),
        changeDescription: Type.String({ description: "What changed in this import." }),
    },
    { additionalProperties: false },
);

export type UpdateWebappRequest = Static<typeof updateWebappRequestSchema>;

export const revertWebappRequestSchema = Type.Object(
    {
        version: Type.Integer({ minimum: 1, description: "The existing version to make current." }),
    },
    { additionalProperties: false },
);

export type RevertWebappRequest = Static<typeof revertWebappRequestSchema>;

export interface WebappResponse {
    webapp: Webapp;
}

export interface ListWebappsResponse {
    webapps: readonly Webapp[];
}

export type WebappManagementErrorCode = "invalid_request" | "invalid_webapp" | "webapp_not_found";

export interface WebappManagementErrorResponse {
    error: {
        code: WebappManagementErrorCode;
        message: string;
    };
}

/**
 * Webapps changed. Live-only, carrying the whole current set so a reconnecting client reads the
 * current webapps instead of replaying every past import.
 */
export interface WebappsChangedEvent {
    createdAt: number;
    data: {
        webapps: readonly Webapp[];
    };
    id: EventId;
    type: "webapps_changed";
}
