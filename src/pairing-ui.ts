import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import { consoleError, consoleLog } from "@/logging";
import { peerPost } from "@/libs/connectivity";
import { checkLocalApiToken, getLocalCandidateUrls, readLocalApiToken, readLocalInstanceId } from "@/libs/local-config";
import { encodePairingPayload, PairingProblem, parsePairingPayload } from "@/libs/pairing";
import {
    connectionLabel,
    PeerProbe,
    PeerResolution,
    probePeer,
    removeConnection,
    resolvePeer,
    SavedConnection,
    sortConnections,
    touchConnection,
    upsertConnection,
} from "@/libs/connections";

/**
 * Settings UI for M3: QR pairing, paste/scan import and the saved-connection list.
 *
 * Everything here is built as `custom` setting items, so it lives inside the normal
 * plugin settings dialog.
 */

export const CONNECTIONS_FILE = "connections.json";

export interface PairingUiContext {
    i18n: any;
    loadData: (file: string) => Promise<any>;
    saveData: (file: string, data: any) => Promise<void>;
    /** Live value of a settings field (falls back to the saved value). */
    readSetting: (key: string) => string;
    /** Persist url/token and re-init the sync manager. */
    applyPairing: (values: { url: string; token: string }) => Promise<void>;
    /** Reuse of the M1 "test connection" report. */
    runConnectionTest: (output: HTMLElement) => Promise<void>;
}

const BUTTON_CLASS = "b3-button b3-button--outline fn__flex-center";
const FIELD_CLASS = "b3-text-field fn__block";
const SMALL_TEXT = "font-size:12px;line-height:1.6";

function statusLine(): HTMLElement {
    const element = document.createElement("div");
    element.className = "b3-label__text";
    element.style.cssText = `${SMALL_TEXT};margin-top:6px;word-break:break-all`;
    return element;
}

async function copyText(text: string, ctx: PairingUiContext, status: HTMLElement) {
    try {
        await navigator.clipboard.writeText(text);
        status.textContent = ctx.i18n.pairingCopied;
        return;
    } catch (error) {
        consoleError("Clipboard API failed, falling back:", error);
    }

    // Fallback for environments without the async clipboard API.
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(helper);
    helper.select();
    try {
        document.execCommand("copy");
        status.textContent = ctx.i18n.pairingCopied;
    } catch (fallbackError) {
        consoleError("Copy fallback failed:", fallbackError);
        status.textContent = text;
    }
    helper.remove();
}

function describeProbe(probe: PeerProbe, ctx: PairingUiContext): string {
    const reason = describeFailure(probe.outcome === "anotherDevice" ? "fingerprintMismatch" : probe.outcome, ctx);
    return `${probe.outcome === "match" ? "✔" : "✘"} ${probe.url} — ${(probe.elapsedMs / 1000).toFixed(2)}s · ${reason}`;
}

export function describeFailure(failure: PeerResolution["failure"] | PeerProbe["outcome"], ctx: PairingUiContext): string {
    switch (failure) {
        case "match": return "";
        case "anotherDevice":
        case "fingerprintMismatch": return ctx.i18n.pairingReasonFingerprintMismatch;
        case "unauthorized": return ctx.i18n.pairingReasonUnauthorized;
        case "timeout": return ctx.i18n.pairingReasonTimeout;
        case "unreachable": return ctx.i18n.pairingReasonUnreachable;
        case "noInstanceId": return ctx.i18n.pairingReasonNoInstanceId;
        case "noCandidate": return ctx.i18n.pairingReasonNoCandidate;
        default: return String(failure);
    }
}

function describePairingProblem(problem: PairingProblem | undefined, ctx: PairingUiContext, detail?: string): string {
    switch (problem) {
        case "empty": return ctx.i18n.pairingProblemEmpty;
        case "badJson": return ctx.i18n.pairingProblemBadJson;
        case "noUrl": return ctx.i18n.pairingProblemNoUrl;
        case "noToken": return ctx.i18n.pairingProblemNoToken;
        case "badUrl": return ctx.i18n.pairingProblemBadUrl.replace("{{detail}}", detail ?? "");
        default: return ctx.i18n.pairingProblemNotPairing;
    }
}

/**
 * Ask for a photo through a file input.
 *
 * This is the only camera path that works inside the SiYuan mobile app: the app's
 * `onShowFileChooser` handles `<input capture>` by opening the system camera
 * (`ACTION_IMAGE_CAPTURE`) and handing the photo back — while `getUserMedia` is
 * refused, because the app's WebView `onPermissionRequest` only grants audio capture.
 */
function pickImageFile(capture: boolean, onFile: (file: File) => void) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (capture) input.setAttribute("capture", "environment");
    input.style.display = "none";

    input.onchange = () => {
        const file = input.files?.[0];
        input.remove();
        if (file) onFile(file);
    };

    document.body.appendChild(input);
    input.click();
}

/** Decode the first QR code found in a photo. Returns null when nothing was found. */
async function decodeQrFromFile(file: File): Promise<string | null> {
    const url = URL.createObjectURL(file);
    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const element = new Image();
            element.onload = () => resolve(element);
            element.onerror = () => reject(new Error("Could not decode the image"));
            element.src = url;
        });

        // Downscale big camera photos: jsQR is CPU bound and a QR code does not need 4000px.
        const maxSide = 1200;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;

        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        const result = jsQR(pixels.data, width, height, { inversionAttempts: "attemptBoth" });
        return result?.data ?? null;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/* ------------------------------------------------------------------ QR (host side) */

export function createQrSection(ctx: PairingUiContext): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "fn__flex-1";
    wrapper.style.minWidth = "260px";

    const generate = document.createElement("button");
    generate.className = BUTTON_CLASS;
    generate.textContent = ctx.i18n.pairingQrGenerate;

    const status = statusLine();
    const qrBox = document.createElement("div");
    qrBox.style.cssText = "margin-top:8px;background:#fff;padding:8px;border-radius:6px;display:none;width:fit-content";
    const payloadField = document.createElement("textarea");
    payloadField.className = FIELD_CLASS;
    payloadField.readOnly = true;
    payloadField.style.cssText = "margin-top:8px;display:none;font-size:11px";
    const copy = document.createElement("button");
    copy.className = BUTTON_CLASS;
    copy.textContent = ctx.i18n.pairingCopy;
    copy.style.cssText = "margin-top:6px;display:none";

    wrapper.append(generate, status, qrBox, payloadField, copy);

    copy.onclick = () => copyText(payloadField.value, ctx, status);

    generate.onclick = async () => {
        generate.disabled = true;
        status.textContent = ctx.i18n.pairingQrWorking;
        qrBox.style.display = "none";
        payloadField.style.display = "none";
        copy.style.display = "none";

        try {
            const token = await readLocalApiToken("");
            if (!token) {
                status.textContent = ctx.i18n.pairingQrNoToken;
                return;
            }

            const check = await checkLocalApiToken(token.value);
            if (!check.ok) {
                status.textContent = ctx.i18n.pairingQrTokenRejected.replace("{{status}}", String(check.httpStatus ?? "?"));
                return;
            }

            // Only advertise addresses that this very device can reach and that answer
            // with *our* instance id — otherwise the peer would scan a dead address.
            const ownId = await readLocalInstanceId();
            const candidates = await getLocalCandidateUrls();
            const verified: string[] = [];
            const lines: string[] = [];

            for (const url of candidates) {
                const probe = await probePeer(url, token.value, 5000);
                const isUs = probe.outcome === "match" && (!ownId || probe.fingerprint === ownId);
                if (isUs) verified.push(url);
                lines.push(`${isUs ? "✔" : "✘"} ${url} — ${(probe.elapsedMs / 1000).toFixed(2)}s`);
            }

            const urls = verified.length > 0 ? verified : candidates;
            if (verified.length === 0 && candidates.length > 0)
                lines.push(`⚠ ${ctx.i18n.pairingQrUnverified.replace("{{urls}}", candidates[0])}`);

            const payload = encodePairingPayload({ urls, token: token.value });
            const qr = qrcode(0, "M");
            qr.addData(payload);
            qr.make();
            // { scalable: true } emits an <svg> with only a viewBox (no width/height), which
            // collapses to 0x0 inside a fit-content container — an invisible QR code.
            // Use the fixed-pixel form and keep a defensive size check.
            qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8 });
            const svg = qrBox.querySelector("svg");
            if (svg) {
                const width = svg.getBoundingClientRect?.().width ?? 0;
                if (!svg.getAttribute("width") || width < 20) {
                    const size = qr.getModuleCount() * 4 + 16;
                    svg.setAttribute("width", `${size}px`);
                    svg.setAttribute("height", `${size}px`);
                }
                svg.style.maxWidth = "100%";
                svg.style.height = "auto";
            }
            qrBox.style.display = "block";
            payloadField.value = payload;
            payloadField.style.display = "block";
            copy.style.display = "";

            lines.unshift(ctx.i18n.pairingQrUrls.replace("{{urls}}", urls.join(" , ")));
            lines.push(ctx.i18n.pairingQrReady);
            lines.push(ctx.i18n.pairingQrPhoneHint);
            status.textContent = lines.join("\n");
            consoleLog(`Pairing QR generated with ${urls.length} candidate url(s).`);
        } catch (error) {
            consoleError("Failed to generate the pairing QR code:", error);
            status.textContent = String(error);
        } finally {
            generate.disabled = false;
        }
    };

    return wrapper;
}

/* --------------------------------------------------------- import (joining side) */

export function createImportSection(ctx: PairingUiContext, onConnectionsChanged: () => void): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "fn__flex-1";
    wrapper.style.minWidth = "260px";

    const input = document.createElement("textarea");
    input.className = FIELD_CLASS;
    input.rows = 3;
    input.placeholder = ctx.i18n.pairingImportPlaceholder;
    input.style.fontSize = "11px";

    const runButton = document.createElement("button");
    runButton.className = BUTTON_CLASS;
    runButton.textContent = ctx.i18n.pairingImportRun;
    runButton.style.marginTop = "6px";

    // The camera path that works inside the mobile app: a file input with `capture` makes
    // the app open the system camera; a plain file input opens the photo picker.
    const photoButton = document.createElement("button");
    photoButton.className = BUTTON_CLASS;
    photoButton.textContent = ctx.i18n.pairingImportPhoto;
    photoButton.style.marginTop = "6px";

    const imageButton = document.createElement("button");
    imageButton.className = BUTTON_CLASS;
    imageButton.textContent = ctx.i18n.pairingImportPhotoPick;
    imageButton.style.cssText = "margin-top:6px;margin-left:6px";

    // The practical path on a phone: scan with the system camera / WeChat, copy the text,
    // then read it straight from the clipboard here.
    const clipboardButton = document.createElement("button");
    clipboardButton.className = BUTTON_CLASS;
    clipboardButton.textContent = ctx.i18n.pairingImportClipboard;
    clipboardButton.style.cssText = "margin-top:6px;margin-left:6px";

    const status = statusLine();
    const output = document.createElement("pre");
    output.style.cssText = `${SMALL_TEXT};margin:8px 0 0;white-space:pre-wrap;word-break:break-all;display:none`;

    const note = document.createElement("div");
    note.className = "b3-label__text";
    note.style.cssText = `${SMALL_TEXT};opacity:.7;margin-top:6px`;
    note.textContent = ctx.i18n.pairingImportPhotoNote;

    wrapper.append(input, photoButton, imageButton, clipboardButton, runButton, status, output, note);

    const connect = async (text: string) => {
        const parsed = parsePairingPayload(text);
        if (!parsed.ok || !parsed.payload) {
            status.textContent = describePairingProblem(parsed.problem, ctx, parsed.detail);
            output.style.display = "none";
            return;
        }

        status.textContent = ctx.i18n.pairingImportWorking.replace("{{count}}", String(parsed.payload.urls.length));
        output.style.display = "none";

        try {
            const resolution = await resolvePeer(parsed.payload.urls, parsed.payload.token, undefined, 8000);
            if (!resolution.url || !resolution.fingerprint) {
                status.textContent = ctx.i18n.pairingImportFail.replace("{{reason}}", describeFailure(resolution.failure, ctx));
                output.textContent = resolution.probes.map(probe => describeProbe(probe, ctx)).join("\n");
                output.style.display = "block";
                return;
            }

            const version = await peerPost(resolution.url, "/api/system/version", {}, parsed.payload.token, 8000);
            const kernelVersion = typeof version.json?.data === "string" ? version.json.data : undefined;

            const list = await loadConnections(ctx);
            await saveConnections(ctx, upsertConnection(list, {
                fingerprint: resolution.fingerprint,
                urls: [resolution.url, ...parsed.payload.urls],
                token: parsed.payload.token,
                kernelVersion,
                lastOkAt: Date.now(),
                lastError: undefined,
                nickname: ctx.readSetting("siyuanNickname") || undefined,
            }));

            await ctx.applyPairing({ url: resolution.url, token: parsed.payload.token });
            onConnectionsChanged();

            status.textContent = ctx.i18n.pairingImportOk
                .replace("{{url}}", resolution.url)
                .replace("{{fingerprint}}", resolution.fingerprint.slice(0, 8));
            output.textContent = "";
            output.style.display = "none";
            await ctx.runConnectionTest(output);
            output.style.display = "block";
        } catch (error) {
            consoleError("Pairing import failed:", error);
            status.textContent = ctx.i18n.pairingImportFail.replace("{{reason}}", String(error));
        }
    };

    runButton.onclick = () => connect(input.value);

    const handleImage = async (file: File) => {
        status.textContent = ctx.i18n.pairingImportDecoding;
        output.style.display = "none";
        try {
            const text = await decodeQrFromFile(file);
            if (!text) {
                status.textContent = ctx.i18n.pairingImportDecodeFailed;
                return;
            }
            input.value = text;
            await connect(text);
        } catch (error) {
            consoleError("Decoding the QR image failed:", error);
            status.textContent = ctx.i18n.pairingImportDecodeFailed;
        }
    };

    photoButton.onclick = () => pickImageFile(true, file => { void handleImage(file); });
    imageButton.onclick = () => pickImageFile(false, file => { void handleImage(file); });

    clipboardButton.onclick = async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (!text || text.trim() === "") {
                status.textContent = ctx.i18n.pairingImportClipboardEmpty;
                return;
            }
            input.value = text;
            await connect(text);
        } catch (error) {
            consoleError("Reading the clipboard failed:", error);
            status.textContent = ctx.i18n.pairingImportClipboardFailed;
        }
    };

    return wrapper;
}

/* --------------------------------------------------------------- history list */

export async function loadConnections(ctx: PairingUiContext): Promise<SavedConnection[]> {
    try {
        const data = await ctx.loadData(CONNECTIONS_FILE);
        return Array.isArray(data) ? data as SavedConnection[] : [];
    } catch (error) {
        consoleError("Failed to load connections.json:", error);
        return [];
    }
}

export async function saveConnections(ctx: PairingUiContext, list: SavedConnection[]): Promise<void> {
    try {
        await ctx.saveData(CONNECTIONS_FILE, sortConnections(list));
    } catch (error) {
        consoleError("Failed to save connections.json:", error);
    }
}

export function createHistorySection(ctx: PairingUiContext): { element: HTMLElement; refresh: () => Promise<void> } {
    const wrapper = document.createElement("div");
    wrapper.className = "fn__flex-1";
    wrapper.style.minWidth = "260px";

    const list = document.createElement("div");
    const status = statusLine();
    const output = document.createElement("pre");
    output.style.cssText = `${SMALL_TEXT};margin:8px 0 0;white-space:pre-wrap;word-break:break-all;display:none`;

    wrapper.append(list, status, output);

    const render = (connections: SavedConnection[]) => {
        list.innerHTML = "";
        if (connections.length === 0) {
            const empty = document.createElement("div");
            empty.className = "b3-label__text";
            empty.style.cssText = SMALL_TEXT;
            empty.textContent = ctx.i18n.pairingHistoryEmpty;
            list.appendChild(empty);
            return;
        }

        for (const connection of connections) {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--b3-border-color)";

            const info = document.createElement("div");
            info.style.cssText = "flex:1;min-width:0";
            const title = document.createElement("div");
            title.style.cssText = "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            title.textContent = `${connection.pinned ? "📌 " : ""}${connectionLabel(connection)}${connection.kernelVersion ? ` · ${connection.kernelVersion}` : ""}`;
            const detail = document.createElement("div");
            detail.style.cssText = `${SMALL_TEXT};opacity:.75;word-break:break-all`;
            const parts: string[] = [connection.urls?.[0] ?? ""];
            if (connection.lastOkAt)
                parts.push(ctx.i18n.pairingHistoryLastOk.replace("{{time}}", new Date(connection.lastOkAt).toLocaleString()));
            if (connection.lastError)
                parts.push(ctx.i18n.pairingHistoryLastError.replace("{{error}}", connection.lastError));
            detail.textContent = parts.filter(part => part !== "").join(" · ");
            info.append(title, detail);

            const connectButton = document.createElement("button");
            connectButton.className = BUTTON_CLASS;
            connectButton.textContent = ctx.i18n.pairingHistoryConnect;
            connectButton.onclick = async () => {
                connectButton.disabled = true;
                status.textContent = ctx.i18n.pairingImportWorking.replace("{{count}}", String(connection.urls?.length ?? 0));
                output.style.display = "none";
                try {
                    const resolution = await resolvePeer(connection.urls ?? [], connection.token, connection.fingerprint, 8000);
                    const current = await loadConnections(ctx);

                    if (!resolution.url) {
                        const reason = describeFailure(resolution.failure, ctx);
                        await saveConnections(ctx, touchConnection(current, connection.fingerprint, { lastError: reason }));
                        status.textContent = ctx.i18n.pairingImportFail.replace("{{reason}}", reason);
                        output.textContent = resolution.probes.map(probe => describeProbe(probe, ctx)).join("\n");
                        output.style.display = "block";
                        await refresh();
                        return;
                    }

                    if (connection.token)
                        await ctx.applyPairing({ url: resolution.url, token: connection.token });

                    await saveConnections(ctx, touchConnection(current, connection.fingerprint, {
                        urls: [resolution.url, ...(connection.urls ?? [])],
                        lastOkAt: Date.now(),
                        lastError: undefined,
                    }));
                    status.textContent = ctx.i18n.pairingImportOk
                        .replace("{{url}}", resolution.url)
                        .replace("{{fingerprint}}", resolution.fingerprint.slice(0, 8));
                    await refresh();
                    if (connection.token) {
                        await ctx.runConnectionTest(output);
                        output.style.display = "block";
                    } else {
                        status.textContent += ` — ${ctx.i18n.pairingHistoryNoToken}`;
                    }
                } catch (error) {
                    consoleError("One-click connect failed:", error);
                    status.textContent = ctx.i18n.pairingImportFail.replace("{{reason}}", String(error));
                } finally {
                    connectButton.disabled = false;
                }
            };

            const pinButton = document.createElement("button");
            pinButton.className = BUTTON_CLASS;
            pinButton.textContent = connection.pinned ? ctx.i18n.pairingHistoryUnpin : ctx.i18n.pairingHistoryPin;
            pinButton.onclick = async () => {
                const current = await loadConnections(ctx);
                await saveConnections(ctx, touchConnection(current, connection.fingerprint, { pinned: !connection.pinned }));
                await refresh();
            };

            const deleteButton = document.createElement("button");
            deleteButton.className = BUTTON_CLASS;
            deleteButton.textContent = ctx.i18n.pairingHistoryDelete;
            deleteButton.onclick = async () => {
                const current = await loadConnections(ctx);
                await saveConnections(ctx, removeConnection(current, connection.fingerprint));
                await refresh();
            };

            row.append(info, connectButton, pinButton, deleteButton);
            list.appendChild(row);
        }
    };

    const refresh = async () => {
        render(await loadConnections(ctx));
    };

    return { element: wrapper, refresh };
}
