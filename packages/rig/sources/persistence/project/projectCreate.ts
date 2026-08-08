import { asc, eq, sql } from "drizzle-orm";

import { projects } from "../database/schema.js";
import { projectNameKey, projectStorageKey } from "../../project/projectIdentity.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import type { ProjectCreator, ProjectRemoteSource } from "../../protocol/index.js";

export interface ProjectCreateInput {
    baseName: string;
    id: string;
    kind: "home" | "regular";
    now: number;
    path: string;
    createdBy?: ProjectCreator;
    remoteSource?: ProjectRemoteSource;
    requiredSecretKind?: "github";
}

export function projectCreate(tx: TX, input: ProjectCreateInput): void {
    inTx(tx, (tx) => {
        const name = reserveUnique(input.baseName, (candidate) => {
            return (
                tx
                    .select({ id: projects.id })
                    .from(projects)
                    .where(eq(projects.nameKey, projectNameKey(candidate)))
                    .get() !== undefined
            );
        });
        const storageKey = reserveUniqueKey(
            input.kind === "home" ? "home" : projectStorageKey(input.baseName),
            (candidate) => {
                return (
                    tx
                        .select({ id: projects.id })
                        .from(projects)
                        .where(sql`${projects.storageKey} = ${candidate} COLLATE NOCASE`)
                        .get() !== undefined
                );
            },
        );
        const first = tx
            .select({ orderKey: projects.orderKey })
            .from(projects)
            .orderBy(asc(projects.orderKey))
            .limit(1)
            .get();
        tx.insert(projects)
            .values({
                createdAtMs: input.now,
                gitAhead: 0,
                gitBehind: 0,
                gitDetached: false,
                id: input.id,
                initializationAttempt: 0,
                initializationStatus: input.kind === "home" ? "ready" : "initializing",
                kind: input.kind,
                name,
                nameKey: projectNameKey(name),
                nameSource: input.remoteSource === undefined ? "folder" : "user",
                orderKey: generateKeyBetween(null, first?.orderKey ?? null),
                path: input.path,
                presence: input.remoteSource === undefined ? "present" : "missing",
                ...(input.createdBy === undefined
                    ? {}
                    : {
                          creatorInstanceId: input.createdBy.instanceId,
                          creatorProfileId: input.createdBy.profileId,
                      }),
                ...(input.remoteSource === undefined
                    ? {}
                    : { remoteSourceJson: JSON.stringify(input.remoteSource) }),
                ...(input.requiredSecretKind === undefined
                    ? {}
                    : { requiredSecretKind: input.requiredSecretKind }),
                storageKey,
                updatedAtMs: input.now,
                userMutationVersion: 1,
                version: 1,
                worktreeSupport: "unknown",
            })
            .run();
    });
}

function reserveUnique(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} (${String(suffix)})`;
        if (!taken(candidate)) return candidate;
    }
}

function reserveUniqueKey(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base}-${String(suffix)}`;
        if (!taken(candidate)) return candidate;
    }
}
