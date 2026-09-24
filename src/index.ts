import { Plugin, showMessage } from "siyuan";
import "@/index.scss";
import { SettingsManager } from "./settings";
import { SyncManager } from "@/sync";
import { cloudSyncSuccIcon } from "@/assets";
import { SyncStatus } from "@/types/sync-status";
import { SyncProgress } from "@/types/progress";
import { consoleError } from "@/logging";
import { isTransferPaused, pauseTransfers, resumeTransfers, cancelTransfers, isTransferCancelled } from "@/libs/concurrency";

export default class BetterSyncPlugin extends Plugin {
    settingsManager: SettingsManager;
    syncManager: SyncManager;

    private progressPanel: HTMLElement;
    private progressHideTimer: number;
    private progressFrame: number;
    private progressCollapsed = false;
    private progressClosed = false;
    private progressDrag: { pointerId: number; offsetX: number; offsetY: number } | null = null;
    private progressFlashTimer: number;

    async onload() {
        this.settingsManager = new SettingsManager(this);
        await this.settingsManager.setupSettings();
        this.syncManager = new SyncManager(this);
        await this.setupProgressPanel();

        this.addTopBar({
            icon: "iconCloudSucc",
            title: this.i18n.cloudIconDesc,
            position: "right",
            callback: async () => { this.syncManager.syncHandler(); },
        });

        this.addCommand({
            langKey: "togglePauseSync",
            callback: () => { this.togglePauseTransfers(); },
        });

        this.eventBus.on("switch-protyle", async ({ detail }) => {
            this.syncManager.setActiveProtyle(detail.protyle.getInstance());
        });

        this.eventBus.on("loaded-protyle-dynamic", async ({ detail }) => {
            this.setupButtonBreadcrumb();
            this.syncManager.insertProtyle(detail.protyle.getInstance());
        });

        this.eventBus.on("loaded-protyle-static", async ({ detail }) => {
            this.setupButtonBreadcrumb();
            this.syncManager.insertProtyle(detail.protyle.getInstance());
        });

        this.eventBus.on("destroy-protyle", async ({ detail }) => {
            this.syncManager.removeProtyle(detail.protyle.getInstance());
        });

        this.syncManager.onSyncStatusChange((status: SyncStatus) => {
            this.updateButtonIcon(status);
        });

        this.addCommand({
            langKey: "startSync",
            hotkey: "⌘S",
            callback: async () => {
                await this.syncManager.syncHandler();
            },
            fileTreeCallback: async (_: any) => {
                await this.syncManager.syncHandler();
            },
            editorCallback: async (_: any) => {
                await this.syncManager.syncHandler();
            },
            dockCallback: async (_: HTMLElement) => {
                await this.syncManager.syncHandler();
            },
        });
    }

    /**
     * Floating panel that shows what a running sync is doing.
     * Without it a long sync (or a hung one) looks exactly the same.
     * The panel can be dragged (by its header), collapsed and closed; the position and
     * the collapsed state are remembered in `ui-state.json`.
     */
    private async setupProgressPanel() {
        const state = await this.loadUiState();
        this.progressCollapsed = state.progressCollapsed === true;

        const panel = document.createElement("div");
        panel.className = "better-sync-progress";
        panel.style.cssText = [
            "position:fixed",
            "z-index:80",
            "display:none",
            "min-width:260px",
            "max-width:min(420px, calc(100vw - 32px))",
            "padding:6px 10px 10px",
            "border-radius:8px",
            "border:1px solid var(--b3-border-color)",
            "background:var(--b3-theme-surface)",
            "color:var(--b3-theme-on-surface)",
            "box-shadow:0 2px 12px rgba(0, 0, 0, .18)",
            "font-size:12px",
            "line-height:1.6",
            "pointer-events:none",
        ].join(";");

        const savedX = typeof state.progressX === "number" ? state.progressX : null;
        const savedY = typeof state.progressY === "number" ? state.progressY : null;
        if (savedX !== null && savedY !== null) {
            panel.style.left = `${savedX}px`;
            panel.style.top = `${savedY}px`;
        } else {
            panel.style.right = "16px";
            panel.style.bottom = "16px";
        }

        panel.innerHTML = `
            <div data-role="head" style="display:flex;align-items:center;gap:4px;pointer-events:auto;cursor:move">
                <div data-role="title" style="flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
                <span data-role="pause" role="button" style="padding:0 5px;cursor:pointer;opacity:.7;display:none">⏸</span>
                <span data-role="cancel" role="button" style="padding:0 5px;cursor:pointer;opacity:.7;display:none">⏹</span>
                <span data-role="collapse" role="button" style="padding:0 5px;cursor:pointer;opacity:.7">−</span>
                <span data-role="close" role="button" style="padding:0 5px;cursor:pointer;opacity:.7">✕</span>
            </div>
            <div data-role="body">
                <div style="height:4px;margin:6px 0;border-radius:2px;background:var(--b3-border-color);overflow:hidden">
                    <div data-role="fill" style="height:100%;width:0;background:var(--b3-theme-primary);transition:width .2s linear"></div>
                </div>
                <div data-role="detail"></div>
                <div data-role="note" style="margin-top:4px;opacity:.75;word-break:break-all"></div>
            </div>`;
        document.body.appendChild(panel);
        this.progressPanel = panel;

        const head = panel.querySelector('[data-role="head"]') as HTMLElement;
        const body = panel.querySelector('[data-role="body"]') as HTMLElement;
        const collapseButton = panel.querySelector('[data-role="collapse"]') as HTMLElement;
        const closeButton = panel.querySelector('[data-role="close"]') as HTMLElement;

        const applyCollapsed = () => {
            body.style.display = this.progressCollapsed ? "none" : "block";
            collapseButton.textContent = this.progressCollapsed ? "+" : "−";
        };
        applyCollapsed();

        collapseButton.addEventListener("pointerdown", event => event.stopPropagation());
        collapseButton.addEventListener("click", () => {
            this.progressCollapsed = !this.progressCollapsed;
            applyCollapsed();
            this.saveUiState({ progressCollapsed: this.progressCollapsed });
        });

        closeButton.addEventListener("pointerdown", event => event.stopPropagation());
        closeButton.addEventListener("click", () => {
            this.progressClosed = true;
            panel.style.display = "none";
        });

        const pauseButton = panel.querySelector('[data-role="pause"]') as HTMLElement;
        pauseButton.addEventListener("pointerdown", event => event.stopPropagation());
        pauseButton.addEventListener("click", () => this.togglePauseTransfers());

        const cancelButton = panel.querySelector('[data-role="cancel"]') as HTMLElement;
        cancelButton.title = this.i18n.progressCancel;
        cancelButton.addEventListener("pointerdown", event => event.stopPropagation());
        cancelButton.addEventListener("click", () => this.cancelRunningSync());

        // Drag by the header; the panel ignores pointer events everywhere else.
        head.addEventListener("pointerdown", (event: PointerEvent) => {
            if ((event.target as HTMLElement).closest('[role="button"]')) return;
            const rect = panel.getBoundingClientRect();
            this.progressDrag = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
            };
            head.setPointerCapture(event.pointerId);
        });
        head.addEventListener("pointermove", (event: PointerEvent) => {
            const drag = this.progressDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const x = Math.max(0, Math.min(window.innerWidth - 60, event.clientX - drag.offsetX));
            const y = Math.max(0, Math.min(window.innerHeight - 24, event.clientY - drag.offsetY));
            panel.style.left = `${x}px`;
            panel.style.top = `${y}px`;
            panel.style.right = "auto";
            panel.style.bottom = "auto";
        });
        head.addEventListener("pointerup", (event: PointerEvent) => {
            if (!this.progressDrag || this.progressDrag.pointerId !== event.pointerId) return;
            this.progressDrag = null;
            const rect = panel.getBoundingClientRect();
            this.saveUiState({ progressX: Math.round(rect.left), progressY: Math.round(rect.top) });
        });

        this.syncManager.onProgressChange(progress => {
            if (this.progressFrame) window.cancelAnimationFrame(this.progressFrame);
            this.progressFrame = window.requestAnimationFrame(() => this.paintProgress(progress));
        });
    }

    /** Stop the running transfer early ("cancel"), keeping everything already transferred. */
    private cancelRunningSync() {
        if (!this.isSyncControllable(this.syncManager.getProgress()) || isTransferCancelled()) return;

        cancelTransfers();
        if (isTransferPaused()) resumeTransfers();
        showMessage(this.i18n.progressCancelling, 4000, "info");
        this.paintProgress(this.syncManager.getProgress());
    }

    private isSyncRunning(): boolean {
        const phase = this.syncManager.getProgress().phase;
        return phase === "preparing" || phase === "scanning" || phase === "transferring" || phase === "finalizing";
    }

    /**
     * A sync request that was dropped because another sync is already running: make it
     * visible (toast + highlight the progress panel) instead of failing silently.
     */
    notifySyncAlreadyRunning(progress: SyncProgress) {
        this.progressClosed = false;

        const panel = this.progressPanel;
        if (panel) {
            panel.style.display = "block";
            panel.style.outline = "2px solid var(--b3-theme-primary)";
            panel.style.outlineOffset = "2px";
            window.clearTimeout(this.progressFlashTimer);
            this.progressFlashTimer = window.setTimeout(() => { panel.style.outline = "none"; }, 2500);
        }

        const files = progress.total > 0
            ? ` · ${this.i18n.progressFiles.replace("{{done}}", String(progress.done)).replace("{{total}}", String(progress.total))}`
            : "";

        showMessage(this.i18n.syncAlreadyRunning.replace("{{progress}}", files), 7000, "info");
        this.paintProgress(progress);
    }

    /**
     * A sync that was refused by the role/direction handshake (M4): explain which device
     * should be syncing instead, so the user can fix the configuration.
     */
    notifySyncRefused(message: string) {
        const panel = this.progressPanel;
        if (panel) {
            panel.style.display = "block";
            panel.style.outline = "2px solid var(--b3-theme-error)";
            panel.style.outlineOffset = "2px";
            window.clearTimeout(this.progressFlashTimer);
            this.progressFlashTimer = window.setTimeout(() => { panel.style.outline = "none"; }, 3000);
        }

        showMessage(message, 12000, "error");
    }

    /** Pause/resume the running transfer. Only meaningful while a sync is running. */
    private togglePauseTransfers() {
        if (isTransferCancelled()) {
            showMessage(this.i18n.progressPauseUnavailable, 3000, "info");
            return;
        }

        const running = this.isSyncRunning();
        if (!running && !isTransferPaused()) return;

        if (isTransferPaused()) {
            resumeTransfers();
            showMessage(this.i18n.progressResumed, 3000, "info");
        } else {
            pauseTransfers();
            showMessage(this.i18n.progressPaused, 4000, "info");
        }
        this.paintProgress(this.syncManager.getProgress());
    }

    /**
     * Pause/cancel only make sense while data is still being moved. During the
     * "finalizing" phase (file tree/protyle refresh + history) there is nothing left to
     * stop — offering the buttons there is what made "cancel then still pause" possible.
     */
    private isSyncControllable(progress: SyncProgress): boolean {
        return progress.phase === "preparing"
            || progress.phase === "scanning"
            || progress.phase === "transferring";
    }

    private updatePanelButtons(progress: SyncProgress) {
        const panel = this.progressPanel;
        if (!panel) return;

        const controllable = this.isSyncControllable(progress);
        const cancelled = isTransferCancelled();

        const pauseButton = panel.querySelector('[data-role="pause"]') as HTMLElement;
        if (pauseButton) {
            // Hidden as soon as a cancel is requested: pausing a cancelling sync is nonsense.
            pauseButton.style.display = controllable && !cancelled ? "" : "none";
            const paused = isTransferPaused();
            pauseButton.textContent = paused ? "▶" : "⏸";
            pauseButton.title = paused ? this.i18n.progressResume : this.i18n.progressPause;
        }

        const cancelButton = panel.querySelector('[data-role="cancel"]') as HTMLElement;
        if (cancelButton) {
            cancelButton.style.display = controllable && !cancelled ? "" : "none";
            cancelButton.title = this.i18n.progressCancel;
        }
    }

    private async loadUiState(): Promise<any> {
        try {
            return (await this.loadData("ui-state.json")) ?? {};
        } catch (error) {
            consoleError("Failed to load ui-state.json:", error);
            return {};
        }
    }

    private async saveUiState(patch: Record<string, any>) {
        try {
            await this.saveData("ui-state.json", { ...(await this.loadUiState()), ...patch });
        } catch (error) {
            consoleError("Failed to save ui-state.json:", error);
        }
    }

    private paintProgress(progress: SyncProgress) {
        const panel = this.progressPanel;
        if (!panel) return;

        if (progress.phase === "idle") {
            panel.style.display = "none";
            return;
        }

        // A new sync re-opens a panel the user closed.
        if (progress.phase === "preparing") this.progressClosed = false;

        const title = panel.querySelector('[data-role="title"]') as HTMLElement;
        const fill = panel.querySelector('[data-role="fill"]') as HTMLElement;
        const detail = panel.querySelector('[data-role="detail"]') as HTMLElement;
        const note = panel.querySelector('[data-role="note"]') as HTMLElement;

        const phaseLabels: Record<string, string> = {
            preparing: this.i18n.progressPhasePreparing,
            scanning: this.i18n.progressPhaseScanning,
            transferring: this.i18n.progressPhaseTransferring,
            finalizing: this.i18n.progressPhaseFinalizing,
        };

        window.clearTimeout(this.progressHideTimer);

        // Nothing was transferred: the toast already explains the failure, so do not pop
        // up a panel for it (a lock conflict or a dead peer produces no progress at all).
        // Nothing was transferred: the toast already explains the failure, so do not pop
        // up a panel for it (a lock conflict or a dead peer produces no progress at all).
        // A *cancel* is deliberate, so it always shows the panel with the interrupt note.
        const failedWithoutWork = progress.phase === "failed" && (progress.total === 0 || progress.done === 0);
        if (failedWithoutWork || this.progressClosed) {
            panel.style.display = "none";
            return;
        }

        panel.style.display = "block";

        // A leftover pause must never wedge a later sync.
        if ((progress.phase === "done" || progress.phase === "failed" || progress.phase === "cancelled") && isTransferPaused())
            resumeTransfers();
        this.updatePanelButtons(progress);

        const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
        fill.style.width = `${progress.phase === "done" ? 100 : percent}%`;
        fill.style.background = progress.phase === "failed" ? "var(--b3-theme-error)" : "var(--b3-theme-primary)";

        switch (progress.phase) {
            case "done":
                title.textContent = this.i18n.progressTitleDone;
                detail.textContent = progress.total > 0
                    ? this.i18n.progressFiles.replace("{{done}}", String(progress.done)).replace("{{total}}", String(progress.total))
                    : "";
                note.textContent = "";
                this.progressHideTimer = window.setTimeout(() => this.paintProgress({ ...progress, phase: "idle" }), 4000);
                break;
            case "failed":
                title.textContent = this.i18n.progressTitleFailed;
                detail.textContent = `${this.i18n.progressFiles.replace("{{done}}", String(progress.done)).replace("{{total}}", String(progress.total))}`;
                note.textContent = this.i18n.syncInterruptNote;
                this.progressHideTimer = window.setTimeout(() => this.paintProgress({ ...progress, phase: "idle" }), 20000);
                break;
            case "cancelled":
                title.textContent = this.i18n.progressTitleCancelled;
                detail.textContent = progress.total > 0
                    ? this.i18n.progressFiles.replace("{{done}}", String(progress.done)).replace("{{total}}", String(progress.total))
                    : "";
                note.textContent = this.i18n.syncCancelledNote;
                this.progressHideTimer = window.setTimeout(() => this.paintProgress({ ...progress, phase: "idle" }), 15000);
                break;
            default:
                if (isTransferCancelled()) {
                    title.textContent = this.i18n.progressTitleCancelling;
                    detail.textContent = progress.total > 0
                        ? `${this.i18n.progressTargets.replace("{{done}}", String(progress.targetsStarted)).replace("{{total}}", String(progress.targetTotal))} · ${this.i18n.progressFiles.replace("{{done}}", String(progress.done)).replace("{{total}}", String(progress.total))}`
                        : "";
                    note.textContent = this.i18n.progressCancellingNote;
                    break;
                }
                if (isTransferPaused()) {
                    title.textContent = this.i18n.progressTitlePaused;
                    detail.textContent = progress.total > 0
                        ? `${this.i18n.progressTargets.replace("{{done}}", String(progress.targetsStarted)).replace("{{total}}", String(progress.targetTotal))} · ${this.i18n.progressFiles.replace("{{done}}", String(progress.done)).replace("{{total}}", String(progress.total))}`
                        : "";
                    note.textContent = this.i18n.progressPausedNote;
                    break;
                }
                title.textContent = this.i18n.progressTitleRunning.replace("{{phase}}", phaseLabels[progress.phase] ?? progress.phase);
                detail.textContent = progress.total > 0
                    ? `${this.i18n.progressTargets.replace("{{done}}", String(progress.targetsStarted)).replace("{{total}}", String(progress.targetTotal))} · ${this.i18n.progressFiles.replace("{{done}}", String(progress.done)).replace("{{total}}", String(progress.total))}`
                    : this.i18n.progressPreparing;
                note.textContent = progress.currentFile ?? "";
                break;
        }
    }

    private addButtonBreadcrumb() {        const elements = document.querySelectorAll(".protyle-breadcrumb");
        if (elements.length === 0) return;

        elements.forEach(e => {
            if (e.querySelector(".better-sync-button")) return;

            const referenceElement = e.querySelector('[data-type="readonly"]');
            if (!referenceElement) return;

            const button = document.createElement("button");
            button.className = "block__icon fn__flex-center ariaLabel better-sync-button";
            button.setAttribute("aria-label", this.i18n.cloudIconDesc);
            button.innerHTML = `<svg><use xlink:href="#iconCloudSucc"></use></svg>`;
            button.onclick = async () => {
                await this.syncManager.syncHandler(false);
            };

            referenceElement.before(button);
        });

        this.updateButtonIcon(this.syncManager.getSyncStatus());
    }

    private replaceToolbarButton() {
        if (document.querySelector(".toolbar__item.better-sync-button"))
            return;

        const element = document.querySelector("#barSync");
        if (!element) return;

        const button = document.createElement("button");
        button.className = "ariaLabel toolbar__item better-sync-button";
        button.id = "barBetterSync";
        button.setAttribute("aria-label", this.i18n.cloudIconDesc);
        button.innerHTML = `<svg><use xlink:href="#iconCloudSucc"></use></svg>`;

        button.onclick = async () => {
            await this.syncManager.syncHandler();
        };

        //element.replaceWith(button);
        let htmlElement = element as HTMLElement;
        htmlElement.style.display = 'none';

        element.parentElement.insertBefore(button, element);

        this.updateButtonIcon(this.syncManager.getSyncStatus());
    }

    private replaceMobileMenuEntry() {
        const element = document.querySelector("#menuSyncNow");
        if (!element) return;

        const menuItem = document.createElement("div");
        menuItem.className = "b3-menu__item better-sync-button";
        menuItem.id = "menuBetterSyncNow";
        menuItem.innerHTML = `<svg class="b3-menu__icon"><use xlink:href="#iconCloudSucc"></use></svg><span class="b3-menu__label">${this.i18n.cloudIconDesc}</span>`;

        menuItem.onclick = async () => {
            await this.syncManager.syncHandler();
        };

        element.replaceWith(menuItem);

        this.updateButtonIcon(this.syncManager.getSyncStatus());
        return true;
    }

    private async updateButtonIcon(status: SyncStatus) {
        const elements = document.querySelectorAll(".better-sync-button");
        if (elements.length === 0) return;

        const lastSyncTime = await this.syncManager.getLastLocalSyncTime() * 1000;
        const lastSyncTimeString = "\n" + this.i18n.lastSyncTime.replace(
            "{{lastSyncTime}}",
            new Date(lastSyncTime).toLocaleString()
        );

        elements.forEach(async e => {
            const svg = e.querySelector("svg");
            if (!svg) return;

            // Get the label element if it exists (for menu items)
            const label = e.querySelector(".b3-menu__label");

            switch (status) {
                case SyncStatus.InProgress:
                    svg.classList.add("fn__rotate");
                    svg.innerHTML = `<use xlink:href="#iconRefresh"></use>`;
                    e.setAttribute("aria-label", this.i18n.syncInProgress);
                    if (label) label.textContent = this.i18n.syncInProgress;
                    break;
                case SyncStatus.Done:
                    svg.classList.remove("fn__rotate");
                    svg.innerHTML = cloudSyncSuccIcon;
                    e.setAttribute("aria-label", this.i18n.syncDone + lastSyncTimeString);
                    if (label) label.textContent = this.i18n.syncDone + lastSyncTimeString;
                    break;
                case SyncStatus.DoneWithConflict:
                    svg.classList.remove("fn__rotate");
                    svg.innerHTML = cloudSyncSuccIcon;
                    e.setAttribute("aria-label", this.i18n.syncDoneWithConflict + lastSyncTimeString);
                    if (label) label.textContent = this.i18n.syncDoneWithConflict + lastSyncTimeString;
                    break;
                case SyncStatus.Failed:
                    svg.classList.remove("fn__rotate");
                    svg.innerHTML = `<use xlink:href="#iconCloudError"></use>`;
                    e.setAttribute("aria-label", this.i18n.syncFailed + lastSyncTimeString);
                    if (label) label.textContent = this.i18n.syncFailed + lastSyncTimeString;
                    break;
                case SyncStatus.None:
                default:
                    svg.classList.remove("fn__rotate");
                    svg.innerHTML = `<svg><use xlink:href="#iconCloudSucc"></use></svg>`;
                    e.setAttribute("aria-label", this.i18n.cloudIconDesc + lastSyncTimeString);
                    if (label) label.textContent = this.i18n.cloudIconDesc + lastSyncTimeString;
                    break;
            }
        });
    }

    private setupButtonBreadcrumb() {
        const syncIconInBreadcrumb = this.settingsManager.getPref("syncIconInBreadcrumb") as Boolean;
        syncIconInBreadcrumb ? this.addButtonBreadcrumb() : this.removeButtonBreadcrumb();
    }

    public removeButtonBreadcrumb() {
        const elements = document.querySelectorAll(".protyle-breadcrumb .better-sync-button");
        elements.forEach(e => e.remove());
    }

    onLayoutReady() {
        const syncOnOpen = this.settingsManager.getPref("syncOnOpen") as boolean;
        const syncIconInBreadcrumb = this.settingsManager.getPref("syncIconInBreadcrumb") as boolean;
        const replaceSyncButton = this.settingsManager.getPref("replaceSyncButton") as boolean;

        if (replaceSyncButton) {
            this.replaceToolbarButton();
            this.replaceMobileMenuEntry();
        }

        if (syncOnOpen) this.syncManager.syncHandler(!syncIconInBreadcrumb, undefined, "auto");
    }

    async onunload() {}

    uninstall() {}
}
