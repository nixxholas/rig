import type {
    AgentBaseModelChange,
    AgentModel,
    AgentModuleAgent,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type {
    HistoryBlock,
    HistoryMessage,
    HistoryRole,
} from "../../sources/history/HistoryMessage.js";
import type { HistoryReader } from "../../sources/history/HistoryReader.js";
import type { HistoryRecord } from "../../sources/history/HistoryStore.js";
import { summarizeHistory } from "../../sources/history/impl/summarizeHistory.js";
import { ModelSwitchModule } from "../../sources/modelSwitch/ModelSwitchModule.js";
import { sharedKV, providersOf } from "../support/fixtures.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

export const DEFAULT_AGENT_ID = "model-switch-test-agent";

export function historyMessage(
    position: number,
    role: HistoryRole = "user",
    blocks: readonly HistoryBlock[] = [{ type: "text", text: `message ${position}` }],
    overrides: Partial<HistoryMessage> = {},
): HistoryMessage {
    return {
        role,
        blocks: [...blocks],
        recordId: `record-${position}`,
        at: position,
        ...overrides,
    };
}

export function historyRecord(
    position: number,
    role: HistoryRole = "user",
    blocks?: readonly HistoryBlock[],
    overrides: Partial<HistoryMessage> = {},
): HistoryRecord {
    return {
        position,
        message: historyMessage(position, role, blocks, overrides),
    };
}

export function readerFor(
    beginning: readonly HistoryRecord[],
    recent: readonly HistoryRecord[] = beginning,
    stats = summarizeHistory(beginning.map((record) => record.message)),
): HistoryReader {
    return {
        messages: async (_ctx, _agentId, query) =>
            query.from === "end" ? [...recent] : [...beginning],
        stats: async () => stats,
    };
}

export function modelSwitchScope(agentId = DEFAULT_AGENT_ID): AgentModuleScope {
    const agent: AgentModuleAgent = {
        id: agentId,
        metadata: undefined,
        provider: "scripted",
        providerKind: "gym",
        model: undefined,
        effort: undefined,
        tier: undefined,
        permissionMode: "auto",
    };
    return {
        agent,
        kv: sharedKV(),
        sharedKV: sharedKV(),
        runKV: sharedKV(),
        historyKV: sharedKV(),
    };
}

export function modelChange(overrides: Partial<AgentBaseModelChange> = {}): AgentBaseModelChange {
    const provider = new ScriptedProvider([]);
    return {
        previousModel: "openai/gpt-5.6-sol",
        model: "anthropic/opus-5",
        previousProvider: "scripted",
        provider: "scripted",
        providers: providersOf(provider),
        wasReset: true,
        ...overrides,
    };
}

export function agentReference(models: readonly AgentModel[] = []): AgentSystemRef {
    return { models } as unknown as AgentSystemRef;
}

export async function modelSwitchNoticeFromHook(
    module: ModelSwitchModule,
    ctx: Context,
    options: {
        readonly models?: readonly AgentModel[];
        readonly change?: AgentBaseModelChange;
        readonly agentId?: string;
    } = {},
) {
    const hooks = await module.beforeStart?.(ctx, agentReference(options.models ?? []));
    if (hooks?.modelChanged === undefined) {
        throw new Error("ModelSwitchModule did not return modelChanged.");
    }
    return await hooks.modelChanged(
        ctx,
        modelSwitchScope(options.agentId),
        options.change ?? modelChange(),
    );
}
