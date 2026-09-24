import { SettingUtils } from "@/libs/setting-utils";
import BetterSyncPlugin from ".";
import { consoleError, consoleLog, consoleWarn } from "@/logging";
import { showMessage } from "siyuan";
import { DEFAULT_REQUEST_TIMEOUT_MS, getRequestTimeoutMs, lsNotebooks, setRequestTimeoutMs } from "@/api";
import { DEFAULT_MAX_CONCURRENT_REQUESTS, setMaxConcurrentRequests } from "@/libs/concurrency";
import { LocalProbe, probeLocalKernel, readLocalApiToken } from "@/libs/local-config";
import { checkPeerUrl, PeerUrlFix, PeerUrlProblem } from "@/libs/url-utils";
import { ConnStepKey, PeerConnReport, peerPost, testPeerConnection } from "@/libs/connectivity";
import { createHistorySection, createImportSection, createQrSection, PairingUiContext } from "@/pairing-ui";
import { DEFAULT_SYNC_ROLE, parseRoleDeclaration, resolveDirectionOwner, ROLE_FILE_PATH } from "@/libs/roles";
import {
    isDirSelected,
    isNotebookSelected,
    parseSyncConfig,
    SYNC_CONFIG_FILE,
    SyncConfig,
} from "@/libs/sync-config";
import { SYNC_DIR_PATHS } from "@/sync/sync-targets";

const STORAGE_NAME = "menu-config";

export class SettingsManager {
    private plugin: BetterSyncPlugin;
    private settingUtils: SettingUtils;

    constructor(plugin: BetterSyncPlugin) {
        this.plugin = plugin;

        this.settingUtils = new SettingUtils({
            plugin: this.plugin,
            name: STORAGE_NAME,
            callback: () => this.applyRequestSettings(),
        });
    }

    /**
     * Push settings that live outside the settings object into the request layer, and
     * let the sync manager pick up URL/key changes confirmed in the dialog without
     * requiring a plugin reload.
     */
    private applyRequestSettings() {
        setRequestTimeoutMs(this.settingUtils.get("requestTimeoutMs") as number);
        setMaxConcurrentRequests(this.settingUtils.get("maxConcurrentRequests") as number);

        const syncManager = this.plugin.syncManager;
        if (syncManager)
            syncManager.init().catch(error => consoleError("Failed to re-initialize the sync manager:", error));
    }

    /** Persist url/token chosen by the pairing UI and make the sync manager use them. */
    private async applyPairing(values: { url: string; token: string }) {
        await this.settingUtils.setAndSave("siyuanUrl", values.url);
        await this.settingUtils.setAndSave("siyuanAPIKey", values.token);
        this.applyRequestSettings();
    }

    private shortId(id: string): string {
        return id ? id.slice(0, 8) : "-";
    }

    /**
     * M5-P6: pick what gets synced. Everything is selected by default, and unchecking
     * something only stops comparing/transferring it — nothing is ever deleted.
     */
    private createSelectionElement(): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "fn__flex-1";
        wrapper.style.minWidth = "280px";

        const notebookBox = document.createElement("div");
        notebookBox.style.cssText = "max-height:150px;overflow:auto;border:1px solid var(--b3-border-color);border-radius:6px;padding:6px";
        notebookBox.textContent = this.plugin.i18n.syncScopeLoading;

        const dirBox = document.createElement("div");
        dirBox.style.cssText = "max-height:150px;overflow:auto;border:1px solid var(--b3-border-color);border-radius:6px;padding:6px;margin-top:6px";

        const rulesField = document.createElement("textarea");
        rulesField.className = "b3-text-field fn__block";
        rulesField.rows = 3;
        rulesField.style.cssText = "margin-top:6px;font-size:12px";
        rulesField.placeholder = this.plugin.i18n.syncScopeRulesPlaceholder;

        const notebookInputs: { value: string; input: HTMLInputElement }[] = [];
        const dirInputs: { value: string; input: HTMLInputElement }[] = [];

        const renderBoxes = (
            host: HTMLElement,
            items: { value: string; label: string }[],
            isChecked: (value: string) => boolean,
            bucket: { value: string; input: HTMLInputElement }[]
        ) => {
            host.innerHTML = "";
            bucket.length = 0;
            if (items.length === 0) {
                host.textContent = "-";
                return;
            }
            items.forEach(item => {
                const row = document.createElement("label");
                row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;line-height:1.9;cursor:pointer";
                const input = document.createElement("input");
                input.type = "checkbox";
                input.checked = isChecked(item.value);
                const text = document.createElement("span");
                text.textContent = item.label;
                text.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
                row.append(input, text);
                host.appendChild(row);
                bucket.push({ value: item.value, input });
            });
        };

        const status = document.createElement("div");
        status.className = "b3-label__text";
        status.style.cssText = "font-size:12px;margin-top:6px;word-break:break-all";

        const saveButton = document.createElement("button");
        saveButton.className = "b3-button b3-button--outline";
        saveButton.textContent = this.plugin.i18n.syncScopeSave;

        const allButton = document.createElement("button");
        allButton.className = "b3-button b3-button--outline";
        allButton.textContent = this.plugin.i18n.syncScopeSelectAll;
        allButton.style.marginLeft = "6px";

        const noneButton = document.createElement("button");
        noneButton.className = "b3-button b3-button--outline";
        noneButton.textContent = this.plugin.i18n.syncScopeClearAll;
        noneButton.style.marginLeft = "6px";

        const hint = document.createElement("div");
        hint.className = "b3-label__text";
        hint.style.cssText = "font-size:12px;opacity:.7;margin-top:6px";
        hint.textContent = this.plugin.i18n.syncScopeEffective;

        const setAll = (checked: boolean) => {
            [...notebookInputs, ...dirInputs].forEach(entry => { entry.input.checked = checked; });
        };

        const notebookLabel = document.createElement("div");
        notebookLabel.className = "b3-label__text";
        notebookLabel.style.cssText = "font-size:12px;font-weight:600;margin:4px 0";
        notebookLabel.textContent = this.plugin.i18n.syncScopeNotebooksLabel;

        const dirLabel = document.createElement("div");
        dirLabel.className = "b3-label__text";
        dirLabel.style.cssText = "font-size:12px;font-weight:600;margin:8px 0 4px";
        dirLabel.textContent = this.plugin.i18n.syncScopeDirsLabel;

        const rulesLabel = document.createElement("div");
        rulesLabel.className = "b3-label__text";
        rulesLabel.style.cssText = "font-size:12px;font-weight:600;margin:8px 0 4px";
        rulesLabel.textContent = this.plugin.i18n.syncScopeRules;

        wrapper.append(
            notebookLabel, notebookBox,
            dirLabel, dirBox,
            rulesLabel, rulesField,
            saveButton, allButton, noneButton,
            status, hint
        );

        allButton.onclick = () => setAll(true);
        noneButton.onclick = () => setAll(false);

        saveButton.onclick = async () => {
            const notebookIds = notebookInputs.map(entry => entry.value);
            const pickedNotebooks = notebookInputs.filter(entry => entry.input.checked).map(entry => entry.value);
            const dirPaths = dirInputs.map(entry => entry.value);
            const pickedDirs = dirInputs.filter(entry => entry.input.checked).map(entry => entry.value);

            const config: SyncConfig = {
                version: 1,
                // "everything picked" is stored as "exclude nothing", which keeps the file minimal.
                notebooks: pickedNotebooks.length === notebookIds.length && notebookIds.length > 0
                    ? { mode: "exclude", ids: [] }
                    : { mode: "include", ids: pickedNotebooks },
                dirs: pickedDirs.length === dirPaths.length && dirPaths.length > 0
                    ? { mode: "exclude", paths: [] }
                    : { mode: "include", paths: pickedDirs },
                rules: rulesField.value
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line.includes(":"))
                    .map(line => {
                        const separator = line.indexOf(":");
                        return {
                            path: line.slice(0, separator).trim(),
                            excludeNames: line.slice(separator + 1).split(",").map(name => name.trim()).filter(name => name !== ""),
                        };
                    })
                    .filter(rule => rule.path !== "" && rule.excludeNames.length > 0),
            };

            try {
                await this.plugin.saveData(SYNC_CONFIG_FILE, config);
                this.plugin.syncManager.invalidateSyncConfig();
                status.textContent = this.plugin.i18n.syncScopeSaved;
                consoleLog("Selective sync configuration saved:", config);
            } catch (error) {
                consoleError("Failed to save the selective sync configuration:", error);
                status.textContent = this.plugin.i18n.syncScopeLoadFailed.replace("{{error}}", String(error));
            }
        };

        void (async () => {
            try {
                const config = parseSyncConfig(await this.plugin.loadData(SYNC_CONFIG_FILE));
                let notebooks: { id: string; name: string }[] = [];
                try {
                    const result = await lsNotebooks("");
                    notebooks = result?.notebooks ?? [];
                } catch (error) {
                    consoleWarn("Could not list notebooks for the selection UI:", error);
                }

                renderBoxes(
                    notebookBox,
                    notebooks.map(notebook => ({ value: notebook.id, label: `${notebook.name} (${this.shortId(notebook.id)})` })),
                    id => isNotebookSelected(id, config),
                    notebookInputs
                );
                renderBoxes(
                    dirBox,
                    SYNC_DIR_PATHS.map(path => ({ value: path, label: path })),
                    path => isDirSelected(path, config),
                    dirInputs
                );

                rulesField.value = config.rules.map(rule => `${rule.path}: ${rule.excludeNames.join(", ")}`).join("\n");
            } catch (error) {
                consoleError("Failed to load the selective sync configuration:", error);
                notebookBox.textContent = this.plugin.i18n.syncScopeLoadFailed.replace("{{error}}", String(error));
            }
        })();

        return wrapper;
    }

    /**
     * M4-P6: show the role declaration of this device and of the peer, plus which device
     * owns the direction of the pair.
     */
    private createRoleStatusElement(): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "fn__flex-1";
        wrapper.style.minWidth = "260px";

        const button = document.createElement("button");
        button.className = "b3-button b3-button--outline";
        button.textContent = this.plugin.i18n.roleStatusRefresh;

        const output = document.createElement("div");
        output.className = "b3-label__text";
        output.style.cssText = "font-size:12px;line-height:1.7;margin-top:6px;white-space:pre-wrap;word-break:break-all";

        wrapper.append(button, output);

        button.onclick = async () => {
            button.disabled = true;
            output.textContent = "…";
            try {
                const token = await readLocalApiToken("");
                const localResult = await peerPost("", "/api/file/getFile", { path: ROLE_FILE_PATH }, token?.value, 6000);
                const local = parseRoleDeclaration(localResult.httpStatus === 200 ? localResult.text : null);

                const remoteUrl = (this.settingUtils.take("siyuanUrl") as string) || (this.settingUtils.get("siyuanUrl") as string) || "";
                const remoteKey = (this.settingUtils.take("siyuanAPIKey") as string) || (this.settingUtils.get("siyuanAPIKey") as string) || "";
                const remoteResult = await peerPost(remoteUrl, "/api/file/getFile", { path: ROLE_FILE_PATH }, remoteKey, 8000);
                const remote = parseRoleDeclaration(remoteResult.httpStatus === 200 ? remoteResult.text : null);

                const localId = local?.instanceId ?? "";
                const remoteId = remote?.instanceId ?? "";
                const setting = ((this.settingUtils.take("directionOwner") as string) || "auto") as any;
                const owner = localId && remoteId ? resolveDirectionOwner(localId, remoteId, setting) : "";

                const lines: string[] = [
                    local
                        ? this.plugin.i18n.roleStatusLocal.replace("{{role}}", local.role).replace("{{id}}", this.shortId(localId))
                        : this.plugin.i18n.roleStatusLocalUnknown,
                    remote
                        ? this.plugin.i18n.roleStatusRemote.replace("{{role}}", remote.role).replace("{{id}}", this.shortId(remoteId))
                        : this.plugin.i18n.roleStatusRemoteUnknown,
                ];

                if (owner) {
                    const ownerLabel = owner === localId
                        ? this.plugin.i18n.roleStatusOwnerLocal
                        : `${this.plugin.i18n.roleStatusOwnerRemote} (${this.shortId(owner)})`;
                    lines.push(this.plugin.i18n.roleStatusOwner.replace("{{owner}}", ownerLabel));
                }

                lines.push(this.plugin.i18n.roleStatusAdvice);
                output.textContent = lines.join("\n");
            } catch (error) {
                consoleError("Failed to read the role declarations:", error);
                output.textContent = String(error);
            } finally {
                button.disabled = false;
            }
        };

        return wrapper;
    }

    async setupSettings() {
        let historyRefresh: () => Promise<void> = async () => { };

        const pairingContext: PairingUiContext = {
            i18n: this.plugin.i18n,
            loadData: (file: string) => this.plugin.loadData(file),
            saveData: async (file: string, data: any) => { await this.plugin.saveData(file, data); },
            readSetting: (key: string) => {
                const live = this.settingUtils.take(key);
                if (typeof live === "string" && live.trim() !== "") return live;
                return (this.settingUtils.get(key) ?? "") as string;
            },
            applyPairing: (values: { url: string; token: string }) => this.applyPairing(values),
            runConnectionTest: (output: HTMLElement) => this.runConnectionTest(output),
        };

        const historySection = createHistorySection(pairingContext);
        historyRefresh = () => historySection.refresh();
        const qrSection = () => createQrSection(pairingContext);
        const importSection = () => createImportSection(pairingContext, () => { void historyRefresh(); });

        this.settingUtils.addItem({
            key: "siyuanUrl",
            value: "",
            type: "custom",
            title: this.plugin.i18n.siyuanUrl,
            description: this.plugin.i18n.siyuanUrlDesc,
            createElement: (value: string) => {
                const wrapper = document.createElement("div");
                wrapper.className = "fn__flex-1";
                wrapper.style.minWidth = "260px";

                const input = document.createElement("input");
                input.className = "b3-text-field fn__block";
                input.placeholder = "http://192.168.1.45:6806";
                input.value = value ?? "";

                const status = document.createElement("div");
                status.className = "b3-label__text";
                status.style.cssText = "margin-top:4px;font-size:12px;line-height:1.5;word-break:break-all";

                wrapper.appendChild(input);
                wrapper.appendChild(status);

                // A malformed URL is invisible to the user but makes every request fail
                // with a bare timeout, so it is validated (and repaired) while typing.
                const render = () => {
                    const state = wrapper as any;
                    const text = input.value;
                    if (text.trim() === "") {
                        state.__valid = false;
                        state.__normalizedUrl = undefined;
                        status.style.color = "var(--b3-theme-error)";
                        status.textContent = this.plugin.i18n.siyuanUrlEmpty;
                        return;
                    }

                    const check = checkPeerUrl(text);
                    if (!check.ok) {
                        state.__valid = false;
                        state.__normalizedUrl = undefined;
                        status.style.color = "var(--b3-theme-error)";
                        status.textContent = this.describeUrlProblem(check.problem);
                        return;
                    }                    state.__valid = true;
                    state.__normalizedUrl = check.normalized;
                    status.style.color = "var(--b3-theme-on-surface)";
                    status.textContent = check.fixes
                        ? `${this.plugin.i18n.siyuanUrlAutoFixed.replace("{{url}}", check.normalized)}（${this.describeUrlFixes(check.fixes)}）`
                        : "";
                };

                input.oninput = render;
                input.onchange = async () => {
                    render();
                    const state = wrapper as any;
                    if (!state.__valid) return;
                    const normalized: string = state.__normalizedUrl;
                    if (normalized && normalized !== input.value) input.value = normalized;
                    await this.settingUtils.setAndSave("siyuanUrl", normalized);
                    render();
                    await this.plugin.syncManager.init();
                };
                input.addEventListener("keydown", (event: KeyboardEvent) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        input.blur();
                    }
                });

                (wrapper as any).__render = render;
                render();
                return wrapper;
            },
            getEleVal: (element: HTMLElement) => {
                const state = element as any;
                // Never persist an unusable URL: keep the last good value instead.
                if (state.__valid && state.__normalizedUrl) return state.__normalizedUrl;
                return this.settingUtils.get("siyuanUrl") ?? "";
            },
            setEleVal: (element: HTMLElement, value: any) => {
                const input = element.querySelector("input");
                if (input) input.value = value ?? "";
                const render = (element as any).__render;
                if (typeof render === "function") render();
            }
        });

        this.settingUtils.addItem({
            key: "siyuanAPIKey",
            value: "",
            type: "textinput",
            title: this.plugin.i18n.siyuanAPIKey,
            description: this.plugin.i18n.siyuanAPIKeyDesc,
            action: {
                callback: () => {
                    this.settingUtils.takeAndSave("siyuanAPIKey");
                    this.plugin.syncManager.init();
                }
            }
        });

        this.settingUtils.addItem({
            key: "testConnection",
            value: "",
            type: "custom",
            title: this.plugin.i18n.testConnection,
            description: this.plugin.i18n.testConnectionDesc,
            createElement: () => {
                const wrapper = document.createElement("div");
                wrapper.className = "fn__flex-1";
                wrapper.style.minWidth = "260px";

                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline fn__flex-center";
                button.textContent = this.plugin.i18n.testConnection;

                const output = document.createElement("pre");
                output.style.cssText = "margin:8px 0 0;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--b3-theme-on-surface)";

                wrapper.appendChild(button);
                wrapper.appendChild(output);

                button.onclick = async () => {
                    button.disabled = true;
                    const label = button.textContent;
                    button.textContent = this.plugin.i18n.testConnectionRunning;
                    output.textContent = "";
                    try {
                        await this.runConnectionTest(output);
                    } catch (error) {
                        consoleError("Connection test failed unexpectedly:", error);
                        output.textContent = `✘ ${this.plugin.i18n.testConnectionFailed.replace("{{reason}}", String(error))}`;
                    } finally {
                        button.disabled = false;
                        button.textContent = label;
                    }
                };

                return wrapper;
            },
            getEleVal: () => undefined,
            setEleVal: () => { }
        });

        this.settingUtils.addItem({
            key: "requestTimeoutMs",
            value: DEFAULT_REQUEST_TIMEOUT_MS,
            type: "number",
            title: this.plugin.i18n.requestTimeoutMs,
            description: this.plugin.i18n.requestTimeoutMsDesc
        });

        this.settingUtils.addItem({
            key: "maxConcurrentRequests",
            value: DEFAULT_MAX_CONCURRENT_REQUESTS,
            type: "number",
            title: this.plugin.i18n.maxConcurrentRequests,
            description: this.plugin.i18n.maxConcurrentRequestsDesc
        });

        this.settingUtils.addItem({
            key: "siyuanNickname",
            value: "",
            type: "textinput",
            title: this.plugin.i18n.siyuanNickname,
            description: this.plugin.i18n.siyuanNicknameDesc,
            action: {
                callback: () => {
                    this.settingUtils.takeAndSave("siyuanNickname");
                }
            }
        });

        this.settingUtils.addItem({
            key: "pairingQr",
            value: "",
            type: "custom",
            title: this.plugin.i18n.pairingQrTitle,
            description: this.plugin.i18n.pairingQrDesc,
            createElement: () => qrSection(),
            getEleVal: () => undefined,
            setEleVal: () => { }
        });

        this.settingUtils.addItem({
            key: "pairingImport",
            value: "",
            type: "custom",
            title: this.plugin.i18n.pairingImportTitle,
            description: this.plugin.i18n.pairingImportDesc,
            createElement: () => importSection(),
            getEleVal: () => undefined,
            setEleVal: () => { }
        });

        this.settingUtils.addItem({
            key: "pairingHistory",
            value: "",
            type: "custom",
            title: this.plugin.i18n.pairingHistoryTitle,
            description: this.plugin.i18n.pairingHistoryDesc,
            createElement: () => {
                void historyRefresh();
                return historySection.element;
            },
            getEleVal: () => undefined,
            setEleVal: () => { }
        });

        this.settingUtils.addItem({
            key: "syncRole",
            value: DEFAULT_SYNC_ROLE,
            type: "select",
            title: this.plugin.i18n.syncRoleTitle,
            description: this.plugin.i18n.syncRoleDesc,
            options: {
                host: this.plugin.i18n.syncRoleHost,
                peer: this.plugin.i18n.syncRolePeer,
                manual: this.plugin.i18n.syncRoleManual,
            }
        });

        this.settingUtils.addItem({
            key: "directionOwner",
            value: "auto",
            type: "select",
            title: this.plugin.i18n.directionOwnerTitle,
            description: this.plugin.i18n.directionOwnerDesc,
            options: {
                auto: this.plugin.i18n.directionAuto,
                local: this.plugin.i18n.directionLocal,
                remote: this.plugin.i18n.directionRemote,
            }
        });

        this.settingUtils.addItem({
            key: "roleStatus",
            value: "",
            type: "custom",
            title: this.plugin.i18n.roleStatusTitle,
            description: this.plugin.i18n.roleStatusDesc,
            createElement: () => this.createRoleStatusElement(),
            getEleVal: () => undefined,
            setEleVal: () => { }
        });

        this.settingUtils.addItem({
            key: "syncScope",
            value: "",
            type: "custom",
            title: this.plugin.i18n.syncScopeTitle,
            description: this.plugin.i18n.syncScopeDesc,
            createElement: () => this.createSelectionElement(),
            getEleVal: () => undefined,
            setEleVal: () => { }
        });

        this.settingUtils.addItem({
            key: "syncOnOpen",
            value: true,
            type: "checkbox",
            title: this.plugin.i18n.syncOnOpen,
            description: this.plugin.i18n.syncOnOpenDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("syncOnOpen");
                    this.settingUtils.set("syncOnOpen", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "syncOnClose",
            value: true,
            type: "checkbox",
            title: this.plugin.i18n.syncOnClose,
            description: this.plugin.i18n.syncOnCloseDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("syncOnClose");
                    this.settingUtils.set("syncOnClose", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "instantSync",
            value: false,
            type: "checkbox",
            title: this.plugin.i18n.instantSync,
            description: this.plugin.i18n.instantSyncDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("instantSync");
                    this.settingUtils.set("instantSync", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "transactionsDebounceTime",
            value: 5000,
            type: "number",
            title: this.plugin.i18n.transactionsDebounceTime,
            description: this.plugin.i18n.transactionsDebounceTimeDesc
        });

        this.settingUtils.addItem({
            key: "trackConflicts",
            value: true,
            type: "checkbox",
            title: this.plugin.i18n.trackConflicts,
            description: this.plugin.i18n.trackConflictsDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("trackConflicts");
                    this.settingUtils.set("trackConflicts", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "createDataSnapshots",
            value: false,
            type: "checkbox",
            title: this.plugin.i18n.createDataSnapshots,
            description: this.plugin.i18n.createDataSnapshotsDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("createDataSnapshots");
                    this.settingUtils.set("createDataSnapshots", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "minHoursBetweenSnapshots",
            value: 24,
            type: "number",
            title: this.plugin.i18n.minHoursBetweenSnapshots,
            description: this.plugin.i18n.minHoursBetweenSnapshotsDesc
        });

        this.settingUtils.addItem({
            key: "snapshotHint",
            value: "",
            type: "hint",
            title: this.plugin.i18n.snapshotHintTitle,
            description: this.plugin.i18n.snapshotHintDesc,
            // Pure text block: keep it out of the saved config instead of writing `null`.
            getEleVal: () => undefined,
            setEleVal: () => { }
        });

        this.settingUtils.addItem({
            key: "syncIconInBreadcrumb",
            value: false,
            type: "checkbox",
            title: this.plugin.i18n.syncIconInBreadcrumb,
            description: this.plugin.i18n.syncIconInBreadcrumbDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("syncIconInBreadcrumb");
                    this.settingUtils.set("syncIconInBreadcrumb", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "replaceSyncButton",
            value: false,
            type: "checkbox",
            title: this.plugin.i18n.replaceSyncButton,
            description: this.plugin.i18n.replaceSyncButtonDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("replaceSyncButton");
                    this.settingUtils.set("replaceSyncButton", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "useExperimentalWebSocket",
            value: false,
            type: "checkbox",
            title: this.plugin.i18n.useExperimentalWebSocket,
            description: this.plugin.i18n.useExperimentalWebSocketDesc,
            action: {
                callback: () => {
                    let value = !this.settingUtils.get("useExperimentalWebSocket");
                    this.settingUtils.set("useExperimentalWebSocket", value);
                }
            }
        });

        this.settingUtils.addItem({
            key: "getLastSyncLog",
            value: "",
            type: "button",
            title: this.plugin.i18n.getLastSyncLog,
            description: this.plugin.i18n.getLastSyncLogDesc,
            button: {
                label: this.plugin.i18n.copyToAssetsFolder,
                callback: async () => {
                    const path = await this.plugin.syncManager.getNewestSyncLogAsAsset();
                    if (path)
                        showMessage(this.plugin.i18n.lastSyncMessageCopied.replace("{{name}}", path.split("/").pop()));
                }
            }
        });

        try {
            await this.settingUtils.load();
        } catch (error) {
            consoleError("Error loading settings storage, probably empty config json:", error);
        }

        this.applyRequestSettings();
    }

    async onLayoutReady() {
        await this.settingUtils.load();
        this.applyRequestSettings();
    }

    /**
     * Run the connectivity check against the values currently typed in the settings
     * dialog and print a step by step report.
     */
    private async runConnectionTest(output: HTMLElement) {
        const rawUrl = (this.settingUtils.take("siyuanUrl") ?? this.settingUtils.get("siyuanUrl") ?? "") as string;
        const token = (this.settingUtils.take("siyuanAPIKey") ?? this.settingUtils.get("siyuanAPIKey") ?? "") as string;

        const check = checkPeerUrl(rawUrl);
        if (!check.ok) {
            output.textContent = `✘ ${this.plugin.i18n.testConnectionFailed.replace("{{reason}}", this.describeUrlProblem(check.problem))}`;
            return;
        }

        consoleLog(`Testing connection to ${check.normalized} (timeout ${getRequestTimeoutMs()}ms)...`);
        const report = await testPeerConnection(check.normalized, token, getRequestTimeoutMs());
        const local = await probeLocalKernel("", 5000);
        this.renderConnectionReport(output, report, local);
    }

    private renderConnectionReport(output: HTMLElement, report: PeerConnReport, local: LocalProbe) {
        const labels: Record<ConnStepKey, string> = {
            version: this.plugin.i18n.connectionStepVersion,
            notebooks: this.plugin.i18n.connectionStepNotebooks,
            readDir: this.plugin.i18n.connectionStepReadDir,
            instanceId: this.plugin.i18n.connectionStepInstanceId,
            repo: this.plugin.i18n.connectionStepRepo,
            clock: this.plugin.i18n.connectionStepClock,
        };

        const lines: string[] = [report.url];

        for (const step of report.steps) {
            const details = [`${(step.elapsedMs / 1000).toFixed(2)}s`];
            if (step.httpStatus !== null) details.push(`HTTP ${step.httpStatus}`);
            if (step.code !== null) details.push(`code ${step.code}`);
            if (step.detail) details.push(step.detail);
            lines.push(`${step.ok ? "✔" : "✘"} ${labels[step.key]} — ${details.join(" · ")}`);
        }

        if (report.instanceId) lines.push(`· ${this.plugin.i18n.connectionPeerId}${report.instanceId}`);
        if (report.repoReady && typeof report.snapshotCount === "number")
            lines.push(`· ${this.plugin.i18n.connPeerRepoReady.replace("{{count}}", String(report.snapshotCount))}`);
        if (typeof report.clockDriftMs === "number")
            lines.push(`· ${this.plugin.i18n.connectionClockDrift}${(report.clockDriftMs / 1000).toFixed(1)}s`);

        lines.push("");
        if (report.ok) {
            lines.push(`✔ ${this.plugin.i18n.testConnectionOk.replace("{{version}}", report.kernelVersion ?? "?")}`);
            if (report.slowStart)
                lines.push(`⚠ ${this.plugin.i18n.connectionSlowStart.replace("{{seconds}}", (report.steps[0].elapsedMs / 1000).toFixed(1))}`);
        } else {
            lines.push(`✘ ${this.plugin.i18n.testConnectionFailed.replace("{{reason}}", this.describeConnectionFailure(report))}`);
        }

        if (report.repoReady === false) lines.push(`⚠ ${this.plugin.i18n.connPeerRepoNotReady}`);

        lines.push("", this.plugin.i18n.connectionLocalHeader);
        if (local.kernelVersion) lines.push(`· ${this.plugin.i18n.connectionLocalKernel}${local.kernelVersion}`);
        if (local.token) {
            const source = local.token.source === "frontend"
                ? this.plugin.i18n.connectionLocalTokenSourceFrontend
                : this.plugin.i18n.connectionLocalTokenSourceConf;
            lines.push(`· ${this.plugin.i18n.connectionLocalTokenSource}${source}`);
            lines.push(local.tokenAccepted
                ? `✔ ${this.plugin.i18n.connectionLocalTokenOk}`
                : `✘ ${this.plugin.i18n.connectionLocalTokenFailed.replace("{{status}}", String(local.tokenHttpStatus ?? "?"))}`);
            if (!local.tokenAccepted) lines.push(`⚠ ${this.plugin.i18n.connectionLocalTokenHint}`);
        } else {
            lines.push(`⚠ ${this.plugin.i18n.connectionLocalTokenMissing}`);
        }

        output.textContent = lines.join("\n");
    }

    /** Turn a failed report into an actionable sentence. */
    private describeConnectionFailure(report: PeerConnReport): string {
        const failed = report.steps.find(step => step.key === report.failedStep);
        const detail = failed?.detail ?? "";

        switch (report.failure) {
            case "timeout":
                return this.plugin.i18n.connReasonTimeout;
            case "unreachable":
                return this.plugin.i18n.connReasonUnreachable;
            case "unauthorized":
                return this.plugin.i18n.connReasonUnauthorized;
            case "businessError":
                return this.plugin.i18n.connReasonBusiness.replace("{{detail}}", detail);
            default:
                return this.plugin.i18n.connReasonUnexpected;
        }
    }

    /** Explain why the typed URL cannot be used. */
    private describeUrlProblem(problem: PeerUrlProblem): string {
        switch (problem.kind) {
            case "empty":
                return this.plugin.i18n.siyuanUrlEmpty;
            case "unknownScheme":
                return this.plugin.i18n.siyuanUrlBadScheme.replace("{{scheme}}", problem.scheme);
            case "badHost":
                return this.plugin.i18n.siyuanUrlBadHost.replace("{{host}}", problem.host);
            case "badPort":
                return this.plugin.i18n.siyuanUrlBadPort.replace("{{port}}", problem.port);
        }
    }

    /** List the automatic corrections applied to the typed URL. */
    private describeUrlFixes(fixes: PeerUrlFix[]): string {
        return fixes.map(fix => {
            switch (fix.kind) {
                case "addedScheme":
                    return this.plugin.i18n.siyuanUrlFixAddedScheme;
                case "fixedScheme":
                    return this.plugin.i18n.siyuanUrlFixScheme.replace("{{from}}", fix.from).replace("{{to}}", fix.to);
                case "fixedPortSeparator":
                    return this.plugin.i18n.siyuanUrlFixSeparator;
                case "addedDefaultPort":
                    return this.plugin.i18n.siyuanUrlFixPort.replace("{{port}}", fix.port);
                case "strippedTrailingSlash":
                    return this.plugin.i18n.siyuanUrlFixSlash;
            }
        }).join(this.plugin.i18n.siyuanUrlFixSeparator2 ?? " / ");
    }

    getPref = (key: string) => {
        return this.settingUtils.get(key);
    }
}
