import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { connectRig } from "./connectRig.js";
import {
    DEFAULT_INSTALLATION_DISCOVERY_TIMEOUT_MS,
    discoverRigInstallation,
    RigInstallationDiscoveryUnsupportedError,
} from "./discoverRigInstallation.js";
import {
    rigCliInstallationInspectionSchema,
    type RigCliInstallationInspection,
} from "./RigInstallationInspection.js";
import {
    MAXIMUM_RIG_PROTOCOL_VERSION,
    MINIMUM_RIG_PROTOCOL_VERSION,
    serverCompatibility,
    type ServerCompatibility,
} from "./ServerCompatibility.js";
import { onboardingStatusSchema } from "./protocol.js";

const exact = { additionalProperties: false } as const;
const messageSchema = Type.String({ maxLength: 2_048, minLength: 1 });
const protocolVersionSchema = Type.Integer({
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 0,
});

/**
 * The native facts that a browser-safe library cannot discover by itself.
 *
 * A desktop bridge returns one of the two process-level states, or the decoded
 * output of `rig inspect --json` unchanged.
 */
export const localRigOnboardingInspectionSchema = Type.Union([
    Type.Object({ status: Type.Literal("not_installed") }, exact),
    Type.Object(
        {
            message: Type.Optional(messageSchema),
            status: Type.Literal("not_running"),
        },
        exact,
    ),
    rigCliInstallationInspectionSchema,
]);
export type LocalRigOnboardingInspection = Static<typeof localRigOnboardingInspectionSchema>;

const rigNotInstalledOnboardingStateSchema = Type.Object(
    { state: Type.Literal("rig_not_installed") },
    exact,
);
const rigNotRunningOnboardingStateSchema = Type.Object(
    {
        message: Type.Optional(messageSchema),
        state: Type.Literal("rig_not_running"),
    },
    exact,
);
const rigUnreachableOnboardingStateSchema = Type.Object(
    {
        message: messageSchema,
        state: Type.Literal("rig_unreachable"),
    },
    exact,
);
const rigProtocolVersionMismatchOnboardingStateSchema = Type.Object(
    {
        installedVersion: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        maximumSupportedProtocolVersion: protocolVersionSchema,
        minimumSupportedProtocolVersion: protocolVersionSchema,
        protocolVersion: protocolVersionSchema,
        reason: Type.Literal("protocol"),
        source: Type.Union([Type.Literal("cli"), Type.Literal("daemon")]),
        state: Type.Literal("version_mismatch"),
        upgrade: Type.Union([Type.Literal("rig"), Type.Literal("happy")]),
    },
    exact,
);
const rigInstallationDataMismatchOnboardingStateSchema = Type.Object(
    {
        dataReason: Type.Literal("newer_schema"),
        installedVersion: Type.String({ maxLength: 256, minLength: 1 }),
        message: messageSchema,
        reason: Type.Literal("installation_data"),
        schemaVersion: Type.Integer({ minimum: 0 }),
        source: Type.Literal("cli"),
        state: Type.Literal("version_mismatch"),
        upgrade: Type.Literal("rig"),
    },
    exact,
);
const rigVersionMismatchOnboardingStateSchema = Type.Union([
    rigProtocolVersionMismatchOnboardingStateSchema,
    rigInstallationDataMismatchOnboardingStateSchema,
]);

/**
 * The one state a desktop application renders before and after connecting.
 *
 * Once the local daemon is compatible, the value is the daemon-owned
 * `OnboardingStatus` unchanged.
 */
export const rigOnboardingStateSchema = Type.Union([
    rigNotInstalledOnboardingStateSchema,
    rigNotRunningOnboardingStateSchema,
    rigUnreachableOnboardingStateSchema,
    rigVersionMismatchOnboardingStateSchema,
    onboardingStatusSchema,
]);
export type RigOnboardingState = Static<typeof rigOnboardingStateSchema>;

export interface ResolveRigOnboardingOptions {
    endpoint: string;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /**
     * Native bridge for process and offline installation facts.
     *
     * A missing executable must be returned as `not_installed`, and a known
     * stopped daemon as `not_running`; thrown errors are bridge failures and
     * are not guessed into either state.
     */
    inspectLocalRig: (
        signal: AbortSignal,
    ) => LocalRigOnboardingInspection | Promise<LocalRigOnboardingInspection>;
    signal?: AbortSignal;
    /** Bound for each daemon request. Defaults to five seconds. */
    timeoutMs?: number;
    token: string;
}

/**
 * Resolves the ordered onboarding gate from native installation facts through
 * the daemon-owned onboarding status without opening the live event stream.
 */
export async function resolveRigOnboarding(
    options: ResolveRigOnboardingOptions,
): Promise<RigOnboardingState> {
    const fallbackController = new AbortController();
    const signal = options.signal ?? fallbackController.signal;
    throwIfAborted(signal);

    let rawInspection: LocalRigOnboardingInspection;
    try {
        rawInspection = await options.inspectLocalRig(signal);
    } catch (error) {
        throwIfAborted(signal);
        throw error;
    }
    let inspection: LocalRigOnboardingInspection;
    try {
        inspection = Value.Decode(localRigOnboardingInspectionSchema, rawInspection);
    } catch {
        throw new Error("The native bridge returned an invalid Rig installation inspection.");
    }

    if ("status" in inspection) {
        if (inspection.status === "not_installed") return { state: "rig_not_installed" };
        return {
            ...(inspection.message === undefined ? {} : { message: inspection.message }),
            state: "rig_not_running",
        };
    }

    const cliCompatibility = serverCompatibility(inspection.cliProtocolVersion);
    if (cliCompatibility.status !== "compatible") {
        return protocolMismatchState(cliCompatibility, "cli", inspection.cliVersion);
    }

    const localDataState = classifyLocalData(inspection);
    if (localDataState !== undefined) return localDataState;

    let discovery;
    try {
        discovery = await discoverRigInstallation({
            endpoint: options.endpoint,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            signal,
            timeoutMs: options.timeoutMs ?? DEFAULT_INSTALLATION_DISCOVERY_TIMEOUT_MS,
            token: options.token,
        });
    } catch (error) {
        throwIfAborted(signal);
        if (error instanceof RigInstallationDiscoveryUnsupportedError) {
            return protocolMismatchState(error.compatibility, "daemon", undefined);
        }
        return unreachableState(error);
    }

    const daemonCompatibility = serverCompatibility(discovery.daemonProtocolVersion);
    if (daemonCompatibility.status !== "compatible") {
        return protocolMismatchState(daemonCompatibility, "daemon", discovery.daemonVersion);
    }
    if (
        inspection.data.status === "initialized" &&
        discovery.data.epoch !== inspection.data.epoch
    ) {
        return {
            message:
                "The running Rig daemon does not match the locally inspected Rig installation.",
            state: "rig_unreachable",
        };
    }

    const rig = connectRig({
        endpoint: options.endpoint,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        token: options.token,
    });
    const statusOperation = timeoutSignal(
        signal,
        options.timeoutMs ?? DEFAULT_INSTALLATION_DISCOVERY_TIMEOUT_MS,
    );
    try {
        return await rig.getOnboardingStatus({ signal: statusOperation.signal });
    } catch (error) {
        throwIfAborted(signal);
        return unreachableState(error);
    } finally {
        statusOperation.detach();
        rig.close();
    }
}

function classifyLocalData(
    inspection: RigCliInstallationInspection,
): RigOnboardingState | undefined {
    const data = inspection.data;
    if (data.status === "incompatible") {
        return {
            dataReason: data.reason,
            installedVersion: boundedVersion(inspection.cliVersion),
            message: boundedMessage(data.message),
            reason: "installation_data",
            schemaVersion: data.schemaVersion,
            source: "cli",
            state: "version_mismatch",
            upgrade: "rig",
        };
    }
    if (data.status === "unavailable") {
        return { message: boundedMessage(data.message), state: "rig_unreachable" };
    }
    if (
        data.status === "absent" ||
        data.status === "uninitialized" ||
        data.status === "upgrade_required" ||
        (data.status === "initialized" && data.schemaCompatibility === "upgrade_required")
    ) {
        return { state: "rig_not_running" };
    }
    return undefined;
}

function protocolMismatchState(
    compatibility: Exclude<ServerCompatibility, { status: "checking" }>,
    source: "cli" | "daemon",
    installedVersion: string | undefined,
): RigOnboardingState {
    return {
        ...(installedVersion === undefined
            ? {}
            : { installedVersion: boundedVersion(installedVersion) }),
        maximumSupportedProtocolVersion: MAXIMUM_RIG_PROTOCOL_VERSION,
        minimumSupportedProtocolVersion: MINIMUM_RIG_PROTOCOL_VERSION,
        protocolVersion: compatibility.serverProtocolVersion,
        reason: "protocol",
        source,
        state: "version_mismatch",
        upgrade: compatibility.status === "client_outdated" ? "happy" : "rig",
    };
}

function unreachableState(error: unknown): RigOnboardingState {
    const message =
        error instanceof Error && error.message.length > 0
            ? error.message
            : "Rig could not be reached.";
    return { message: boundedMessage(message), state: "rig_unreachable" };
}

function boundedMessage(message: string): string {
    return message.slice(0, 2_048) || "Rig could not be reached.";
}

function boundedVersion(version: string): string {
    return version.slice(0, 256);
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason ?? new DOMException("This onboarding check was cancelled.", "AbortError");
}

function timeoutSignal(
    parent: AbortSignal,
    timeoutMs: number,
): { detach: () => void; signal: AbortSignal } {
    const controller = new AbortController();
    const abortForParent = () => controller.abort(parent.reason);
    if (parent.aborted) abortForParent();
    else parent.addEventListener("abort", abortForParent, { once: true });
    const timeout = setTimeout(() => {
        controller.abort(new DOMException("Rig onboarding status timed out.", "TimeoutError"));
    }, timeoutMs);
    return {
        detach: () => {
            clearTimeout(timeout);
            parent.removeEventListener("abort", abortForParent);
        },
        signal: controller.signal,
    };
}
