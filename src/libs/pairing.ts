import { checkPeerUrl } from "./url-utils";

/**
 * Pairing payload: what the QR code / the copied text carries.
 *
 * Format: `bsync:v1:{"u":["http://192.168.1.5:6806"],"k":"<api token>"}`
 *
 * Kept ASCII-only on purpose: the QR encoder in use only handles Latin-1 by default,
 * so no nicknames or other free text go into the payload.
 */

export const PAIRING_PREFIX = "bsync:v1:";

export interface PairingPayload {
    /** Candidate peer URLs, best first. */
    urls: string[];
    token: string;
}

export type PairingProblem =
    | "empty"
    | "notPairing"
    | "badJson"
    | "noUrl"
    | "noToken"
    | "badUrl";

export interface PairingParseResult {
    ok: boolean;
    payload?: PairingPayload;
    problem?: PairingProblem;
    /** Detail for `badUrl` (the offending value). */
    detail?: string;
}

const UUID_LIKE = /^[0-9a-zA-Z-]{8,64}$/;

export function encodePairingPayload(payload: PairingPayload): string {
    const body = { u: payload.urls, k: payload.token };
    return PAIRING_PREFIX + JSON.stringify(body);
}

/**
 * Parse what the user pasted (or what a scanner handed over).
 *
 * Tolerant on purpose — people copy from chat apps, notes and screenshots:
 *  - `bsync:v1:{...}`
 *  - `{...}` (raw JSON, with `u`/`url`/`urls` and `k`/`token`/`key`)
 *  - two lines: a URL followed by the token
 */
export function parsePairingPayload(text: string): PairingParseResult {
    const raw = (text ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!raw) return { ok: false, problem: "empty" };

    let jsonText: string | null = null;
    if (raw.startsWith(PAIRING_PREFIX)) {
        jsonText = raw.slice(PAIRING_PREFIX.length).trim();
    } else if (raw.startsWith("{")) {
        // No closing-brace requirement on purpose: a truncated paste should be reported
        // as "badJson" (probably cut off) rather than as "no address".
        jsonText = raw;
    }

    if (jsonText !== null) {
        let parsed: any;
        try {
            parsed = JSON.parse(jsonText);
        } catch {
            return { ok: false, problem: "badJson" };
        }
        return fromObject(parsed);
    }

    // Not JSON: expect "<url> <token>" (any whitespace/newline between them).
    const parts = raw.split(/\s+/).filter(part => part !== "");
    const urlPart = parts.find(part => /^(https?:\/\/|[0-9a-zA-Z-]+\.[0-9a-zA-Z-]+)/.test(part));
    const tokenPart = parts.find(part => part !== urlPart && UUID_LIKE.test(part));
    if (!urlPart) return { ok: false, problem: "noUrl" };
    if (!tokenPart) return { ok: false, problem: "noToken" };
    return fromObject({ u: [urlPart], k: tokenPart });
}

function fromObject(parsed: any): PairingParseResult {
    if (!parsed || typeof parsed !== "object") return { ok: false, problem: "badJson" };

    const rawUrls = parsed.u ?? parsed.url ?? parsed.urls;
    const urls = (Array.isArray(rawUrls) ? rawUrls : [rawUrls])
        .filter((value: any) => typeof value === "string" && value.trim() !== "")
        .map((value: string) => value.trim());
    if (urls.length === 0) return { ok: false, problem: "noUrl" };

    const token = parsed.k ?? parsed.token ?? parsed.key;
    if (typeof token !== "string" || token.trim() === "") return { ok: false, problem: "noToken" };

    const normalized: string[] = [];
    for (const url of urls) {
        const check = checkPeerUrl(url);
        if (!check.ok) return { ok: false, problem: "badUrl", detail: url };
        if (check.normalized && !normalized.includes(check.normalized)) normalized.push(check.normalized);
    }

    return { ok: true, payload: { urls: normalized, token: token.trim() } };
}
