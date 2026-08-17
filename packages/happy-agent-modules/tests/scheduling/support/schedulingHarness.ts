import type { AgentModuleHooks, AgentSystemRef } from "@slopus/happy-agent-base";

import {
    SchedulingModule,
    type SchedulingModuleOptions,
} from "../../../sources/scheduling/SchedulingModule.js";
import type { SchedulingTimers } from "../../../sources/scheduling/SchedulingTimers.js";
import { moduleDatabase, type ModuleDatabase } from "../../support/moduleDatabase.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";

/** One message the fake collection was asked to deliver. */
export interface DeliveredMessage {
    readonly agentId: string;
    readonly text: string;
    readonly id: string | undefined;
    readonly metadata: Record<string, unknown> | undefined;
}

/**
 * Time under the test's control.
 *
 * The clock and the timers move together, because scheduling only fires an alarm once its own
 * clock has really reached the moment asked for.
 */
export class TestClock {
    #now: number;
    #nextHandle = 1;
    readonly #pending = new Map<number, { readonly at: number; readonly fire: () => void }>();

    constructor(start = 1_000) {
        this.#now = start;
    }

    now(): number {
        return this.#now;
    }

    readonly timers: SchedulingTimers = {
        start: (delay: number, fire: () => void): unknown => {
            const handle = this.#nextHandle++;
            this.#pending.set(handle, { at: this.#now + delay, fire });
            return handle;
        },
        stop: (handle: unknown): void => {
            this.#pending.delete(handle as number);
        },
    };

    /** Move the clock forward, firing everything that becomes due on the way. */
    async advance(milliseconds: number): Promise<void> {
        this.#now += milliseconds;
        for (;;) {
            const due = [...this.#pending.entries()].filter(([, entry]) => entry.at <= this.#now);
            if (due.length === 0) break;
            for (const [handle, entry] of due) {
                this.#pending.delete(handle);
                entry.fire();
            }
            await settle();
        }
        await settle();
    }

    get armed(): number {
        return this.#pending.size;
    }
}

/** A stand-in for the agent collection: it records deliveries and answers about parentage. */
export class TestAgents {
    readonly delivered: DeliveredMessage[] = [];
    readonly #parents: Map<string, string | null>;
    #failure: string | undefined;
    readonly #accepted = new Set<string>();

    constructor(parents: Readonly<Record<string, string | null>> = {}) {
        this.#parents = new Map(Object.entries(parents));
    }

    failNextDeliveries(reason: string): void {
        this.#failure = reason;
    }

    async parentOf(_ctx: unknown, agentId: string): Promise<string | null> {
        return this.#parents.get(agentId) ?? null;
    }

    async send(
        _ctx: unknown,
        agentId: string,
        message: { readonly content: readonly { readonly text?: string }[] },
        options?: { readonly id?: string; readonly metadata?: Record<string, unknown> },
    ): Promise<{ readonly accepted: string }> {
        if (this.#failure !== undefined) throw new Error(this.#failure);
        // Agent Base accepts one message per identity; the fake says so too.
        if (options?.id !== undefined && this.#accepted.has(options.id)) {
            return { accepted: "existing" };
        }
        if (options?.id !== undefined) this.#accepted.add(options.id);
        this.delivered.push({
            agentId,
            text: message.content.map((block) => block.text ?? "").join(""),
            id: options?.id,
            metadata: options?.metadata,
        });
        return { accepted: "created" };
    }

    get ref(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

export interface SchedulingHarness {
    readonly clock: TestClock;
    readonly agents: TestAgents;
    readonly database: ModuleDatabase;
    readonly hooks: AgentModuleHooks;
    readonly module: SchedulingModule;
    readonly close: () => void;
}

export interface SchedulingHarnessOptions {
    readonly agents?: TestAgents;
    readonly clock?: TestClock;
    readonly database?: ModuleDatabase;
    readonly listener?: SchedulingModuleOptions["listener"];
    readonly maxOutputCharacters?: number;
}

let ids = 0;

/** A started scheduling module over a real SQLite database, with time and delivery in hand. */
export async function schedulingHarness(
    name: string,
    options: SchedulingHarnessOptions = {},
): Promise<SchedulingHarness> {
    const clock = options.clock ?? new TestClock();
    const agents = options.agents ?? new TestAgents();
    let eventIds = 0;
    const module = new SchedulingModule({
        clock: () => clock.now(),
        timers: clock.timers,
        idFactory: () => `generated${++ids}`,
        eventIdFactory: () => `event${++eventIds}`,
        ...(options.listener === undefined ? {} : { listener: options.listener }),
        ...(options.maxOutputCharacters === undefined
            ? {}
            : { maxOutputCharacters: options.maxOutputCharacters }),
    });
    const database = options.database ?? moduleDatabase(module.migrations, name);
    await database.ready;
    const hooks = await resolveModuleHooks(database.context, module, agents.ref);
    return {
        clock,
        agents,
        database,
        hooks,
        module,
        close: () => {
            module.stop();
            if (options.database === undefined) database.close();
        },
    };
}

/** Let every already-resolved promise run, without moving the clock. */
export async function settle(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
}
