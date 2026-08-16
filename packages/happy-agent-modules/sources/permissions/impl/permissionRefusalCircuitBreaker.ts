export const MAX_RECENT_PERMISSION_REFUSALS = 10;
export const PERMISSION_REFUSAL_WINDOW = 50;

export interface PermissionRefusalCircuitStatus {
    readonly consecutive: number;
    readonly recent: number;
    readonly stopped: boolean;
    readonly newlyStopped: boolean;
}

/**
 * Keeps the short refusal streak and the bounded refusal-rate window separate. An allowed call
 * clears only the streak; it is still recorded in the long window.
 */
export class PermissionRefusalCircuitBreaker {
    #consecutive = 0;
    #recent: boolean[] = [];
    #stopped = false;

    constructor(readonly maxConsecutive = 3) {
        if (!Number.isInteger(maxConsecutive) || maxConsecutive < 1) {
            throw new Error("Permission refusal limit is invalid.");
        }
    }

    get stopped(): boolean {
        return this.#stopped;
    }

    status(): PermissionRefusalCircuitStatus {
        return {
            consecutive: this.#consecutive,
            recent: this.#recent.filter(Boolean).length,
            stopped: this.#stopped,
            newlyStopped: false,
        };
    }

    recordRefusal(): PermissionRefusalCircuitStatus {
        this.#consecutive += 1;
        this.#record(true);
        const recent = this.#recent.filter(Boolean).length;
        if (this.#stopped) {
            return {
                consecutive: this.#consecutive,
                recent,
                stopped: true,
                newlyStopped: false,
            };
        }
        if (this.#consecutive < this.maxConsecutive && recent < MAX_RECENT_PERMISSION_REFUSALS) {
            return {
                consecutive: this.#consecutive,
                recent,
                stopped: false,
                newlyStopped: false,
            };
        }
        this.#stopped = true;
        return {
            consecutive: this.#consecutive,
            recent,
            stopped: true,
            newlyStopped: true,
        };
    }

    recordAllowed(): boolean {
        if (this.#stopped) return false;
        this.#consecutive = 0;
        this.#record(false);
        return true;
    }

    #record(refused: boolean): void {
        this.#recent.push(refused);
        if (this.#recent.length > PERMISSION_REFUSAL_WINDOW) this.#recent.shift();
    }
}
