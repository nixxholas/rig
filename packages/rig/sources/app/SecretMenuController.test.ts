import { describe, expect, it, vi } from "vitest";

import type { SecretSummary } from "../protocol/index.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { SecretMenuController } from "./SecretMenuController.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("SecretMenuController", () => {
    it("does not replace a competing panel after a delayed secret-list result", async () => {
        let resolveSecrets: ((secrets: readonly SecretSummary[]) => void) | undefined;
        const listSecrets = vi.fn(
            () =>
                new Promise<readonly SecretSummary[]>((resolve) => {
                    resolveSecrets = resolve;
                }),
        );
        const requestRender = vi.fn();
        let activePanel: unknown;
        const controller = new SecretMenuController({
            appendEntry: vi.fn(),
            attachSecret: vi.fn(),
            closePanel: () => {
                activePanel = undefined;
            },
            detachSecret: vi.fn(),
            initialProjectSecretIds: [],
            initialSessionSecretIds: [],
            listSecrets,
            registerSecret: vi.fn(),
            requestRender,
            showPanel: (panel) => {
                activePanel = panel;
            },
            theme: DEFAULT_TERMINAL_THEME,
            unregisterSecret: vi.fn(),
        });

        controller.open();
        await vi.waitFor(() => expect(listSecrets).toHaveBeenCalledOnce());

        controller.hide();
        const competingPanel = {};
        activePanel = competingPanel;
        resolveSecrets?.([]);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(activePanel).toBe(competingPanel);
        expect(requestRender).not.toHaveBeenCalled();
    });

    it("labels a system-managed GitHub credential as unavailable to the model", async () => {
        let activePanel: { render: (width: number) => string[] } | undefined;
        const controller = new SecretMenuController({
            appendEntry: vi.fn(),
            attachSecret: vi.fn(),
            closePanel: () => {
                activePanel = undefined;
            },
            detachSecret: vi.fn(),
            initialProjectSecretIds: [],
            initialSessionSecretIds: [],
            listSecrets: async () => [
                {
                    availableToModel: false,
                    description: "GitHub CLI credentials",
                    environmentVariables: ["GH_TOKEN"],
                    id: "github",
                    kind: "github",
                },
            ],
            registerSecret: vi.fn(),
            requestRender: vi.fn(),
            showPanel: (panel) => {
                activePanel = panel;
            },
            theme: DEFAULT_TERMINAL_THEME,
            unregisterSecret: vi.fn(),
        });

        controller.open();
        await vi.waitFor(() =>
            expect(stripAnsi(activePanel?.render(100).join("\n") ?? "")).toContain(
                "Not available to model",
            ),
        );
    });
});
