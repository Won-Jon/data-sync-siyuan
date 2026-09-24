import { peerPost } from "./connectivity";

/**
 * Saved peer connections — "pair once, connect with one click afterwards".
 *
 * The identity of a peer is its `data/.siyuan/sync/instance-id`, not its IP: the DHCP
 * lease of a phone changes, the instance id does not. So a saved entry keeps a list of
 * candidate URLs plus the fingerprint, and connecting = find the candidate whose
 * instance-id matches.
 */

export interface SavedConnection {
    /** Peer `data/.siyuan/sync/instance-id`. */
    fingerprint: string;
    nickname?: string;
    /** Candidate URLs, most recently working first. */
    urls: string[];
    /** Omitted when the user chose not to store the key. */
    token?: string;
    kernelVersion?: string;
    lastOkAt?: number;
    lastError?: string;
    pinned?: boolean;
}

export const INSTANCE_ID_PATH = "data/.siyuan/sync/instance-id";

const UUID_LIKE = /^[0-9a-zA-Z-]{8,64}$/;

export function connectionLabel(connection: SavedConnection): string {
    const nickname = connection.nickname?.trim();
    if (nickname) return nickname;
    return connection.fingerprint.slice(0, 8);
}

/** Pinned first, then most recently working. */
export function sortConnections(list: SavedConnection[]): SavedConnection[] {
    return [...list].sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0);
    });
}

export function upsertConnection(list: SavedConnection[], entry: SavedConnection): SavedConnection[] {
    const existing = list.find(item => item.fingerprint === entry.fingerprint);
    // Deduplicate on insert too: the matched URL is usually also the first candidate.
    if (!existing) return sortConnections([...list, { ...entry, urls: dedupe(entry.urls ?? []) }]);

    const merged: SavedConnection = {
        ...existing,
        ...entry,
        urls: dedupe([...(entry.urls ?? []), ...(existing.urls ?? [])]),
        token: entry.token ?? existing.token,
        nickname: entry.nickname ?? existing.nickname,
        pinned: existing.pinned,
    };
    return sortConnections(list.map(item => item.fingerprint === entry.fingerprint ? merged : item));
}

export function removeConnection(list: SavedConnection[], fingerprint: string): SavedConnection[] {
    return list.filter(item => item.fingerprint !== fingerprint);
}

export function touchConnection(list: SavedConnection[], fingerprint: string, patch: Partial<SavedConnection>): SavedConnection[] {
    return sortConnections(list.map(item => item.fingerprint === fingerprint ? { ...item, ...patch } : item));
}

export function dedupe(values: string[]): string[] {
    return Array.from(new Set(values.filter(value => typeof value === "string" && value.trim() !== "")));
}

export type PeerProbeOutcome =
    | "match"
    | "anotherDevice"
    | "noInstanceId"
    | "unauthorized"
    | "timeout"
    | "unreachable";

export interface PeerProbe {
    url: string;
    outcome: PeerProbeOutcome;
    fingerprint?: string;
    httpStatus: number | null;
    elapsedMs: number;
    detail?: string;
}

/** Ask one candidate URL who it is. */
export async function probePeer(url: string, token: string | undefined, timeoutMs: number = 8000): Promise<PeerProbe> {
    const result = await peerPost(url, "/api/file/getFile", { path: INSTANCE_ID_PATH }, token, timeoutMs);
    const text = (result.text ?? "").trim();

    if (result.error) {
        return {
            url,
            outcome: result.error.name === "AbortError" ? "timeout" : "unreachable",
            httpStatus: null,
            elapsedMs: result.elapsedMs,
            detail: result.error.message,
        };
    }

    if (result.httpStatus === 401 || result.httpStatus === 403) {
        return {
            url,
            outcome: "unauthorized",
            httpStatus: result.httpStatus,
            elapsedMs: result.elapsedMs,
            detail: result.json?.msg,
        };
    }

    const looksLikeId = text !== "" && !text.startsWith("{") && UUID_LIKE.test(text);
    if (!looksLikeId) {
        return {
            url,
            outcome: "noInstanceId",
            httpStatus: result.httpStatus,
            elapsedMs: result.elapsedMs,
            detail: result.json?.msg,
        };
    }

    return {
        url,
        outcome: "match",
        fingerprint: text,
        httpStatus: result.httpStatus,
        elapsedMs: result.elapsedMs,
    };
}

export interface PeerResolution {
    /** The candidate that matched, when found. */
    url?: string;
    fingerprint?: string;
    probes: PeerProbe[];
    /** Most specific failure the UI can explain. */
    failure: PeerProbe["outcome"] | "fingerprintMismatch" | "noCandidate";
}

/**
 * Try the candidate URLs in order until one reports the expected fingerprint.
 * A candidate that answers with a *different* fingerprint is recorded and skipped,
 * so "the phone got a new IP and something else now lives there" is handled.
 */
export async function resolvePeer(
    urls: string[],
    token: string | undefined,
    expectedFingerprint: string | undefined,
    timeoutMs: number = 8000
): Promise<PeerResolution> {
    const candidates = dedupe(urls);
    if (candidates.length === 0) return { probes: [], failure: "noCandidate" };

    const probes: PeerProbe[] = [];
    let sawMismatch = false;

    for (const url of candidates) {
        const probe = await probePeer(url, token, timeoutMs);

        if (probe.outcome === "match" && probe.fingerprint) {
            if (expectedFingerprint && probe.fingerprint !== expectedFingerprint) {
                // Reached *a* SiYuan kernel, but not the device we remember.
                probes.push({ ...probe, outcome: "anotherDevice" });
                sawMismatch = true;
                continue;
            }
            probes.push(probe);
            return { url, fingerprint: probe.fingerprint, probes, failure: "match" as any };
        }

        probes.push(probe);
    }

    const last = probes[probes.length - 1];
    const failure = sawMismatch ? "fingerprintMismatch" : (last?.outcome ?? "noCandidate");
    return { probes, failure };
}
