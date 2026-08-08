import { Value } from "@sinclair/typebox/value";

import type { ConnectionState } from "./ChatElement.js";
import {
    workletSummarySchema,
    type WorkletPermissions,
    type WorkletState,
    type WorkletSummary,
} from "./protocol.js";

export interface WorkletTool {
    description: string;
    name: string;
}

export interface WorkletVersion {
    changeDescription: string;
    createdAt: number;
    description: string;
    /** What this version's manifest declared it may touch. */
    permissions: WorkletPermissions;
    version: number;
}

/** One installed worklet, as a view holds it. */
export interface Worklet {
    authorSessionId: string;
    createdAt: number;
    currentVersion: number;
    /** The folder the worklet writes into. It survives every version change. */
    dataDirectory: string;
    description: string;
    /** Why the worklet is not running, when it failed or stopped. */
    failure?: string;
    iconThumbhash: string;
    iconUrl: string;
    id: string;
    name: string;
    /** What the current version's manifest declared, and what rig is enforcing. */
    permissions: WorkletPermissions;
    sourceDescription?: string;
    state: WorkletState;
    /** The worklet's own words about itself. */
    status?: string;
    tools: readonly WorkletTool[];
    updatedAt: number;
    versions: readonly WorkletVersion[];
}

export interface WorkletsState {
    connection: ConnectionState;
    /** Catalog entries rig sent that this client could not read. */
    failures: readonly WorkletFailure[];
}

export interface WorkletFailure {
    error: string;
    workletId: string;
}

export type WorkletManagementRequestErrorCode =
    | "invalid_request"
    | "invalid_response"
    | "invalid_worklet"
    | "request_failed"
    | "worklet_not_found";

export class WorkletManagementRequestError extends Error {
    constructor(
        readonly code: WorkletManagementRequestErrorCode,
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "WorkletManagementRequestError";
    }
}

export interface ReadWorkletLogResult {
    log: string;
    /** True when the read bound omitted older output. */
    truncated: boolean;
}

/** Immutable, reference-stable projection of rig's worklet catalog. */
export class WorkletStore {
    #state: WorkletsState = { connection: "connecting", failures: [] };
    #worklets: readonly Worklet[] = [];

    state(): WorkletsState {
        return this.#state;
    }

    worklets(): readonly Worklet[] {
        return this.#worklets;
    }

    replace(worklets: readonly WorkletSummary[], connection: ConnectionState): boolean {
        const previous = new Map(this.#worklets.map((worklet) => [worklet.id, worklet]));
        const failures: WorkletFailure[] = [];
        const valid = worklets.flatMap((worklet, index) => {
            try {
                return [Value.Decode(workletSummarySchema, worklet)];
            } catch {
                failures.push({
                    error: "Rig returned invalid catalog metadata for this worklet.",
                    workletId: workletIdentity(worklet, index),
                });
                return [];
            }
        });
        const next = valid
            .sort((left, right) => compareText(left.name, right.name))
            .map((worklet) => {
                const before = previous.get(worklet.name);
                const projected = projectWorklet(worklet, before);
                return sameWorklet(before, projected) ? before! : projected;
            });
        const nextFailures = failures.sort((left, right) =>
            compareText(left.workletId, right.workletId),
        );
        const unchanged =
            sameReferences(this.#worklets, next) &&
            this.#state.connection === connection &&
            sameFailures(this.#state.failures, nextFailures);
        if (unchanged) return false;
        this.#worklets = next;
        this.#state = {
            connection,
            failures: sameFailures(this.#state.failures, nextFailures)
                ? this.#state.failures
                : nextFailures,
        };
        return true;
    }

    setConnection(connection: ConnectionState): boolean {
        if (this.#state.connection === connection) return false;
        this.#state = { ...this.#state, connection };
        return true;
    }
}

function workletIdentity(worklet: WorkletSummary, index: number): string {
    return typeof worklet.name === "string" && worklet.name.length > 0
        ? worklet.name
        : `invalid-worklet-${String(index + 1)}`;
}

/** Turns one catalog entry into the immutable worklet a view holds. */
export function projectWorklet(worklet: WorkletSummary, previous?: Worklet): Worklet {
    const tools = worklet.tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
    }));
    const versions = worklet.versions.map((version) => ({
        changeDescription: version.changeDescription,
        createdAt: version.createdAt,
        description: version.description,
        permissions: version.permissions,
        version: version.version,
    }));
    return {
        authorSessionId: worklet.authorSessionId,
        createdAt: worklet.createdAt,
        currentVersion: worklet.currentVersion,
        dataDirectory: worklet.dataDirectory,
        description: worklet.description,
        ...(worklet.failure === undefined ? {} : { failure: worklet.failure }),
        iconThumbhash: worklet.iconThumbhash,
        iconUrl: worklet.iconUrl,
        id: worklet.name,
        name: worklet.name,
        permissions:
            previous !== undefined && samePermissions(previous.permissions, worklet.permissions)
                ? previous.permissions
                : worklet.permissions,
        ...(worklet.sourceDescription === undefined
            ? {}
            : { sourceDescription: worklet.sourceDescription }),
        state: worklet.state,
        ...(worklet.status === undefined ? {} : { status: worklet.status }),
        tools: previous !== undefined && sameTools(previous.tools, tools) ? previous.tools : tools,
        updatedAt: worklet.updatedAt,
        versions:
            previous !== undefined && sameVersions(previous.versions, versions)
                ? previous.versions
                : versions,
    };
}

function sameWorklet(left: Worklet | undefined, right: Worklet): boolean {
    return (
        left !== undefined &&
        left.authorSessionId === right.authorSessionId &&
        left.createdAt === right.createdAt &&
        left.currentVersion === right.currentVersion &&
        left.dataDirectory === right.dataDirectory &&
        left.description === right.description &&
        left.failure === right.failure &&
        left.iconThumbhash === right.iconThumbhash &&
        left.iconUrl === right.iconUrl &&
        left.id === right.id &&
        left.name === right.name &&
        left.permissions === right.permissions &&
        left.sourceDescription === right.sourceDescription &&
        left.state === right.state &&
        left.status === right.status &&
        left.tools === right.tools &&
        left.updatedAt === right.updatedAt &&
        left.versions === right.versions
    );
}

function sameTools(left: readonly WorkletTool[], right: readonly WorkletTool[]): boolean {
    return (
        left.length === right.length &&
        left.every(
            (tool, index) =>
                tool.description === right[index]?.description && tool.name === right[index]?.name,
        )
    );
}

function sameVersions(left: readonly WorkletVersion[], right: readonly WorkletVersion[]): boolean {
    return (
        left.length === right.length &&
        left.every(
            (version, index) =>
                version.changeDescription === right[index]?.changeDescription &&
                version.createdAt === right[index]?.createdAt &&
                version.description === right[index]?.description &&
                version.version === right[index]?.version &&
                samePermissions(version.permissions, right[index].permissions),
        )
    );
}

/** Compared by value, because a permission set is a small tree rather than a scalar. */
function samePermissions(left: WorkletPermissions, right: WorkletPermissions): boolean {
    return left.disk === right.disk && sameNetworkGrant(left.network, right.network);
}

function sameNetworkGrant(
    left: WorkletPermissions["network"],
    right: WorkletPermissions["network"],
): boolean {
    if (typeof left === "string" || typeof right === "string") return left === right;
    return (
        left.hosts.length === right.hosts.length &&
        left.hosts.every((value, index) => value === right.hosts[index])
    );
}

function sameFailures(left: readonly WorkletFailure[], right: readonly WorkletFailure[]): boolean {
    return (
        left.length === right.length &&
        left.every(
            (failure, index) =>
                failure.error === right[index]?.error &&
                failure.workletId === right[index]?.workletId,
        )
    );
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
