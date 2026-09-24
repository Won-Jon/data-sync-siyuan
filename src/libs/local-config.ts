import { peerPost, PeerRequestResult } from "./connectivity";

/**
 * This device's own API token.
 *
 * Needed when this device acts as the *server* for another one (the peer needs a token
 * to call our kernel API). Two sources, in order of trust:
 *
 *  1. `window.siyuan.config.api.token` — the value the running kernel knows and shows
 *     in 设置 → 关于 → API token.
 *  2. `conf/conf.json` on disk — **can lag behind**: observed on 2026-09-24, the file
 *     held a token the kernel answered with `401 Auth failed`. Only used as fallback.
 *
 * Always confirm with `checkLocalApiToken()` before handing the value to a peer.
 */

export interface LocalApiToken {
    value: string;
    source: "frontend" | "conf";
}

function readFrontendToken(): string | null {
    const globalWindow = (globalThis as any)?.window;
    const token = globalWindow?.siyuan?.config?.api?.token;
    return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
}

async function readConfToken(baseUrl: string, timeoutMs: number): Promise<string | null> {
    const result = await peerPost(baseUrl, "/api/file/getFile", { path: "conf/conf.json" }, undefined, timeoutMs);
    if (result.error || result.httpStatus !== 200 || !result.text) return null;
    try {
        const token = JSON.parse(result.text)?.api?.token;
        return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
    } catch {
        return null;
    }
}

export async function readLocalApiToken(baseUrl: string = "", timeoutMs: number = 5000): Promise<LocalApiToken | null> {
    const frontendToken = readFrontendToken();
    if (frontendToken) return { value: frontendToken, source: "frontend" };

    const confToken = await readConfToken(baseUrl, timeoutMs);
    return confToken ? { value: confToken, source: "conf" } : null;
}

export interface LocalApiTokenCheck {
    ok: boolean;
    httpStatus: number | null;
    message?: string;
}

/** Verify a token against this kernel using an endpoint that requires authentication. */
export async function checkLocalApiToken(token: string, baseUrl: string = "", timeoutMs: number = 5000): Promise<LocalApiTokenCheck> {
    const result: PeerRequestResult = await peerPost(baseUrl, "/api/file/readDir", { path: "data/.siyuan/sync" }, token, timeoutMs);
    const ok = !result.error && result.httpStatus === 200 && result.json?.code === 0;
    return {
        ok,
        httpStatus: result.httpStatus,
        message: result.json?.msg ?? result.error?.message,
    };
}

export interface LocalProbe {
    kernelVersion?: string;
    token?: LocalApiToken;
    /** Whether the token we found is accepted by the running kernel. */
    tokenAccepted: boolean;
    tokenHttpStatus: number | null;
    tokenMessage?: string;
}

/** SiYuan's default port for "network serving" (网络伺服). */
export const DEFAULT_SERVE_PORT = 6806;

function readFrontendServerAddrs(): string[] {
    const globalWindow = (globalThis as any)?.window;
    const addrs = globalWindow?.siyuan?.config?.serverAddrs;
    return Array.isArray(addrs) ? addrs.filter((value: any) => typeof value === "string") : [];
}

async function readConfServerAddrs(baseUrl: string, timeoutMs: number): Promise<string[]> {
    const result = await peerPost(baseUrl, "/api/file/getFile", { path: "conf/conf.json" }, undefined, timeoutMs);
    if (result.error || result.httpStatus !== 200 || !result.text) return [];
    try {
        const addrs = JSON.parse(result.text)?.serverAddrs;
        return Array.isArray(addrs) ? addrs.filter((value: any) => typeof value === "string") : [];
    } catch {
        return [];
    }
}

/**
 * URLs another device can use to reach *this* device's SiYuan kernel.
 *
 * `conf.serverAddrs` lists the UI port — a random one that changes at every start — so
 * every host is rewritten to the network-serving port (6806 by default) first, and the
 * original address is kept as a fallback. Loopback entries are useless for a peer and
 * are dropped.
 */
export async function getLocalCandidateUrls(
    baseUrl: string = "",
    servePort: number = DEFAULT_SERVE_PORT,
    timeoutMs: number = 5000
): Promise<string[]> {
    let addrs = readFrontendServerAddrs();
    if (addrs.length === 0) addrs = await readConfServerAddrs(baseUrl, timeoutMs);

    const servedUrls: string[] = [];
    const originalUrls: string[] = [];
    for (const addr of addrs) {
        try {
            const parsed = new URL(addr);
            const host = parsed.hostname;
            if (!host || host === "127.0.0.1" || host === "localhost" || host === "::1") continue;

            servedUrls.push(`http://${host}:${servePort}`);

            const original = `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
            if (original !== `http://${host}:${servePort}`) originalUrls.push(original);
        } catch {
            // ignore malformed entries
        }
    }
    // Stable candidates first: the serving port survives restarts, the UI port does not.
    return Array.from(new Set([...servedUrls, ...originalUrls]));
}

/** Read this device's own instance id (the fingerprint peers recognise it by). */
export async function readLocalInstanceId(baseUrl: string = "", timeoutMs: number = 5000): Promise<string | null> {
    const result = await peerPost(baseUrl, "/api/file/getFile", { path: "data/.siyuan/sync/instance-id" }, undefined, timeoutMs);
    const text = (result.text ?? "").trim();
    return text !== "" && !text.startsWith("{") ? text : null;
}

/** Inspect this device: kernel version, API token source, and whether that token works. */
export async function probeLocalKernel(baseUrl: string = "", timeoutMs: number = 5000): Promise<LocalProbe> {
    const probe: LocalProbe = { tokenAccepted: false, tokenHttpStatus: null };

    const version = await peerPost(baseUrl, "/api/system/version", {}, undefined, timeoutMs);
    if (!version.error && typeof version.json?.data === "string") probe.kernelVersion = version.json.data;

    const token = await readLocalApiToken(baseUrl, timeoutMs);
    if (!token) return probe;

    probe.token = token;
    const check = await checkLocalApiToken(token.value, baseUrl, timeoutMs);
    probe.tokenAccepted = check.ok;
    probe.tokenHttpStatus = check.httpStatus;
    probe.tokenMessage = check.message;
    return probe;
}
