/**
 * M4: two-sided roles, handshake and "who is allowed to start a sync".
 *
 * Background: the plain lock only stops *simultaneous* pushes. It does not stop two sides
 * from taking turns pushing over each other, and a lock older than five minutes used to be
 * ignored (so a long sync could be interrupted by the other side). Roles + direction
 * ownership decide who may start, heartbeats decide whether a lock is really abandoned.
 */

export type SyncRole = "host" | "peer" | "manual";

/** Unset means "host": a single-device setup keeps working exactly as before. */
export const DEFAULT_SYNC_ROLE: SyncRole = "host";

export const ROLE_FILE_PATH = "data/.siyuan/sync/role.json";
export const DIRECTION_FILE = "direction.json";

/** A lock whose heartbeat stopped this long ago is considered abandoned. */
export const LOCK_STALE_MS = 5 * 60 * 1000;
/** Renew the lock this often while a sync is running. */
export const LOCK_HEARTBEAT_MS = 30 * 1000;

export interface RoleDeclaration {
    role: SyncRole;
    instanceId?: string;
    nickname?: string;
    updatedAt?: number;
}

export interface SyncLockContent {
    instanceId: string;
    nickname?: string;
    /** Which way the holder is moving data ("outgoing" for the initiator). */
    direction?: string;
    startedAt: number;
    heartbeatAt: number;
}

export function isSyncRole(value: unknown): value is SyncRole {
    return value === "host" || value === "peer" || value === "manual";
}

export function parseRoleDeclaration(raw: string | null | undefined): RoleDeclaration | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!isSyncRole(parsed?.role)) return null;
        return {
            role: parsed.role,
            instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : undefined,
            nickname: typeof parsed.nickname === "string" ? parsed.nickname : undefined,
            updatedAt: Number(parsed.updatedAt) || undefined,
        };
    } catch {
        return null;
    }
}

/** Locks written by older versions hold a bare instance id; tolerate both shapes. */
export function parseLockContent(raw: string | null | undefined): SyncLockContent | null {
    if (!raw) return null;
    const text = raw.trim();
    if (text === "") return null;

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && parsed.instanceId) {
            return {
                instanceId: String(parsed.instanceId),
                nickname: typeof parsed.nickname === "string" ? parsed.nickname : undefined,
                direction: typeof parsed.direction === "string" ? parsed.direction : undefined,
                startedAt: Number(parsed.startedAt) || 0,
                heartbeatAt: Number(parsed.heartbeatAt) || 0,
            };
        }
    } catch {
        // Not JSON — legacy lock.
    }

    return { instanceId: text, startedAt: 0, heartbeatAt: 0 };
}

export function serializeLockContent(content: SyncLockContent): string {
    return JSON.stringify(content);
}

/**
 * Staleness is decided by the heartbeat; the file timestamp is only the fallback for
 * legacy locks that carry no heartbeat.
 */
export function isLockStale(content: SyncLockContent | null, lockUpdatedMs: number, now: number): boolean {
    const heartbeatAt = content?.heartbeatAt ?? 0;
    const reference = heartbeatAt > 0 ? heartbeatAt : lockUpdatedMs;
    return now - reference > LOCK_STALE_MS;
}

export function lockAgeSeconds(content: SyncLockContent | null, lockUpdatedMs: number, now: number): number {
    const reference = content?.heartbeatAt ? content.heartbeatAt : lockUpdatedMs;
    return Math.max(0, Math.round((now - reference) / 1000));
}

export type SyncTrigger = "auto" | "manual";
export type DirectionOwnerSetting = "auto" | "local" | "remote";

/**
 * Which device owns the direction of a pair. Deterministic by default (lower instance id),
 * so both sides compute the same answer without talking to each other.
 */
export function resolveDirectionOwner(
    localInstanceId: string,
    remoteInstanceId: string,
    setting: DirectionOwnerSetting = "auto",
    override?: string | null
): string {
    if (override) return override;
    if (setting === "local") return localInstanceId;
    if (setting === "remote") return remoteInstanceId;
    return localInstanceId <= remoteInstanceId ? localInstanceId : remoteInstanceId;
}

export type InitiationCode =
    | "ok"
    | "bothHostsNotOwner"
    | "bothPeers"
    | "localIsPeer"
    | "localIsManual"
    | "remoteRoleUnknown";

export interface InitiationDecision {
    allowed: boolean;
    code: InitiationCode;
}

/**
 * Decide whether this device may start a sync now.
 *
 * - `auto` (on open / on close / instant sync) is only for the direction owner.
 * - `manual` (the user pressed sync) always goes through unless the pair is
 *   self-contradictory, and even then the both-hosts case is refused so that two hosts
 *   cannot take turns overwriting each other.
 */
export function decideInitiation(options: {
    localRole: SyncRole;
    /** null when the peer did not declare a role (older plugin, or file missing). */
    remoteRole: SyncRole | null;
    trigger: SyncTrigger;
    directionOwner: string;
    localInstanceId: string;
}): InitiationDecision {
    const { localRole, remoteRole, trigger, directionOwner, localInstanceId } = options;
    const isOwner = directionOwner === localInstanceId;

    if (remoteRole === null) {
        // Never auto-start against a peer we cannot reason about; an explicit click may pass.
        return trigger === "auto" ? { allowed: false, code: "remoteRoleUnknown" } : { allowed: true, code: "ok" };
    }

    if (localRole === "host" && remoteRole === "host")
        return isOwner ? { allowed: true, code: "ok" } : { allowed: false, code: "bothHostsNotOwner" };

    if (trigger === "manual") return { allowed: true, code: "ok" };

    if (localRole === "peer" && remoteRole === "peer") return { allowed: false, code: "bothPeers" };
    if (localRole === "peer") return { allowed: false, code: "localIsPeer" };
    if (localRole === "manual") return { allowed: false, code: "localIsManual" };

    return { allowed: true, code: "ok" };
}
