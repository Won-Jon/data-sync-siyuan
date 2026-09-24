/**
 * Peer connectivity diagnostics.
 *
 * The plugin used to fail with `Request timeout for .../api/file/readDir` and no
 * explanation. This module runs a small sequence of real API calls against the
 * peer and reports *which* step failed and *why*, so the settings UI can show
 * something actionable (wrong port / wrong token / peer asleep / not a SiYuan
 * instance ...).
 */

export interface PeerRequestResult {
    url: string;
    /** HTTP status, or null when the request never completed. */
    httpStatus: number | null;
    elapsedMs: number;
    /** Parsed JSON body when the response was JSON. */
    json: any | null;
    /** Raw response body. */
    text: string | null;
    error: { name: string; message: string } | null;
}

export type ConnStepKey = "version" | "notebooks" | "readDir" | "instanceId" | "repo" | "clock";

export interface ConnStep {
    key: ConnStepKey;
    ok: boolean;
    httpStatus: number | null;
    /** SiYuan business code (`json.code`), when available. */
    code: number | null;
    elapsedMs: number;
    /** Raw detail (server message or thrown error), for troubleshooting. */
    detail?: string;
}

/** Coarse failure classification, used to pick the user facing hint. */
export type ConnFailure =
    | "timeout"
    | "unreachable"
    | "unauthorized"
    | "businessError"
    | "unexpected";

export interface PeerConnReport {
    url: string;
    ok: boolean;
    failedStep: ConnStepKey | null;
    failure: ConnFailure | null;
    steps: ConnStep[];
    kernelVersion?: string;
    notebookCount?: number;
    instanceId?: string;
    /** Whether the peer's data repository (snapshots) is initialized. */
    repoReady?: boolean;
    snapshotCount?: number;
    /** peer `currentTime` minus local time, in ms. */
    clockDriftMs?: number;
    /** The very first request took >= 3s: typical for a peer waking up from sleep. */
    slowStart: boolean;
}

/**
 * POST a SiYuan API request and never throw: the caller inspects the result.
 */
export async function peerPost(
    baseUrl: string,
    path: string,
    body: any,
    token?: string,
    timeoutMs: number = 15000
): Promise<PeerRequestResult> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token && token.trim() !== "") headers["Authorization"] = `Token ${token.trim()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body ?? {}),
            signal: controller.signal,
        });
        const elapsedMs = Date.now() - startedAt;
        const text = await response.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
        return { url, httpStatus: response.status, elapsedMs, json, text, error: null };
    } catch (error: any) {
        return {
            url,
            httpStatus: null,
            elapsedMs: Date.now() - startedAt,
            json: null,
            text: null,
            error: {
                name: error?.name ?? "Error",
                message: error?.message ?? String(error),
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

function classify(result: PeerRequestResult): ConnFailure {
    if (result.error) {
        // fetch() cannot tell "connection refused" from "host unreachable" from DNS
        // failure — the browser hides it. Only our own abort is distinguishable.
        return result.error.name === "AbortError" ? "timeout" : "unreachable";
    }
    if (result.httpStatus === 401 || result.httpStatus === 403) return "unauthorized";
    if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus >= 300))
        return "unexpected";
    if (result.json === null) return "unexpected";
    if (typeof result.json.code === "number" && result.json.code !== 0) return "businessError";
    return "unexpected";
}

function toStep(key: ConnStepKey, result: PeerRequestResult, ok: boolean): ConnStep {
    const detail = result.error
        ? `${result.error.name}: ${result.error.message}`
        : (result.json?.msg ? String(result.json.msg) : undefined);
    return {
        key,
        ok,
        httpStatus: result.httpStatus,
        code: typeof result.json?.code === "number" ? result.json.code : null,
        elapsedMs: result.elapsedMs,
        detail: detail && detail.trim() !== "" ? detail : undefined,
    };
}

function businessOk(result: PeerRequestResult): boolean {
    return result.error === null
        && result.httpStatus !== null
        && result.httpStatus >= 200
        && result.httpStatus < 300
        && result.json !== null
        && result.json.code === 0;
}

/**
 * Run the connectivity check sequence against a peer.
 *
 * The URL is expected to be already normalized by `checkPeerUrl()`.
 */
export async function testPeerConnection(
    baseUrl: string,
    token: string,
    timeoutMs: number = 15000
): Promise<PeerConnReport> {
    const report: PeerConnReport = {
        url: baseUrl,
        ok: false,
        failedStep: null,
        failure: null,
        steps: [],
        slowStart: false,
    };

    const fail = (key: ConnStepKey, result: PeerRequestResult): PeerConnReport => {
        report.steps.push(toStep(key, result, false));
        report.failedStep = key;
        report.failure = classify(result);
        report.ok = false;
        return report;
    };

    // 1. Kernel version — proves there is a SiYuan kernel answering HTTP.
    const version = await peerPost(baseUrl, "/api/system/version", {}, token, timeoutMs);
    if (!businessOk(version)) return fail("version", version);
    report.steps.push(toStep("version", version, true));
    report.kernelVersion = typeof version.json?.data === "string" ? version.json.data : undefined;
    report.slowStart = version.elapsedMs >= 3000;

    // 2. Notebook list — proves the API token is accepted.
    const notebooks = await peerPost(baseUrl, "/api/notebook/lsNotebooks", {}, token, timeoutMs);
    if (!businessOk(notebooks)) return fail("notebooks", notebooks);
    report.steps.push(toStep("notebooks", notebooks, true));
    report.notebookCount = Array.isArray(notebooks.json?.data?.notebooks)
        ? notebooks.json.data.notebooks.length
        : undefined;

    // 3. Plugin state directory — the sync lock and history live there.
    const readDir = await peerPost(baseUrl, "/api/file/readDir", { path: "data/.siyuan/sync" }, token, timeoutMs);
    if (!businessOk(readDir)) return fail("readDir", readDir);
    report.steps.push(toStep("readDir", readDir, true));

    // 4. Device fingerprint (non fatal: peers that never synced have no file yet).
    const instanceId = await peerPost(baseUrl, "/api/file/getFile", { path: "data/.siyuan/sync/instance-id" }, token, timeoutMs);
    const instanceIdText = (instanceId.text ?? "").trim();
    const hasInstanceId = instanceId.error === null && instanceId.httpStatus === 200
        && instanceIdText !== "" && !instanceIdText.startsWith("{");
    report.steps.push(toStep("instanceId", instanceId, hasInstanceId));
    if (hasInstanceId) report.instanceId = instanceIdText;

    // 5. Data repository (snapshots) — only relevant when the snapshot option is on,
    //    so a missing repo is reported but does not fail the whole test.
    const repo = await peerPost(baseUrl, "/api/repo/getRepoSnapshots", { page: 1 }, token, timeoutMs);
    const repoReady = businessOk(repo);
    report.steps.push(toStep("repo", repo, repoReady));
    report.repoReady = repoReady;
    if (repoReady && Array.isArray(repo.json?.data?.snapshots))
        report.snapshotCount = repo.json.data.snapshots.length;

    // 6. Clock drift — files are compared by mtime, so a big drift breaks direction detection.
    const clock = await peerPost(baseUrl, "/api/system/currentTime", {}, token, timeoutMs);
    const remoteNow = typeof clock.json?.data === "number" ? clock.json.data : null;
    const clockOk = businessOk(clock) && remoteNow !== null;
    report.steps.push(toStep("clock", clock, clockOk));
    if (clockOk) report.clockDriftMs = remoteNow! - Date.now();

    report.ok = true;
    return report;
}
