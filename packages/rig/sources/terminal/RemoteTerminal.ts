import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import {
    createGhosttyRemoteTerminalServer,
    ghosttySnapshotToGrid,
    type GhosttyRemoteTerminalServerDriver,
    type RemoteTerminalAttachOptions,
    type RemoteTerminalProtocolMetrics,
    type RemoteTerminalProtocolServer,
    type RemoteTerminalScrollbackPage,
} from "@slopus/ghostty-web";

import { GhosttyWebTerminal } from "./GhosttyWebTerminal.js";
import type {
    RemoteTerminalConfinement,
    RemoteTerminalProcess,
    RemoteTerminalProcessFactory,
    RemoteTerminalProcessOptions,
} from "./RemoteTerminalProcess.js";
import type { RemoteTerminalColorScheme, RemoteTerminalSummary } from "./types.js";

export class RemoteTerminal {
    readonly id = randomUUID();
    readonly colorScheme: RemoteTerminalColorScheme;

    /**
     * Where this terminal's process actually runs.
     *
     * Recorded at creation from the factory that started it, so anything asking
     * whether this terminal may be shown to another person gets the truth about
     * this terminal rather than a fresh reading of a project setting that may
     * have changed since. A project that gains a container configuration does
     * not retroactively confine the host terminals already running in it.
     */
    readonly confinement: RemoteTerminalConfinement;

    readonly #driver: GhosttyRemoteTerminalServerDriver;
    #exitCode: number | null = null;
    readonly #exited: Promise<void>;
    readonly #process: RemoteTerminalProcess;
    readonly #protocol: RemoteTerminalProtocolServer;
    readonly #onChange: (summary: RemoteTerminalSummary) => void;
    #status: "exited" | "running" = "running";
    readonly #state: GhosttyWebTerminal;
    readonly #unsubscribeData: () => void;

    private constructor(
        state: GhosttyWebTerminal,
        process: RemoteTerminalProcess,
        created: ReturnType<typeof createGhosttyRemoteTerminalServer>,
        onChange: (summary: RemoteTerminalSummary) => void,
        confinement: RemoteTerminalConfinement,
        colorScheme: RemoteTerminalColorScheme,
    ) {
        this.colorScheme = colorScheme;
        this.confinement = confinement;
        this.#state = state;
        this.#process = process;
        this.#driver = created.driver;
        this.#protocol = created.protocol;
        this.#onChange = onChange;
        this.#unsubscribeData = process.onData((data) => {
            void this.#driver.publishOutput(data).catch(() => process.kill());
        });
        this.#exited = process.wait().then(async ({ exitCode }) => {
            this.#exitCode = exitCode;
            this.#status = "exited";
            this.#unsubscribeData();
            await this.#driver.publishExit(exitCode).catch(() => undefined);
            this.#onChange(this.summary());
        });
    }

    static async create(options: {
        cols: number;
        colorScheme: RemoteTerminalColorScheme;
        maxScrollback: number;
        processFactory: RemoteTerminalProcessFactory;
        processOptions: RemoteTerminalProcessOptions;
        rows: number;
        onChange?: (summary: RemoteTerminalSummary) => void;
    }): Promise<RemoteTerminal> {
        const state = await GhosttyWebTerminal.create(options);
        let process: RemoteTerminalProcess | undefined;
        try {
            process = await options.processFactory.start(options.processOptions);
            const historyEpoch = randomUUID();
            const created = createGhosttyRemoteTerminalServer(state, {
                initialCols: options.cols,
                initialRows: options.rows,
                onFlowControl(paused) {
                    if (paused) process?.pause();
                    else process?.resume();
                },
                async onInput(data) {
                    if (!(await process?.write(data))) throw new Error("The terminal has exited.");
                },
                onResize(cols, rows) {
                    return process?.resize(cols, rows);
                },
                onScrollback(start, count, basis) {
                    return createScrollbackPage(state, historyEpoch, start, count, basis);
                },
                async onTerminalResponse(data) {
                    await process?.write(data);
                },
            });
            created.protocol.publishGrid({
                ...ghosttySnapshotToGrid(state.snapshot(), options.cols),
                coversOutputOffset: 0,
            });
            const terminal = new RemoteTerminal(
                state,
                process,
                created,
                options.onChange ?? (() => undefined),
                options.processFactory.confinement,
                options.colorScheme,
            );
            return terminal;
        } catch (error) {
            await process?.kill();
            state.close();
            throw error;
        }
    }

    /**
     * Add one attachment to this terminal.
     *
     * `input: false` attaches a viewer. It is the same call every other client
     * makes, so snapshot-then-deltas, resize barriers, epoch invalidation, and
     * credit-based flow control all apply to it unchanged; the only difference
     * is that it is never issued a lease that may write.
     */
    attach(stream: Duplex, options?: RemoteTerminalAttachOptions): () => void {
        return this.#protocol.attach(stream, options);
    }

    async dispose(): Promise<void> {
        await this.stop();
        this.#driver.close();
        this.#state.close();
    }

    metrics(): Readonly<RemoteTerminalProtocolMetrics> {
        return this.#protocol.metrics;
    }

    async resize(cols: number, rows: number): Promise<RemoteTerminalSummary> {
        validateSize(cols, rows);
        await this.#protocol.resize(cols, rows);
        const summary = this.summary();
        this.#onChange(summary);
        return summary;
    }

    async stop(): Promise<RemoteTerminalSummary> {
        if (this.#status === "running") await this.#process.kill();
        await this.#exited;
        return this.summary();
    }

    summary(): RemoteTerminalSummary {
        const dimensions = this.#protocol.dimensions();
        return {
            ...dimensions,
            colorScheme: this.colorScheme,
            epoch: this.#protocol.epoch,
            exitCode: this.#exitCode,
            id: this.id,
            status: this.#status,
        };
    }
}

function createScrollbackPage(
    state: GhosttyWebTerminal,
    historyEpoch: string,
    start: number,
    count: number,
    basis?: { historyEpoch: string; historyRevision: number },
): RemoteTerminalScrollbackPage {
    const historyRevision = state.historyRevision();
    if (
        basis !== undefined &&
        (basis.historyEpoch !== historyEpoch || basis.historyRevision !== historyRevision)
    ) {
        throw new Error("The terminal scrollback basis is stale.");
    }
    const snapshot = state.snapshotPage(start, count);
    const grid = ghosttySnapshotToGrid(snapshot);
    return {
        baseRow: 0,
        count,
        historyEpoch,
        historyRevision,
        palette: grid.palette,
        rows: grid.rows,
        start,
        styles: grid.styles,
        totalRows: snapshot.scroll.totalRows,
    };
}

function validateSize(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 1 || cols > 500) {
        throw new Error("The terminal column count must be between 1 and 500.");
    }
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > 200) {
        throw new Error("The terminal row count must be between 1 and 200.");
    }
}
