/**
 * Helpers for the peer SiYuan instance URL.
 *
 * A malformed URL here makes every request hang until the request timeout, which
 * surfaces to the user as `Request timeout for .../api/file/readDir` with no hint
 * about the real cause. Real values seen in the wild:
 *
 *   htttp://192.168.100.159://6808  -> http://192.168.100.159:6808
 *   http://192.168.100.159://6806   -> http://192.168.100.159:6806
 *
 * So the value is validated and normalized before it is stored or used.
 */

/** Why a value cannot be used as a peer URL. */
export type PeerUrlProblem =
    | { kind: "empty" }
    | { kind: "unknownScheme"; scheme: string }
    | { kind: "badHost"; host: string }
    | { kind: "badPort"; port: string };

/** What was corrected automatically while normalizing. */
export type PeerUrlFix =
    | { kind: "addedScheme"; scheme: string }
    | { kind: "fixedScheme"; from: string; to: string }
    | { kind: "fixedPortSeparator" }
    | { kind: "addedDefaultPort"; port: string }
    | { kind: "strippedTrailingSlash" };

export interface PeerUrlCheck {
    ok: boolean;
    /** Normalized URL — only present when ok. */
    normalized?: string;
    /** Why the value is unusable — only present when !ok. */
    problem?: PeerUrlProblem;
    /** Automatic corrections applied — only present when ok. */
    fixes?: PeerUrlFix[];
}

/** SiYuan's default port for the "network serving" (网络伺服) feature. */
export const DEFAULT_SIYUAN_PORT = 6806;

const SCHEME_TYPOS: Record<string, string> = {
    htttp: "http", htpp: "http", htp: "http", httpd: "http",
    htps: "https", httpss: "https", httpsss: "https",
};

/**
 * Guess the intended scheme for a scheme that is not http/https.
 * Handles repeated letters (`htttp`) and missing letters (`htps`).
 */
function guessScheme(scheme: string): string | null {
    const lower = scheme.toLowerCase();
    if (SCHEME_TYPOS[lower]) return SCHEME_TYPOS[lower];
    if (!lower.startsWith("h")) return null;
    if (lower.includes("ttp") || lower.endsWith("tp")) {
        return lower.endsWith("s") ? "https" : "http";
    }
    if (lower.includes("tps")) return "https";
    return null;
}

function isIpv4(host: string): boolean {
    const parts = host.split(".");
    if (parts.length !== 4) return false;
    return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isHostname(host: string): boolean {
    if (host.length === 0 || host.length > 253) return false;
    return host.split(".").every(label =>
        /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    );
}

function isIpv6(host: string): boolean {
    return /^[0-9A-Fa-f:]+$/.test(host) && host.includes(":");
}

/**
 * Validate and normalize a peer URL.
 *
 * Rules:
 *  - only `http` / `https`; a typo'd scheme is repaired when it is obvious (`htttp` -> `http`)
 *  - a scheme is added when it is missing (`192.168.1.5:6806` -> `http://192.168.1.5:6806`)
 *  - a stray `//` before the port is repaired (`host://6806` -> `host:6806`)
 *  - `http` without a port gets SiYuan's default serve port (6806)
 *  - a trailing `/` is stripped
 */
export function checkPeerUrl(raw: string): PeerUrlCheck {
    const original = (raw ?? "").trim();
    if (!original) return { ok: false, problem: { kind: "empty" } };

    const fixes: PeerUrlFix[] = [];
    let rest = original;
    let scheme = "http";

    const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/)?/.exec(rest);
    if (schemeMatch) {
        const rawScheme = schemeMatch[1];
        rest = rest.slice(schemeMatch[0].length);
        if (rawScheme.toLowerCase() === "http" || rawScheme.toLowerCase() === "https") {
            scheme = rawScheme.toLowerCase();
        } else {
            const guessed = guessScheme(rawScheme);
            if (!guessed) return { ok: false, problem: { kind: "unknownScheme", scheme: rawScheme } };
            scheme = guessed;
            fixes.push({ kind: "fixedScheme", from: rawScheme, to: guessed });
        }
    } else {
        // No scheme at all: assume http (peers are reached over the LAN).
        fixes.push({ kind: "addedScheme", scheme: "http" });
    }

    // `host://6806` and `host:/6806` both mean `host:6806`.
    if (/:\/+\d/.test(rest)) {
        rest = rest.replace(/:\/+(?=\d)/g, ":");
        fixes.push({ kind: "fixedPortSeparator" });
    }

    const slashIndex = rest.search(/[/?#]/);
    let authority = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
    let path = slashIndex === -1 ? "" : rest.slice(slashIndex);

    // `host//6806` (no colon at all) — the "port" ended up in the path.
    const strayPort = /^\/+(\d{1,5})$/.exec(path);
    if (strayPort && !authority.includes(":")) {
        authority = `${authority}:${strayPort[1]}`;
        path = "";
        fixes.push({ kind: "fixedPortSeparator" });
    }

    let host = authority;
    let port: string | undefined;

    if (authority.startsWith("[")) {
        const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
        if (!match) return { ok: false, problem: { kind: "badHost", host: authority } };
        host = `[${match[1]}]`;
        port = match[2];
        if (!isIpv6(match[1])) return { ok: false, problem: { kind: "badHost", host: authority } };
    } else {
        const match = /^([^:]*)(?::(.*))?$/.exec(authority);
        host = (match?.[1] ?? "").trim();
        port = match?.[2]?.trim();
        if (port === "") port = undefined;
        const bareHost = host;
        if (!isIpv4(bareHost) && !isHostname(bareHost)) {
            return { ok: false, problem: { kind: "badHost", host: authority } };
        }
    }

    if (host.startsWith("[") === false && host.length === 0)
        return { ok: false, problem: { kind: "badHost", host: authority } };

    if (port !== undefined) {
        if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
            return { ok: false, problem: { kind: "badPort", port } };
    } else if (scheme === "http") {
        port = String(DEFAULT_SIYUAN_PORT);
        fixes.push({ kind: "addedDefaultPort", port });
    }

    if (path.endsWith("/")) {
        path = path.replace(/\/+$/, "");
        fixes.push({ kind: "strippedTrailingSlash" });
    }

    const normalized = `${scheme}://${host}${port ? `:${port}` : ""}${path}`;
    return { ok: true, normalized, fixes: fixes.length > 0 ? fixes : undefined };
}
