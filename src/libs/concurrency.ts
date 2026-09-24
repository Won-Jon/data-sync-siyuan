/**
 * Shared concurrency budget for file IO during a sync.
 *
 * The plugin used to fire one request per file and per subdirectory at once
 * (`Promise.all` while scanning, `Promise.allSettled` while transferring). On a large
 * workspace — and especially against a mobile peer — that alone produced batches of
 * timeouts. `src/libs/promise-pool.ts` exists but a per-call-site pool cannot bound
 * the whole sync: every recursion level and every target would get its own budget.
 * A single process-wide semaphore does.
 */

export const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;

let maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS;

/** Clamped to 1..64; anything else falls back to the default. */
export function setMaxConcurrentRequests(value: number) {
    if (typeof value === "number" && isFinite(value) && value >= 1)
        maxConcurrentRequests = Math.min(Math.floor(value), 64);
    else
        maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS;
}

export function getMaxConcurrentRequests(): number {
    return maxConcurrentRequests;
}

/**
 * Pause gate.
 *
 * While paused, no new request or operation starts; whatever is already in flight is
 * allowed to finish (an HTTP request cannot be cancelled mid-way without risking a
 * half-written file). Resuming releases everything that was queued.
 */
let pausePromise: Promise<void> | null = null;
let releasePause: (() => void) | null = null;

export function pauseTransfers() {
    if (!pausePromise)
        pausePromise = new Promise<void>(resolve => { releasePause = resolve; });
}

export function resumeTransfers() {
    if (releasePause) releasePause();
    pausePromise = null;
    releasePause = null;
}

export function isTransferPaused(): boolean {
    return pausePromise !== null;
}

/**
 * Cancel gate ("stop the transfer now").
 *
 * Unlike pause this does not wait for anything: queued work is refused and any request
 * that supports it (the raw-fetch file download) is aborted. Requests issued through the
 * SiYuan SDK cannot be aborted, so those are simply no longer waited for beyond their own
 * timeout — the sync unwinds at the next checkpoint instead.
 */
export class TransferCancelledError extends Error {
    constructor() {
        super("Transfer cancelled");
        this.name = "TransferCancelledError";
    }
}

let cancelRequested = false;
const abortableControllers = new Set<AbortController>();

export function cancelTransfers() {
    cancelRequested = true;
    for (const controller of Array.from(abortableControllers)) {
        try {
            controller.abort();
        } catch {
            // already aborted / not abortable
        }
    }
}

export function isTransferCancelled(): boolean {
    return cancelRequested;
}

/** Called at the start of every sync so a previous cancel cannot leak into it. */
export function resetTransferCancel() {
    cancelRequested = false;
}

/** Register an AbortController that should be aborted when the user cancels. */
export function registerAbortableController(controller: AbortController) {
    abortableControllers.add(controller);
}

export function unregisterAbortableController(controller: AbortController) {
    abortableControllers.delete(controller);
}

/**
 * A FIFO semaphore.
 *
 * Never hold a slot while waiting for another slot of the *same* semaphore: that is
 * how the first version of this file deadlocked a sync (recursive directory scans held
 * slots while waiting for their children's slots, so the queue never drained and the
 * plugin hung with the locks still on disk).
 */
class Semaphore {
    private running = 0;
    private waiting: (() => void)[] = [];

    constructor(private readonly limit: () => number) { }

    get runningCount() {
        return this.running;
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        // Refuse queued work outright once the user cancelled.
        if (cancelRequested) throw new TransferCancelledError();

        // Wait outside the slot, so a paused sync does not keep slots occupied.
        while (pausePromise) await pausePromise;

        if (this.running >= this.limit())
            await new Promise<void>(resolve => this.waiting.push(resolve));

        // We may have been handed a free slot only to refuse it (pause/cancel). Whoever
        // refuses a slot MUST pass it on, otherwise the remaining queue stalls forever.
        if (cancelRequested) {
            this.releaseNext();
            throw new TransferCancelledError();
        }
        while (pausePromise) {
            await pausePromise;
            if (cancelRequested) {
                this.releaseNext();
                throw new TransferCancelledError();
            }
        }

        this.running++;
        try {
            return await task();
        } finally {
            this.running--;
            this.releaseNext();
        }
    }

    /** Hand a free slot to the next waiter, if any. */
    private releaseNext() {
        const next = this.waiting.shift();
        if (next) next();
    }
}

/** Budget for in-flight HTTP requests (the real protection for a mobile peer). */
const requestSemaphore = new Semaphore(() => maxConcurrentRequests);

/**
 * Budget for in-flight sync *operations*. Separate from the request budget on purpose:
 * an operation holds a slot while awaiting its own requests, and a shared budget would
 * deadlock (all slots held by operations waiting for a request slot).
 */
const operationSemaphore = new Semaphore(() => maxConcurrentRequests);

export function withConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
    return requestSemaphore.run(task);
}

export function withOperationLimit<T>(task: () => Promise<T>): Promise<T> {
    return operationSemaphore.run(task);
}

/** Number of requests currently running under the budget (for diagnostics). */
export function getRunningRequestCount(): number {
    return requestSemaphore.runningCount;
}

/** Number of sync operations currently running under the budget (for diagnostics). */
export function getRunningOperationCount(): number {
    return operationSemaphore.runningCount;
}
