import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";

import type { Project } from "../Project.js";
import { PROJECTS_TABLE, PROJECT_SETTINGS_TABLE } from "../ProjectMigrations.js";
import {
    parseProjectSettings,
    projectFromRow,
    type ProjectRow,
    type ProjectSettingsRow,
} from "../ProjectRow.js";
import type { ProjectStore } from "../ProjectStore.js";
import {
    assertExpectedProjectVersion,
    databaseFor,
    orderKeyForPosition,
    requireProject,
    writeGuardedProject,
    writeGuardedProjectOrder,
} from "./projectRecords.js";

/** The edits a person makes to a catalog row: its name, place, avatar and settings. */
export function createProjectCatalogEdits(): Pick<
    ProjectStore,
    "rename" | "reorder" | "setAvatar" | "clearAvatar" | "updateSettings"
> {
    return {
        rename: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await requireProject(database, input.projectId);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before it could be renamed.",
            );
            if (before.name === input.name && before.nameSource === "user") {
                return {
                    operation: "rename",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            return {
                operation: "rename",
                agentId: actingAgentId,
                changed: true,
                project: await writeGuardedProject(
                    database,
                    input.projectId,
                    before.version,
                    sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                        SET name = ${input.name}, name_source = 'user',
                            updated_at = ${updatedAt}, version = version + 1
                        WHERE id = ${input.projectId} AND version = ${before.version}
                        RETURNING id`,
                    "The project changed before it could be renamed.",
                ),
            };
        },
        reorder: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await requireProject(database, input.projectId);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before it could be reordered.",
            );
            if (input.afterId === input.projectId) {
                throw new Error("A project cannot be placed after itself.");
            }
            const rows = await agentDatabaseRows<ProjectRow>(
                database,
                sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)} ORDER BY order_key, id`,
            );
            const ordered = rows.map(projectFromRow);
            const currentIndex = ordered.findIndex((project) => project.id === input.projectId);
            if (currentIndex === -1) {
                throw new Error(`Project "${input.projectId}" was not found.`);
            }
            const withoutTarget = ordered.filter((project) => project.id !== input.projectId);
            const insertionIndex =
                input.afterId === null
                    ? 0
                    : (() => {
                          const afterIndex = withoutTarget.findIndex(
                              (project) => project.id === input.afterId,
                          );
                          if (afterIndex === -1) {
                              throw new Error(
                                  "The project to place after was not found in the catalog.",
                              );
                          }
                          return afterIndex + 1;
                      })();
            const reordered = [...withoutTarget];
            reordered.splice(insertionIndex, 0, before);
            const changed =
                reordered.some((project, index) => project.id !== ordered[index]?.id) ||
                before.orderKey !== orderKeyForPosition(currentIndex + 1);
            if (!changed) {
                return {
                    operation: "reorder",
                    agentId: actingAgentId,
                    changed: false,
                    previousOrderKey: before.orderKey,
                    project: before,
                };
            }
            // One rearrangement of one list. Every row is guarded by the version it was read at, so
            // a catalog that moved while this order was being computed refuses the whole thing
            // rather than leaving half a list in the new order and half in the old one. Only the
            // project someone actually moved counts as changed; its neighbours just sit elsewhere.
            const updatedAt = Date.now();
            const conflict = "The project catalog changed before it could be reordered.";
            let moved: Project | undefined;
            for (const [index, project] of reordered.entries()) {
                const orderKey = orderKeyForPosition(index + 1);
                if (project.id === input.projectId) {
                    moved = await writeGuardedProject(
                        database,
                        project.id,
                        before.version,
                        sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                            SET order_key = ${orderKey}, updated_at = ${updatedAt},
                                version = version + 1
                            WHERE id = ${project.id} AND version = ${before.version}
                            RETURNING id`,
                        "The project changed before it could be reordered.",
                    );
                } else if (project.orderKey !== orderKey) {
                    await writeGuardedProjectOrder(
                        database,
                        project.id,
                        project.version,
                        orderKey,
                        conflict,
                    );
                }
            }
            if (moved === undefined) throw new Error(conflict);
            return {
                operation: "reorder",
                agentId: actingAgentId,
                changed: true,
                previousOrderKey: before.orderKey,
                project: moved,
            };
        },
        setAvatar: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await requireProject(database, input.projectId);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before the avatar could be saved.",
            );
            if (JSON.stringify(before.avatar ?? null) === JSON.stringify(input.avatar)) {
                return {
                    operation: "set_avatar",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            return {
                operation: "set_avatar",
                agentId: actingAgentId,
                changed: true,
                project: await writeGuardedProject(
                    database,
                    input.projectId,
                    before.version,
                    sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                        SET avatar_json = ${JSON.stringify(input.avatar)},
                            updated_at = ${updatedAt}, version = version + 1
                        WHERE id = ${input.projectId} AND version = ${before.version}
                        RETURNING id`,
                    "The project changed before the avatar could be saved.",
                ),
            };
        },
        clearAvatar: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const before = await requireProject(database, input.projectId);
            assertExpectedProjectVersion(
                before,
                input.expectedVersion,
                "The project changed before the avatar could be cleared.",
            );
            if (before.avatar === undefined) {
                return {
                    operation: "clear_avatar",
                    agentId: actingAgentId,
                    changed: false,
                    project: before,
                };
            }
            const updatedAt = Date.now();
            return {
                operation: "clear_avatar",
                agentId: actingAgentId,
                changed: true,
                project: await writeGuardedProject(
                    database,
                    input.projectId,
                    before.version,
                    sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                        SET avatar_json = ${null}, updated_at = ${updatedAt},
                            version = version + 1
                        WHERE id = ${input.projectId} AND version = ${before.version}
                        RETURNING id`,
                    "The project changed before the avatar could be cleared.",
                ),
            };
        },
        updateSettings: async (ctx, actingAgentId, input) => {
            const database = databaseFor(ctx);
            const project = await requireProject(database, input.projectId);
            assertExpectedProjectVersion(
                project,
                input.expectedVersion,
                "The project changed before its settings could be saved.",
            );
            const rows = await agentDatabaseRows<ProjectSettingsRow>(
                database,
                sql`SELECT project_id, settings_json
                    FROM ${sql.raw(PROJECT_SETTINGS_TABLE)}
                    WHERE project_id = ${input.projectId} LIMIT 1`,
            );
            const row = rows[0];
            const before = row === undefined ? {} : parseProjectSettings(row.settings_json);
            const changed = JSON.stringify(before) !== JSON.stringify(input.settings);
            await agentDatabaseRun(
                database,
                sql`INSERT INTO ${sql.raw(PROJECT_SETTINGS_TABLE)} (project_id, settings_json)
                    VALUES (${input.projectId}, ${JSON.stringify(input.settings)})
                    ON CONFLICT (project_id) DO UPDATE
                    SET settings_json = excluded.settings_json`,
            );
            if (changed) {
                await writeGuardedProject(
                    database,
                    input.projectId,
                    project.version,
                    sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                        SET updated_at = ${Date.now()}, version = version + 1
                        WHERE id = ${input.projectId} AND version = ${project.version}
                        RETURNING id`,
                    "The project changed before its settings could be saved.",
                );
            }
            return {
                operation: "update_settings",
                agentId: actingAgentId,
                changed,
                projectId: input.projectId,
                settings: structuredClone(input.settings),
                version: project.version + (changed ? 1 : 0),
            };
        },
    };
}
