import type { ProviderUsageToolEntry } from "./get_provider_usage.js";

/**
 * One provider on one line, in the words a person would use. The model reads
 * this rather than the raw structure, so it stays plain rather than terse.
 */
export function formatProviderUsageLine(entry: ProviderUsageToolEntry): string {
    const parts: string[] = [entry.provider_id];
    if (entry.plan !== null) parts.push(`(${entry.plan})`);
    parts.push(`— ${entry.status.toLowerCase()}`);

    const windows: string[] = [];
    if (entry.five_hour !== null) windows.push(`5-hour ${formatPercent(entry.five_hour)}`);
    if (entry.weekly !== null) windows.push(`weekly ${formatPercent(entry.weekly)}`);
    if (entry.monthly !== null) windows.push(`monthly ${formatPercent(entry.monthly)}`);
    if (windows.length > 0) parts.push(`· ${windows.join(", ")}`);

    if (entry.remaining_credit_usd !== null) {
        parts.push(`· $${entry.remaining_credit_usd.toFixed(2)} credit left`);
    }

    const resets = entry.weekly?.resets_at ?? entry.five_hour?.resets_at ?? null;
    if (resets !== null) parts.push(`· resets ${formatWhen(resets)}`);

    return parts.join(" ");
}

function formatPercent(window: { used_percent: number }): string {
    // Small readings deserve a decimal; a whole number is clearer above that.
    const used = window.used_percent;
    return `${used > 0 && used < 1 ? used.toFixed(2) : Math.round(used)}% used`;
}

function formatWhen(iso: string): string {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return iso;
    const hours = Math.round((at - Date.now()) / (60 * 60 * 1_000));
    if (hours <= 0) return "shortly";
    if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.round(hours / 24);
    return `in ${days} day${days === 1 ? "" : "s"}`;
}
