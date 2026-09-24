/**
 * Permanent regression tests for the pure-logic modules (no SiYuan runtime needed).
 *
 *   node tests/run-tests.mjs        (or: npm test)
 *
 * Everything here is deliberately dependency-free: esbuild bundles the TypeScript sources
 * into a temp dir, the bundles are imported, and assertions run against them. The paths
 * used for the selective-sync cases mirror a real workspace layout:
 *
 *   data/<notebookId>/<parentDocId>.sy              ← a document
 *   data/<notebookId>/<parentDocId>/<childDocId>.sy ← its sub-document (folder = parent id)
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "bsync-tests-"));

async function load(relativeEntry, name) {
    const outfile = join(outDir, `${name}.mjs`);
    await build({
        absWorkingDir: root,
        entryPoints: [relativeEntry],
        bundle: true,
        format: "esm",
        platform: "neutral",
        outfile,
        logLevel: "error",
    });
    return import(pathToFileURL(outfile).href);
}

const roles = await load("src/libs/roles.ts", "roles");
const config = await load("src/libs/sync-config.ts", "sync-config");

let pass = 0;
const failures = [];
const check = (name, condition, extra = "") => {
    if (condition) pass++;
    else failures.push(`${name}${extra ? ` → ${extra}` : ""}`);
};

const now = 1000000000000;

/* ---------------------------------------------------------------- roles (M4) */

check("旧版裸 instanceId 锁可解析", roles.parseLockContent("abc-123")?.instanceId === "abc-123");
const lockJson = roles.parseLockContent(JSON.stringify({
    instanceId: "id-1", nickname: "手机", direction: "bidirectional", startedAt: now - 60000, heartbeatAt: now - 5000,
}));
check("新 JSON 形态锁可解析", lockJson?.nickname === "手机" && lockJson?.heartbeatAt === now - 5000);
check("空锁内容为 null", roles.parseLockContent("   ") === null && roles.parseLockContent(null) === null);
check("角色声明可解析", roles.parseRoleDeclaration('{"role":"peer","instanceId":"x"}')?.role === "peer");
check("非法角色声明为 null", roles.parseRoleDeclaration('{"role":"boss"}') === null && roles.parseRoleDeclaration("nope") === null);

check("心跳新鲜的长同步不算陈旧", roles.isLockStale({ instanceId: "a", startedAt: now - 6 * 60 * 1000, heartbeatAt: now - 10000 }, now - 6 * 60 * 1000, now) === false);
check("心跳过期算陈旧", roles.isLockStale({ instanceId: "a", startedAt: now - 10 * 60 * 1000, heartbeatAt: now - 6 * 60 * 1000 }, now, now) === true);
check("旧版锁退回文件时间（新）", roles.isLockStale({ instanceId: "a", startedAt: 0, heartbeatAt: 0 }, now - 60000, now) === false);
check("旧版锁退回文件时间（旧）", roles.isLockStale({ instanceId: "a", startedAt: 0, heartbeatAt: 0 }, now - 6 * 60 * 1000, now) === true);
check("锁龄按心跳计算", roles.lockAgeSeconds({ instanceId: "a", startedAt: 0, heartbeatAt: now - 42000 }, now, now) === 42);

check("auto 方向所有者取字典序小者", roles.resolveDirectionOwner("aaa", "bbb", "auto") === "aaa" && roles.resolveDirectionOwner("zzz", "bbb", "auto") === "bbb");
check("可强制本机/对方", roles.resolveDirectionOwner("zzz", "bbb", "local") === "zzz" && roles.resolveDirectionOwner("aaa", "bbb", "remote") === "bbb");

const decide = options => roles.decideInitiation({ localInstanceId: "aaa", directionOwner: "aaa", ...options });
check("host+peer 自动允许", decide({ localRole: "host", remoteRole: "peer", trigger: "auto" }).allowed === true);
check("host+host 且本机是所有者允许", decide({ localRole: "host", remoteRole: "host", trigger: "auto" }).allowed === true);
check("host+host 且本机非所有者：自动拒绝", (() => {
    const result = roles.decideInitiation({ localRole: "host", remoteRole: "host", trigger: "auto", directionOwner: "bbb", localInstanceId: "aaa" });
    return !result.allowed && result.code === "bothHostsNotOwner";
})());
check("host+host 且本机非所有者：手动也拒绝（零传输）", (() => {
    const result = roles.decideInitiation({ localRole: "host", remoteRole: "host", trigger: "manual", directionOwner: "bbb", localInstanceId: "aaa" });
    return !result.allowed && result.code === "bothHostsNotOwner";
})());
check("peer+peer 自动拒绝、手动允许", decide({ localRole: "peer", remoteRole: "peer", trigger: "auto" }).code === "bothPeers" && decide({ localRole: "peer", remoteRole: "peer", trigger: "manual" }).allowed === true);
check("本机 peer：自动拒绝、手动允许", decide({ localRole: "peer", remoteRole: "host", trigger: "auto" }).code === "localIsPeer" && decide({ localRole: "peer", remoteRole: "host", trigger: "manual" }).allowed === true);
check("本机 manual：自动拒绝", decide({ localRole: "manual", remoteRole: "host", trigger: "auto" }).code === "localIsManual");
check("对端未声明：自动拒绝、手动允许", decide({ localRole: "host", remoteRole: null, trigger: "auto" }).code === "remoteRoleUnknown" && decide({ localRole: "host", remoteRole: null, trigger: "manual" }).allowed === true);
check("host+manual 自动允许", decide({ localRole: "host", remoteRole: "manual", trigger: "auto" }).allowed === true);

/* -------------------------------------------------------- selective sync (M5) */

const { defaultSyncConfig, parseSyncConfig, normalizePath, matchesGlob, globToRegExp, isNotebookSelected, isDirSelected, excludeNamesFor, isNameExcluded, filterSyncTargets, shouldSyncFile } = config;

const NB = "20260923122935-exk3nei";
const NB_OTHER = "20260923124807-tu6yv65";
const PARENT = "20260923123012-tr1a2eh";
const CHILD = "20260923123012-6dqm748";
const GRAND = "20260923123012-v4itivt";
const GREAT = "20260923123012-qj6c380";
const SIBLING = "20260923122935-ush98vy";
const PARENT_FILE = `data/${NB}/${PARENT}.sy`;
const CHILD_FILE = `data/${NB}/${PARENT}/${CHILD}.sy`;
const GRAND_FILE = `data/${NB}/${PARENT}/${CHILD}/${GRAND}.sy`;
const GREAT_FILE = `data/${NB}/${PARENT}/${CHILD}/${GRAND}/${GREAT}.sy`;
const SIBLING_FILE = `data/${NB}/${SIBLING}.sy`;

const def = defaultSyncConfig();
const withRule = (path, excludeNames) => ({ ...def, rules: [{ path, excludeNames }] });

check("默认不排除任何笔记本", isNotebookSelected(NB, def) === true && isNotebookSelected(NB_OTHER, def) === true);
check("默认不排除任何目录", isDirSelected("data/plugins", def) === true && isDirSelected("conf/appearance/themes", def) === true);
check("默认没有排除规则", def.rules.length === 0 && isNameExcluded("a.psd", "data/assets", def) === false);

check("无通配=精确匹配", matchesGlob("better-sync", "better-sync") === true && matchesGlob("better-sync2", "better-sync") === false);
check("*.ext 通配", matchesGlob("a.psd", "*.psd") === true && matchesGlob("a.zip", "*.psd") === false);
check("前缀通配", matchesGlob("draft-1.md", "draft*") === true && matchesGlob("my-draft.md", "draft*") === false);
check("** 跨层通配", matchesGlob("a/b/temp", "**/temp") === true && matchesGlob("temp", "**/temp") === false);
check("? 单字符通配", matchesGlob("a1.md", "a?.md") === true && matchesGlob("a12.md", "a?.md") === false);
check("正则元字符按字面处理", globToRegExp("a+b.md").test("a+b.md") === true && globToRegExp("a+b.md").test("aab.md") === false);

const onlyNotebookA = { ...def, notebooks: { mode: "include", ids: [NB] } };
check("include 模式只选指定笔记本", isNotebookSelected(NB, onlyNotebookA) === true && isNotebookSelected(NB_OTHER, onlyNotebookA) === false);
const excludeNotebookB = { ...def, notebooks: { mode: "exclude", ids: [NB_OTHER] } };
check("exclude 模式排除指定笔记本", isNotebookSelected(NB, excludeNotebookB) === true && isNotebookSelected(NB_OTHER, excludeNotebookB) === false);

check("目录 include 命中", isDirSelected("data/assets", { ...def, dirs: { mode: "include", paths: ["data/assets"] } }) === true);
check("目录 include 未命中被排除", isDirSelected("data/plugins", { ...def, dirs: { mode: "include", paths: ["data/assets"] } }) === false);
check("父目录覆盖子目录", isDirSelected("data/storage/av", { ...def, dirs: { mode: "include", paths: ["data/storage"] } }) === true);
check("exclude 连带子目录", isDirSelected("data/plugins/foo", { ...def, dirs: { mode: "exclude", paths: ["data/plugins"] } }) === false);

const assetRules = withRule("data/assets", ["*.psd", "*.zip"]);
check("规则命中排除名", isNameExcluded("big.psd", "data/assets", assetRules) === true);
check("规则继承到子目录", excludeNamesFor("data/assets/sub", assetRules).includes("*.psd") === true);
check("规则不外溢到别的目录", isNameExcluded("big.psd", "data/storage", assetRules) === false);

const targets = [
    { path: `data/${NB}`, excludedItems: [".siyuan"] },
    { path: `data/${NB_OTHER}` },
    { path: "data/assets" },
    { path: "data/plugins" },
    { path: "data/storage/petal", excludedItems: ["better-sync"] },
];
const onlyTargets = filterSyncTargets(targets, onlyNotebookA, [NB, NB_OTHER]);
check("目标过滤：只留选中的笔记本", onlyTargets.some(t => t.path === `data/${NB}`) === true && onlyTargets.some(t => t.path === `data/${NB_OTHER}`) === false);
check("只限笔记本时目录不受限（默认全选）", onlyTargets.some(t => t.path === "data/plugins") === true);
const dirFiltered = filterSyncTargets(targets, { ...onlyNotebookA, dirs: { mode: "include", paths: ["data/assets"] } }, [NB, NB_OTHER]);
check("目录 include 过滤生效", dirFiltered.some(t => t.path === "data/assets") === true && dirFiltered.some(t => t.path === "data/plugins") === false);
const rulesFiltered = filterSyncTargets(targets, assetRules, [NB, NB_OTHER]);
check("规则并入目标 excludedItems", rulesFiltered.find(t => t.path === "data/assets").excludedItems.join(",") === "*.psd,*.zip");
check("目标原有 excludedItems 保留", rulesFiltered.find(t => t.path === "data/storage/petal").excludedItems.join(",") === "better-sync");

// nested documents
check("默认纳入父/子/孙/曾孙全部层级", [PARENT_FILE, CHILD_FILE, GRAND_FILE, GREAT_FILE, SIBLING_FILE].every(path => shouldSyncFile(path, def)) === true);
check("只勾笔记本时四层嵌套全纳入", [PARENT_FILE, CHILD_FILE, GRAND_FILE, GREAT_FILE].every(path => shouldSyncFile(path, onlyNotebookA)) === true);
check("未勾选笔记本的文档被拦", shouldSyncFile(`data/${NB_OTHER}/x.sy`, onlyNotebookA) === false);
const keepChildren = withRule(`data/${NB}`, [`${PARENT}.sy`]);
check("排除父文档本体", shouldSyncFile(PARENT_FILE, keepChildren) === false);
check("父文档本体被排除后子文档仍同步", shouldSyncFile(CHILD_FILE, keepChildren) === true);
check("孙/曾孙仍同步", shouldSyncFile(GRAND_FILE, keepChildren) === true && shouldSyncFile(GREAT_FILE, keepChildren) === true);
check("兄弟文档不受影响", shouldSyncFile(SIBLING_FILE, keepChildren) === true);
const wholeTree = withRule(`data/${NB}`, [`${PARENT}*`]);
check("父文档+子孙一并排除", [PARENT_FILE, CHILD_FILE, GRAND_FILE, GREAT_FILE].every(path => shouldSyncFile(path, wholeTree) === false) === true);
check("整棵子树掉后兄弟文档仍同步", shouldSyncFile(SIBLING_FILE, wholeTree) === true);
const childFileOnly = withRule(`data/${NB}/${PARENT}`, [`${CHILD}.sy`]);
check("只排除子文档本体", shouldSyncFile(CHILD_FILE, childFileOnly) === false && shouldSyncFile(PARENT_FILE, childFileOnly) === true);
check("子文档本体被排除时其子孙保留", shouldSyncFile(GRAND_FILE, childFileOnly) === true && shouldSyncFile(GREAT_FILE, childFileOnly) === true);
const childTree = withRule(`data/${NB}/${PARENT}`, [`${CHILD}*`]);
check("子文档+其子孙一并排除", [CHILD_FILE, GRAND_FILE, GREAT_FILE].every(path => shouldSyncFile(path, childTree) === false) === true);
check("目录级排除连带子文件", shouldSyncFile("data/plugins/foo/bar.js", { ...def, dirs: { mode: "include", paths: ["data/assets"] } }) === false);
check("data 之外的规则不误伤 conf", shouldSyncFile("conf/appearance/themes/x/a.css", wholeTree) === true);
check("路径规范化", normalizePath("data\\assets\\") === "data/assets");
check("空路径不同步", shouldSyncFile("", def) === false);
check("规则并入笔记本目标供递归使用", filterSyncTargets(targets, wholeTree, [NB]).find(t => t.path === `data/${NB}`).excludedItems.join(",") === `.siyuan,${PARENT}*`);

check("null 配置退回默认", parseSyncConfig(null).notebooks.mode === "exclude");
check("脏配置被清洗", (() => {
    const parsed = parseSyncConfig({ notebooks: { mode: "bogus", ids: ["a", 3, ""] }, rules: [{ path: "p", excludeNames: [] }, { nope: 1 }] });
    return parsed.notebooks.mode === "exclude" && parsed.notebooks.ids.length === 1 && parsed.rules.length === 0;
})());

/* ------------------------------------------------------------------------- */

console.log(`\n${failures.length === 0 ? "ALL PASS" : "FAILURES"} — PASS=${pass} FAIL=${failures.length}`);
failures.forEach(failure => console.log(`  FAIL ${failure}`));
process.exit(failures.length === 0 ? 0 : 1);
