/**
 * Progress model for a running sync.
 *
 * Sync used to be a black box: a spinner on the toolbar icon and nothing else, so a
 * long sync was indistinguishable from a hung one. These values are pushed to the UI
 * through `SyncManager.onProgressChange()`.
 */

export type SyncPhase =
    | "idle"
    | "preparing"
    | "scanning"
    | "transferring"
    | "finalizing"
    | "done"
    | "failed"
    | "cancelled";

export interface SyncProgress {
    phase: SyncPhase;
    /** Number of sync targets whose scan has started (targets run concurrently). */
    targetsStarted: number;
    /** Total number of sync targets, known once the target list is built. */
    targetTotal: number;
    /** Finished file operations. */
    done: number;
    /** Planned file operations; grows while targets are still being scanned. */
    total: number;
    /** File currently being transferred (informational, last one wins). */
    currentFile?: string;
    startedAt: number;
    finishedAt?: number;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

export function idleProgress(): SyncProgress {
    return {
        phase: "idle",
        targetsStarted: 0,
        targetTotal: 0,
        done: 0,
        total: 0,
        startedAt: 0,
    };
}
