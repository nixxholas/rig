import { describe, expect, it } from "vitest";

import { SecretRegistry } from "./SecretRegistry.js";
import { SessionSecretContext } from "./SessionSecretContext.js";
import { createSecretInstructions } from "./createSecretInstructions.js";

describe("SecretRegistry", () => {
    it("registers, rotates, and resolves multi-variable bundles without exposing values", () => {
        const registry = new SecretRegistry([
            {
                description: "Service API credentials",
                environment: { SERVICE_REGION: "us-east-1", SERVICE_TOKEN: "first" },
                id: "service",
            },
        ]);

        expect(registry.reference("service")).toEqual({
            description: "Service API credentials",
            environmentVariables: ["SERVICE_REGION", "SERVICE_TOKEN"],
            id: "service",
        });
        expect(registry.reference("service")).not.toHaveProperty("environment");
        expect(registry.resolve(["service"])).toEqual({
            SERVICE_REGION: "us-east-1",
            SERVICE_TOKEN: "first",
        });

        registry.register({
            description: "Rotated service credentials",
            environment: { SERVICE_REGION: "us-west-2", SERVICE_TOKEN: "rotated" },
            id: "service",
        });
        expect(registry.reference("service").description).toBe("Rotated service credentials");
        expect(registry.resolve(["service"])).toEqual({
            SERVICE_REGION: "us-west-2",
            SERVICE_TOKEN: "rotated",
        });
    });

    it("keeps the enumerated GitHub secret away from models while rotating it in place", () => {
        const registry = new SecretRegistry();
        const context = new SessionSecretContext(registry);

        registry.register({ kind: "github", token: "first-token" });
        expect(registry.reference("github")).toEqual({
            availableToModel: false,
            description: "GitHub CLI credentials",
            environmentVariables: ["GH_TOKEN"],
            id: "github",
            kind: "github",
        });
        expect(context.references()).toEqual([]);
        const instructions = createSecretInstructions(context);
        expect(instructions).toBeUndefined();
        expect(() => context.resolve(["github"])).toThrow("not attached");

        registry.register({ kind: "github", token: "rotated-token" });
        expect(registry.resolve(["github"])).toEqual({ GH_TOKEN: "rotated-token" });

        expect(registry.unregisterSpecial("github")).toBe(true);
        expect(context.references()).toEqual([]);
        expect(() => context.resolve(["github"])).toThrow("not attached");
    });

    it("reserves special secret IDs for their exact schemas", () => {
        expect(
            () =>
                new SecretRegistry([
                    {
                        description: "Spoofed GitHub credentials",
                        environment: { GH_TOKEN: "token" },
                        id: "github",
                    },
                ]),
        ).toThrow("reserved for GitHub CLI credentials");
        expect(
            () =>
                new SecretRegistry([
                    {
                        kind: "github",
                        token: "",
                    },
                ]),
        ).toThrow("GitHub secret schema");
    });

    it("rejects invalid registrations and conflicting command selections", () => {
        const registry = new SecretRegistry();
        expect(() =>
            registry.register({
                description: "Invalid environment",
                environment: { "BAD-NAME": "value" },
                id: "valid",
            }),
        ).toThrow("invalid environment variable name");
        expect(() =>
            registry.register({
                description: "Invalid ID",
                environment: { VALID_NAME: "value" },
                id: "has space",
            }),
        ).toThrow("Secret IDs");

        registry.register({
            description: "First token",
            environment: { TOKEN: "one" },
            id: "first",
        });
        registry.register({
            description: "Second token",
            environment: { token: "two" },
            id: "second",
        });
        expect(() => registry.resolve(["first", "second"])).toThrow("both define token");
    });

    it("unions session and project attachments and detaches each source independently", () => {
        const registry = new SecretRegistry([
            {
                description: "Shared credentials",
                environment: { SHARED_TOKEN: "shared" },
                id: "shared",
            },
            {
                description: "Session credentials",
                environment: { SESSION_TOKEN: "session" },
                id: "session-only",
            },
            {
                description: "Project credentials",
                environment: { PROJECT_TOKEN: "project" },
                id: "project-only",
            },
        ]);
        const context = new SessionSecretContext(
            registry,
            ["shared", "session-only"],
            ["shared", "project-only"],
        );

        expect(context.sessionIds()).toEqual(["session-only", "shared"]);
        expect(context.projectIds()).toEqual(["project-only", "shared"]);
        expect(context.ids()).toEqual(["project-only", "session-only", "shared"]);
        expect(context.resolve(["shared", "session-only", "project-only"])).toEqual({
            PROJECT_TOKEN: "project",
            SESSION_TOKEN: "session",
            SHARED_TOKEN: "shared",
        });

        expect(context.detach("shared", "session")).toBe(true);
        expect(context.ids()).toContain("shared");
        expect(context.resolve(["shared"])).toHaveProperty("SHARED_TOKEN", "shared");

        expect(context.detach("shared", "project")).toBe(true);
        expect(context.ids()).not.toContain("shared");
        expect(context.resolve([])).not.toHaveProperty("SHARED_TOKEN");
        expect(() => context.resolve(["shared"])).toThrow("not attached");
    });

    it("supports valid environment names that are special object properties", () => {
        const registry = new SecretRegistry([
            {
                description: "Special property",
                environment: { ["__proto__"]: "value" },
                id: "special",
            },
        ]);

        const environment = registry.resolve(["special"]);

        expect(Object.hasOwn(environment, "__proto__")).toBe(true);
        expect(environment["__proto__"]).toBe("value");
    });

    it("remembers attached destinations while registrations are removed or replaced", () => {
        const registry = new SecretRegistry([
            {
                description: "Initial service credentials",
                environment: { FIRST_REGION: "east", FIRST_TOKEN: "first" },
                id: "service",
            },
        ]);
        const context = new SessionSecretContext(registry, ["service"]);

        expect(context.environmentVariables()).toEqual(["FIRST_REGION", "FIRST_TOKEN"]);
        registry.unregister("service");
        expect(context.environmentVariables()).toEqual(["FIRST_REGION", "FIRST_TOKEN"]);

        registry.register({
            description: "Replacement service credentials",
            environment: { SECOND_TOKEN: "second" },
            id: "service",
        });
        expect(context.environmentVariables()).toEqual([
            "FIRST_REGION",
            "FIRST_TOKEN",
            "SECOND_TOKEN",
        ]);
        context.detach("service");
        expect(context.environmentVariables()).toEqual([]);
    });
});
