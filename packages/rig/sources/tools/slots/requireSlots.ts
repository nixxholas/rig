import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { SlotContext } from "../../agent/context/SlotContext.js";

export function requireSlots(context: AgentContext): SlotContext {
    if (context.slots === undefined) {
        throw new Error("Slots are unavailable in this session.");
    }
    return context.slots;
}
