import { SyncTarget } from "@/sync/sync-targets";

/**
 * M5: selective sync.
 *
 * The whole model is "what is compared and transferred", never "what is deleted":
 * an unchecked notebook/dir is simply not visited, so neither side loses data.
 * The default (no selection at all) is "exclude nothing" = the old behaviour.
 */

export const SYNC_CONFIG_FILE = "sync-config.json";

export type SelectionMode = "include" | "exclude";

export interface SyncConfig {
    version: 1;
    notebooks: { mode: SelectionMode; ids: string[] };
    dirs: { mode: SelectionMode; paths: string[] };
    rules: { path: string; excludeNames: string[] }[];
}

export function defaultSyncConfig(): SyncConfig {
    return {
        version: 1,
        // "exclude nothing" is the same as "everything selected" and stays readable.
        notebooks: { mode: "exclude", ids: [] },
        dirs: { mode: "exclude", paths: [] },
        rules: [],
    };
}

export function parseSyncConfig(raw: unknown): SyncConfig {
    const config = defaultSyncConfig();
    if (!raw || typeof raw !== "object") return config;

    const source = raw as Partial<SyncConfig>;

    if (source.notebooks && typeof source.notebooks === "object") {
        config.notebooks = {
            mode: source.notebooks.mode === "include" ? "include" : "exclude",
            ids: toStringArray(source.notebooks.ids).map(normalizePath),
        };
    }

    if (source.dirs && typeof source.dirs === "object") {
        config.dirs = {
            mode: source.dirs.mode === "include" ? "include" : "exclude",
            paths: toStringArray(source.dirs.paths).map(normalizePath),
        };
    }

    if (Array.isArray(source.rules)) {
        config.rules = source.rules
            .filter(rule => rule && typeof rule.path === "string")
            .map(rule => ({
                path: normalizePath(rule.path),
                excludeNames: toStringArray(rule.excludeNames),
            }))
            .filter(rule => rule.excludeNames.length > 0);
    }

    return config;
}

function toStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter(entry => typeof entry === "string" && entry.trim() !== "").map(entry => entry.trim()) : [];
}

export function normalizePath(path: string): string {
    return (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/+/, "");
}

/** Escape everything, then translate the wildcards: `**` = any depth, `*` = within a name. */
export function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const body = escaped
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${body}$`);
}

/** Exact name when the pattern has no wildcard (keeps the old `excludedItems.includes` behaviour). */
export function matchesGlob(name: string, pattern: string): boolean {
    if (!pattern) return false;
    if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;
    return globToRegExp(pattern).test(name);
}

export function isNotebookSelected(notebookId: string, config: SyncConfig): boolean {
    const { mode, ids } = config.notebooks;
    const listed = ids.includes(notebookId);
    return mode === "include" ? listed : !listed;
}

export function isDirSelected(dirPath: string, config: SyncConfig): boolean {
    const path = normalizePath(dirPath);
    const { mode, paths } = config.dirs;
    // A listed parent covers its children, so `data/storage` also selects `data/storage/av`.
    const listed = paths.some(entry => path === entry || path.startsWith(`${entry}/`));
    return mode === "include" ? listed : !listed;
}

/** Extra name patterns configured for a directory (its own rules and any ancestor's). */
export function excludeNamesFor(dirPath: string, config: SyncConfig): string[] {
    const path = normalizePath(dirPath);
    return config.rules
        .filter(rule => path === rule.path || path.startsWith(`${rule.path}/`))
        .flatMap(rule => rule.excludeNames);
}

export function isNameExcluded(name: string, dirPath: string, config: SyncConfig, baseExcluded: string[] = []): boolean {
    return [...baseExcluded, ...excludeNamesFor(dirPath, config)].some(pattern => matchesGlob(name, pattern));
}

/**
 * Drop the targets the user deselected and merge the per-directory rules into each
 * target's `excludedItems`, so the existing recursion filters them out.
 */
export function filterSyncTargets(targets: SyncTarget[], config: SyncConfig, notebookIds: string[] = []): SyncTarget[] {
    return targets
        .filter(target => {
            const path = normalizePath(target.path);
            const notebookId = notebookIds.find(id => path === `data/${id}` || path.startsWith(`data/${id}/`));
            if (notebookId) return isNotebookSelected(notebookId, config);
            return isDirSelected(path, config);
        })
        .map(target => {
            const rules = excludeNamesFor(target.path, config);
            if (rules.length === 0) return target;
            return { ...target, excludedItems: [...(target.excludedItems ?? []), ...rules] };
        });
}

/**
 * Is a single data-relative file inside the selected scope? Used by the instant-sync hooks,
 * which see individual path events instead of a directory listing.
 */
/** SiYuan notebook ids look like `20260923140639-eltt6d7`. */
const NOTEBOOK_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;

export function looksLikeNotebookId(segment: string): boolean {
    return NOTEBOOK_ID_PATTERN.test(segment);
}

export function shouldSyncFile(filePath: string, config: SyncConfig, notebookIds: string[] = []): boolean {
    const path = normalizePath(filePath);
    if (!path) return false;

    const segments = path.split("/");
    const candidate = segments.length > 1 && segments[0] === "data" ? segments[1] : "";
    const knownNotebookId = notebookIds.find(id => path === `data/${id}` || path.startsWith(`data/${id}/`));
    // Fall back to recognising the id by shape: the instant-sync hooks have no notebook list.
    const notebookId = knownNotebookId ?? (candidate && looksLikeNotebookId(candidate) ? candidate : "");

    if (notebookId && !isNotebookSelected(notebookId, config)) return false;

    // Every ancestor directory must be selected, and the file name must not be excluded
    // by a rule that is attached to one of those ancestors.
    for (let index = 1; index < segments.length; index++) {
        const dir = segments.slice(0, index).join("/");
        // index 1 is "data" itself: not a sync target, and the notebook id is not a rule
        // target either. (Skipping `data/<notebookId>` here swallowed rules aimed at a
        // notebook root, e.g. excluding one parent document inside that notebook.)
        if (dir === "data") continue;
        if (!isDirSelected(dir, config)) return false;
        if (isNameExcluded(segments[index], dir, config)) return false;
    }

    return true;
}
