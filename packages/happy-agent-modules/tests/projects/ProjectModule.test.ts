import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    projectMigrations,
    projectModuleOptionsSchema,
    projectSchema,
    ProjectsModule,
} from "../../sources/projects/index.js";

describe("ProjectsModule", () => {
    it("owns its catalog migration and does not require an injected store", () => {
        const module = new ProjectsModule({});

        expect(module.name).toBe("projects");
        expect(module.migrations).toEqual(projectMigrations);
        expect(Value.Check(projectModuleOptionsSchema, {})).toBe(true);
        expect(Value.Check(projectModuleOptionsSchema, { store: {} })).toBe(false);
    });

    it("keeps project rows runtime-validated", () => {
        expect(
            Value.Check(projectSchema, {
                id: "project-1",
                ownerAgentId: "agent-1",
                repositoryRef: "repo:1",
                name: "Project",
                status: "active",
                createdAt: 1,
                updatedAt: 1,
            }),
        ).toBe(true);
    });
});
