/**
 * Stops a turn that keeps being refused.
 *
 * Auto never interrupts the user, so nothing outside the agent breaks a refusal loop. An agent
 * that reacts to a refusal by trying a variation of the same action would otherwise keep going
 * until the model gives up on its own.
 *
 * Two limits run together. A short run of refusals with nothing working in between means the
 * agent is stuck right now, and any successful action clears it. A high refusal rate over a long
 * stretch means the turn as a whole is going badly, so that one is not cleared by success.
 */
export const MAX_CONSECUTIVE_AUTO_PERMISSION_DENIALS = 3;
export const MAX_RECENT_AUTO_PERMISSION_DENIALS = 10;
export const AUTO_PERMISSION_DENIAL_WINDOW = 50;

export class AutoPermissionDenialCircuitBreaker {
    #consecutive = 0;
    #recent: boolean[] = [];
    #tripped = false;

    /** Records a refusal and reports whether this one should end the turn. */
    recordDenial(): boolean {
        this.#consecutive += 1;
        this.#record(true);
        if (this.#tripped) return false;
        const recentDenials = this.#recent.filter((denied) => denied).length;
        if (
            this.#consecutive < MAX_CONSECUTIVE_AUTO_PERMISSION_DENIALS &&
            recentDenials < MAX_RECENT_AUTO_PERMISSION_DENIALS
        ) {
            return false;
        }
        // Only the first trip ends the turn. Later refusals in the same turn are already being
        // wound down and must not each raise their own stop.
        this.#tripped = true;
        return true;
    }

    recordAllowed(): void {
        this.#consecutive = 0;
        this.#record(false);
    }

    describeStop(): string {
        const recentDenials = this.#recent.filter((denied) => denied).length;
        return `Automatic permission review refused too many actions in this turn (${String(this.#consecutive)} in a row, ${String(recentDenials)} of the last ${String(this.#recent.length)}), so the turn was stopped. Tell the user what you were trying to do and why it kept being refused.`;
    }

    #record(denied: boolean): void {
        this.#recent.push(denied);
        if (this.#recent.length > AUTO_PERMISSION_DENIAL_WINDOW) this.#recent.shift();
    }
}
