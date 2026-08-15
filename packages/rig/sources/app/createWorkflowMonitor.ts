import {
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
} from "@earendil-works/pi-tui";
import type { WorkflowRun } from "@slopus/happy-agent-features";

import { formatActivityElapsedTime } from "./formatActivityElapsedTime.js";
import { humanizeWorkflowName } from "./humanizeWorkflowName.js";
import { humanizeWorkflowStatus } from "./humanizeWorkflowStatus.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import type { TerminalTheme } from "./TerminalTheme.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const MAX_LIST_ITEMS = 8;
const MAX_DETAIL_LINES = 10;
const MAX_DETAIL_TEXT_CHARS = 4_000;

export interface CreateWorkflowMonitorOptions {
    getWorkflows(): readonly WorkflowRun[];
    initialRunId?: string;
    now?: () => number;
    onCancel(): void;
    onRequestRender?(): void;
    onStop(runId: string): void | Promise<void>;
    theme?: TerminalTheme;
}

export function createWorkflowMonitor(options: CreateWorkflowMonitorOptions): Component {
    return new WorkflowMonitor(options);
}

class WorkflowMonitor implements Component {
    readonly #getWorkflows: () => readonly WorkflowRun[];
    readonly #now: () => number;
    readonly #onCancel: () => void;
    readonly #onRequestRender: (() => void) | undefined;
    readonly #onStop: (runId: string) => void | Promise<void>;
    readonly #theme: TerminalTheme;

    #detailRunId: string | undefined;
    #selectedIndex = 0;
    #stoppingRunId: string | undefined;

    constructor(options: CreateWorkflowMonitorOptions) {
        this.#detailRunId = options.initialRunId;
        this.#getWorkflows = options.getWorkflows;
        this.#now = options.now ?? Date.now;
        this.#onCancel = options.onCancel;
        this.#onRequestRender = options.onRequestRender;
        this.#onStop = options.onStop;
        this.#theme = options.theme ?? DEFAULT_TERMINAL_THEME;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const workflows = this.#getWorkflows();
        const detail = workflows.find((workflow) => workflow.id === this.#detailRunId);
        const lines =
            detail === undefined
                ? this.#renderList(workflows, width)
                : this.#renderDetail(detail, width);
        return lines.map((line) => this.#surfaceLine(line, Math.max(1, width)));
    }

    handleInput(data: string): void {
        const workflows = this.#getWorkflows();
        const detail = workflows.find((workflow) => workflow.id === this.#detailRunId);
        if (matchesKey(data, "escape")) {
            if (detail === undefined) this.#onCancel();
            else this.#detailRunId = undefined;
            return;
        }
        if (detail !== undefined) {
            if (data.toLowerCase() === "s" && isActive(detail.status)) this.#stop(detail.id);
            return;
        }
        if (matchesKey(data, "up")) {
            this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
            return;
        }
        if (matchesKey(data, "down")) {
            this.#selectedIndex = Math.min(
                Math.max(0, workflows.length - 1),
                this.#selectedIndex + 1,
            );
            return;
        }
        if (matchesKey(data, "enter") && workflows[this.#selectedIndex] !== undefined) {
            this.#detailRunId = workflows[this.#selectedIndex]?.id;
        }
    }

    #renderList(workflows: readonly WorkflowRun[], width: number): string[] {
        const active = workflows.filter((workflow) => isActive(workflow.status)).length;
        const lines = [
            "",
            `  ${this.#theme.brand}${BOLD}Workflows${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            `  ${this.#theme.secondary}${active === 0 ? "No active workflows" : `${active} active`} · Updates live${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            "",
        ];
        if (workflows.length === 0) {
            lines.push(
                `  ${this.#theme.secondary}No workflows have been started in this session.${RESET}`,
            );
        } else {
            this.#selectedIndex = Math.min(this.#selectedIndex, workflows.length - 1);
            const start = Math.max(
                0,
                Math.min(
                    this.#selectedIndex - Math.floor(MAX_LIST_ITEMS / 2),
                    workflows.length - MAX_LIST_ITEMS,
                ),
            );
            for (const [offset, workflow] of workflows
                .slice(start, start + MAX_LIST_ITEMS)
                .entries()) {
                const index = start + offset;
                const selected = index === this.#selectedIndex;
                const marker = selected ? "→ " : "  ";
                const label = sanitizeTerminalText(humanizeWorkflowName(workflow.workflow));
                const content = `${marker}${label}  ${humanizeWorkflowStatus(workflow.status)}`;
                lines.push(
                    selected
                        ? `  ${this.#theme.brand}${truncateToWidth(content, Math.max(1, width - 2))}${RESET}`
                        : `  ${truncateToWidth(content, Math.max(1, width - 2))}`,
                );
            }
        }
        lines.push(
            "",
            `  ${DIM}${this.#theme.secondary}Use ↑/↓ to move, Enter to open, Esc to close.${RESET}`,
            "",
        );
        return lines;
    }

    #renderDetail(workflow: WorkflowRun, width: number): string[] {
        const contentWidth = Math.max(1, width - 4);
        const startedAt = "startedAt" in workflow ? workflow.startedAt : workflow.createdAt;
        const finishedAt = "finishedAt" in workflow ? workflow.finishedAt : this.#now();
        const elapsed = formatActivityElapsedTime(finishedAt - startedAt);
        const lines = [
            "",
            `  ${this.#theme.brand}${BOLD}${sanitizeTerminalText(humanizeWorkflowName(workflow.workflow))}${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
            `  ${this.#statusColor(workflow.status)}${humanizeWorkflowStatus(workflow.status)}${RESET}${this.#theme.inputBackground}${this.#theme.primary} ${this.#theme.secondary}· ${elapsed}${RESET}`,
            `  ${this.#theme.secondary}Run ${sanitizeTerminalText(workflow.id)}${RESET}`,
        ];
        if (workflow.input !== undefined) {
            lines.push(
                "",
                `  ${this.#theme.secondary}Input${RESET}`,
                ...detailLines(workflow.input, contentWidth),
            );
        }
        const error = "error" in workflow ? workflow.error : undefined;
        const output = "output" in workflow ? workflow.output : undefined;
        const result = error ?? output;
        if (result !== undefined) {
            lines.push(
                "",
                `  ${this.#theme.secondary}${error === undefined ? "Result" : "Error"}${RESET}`,
                ...detailLines(result, contentWidth),
            );
        }
        lines.push(
            "",
            `  ${DIM}${this.#theme.secondary}${isActive(workflow.status) ? "S to cancel · " : ""}Esc to return.${RESET}`,
            "",
        );
        return lines;
    }

    #statusColor(status: WorkflowRun["status"]): string {
        if (status === "completed") return this.#theme.success;
        if (status === "failed" || status === "unavailable") return this.#theme.error;
        if (status === "queued" || status === "running") return this.#theme.brand;
        return this.#theme.warning;
    }

    #stop(runId: string): void {
        if (this.#stoppingRunId !== undefined) return;
        this.#stoppingRunId = runId;
        void Promise.resolve(this.#onStop(runId)).finally(() => {
            this.#stoppingRunId = undefined;
            this.#onRequestRender?.();
        });
    }

    #surfaceLine(content: string, width: number): string {
        const restored = content.replaceAll(
            RESET,
            `${RESET}${this.#theme.inputBackground}${this.#theme.primary}`,
        );
        const fitted = truncateToWidth(restored, width, "", true);
        const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
        return `${this.#theme.inputBackground}${this.#theme.primary}${fitted}${padding}${RESET}`;
    }
}

function detailLines(value: string, width: number): string[] {
    return sanitizeTerminalText(value.slice(0, MAX_DETAIL_TEXT_CHARS))
        .split("\n")
        .flatMap((line) => wrapTextWithAnsi(line, width))
        .slice(0, MAX_DETAIL_LINES)
        .map((line) => `  ${line}`);
}

function isActive(status: WorkflowRun["status"]): boolean {
    return status === "queued" || status === "running" || status === "paused";
}
