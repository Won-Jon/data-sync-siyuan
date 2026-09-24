# better-sync fork 改进计划清单

> 基线：本 fork v1.5.2（`minAppVersion 3.0.12`），装在 SiYuan 3.8.5（Windows 桌面 + Android 手机）。
> 用途：把「本次真实排查暴露的问题」+「想要的新功能（二维码配对 / 免重复扫码的连接历史 / 进度条 / 自选文件同步 / 防双端打架）」收敛成一张可勾选的实施清单。
> 进度：**M1（P0）已完成并已安装验证**，见 §2 与 §10。
> 每期（M1..M5）都能独立发布。

---

## 0. 起因：本次排查结论（作为 P0 的依据）

| 现象 | 实测证据 | 根因 |
|---|---|---|
| `同步失败，耗时 15.1s：Request timeout for .../getRepoSnapshots` | 插件 `api.ts` 默认超时 15000ms；`syncWithRemote` 第一步就是 `createDataSnapshots`（`sync.ts:1079-1081`） | 请求根本没有响应（网络层未通），不是对端慢 |
| `同步失败，耗时 5.0s：Request timeout for http://192.168.100.159://6806/api/file/readDir` | 5000ms 只出现在 `acquireLock`（`sync.ts:267`）；该 URL 实测被解析成 `192.168.100.159:80` → 拒绝连接 | 设置里 URL 手误多写一个 `//`（`http://host://6806`），插件零校验 |
| 手机端其实完全正常 | 实测 `POST http://192.168.100.159:6806/api/system/version` → 200 `3.8.5`；带 `Authorization: Token <token>` 的 `/api/file/readDir` → 200 | 电脑端配置错，非网络问题 |
| 手机休眠时首个请求 7.36s，之后 0.02s | 冷启动实测 | 插件 `readDir` 超时只有 5s → 会误报失败 |
| 失败时日志 `[ERROR]: Error during sync: {}` | `logging.ts` 用 `JSON.stringify(error)` | Error 序列化成空对象，等于没有日志 |
| 失败后界面不刷新 | `reloadFiletree/reloadProtyles` 只在成功路径（`sync.ts:1143-1174`） | 失败路径处理缺失（注：统计集合的清空本来就在 `finally` 里，失败也会执行，不存在"累加"问题） |
| 大工作区/手机端易"假超时" | `syncTargets.map` 无上限并发（`sync.ts:1122-1133`）；`getDirFilesRecursively` 递归 `Promise.all`；`src/libs/promise-pool.ts` 写了但**全项目未使用** | 无并发限流（M2-P2 已修：共享信号量，默认 8） |
| `conf/conf.json` 里的 API token 被本机内核 401 拒绝 | `POST 127.0.0.1:6806/api/file/readDir` + `Token f5y6mxojcrllttf0` → 401 `Auth failed` | **M2-P5 已查清**：conf 文件里的值可能滞后于运行中的内核（改文件后同一接口立即 200）；已改为优先读运行中内核的值并每次自测 |

**两处关键结论（决定后面设计）：**
- 同步是**文件级、幂等、无回滚**：`putFile` 直写真实路径 + `upsertIndexes`；删除操作永远排在最后一批（`sync.ts:1440-1457`）。**超时/中断不会让已同步的内容丢失**，重跑即续传。
- `sync-history.json` 只在成功末尾推进（`sync.ts:1176-1185`）→ 失败后重跑天然断点续传；代价是"两边都改过的文件"容易多报冲突。

---

## 0.1 同步语义 FAQ（2026-09-24 用户提问后补充）

**Q：点两次同步会怎样？**
A：第二次被**直接忽略**。`syncHandler` 一进门查状态 `InProgress` → 打印 `Sync is already in progress, ignoring this request.` → 弹一条 info 提示 → 返回；由于带 `started` 标记，这次点击**不会**写日志、**不会**清计数器、**不会**弹成功/失败提示、**不会**碰锁。第一次的同步完全不受影响。只有第一次已经结束（成功或失败）后再点，才是新的一次同步。M2.1 之前"连点报锁错误"是并发死锁把锁留在了盘上造成的。

**Q：是双向同步吗？能保证两边一模一样吗？**
A：**双向，但不是镜像**。逐文件按修改时间比新旧（`getSyncFileOperation`），新的一侧覆盖旧的一侧，所以两边谁改了都会传过去。

参与同步（`src/sync/sync-targets.ts`）：
- 笔记本目录 `data/<笔记本id>` 及其 `.siyuan`、`data/assets`
- `data/plugins`、`data/templates`、`data/widgets`、`data/emojis`
- `data/storage/av`、`data/storage/riff`
- `conf/appearance/themes`、`conf/appearance/icons`
- `data/storage/petal`（只补缺失）、`data/snippets`（只补缺失）

**不参与同步**（所以两边"注定不一样"，这是设计而非缺陷）：
- `conf/conf.json`（全部设备级设置：语言、外观、编辑器偏好、API token…）
- `data/.siyuan/`（索引、锁、instance-id）、`temp/`、`history/`、`repo/`（快照仓库）
  - 例外：`data/.siyuan/sync/` 下的 `sync-history.json`（以及 `lock`、`instance-id`）由插件**按需主动写到对端**，目的是让两端对"上次同步时间"达成一致 —— 这不算目录同步范围，但两边都会有这些文件。日志里的 `File sync-history.json … synced successfully` 就是它。
- `data/storage/` 下除 av/riff/petal 之外的部分

删除与冲突规则（不是 `rsync --delete` 那种镜像）：
- 删除会传播，但按目录有例外：主题/图标/petal/snippets **永不删**（`avoidDeletions`）；插件/模板/挂件/表情**只删目录不删单文件**（`deleteFoldersOnly`）
- `trackConflicts` 开启时，两边都改过的文件会保留一份 `Conflict` 文档而不是直接覆盖（当前用户配置为关闭）
- 判新旧依赖文件 mtime → **两端时钟差会影响判定**（「测试连接」会报告时钟偏差）

**Q：为什么同步时间歇性报超时？**
A：对端（手机）休眠/后台时首个请求可达 7s+。M1 起：锁探测不再固定 5s、只读请求自动重试 2 次、超时可配（默认 15000ms，建议手机对端 30000）。

---

## 1. 优先级总览

| 编号 | 项目 | 优先级 | 预估 | 状态 |
|---|---|---|---|---|
| M1-P1 | URL 规范化校验 | P0 | 1h | ✅ 已完成 |
| M1-P2 | 「测试连接」按钮 | P0 | 2h | ✅ 已完成 |
| M1-P3 | 错误可观测性 | P0 | 1h | ✅ 已完成 |
| M1-P4 | 失败路径收敛（失败后刷新界面） | P0 | 1h | ✅ 已完成 |
| M1-P5 | 超时可配 + 关键请求重试 | P0 | 2h | ✅ 已完成 |
| M1-P6 | 排除插件自身配置目录 | P0 | 1h | ✅ 已完成 |
| M2-P1 | 同步进度条 | P1 | 半天 | ✅ 已完成 |
| M2-P2 | 并发限流（共享信号量） | P1 | 半天 | ✅ 已完成 |
| M2-P3 | 中断语义 UI 化 | P1 | 1h | ✅ 已完成 |
| M2-P4 | 快照引导 | P1 | 1h | ✅ 已完成 |
| M2-P5 | 查清 conf token 401 疑点 | P1 | - | ✅ 已完成（结论见 §3） |
| M3-P1 | 二维码生成（自测通过才出码） | P2 | 半天 | ✅ 已完成 |
| M3-P2 | 扫码/粘贴接入（摄像头为增强） | P2 | 半天 | ✅ 已完成 |
| M3-P3 | **连接历史（免重复扫码）** | P2 | 半天~1天 | ✅ 已完成 |
| M3-P4 | 连接诊断面板 | P2 | 2h | ✅ 已完成 |
| M4-P1 | 双端角色声明（主机/从机） | P3 | 半天 | ✅ 已完成 |
| M4-P2 | 握手互认 + 精确指认"改哪台" | P3 | 半天 | ✅ 已完成 |
| M4-P3 | 锁升级（instanceId/方向/心跳） | P3 | 半天 | ✅ 已完成 |
| M4-P4 | 方向所有权 | P3 | 半天 | ✅ 已完成 |
| M4-P5 | instantSync 角色化 | P3 | 2h | ✅ 已完成 |
| M5-P1..7 | 选择性同步（自选文件/目录/扩展名） | P3 | 1~2天 | ✅ 已完成 |

---

## 2. M1（P0）—— 已完成 ✅

- [x] **M1-P1 URL 规范化校验**
  - 新增 `src/libs/url-utils.ts`：`checkPeerUrl()` 返回 `{ok, normalized, problem, fixes}`
  - 规则：只允许 `http|https`；协议名笔误自动修（`htttp`/`htpp`/`htps`…）；`host://6806`、`host:/6806`、`host//6806` 一律修成 `host:6806`；缺协议补 `http://`；`http` 缺端口补 SiYuan 默认端口 6806；去尾部斜杠；主机名/端口做合法性校验
  - `src/settings.ts`：`siyuanUrl` 从 `textinput` 改为 `custom`，输入时实时显示"已自动修正为 …（问题清单）"或红字原因；失焦即改写并保存；**非法值不落盘**（`getEleVal` 回退到上一个合法值）
  - 验收（esbuild + node 实跑 10 例）：`htttp://192.168.100.159://6808` → `http://192.168.100.159:6808`；`http://192.168.100.159://6806` → `http://192.168.100.159:6806`；`192.168.100.42` → `http://192.168.100.42:6806`；`https://notes.example.com` 不动；`ftp://`、端口 `99999`、空主机、空串全部正确拒绝
- [x] **M1-P2 「测试连接」按钮**
  - 新增 `src/libs/connectivity.ts`：`peerPost()`（fetch + AbortController，永不抛）+ `testPeerConnection()` 五步诊断 + 失败归类（timeout / unreachable / unauthorized / businessError / unexpected）
  - 五步：`/api/system/version` → `/api/notebook/lsNotebooks`（验密钥）→ `/api/file/readDir data/.siyuan/sync`（验插件目录）→ `getFile` 读对端 `instance-id`（设备指纹）→ `/api/system/currentTime`（时钟偏差）；额外报告"首次请求是否 ≥3s"（休眠征兆）
  - `src/settings.ts`：按钮下方逐行渲染「✔/✘ + 步骤 + 耗时 · HTTP 码 · code · 服务端原文」，最后给人话结论
  - 验收（打真实内核）：本机 6806 用错密钥 → 第 2 步 `HTTP 401 Auth failed` → 判定「API 密钥不正确」；手机（当时在后台） → 判定「超时（对端可能休眠）」；不存在端口 → 判定「连不上」
- [x] **M1-P3 错误可观测性**
  - `src/logging.ts`：`valueToString()` 处理 `Error`（name + message + stack + cause）与循环引用，不再输出 `{}`
  - `src/api.ts`：请求失败日志带 URL 与耗时；超时错误带 `no response within <ms>ms`；重试过程有 WARN
- [x] **M1-P4 失败路径收敛**
  - `src/sync/sync.ts`：失败分支先 `reloadFiletree` + `reloadProtyles`（局部传输已落地，界面不再停留在旧内容），再提示错误；错误消息含 `timeout` 时追加「对端可能休眠/已退出前台」提示
  - **修正**：原计划里写的"失败时统计不清空、下次会累加"经核对是**错的**——`locallyUpdatedFiles` 等本来就在 `finally` 里清空，失败也会执行；真实缺口只有"失败后不刷新界面"，已补
- [x] **M1-P5 超时可配 + 重试**
  - `src/api.ts`：`setRequestTimeoutMs()/getRequestTimeoutMs()`（默认 15000）；`requestWithHeaders()` 支持 `retries`（1s/2s 退避）；`getFileBlob()` 默认超时由 5000 改为可配
  - `src/sync/sync.ts`：锁探测不再硬编码 5000ms；`src/sync/sync-utils.ts`：4 处只读 `readDir` 加 `READ_ONLY_RETRIES = 2`
  - `src/settings.ts`：新增「网络请求超时（毫秒）」设置项（对话框确认时生效）
- [x] **M1-P6 排除插件自身配置目录**
  - `src/sync/sync-targets.ts`：`data/storage/petal` 增加 `excludedItems: ["better-sync"]`，避免把本机对端 URL/密钥同步到新设备造成"指向自己"
- [x] **i18n**：中英各新增 34 条（URL 校验/修正、测试连接、五步标签、五类失败原因、超时设置、超时提示）
- [x] **构建与安装**：`npx tsc --noEmit` 通过（顺带删掉仓库里本来就未使用的 `getUnusedAssets` 导入）；`npm run build` 通过；`release/package.zip` 已产出并解包验证；工作区 `data/plugins/better-sync` 已更新（备份 `better-sync.bak-20260923-164411`）

---

## 3. M2（P1）—— 已完成 ✅

- [x] **M2-P1 同步进度条**
  - 新增 `src/types/progress.ts`：`SyncProgress { phase, targetsStarted, targetTotal, done, total, currentFile, startedAt, finishedAt }`
  - `src/sync/sync.ts`：`onProgressChange()/getProgress()/updateProgress()`；埋点＝`syncHandler`（preparing/done/failed）、`syncWithRemote`（scanning/finalizing + `targetTotal`）、`syncDirectory`（`targetsStarted`）、`syncDirWork`（`total += 已规划操作数`）、`executeOperationsByPriority`（每个操作完成 `done++`、记录 `currentFile`）
  - `src/index.ts`：右下角悬浮面板（`pointer-events:none`，不挡操作），显示阶段 + `目录 i/N · 文件 i/M` + 当前文件 + 进度条；成功 4s 后自动收起，失败变红并显示中断语义（M2-P3），20s 后收起
  - 实现说明：多目录并发 + 总量随扫描增长 → 展示为"已开始目录数/总数"与"已完成/已规划文件数"，**不假装单一百分比**
  - v2 仍可选：把 `putFile/getFileBlob` 的 `fetch` 换成 XHR 以得到字节级进度
- [x] **M2-P2 并发限流**
  - 新增 `src/libs/concurrency.ts`：进程级信号量 `withConcurrencyLimit()` + `setMaxConcurrentRequests()`（默认 8，夹取 1~64）
  - 应用点：`sync-utils.ts` 的 `getDirFilesRecursively` 递归扫描、`sync.ts` 的 `executeOperationsByPriority` 传输/删除
  - 与计划不同的决策：`src/libs/promise-pool.ts` 是**每个调用点各自一份**的池，无法约束整场同步（每层递归、每个目录都会各拿一份预算），所以改用共享信号量；`promise-pool.ts` 仍然弃用（可后续删除）
  - 设置项：`maxConcurrentRequests`（对话框确认时生效）
  - 验收（node 实跑）：上限 2 时 12 个任务峰值并发 = 2、全部完成；`0` → 回退 8；`100` → 夹到 64
- [x] **M2-P3 中断语义 UI 化**
  - i18n `syncInterruptNote` 在失败面板中固定展示：「已同步完成的文件会保留；再次同步会从断点继续，不会删除对端数据。」
- [x] **M2-P4 快照引导**
  - `createDataSnapshots` 改为弹 10s 的可操作提示（`snapshotRepoNotInitialized`）：指出"两端都要初始化数据仓库密钥"的具体菜单路径；快照失败**不影响同步继续**
  - 设置页在快照项下方新增说明块（`snapshotHintTitle/Desc`）
  - 「测试连接」新增对端「数据仓库（快照）」步骤 + `⚠ 对端数据仓库未初始化…` 提示行
- [x] **M2-P5 查清 conf token 401 疑点**
  - 结论：`conf/conf.json` 里的 API token **可能滞后于运行中的内核**。首次排查时该文件的值被内核以 `401 Auth failed` 拒绝；随后把文件/界面里的值改为 `wjl030425` 后，同一接口立即 200。也就是说"文件里的值"不能当权威值。
  - 落地：新增 `src/libs/local-config.ts`：`readLocalApiToken()` 优先取运行中内核的值（`window.siyuan.config.api.token`，即设置页显示值），`conf/conf.json` 仅兜底；`checkLocalApiToken()` 每次自测；`probeLocalKernel()` 汇总内核版本 + 密钥来源 + 自测结果，并显示在「测试连接」的「本机」小节
  - 验收（node 实跑 + 真实内核）：正确的 token → `tokenAccepted=true`；错误 token → `401 Auth failed`；无前端 config 时不会崩（退回兜底）
  - 顺带确认：`Authorization: Token <t>`、`Bearer <t>`、`?token=<t>` 三种都通过；`X-API-Token` 头与 `Token<t>`（无空格）不通过

---

## 3.1 M2.1 热修（用户首轮 M2 自测反馈）—— 已完成 ✅

- [x] **【严重】并发限流死锁**
  - 现象：点同步后进度面板停在「17 个目录 / 3 个文件」不动，锁文件永不释放，再点同步报「已有同步正在进行中」
  - 根因（已用 node 复现）：首版把**递归扫描整体**包进同一个信号量 —— 父目录持槽等子目录、子目录在队列等槽，配额耗尽即永久死锁；同一个池里"操作持槽等请求"同样会死锁
  - 修法：递归不再占槽，改成**每个 HTTP 请求**占槽（`api.ts` 的 `requestWithHeaders` / `getFileBlob`）；预算拆成**请求槽**与**操作槽**两个独立信号量（`libs/concurrency.ts`）
  - 验证：10 个操作各含 2 次请求（上限 2）全部完成；8 根 × 深度 4 × 3 子递归 968 次请求无死锁；旧写法 3 秒必超时（复现证据）
- [x] **连点同步拦截**
  - `syncHandler` 增加 `started` 标记：被"已在同步中"挡下的点击**不再进入**收尾的报告/清理逻辑（旧行为会写日志、清计数器，甚至弹"同步成功"假提示）
  - 被挡下时给一条 info 提示：`syncAlreadyRunning`
- [x] **锁的归属与自救**
  - 锁文件内容写入本机 `instance-id`；发现**本机自己**残留的锁（内容 == 本机 instanceId）时自动接管并打印原因
  - `syncLockAlreadyExists` 文案补上**锁龄**与具体处理建议（删除对端 `data/.siyuan/sync/lock`、>5 分钟自动忽略）
  - 说明：旧版遗留的**空内容**锁无法判断归属，仍会按"别人的锁"拒绝，直到超过 5 分钟
- [x] **进度面板交互**
  - 可拖动（按住标题行）、可折叠（`−`/`+`）、可关闭（`✕`，下次同步自动重现）；位置与折叠状态持久化到 `data/storage/petal/better-sync/ui-state.json`
  - 失败但**没有任何传输**时不弹面板（只有 toast）；传了一部分才失败时才显示红色面板 + 中断语义
- [x] **M2.2 请求槽泄漏修复（用户追问"并发=1 能跑吗"时发现）**
  - 现象：并发设为 1 时，一次卡住的连接会**一直占着唯一的请求槽** —— 实测超时后槽位仍被占用，后续任务被阻塞 **9310ms**（本该 100ms）
  - 根因：`getFileBlob` 用 `Promise.race([fetch, timeout])`，**从不中止底层 fetch**；超时只是让调用方提前返回，槽位仍被挂起的请求持有
  - 修法：改用 `AbortController` 真正中止；**拿到响应头后立即停表**，避免大文件下载被计时器截断（原来 body 读取本来就是无超时的，保持语义不变）
  - 验证：超时后槽位 = 0、后续受限任务 105ms、36 字符小文件与 85,347 字节大文件均完整读取；错误文案仍是 `Request timeout for … (no response within Xms)`
- [x] **M2.3 传输暂停/继续（用户要求）**
  - `libs/concurrency.ts`：新增暂停闸门 `pauseTransfers()/resumeTransfers()/isTransferPaused()`；两个信号量在"取槽前"与"排队后"各检查一次暂停，**暂停时不启动任何新请求/新操作**，在飞的请求跑完（不硬取消，避免半写文件）
  - `index.ts`：进度面板标题栏加 ⏸/▶ 按钮；暂停中标题显示「同步已暂停」并提示"暂停超过 5 分钟锁会被判过期"；同步结束/失败**自动清除暂停态**（避免下次同步一开局就暂停）；另注册命令 `togglePauseSync`（可在 设置→快捷键 绑定）
  - 验证：node 实测——暂停中启动数 = 0，恢复后 5/5 完成；中途暂停时在飞的照常完成、其余不启动，恢复后 4/4 完成
- [x] **M2.4 重复点击提醒 + 取消传输（用户补充要求）**
  - 重复点击：不再是"静默忽略"，改为**明确提醒** —— toast 带上当前进度（`同步已在进行中 · 文件 137/520，本次点击已忽略`）+ 高亮进度面板 2.5 秒 + 面板若被关闭过会自动重现
  - 取消（⏹ 提前中断）：`libs/concurrency.ts` 增加取消闸门 `cancelTransfers()/isTransferCancelled()/resetTransferCancel()` + `TransferCancelledError`；`api.ts` 的 `getFileBlob` 注册 `AbortController` 以便真中止，且**重试逻辑不重试被取消的请求**
  - 取消的传播：`executeOperationsByPriority`（每批前）、`syncDirectory`（扫描后/传输后）、`syncWithRemote`（所有目标之后）都加了检查点 —— 否则各操作自己吞掉错误（`allSettled`），会出现"取消了却继续跑完并报成功"
  - 取消后的状态：顶部图标回普通（不算 Failed）、面板显示「同步已取消」+ 中断语义、toast 提示已传部分保留；**每次同步开始自动重置取消状态**
  - 又修一个自引入的死锁：被"让出名额"的任务若因取消/暂停拒绝执行，**必须把名额传给下一个排队者**（`releaseNext()`），否则队列永远停住（用 node 实测复现并验证修复）
  - 验证：取消时在飞 2 个正常收尾、排队 4 个被拒且队列排空；`reset` 后可继续；暂停+取消组合不挂起；`tsc` 0 错误
- [x] **M2.5 按钮状态自洽（用户反馈"点了终止依然能点暂停"）**
  - 现象与日志核对：全量日志里**没有** `cancelled` 记录，说明点 ⏹ 时同步已进入收尾阶段（或已结束）→ 取消无对象，同步照常成功、锁正常释放（不影响结果），但 ⏸ 在那两个窗口里仍然可见可点
  - 修法：暂停/取消按钮只在 `preparing/scanning/transferring` 三阶段显示（**收尾阶段不再显示** —— 那里已无数据可停）；取消一旦发出 ⏸ 立即隐藏；用快捷键在"取消中"调暂停时提示 `progressPauseUnavailable` 而不是静默生效
  - 顺带修正 FAQ 措辞：`data/.siyuan/sync/` 下的 `sync-history.json`（以及锁、instance-id）由插件**主动**写到对端，不属于目录同步范围 —— 日志里能看到 `File sync-history.json … synced successfully`

---

## 4. M3（P2，1~2 天）配对与连接管理（含"免重复扫码"）

- [x] **M3-P1 二维码生成**（在"被连接的一侧"）—— 已完成
  - 新增 `src/libs/pairing.ts`（载荷编解码）与 `src/pairing-ui.ts`（设置界面）；依赖 `qrcode-generator`（MIT，纯 JS）
  - 流程：读运行中内核的 token（M2-P5 的 `readLocalApiToken`）→ `checkLocalApiToken()` 自测 → 地址取 `getLocalCandidateUrls()`（`conf.serverAddrs` 的局域网 IP **改写为网络伺服端口 6806**，丢掉 loopback）→ 逐个 `probePeer()` 自测（须与本机 instance-id 相符）→ **只把可用地址**写进二维码，另附「复制连接文本」
  - 验收（node 实跑）：`probePeer` 对真实内核 正确密钥=match（拿到真实指纹）、错误密钥=unauthorized(401)、黑洞地址=timeout
  - 本机地址：`conf.serverAddrs` 的局域网 IP + 网络伺服端口（**不要用随机 UI 端口**）
  - 取 token：已由 M2-P5 解决 —— 用 `libs/local-config.ts` 的 `readLocalApiToken()`（优先运行中内核的值）+ `checkLocalApiToken()` 自测通过才出码
  - 载荷（纯文本）：`bsync:v1:{"u":"http://192.168.100.42:6806","k":"<token>"}`；附「复制文本」按钮
  - UI：`setting-utils` 的 `type:"custom"` 元素（M1-P1/P2 已有先例）
- [x] **M3-P2 二维码接收** —— 已完成
  - `parsePairingPayload()` 容错解析：`bsync:v1:{...}` / 裸 JSON（`u`|`url`|`urls` + `k`|`token`|`key`）/ **"地址 + 密钥"两行式**；地址复用 M1 的 `checkPeerUrl` 自动修正（协议名、多余斜杠、补 6806）；截断的 JSON 报"可能被截断"而不是"没有地址"
  - 接入流程：`resolvePeer()` 逐个候选探测（读对端 `data/.siyuan/sync/instance-id` 校验身份）→ 成功后自动写入 URL/密钥、重init 同步、跑一遍完整连接诊断、并入历史
  - 摄像头：改用内置 `BarcodeDetector` **特性检测**（不再引 jsQR）；不可用时按钮不显示并提示用相机扫码后粘贴 —— 粘贴是主路径
  - 验收（node 实跑）：解析 10 例全通过（含坏地址自动修正、往返一致）；候选轮询"第一个超时→第二个 match"、指纹不符、无候选 均按预期
- [x] **M3-P3 连接历史（免重复扫码）** ← 用户新增需求 —— 已完成
  - `src/libs/connections.ts` + `data/storage/petal/better-sync/connections.json`：`{fingerprint(=对端 instance-id), nickname, urls[], token?, kernelVersion, lastOkAt, lastError, pinned}`
  - 一键连接：按候选顺序 `resolvePeer(urls, token, fingerprint)` → 命中即复用地址、刷新 `lastOkAt`；**IP 变了也能找回**（靠指纹而非 IP）；置顶/删除/合并候选 URL 去重
  - 分级失败提示：401 密钥变更 / 超时（休眠）/ 连不上 / 不是思源内核 / **地址被别的设备占用**（指纹不符，拒绝连错设备）
  - 验收（node 实跑）：存储函数 4 例（置顶排序、同指纹合并保留旧候选、写失败、删除）全通过
- [x] **M3.1 修复（用户首轮 M3 反馈：二维码没显示 / 手机上怎么扫）**
  - **二维码不可见**：`createSvgTag({ scalable: true })` 生成的 `<svg>` 只有 `viewBox`、**没有 width/height**，放进 `width:fit-content` 容器就塌成 **0×0**（只能看到一个白色圆角框）。改用固定像素形式 + 保留防御性尺寸兜底（`getBoundingClientRect().width < 20` 时按 moduleCount 显式设宽高）+ `max-width:100%`
  - **验证（浏览器实拍）**：同一段载荷并排渲染，旧写法=空白、新写法=完整二维码（截图作证）
  - **手机接入路径**：思源 App 内没有系统级扫码 → 新增「**从剪贴板读取**」按钮（`navigator.clipboard.readText()`，无权限时提示手动粘贴）；二维码区新增手机操作指引（系统相机/微信扫码 → 复制 → 插件里读取/粘贴）
  - 顺带：本机候选地址排序改为「所有 6806 稳定端口在前，UI 随机端口只作兜底在后」（原来两端口交错）
- [x] **M3.2 手机端"扫码"的真实解法（用户追问"能不能给手机插件做扫码 / 要不要拉 App 源码"）**
  - **查证结论（读源码所得，非猜测）**：思源 Android App 在独立仓库 `siyuan-note/siyuan-android`（Java，默认分支 main，AGPL-3.0，仍在更新）。`MainActivity.java:610` 的 `onPermissionRequest` 只调用 `handleAudioPermissionRequest()`，放行的是 `RESOURCE_AUDIO_CAPTURE`；判定函数只认音频 → 摄像头的 `RESOURCE_VIDEO_CAPTURE` **一律被拒** → 插件里的 `getUserMedia` 在安卓上必然 `NotAllowedError`。App 在 manifest 里确实声明了 CAMERA，但那是"拍照插入文档"的原生通道（`onShowFileChooser` → Android 10+ → `ACTION_IMAGE_CAPTURE`）。
  - **解法（零 App 改动、零权限 API）**：走 App 已经实现的那条原生通道 —— `<input type="file" accept="image/*" capture="environment">` 在安卓上会**直接打开系统相机**并把照片交给页面；插件再用 `jsqr` 解码图片。于是新增两个按钮：
    - 「**拍照识别二维码**」= 手机上真正的"扫码"（点一下 → 相机 → 拍 → 自动识别并连接）
    - 「**选图片识别**」= 从相册选二维码截图（桌面端同样可用）
  - 依赖：`jsqr@1.4.0`（MIT，压缩后 130KB；插件产物 127KB → 259KB，WebView 场景可接受）
  - 验证（node 实跑）：把载荷二维码按 8x/6x/4x/3x/2x 放大渲染成像素（含静默区）→ jsQR 解码 **5/5 与原载荷完全一致**（最小 82×82 像素仍可解）；`tsc` 0 错误
  - 保留：若某平台真有 `BarcodeDetector`，「用摄像头扫码」按钮照旧可用（实时预览）
  - 结论：**不需要拉内核源码，也不建议 fork Android App**（改 App 需自签名安装 + 每次官方更新重打补丁）
  - 存储：`data/storage/petal/better-sync/connections.json`
    ```json
    [{
      "fingerprint": "<对端 data/.siyuan/sync/instance-id>",
      "nickname": "手机的思源",
      "urls": ["http://192.168.100.159:6806"],
      "token": "<可选：不保存密钥时留空>",
      "kernelVersion": "3.8.5",
      "source": "qr | manual",
      "lastOkAt": 1790150000,
      "lastError": "timeout 5.0s",
      "pinned": true
    }]
    ```
  - **指纹用 `instance-id`（不是 IP）** → IP 变了也认得出是同一台
  - 一键连接：按"最近成功 URL → 同网段上次见过的 IP"依次尝试 → 读对端 `instance-id` 比对指纹 → 命中后更新 url/token → 跑连通性自测
  - 401 立刻提示「密钥已变更，请重新扫码/粘贴」，不再干等超时；支持多设备切换、置顶、删除、可选"不保存密钥"
  - 验收：手机重连 WiFi 换了 IP → 一键连接能自动找回
- [x] **M3-P4 连接诊断面板** —— 已完成：历史每条显示「上次成功时间 / 上次失败原因」，连接动作完成后自动重跑完整诊断报告（M1-P2 的五步 + 数据仓库 + 本机块），探测明细逐地址列出 outcome 与耗时

---

## 5. M4（P3，2~3 天）双端角色与「防打架」

**先看清现状（别误判）：** 现有锁**已经能挡住"同时互推"**——`acquireAllLocks` 会先给远端写锁再给本地写锁（`sync.ts:307-317`），B 在 A 同步期间启动会读到锁并报 `syncLockAlreadyExists`。它挡不住的是三类：

1. **轮流对推**：正常结束后 `finally` 释放锁（`sync.ts:982-984`）→ A 推完 B 立刻推 A，来回覆盖 + 冲突文档爆炸；
2. **长同步中途被插入**：锁超过 5 分钟被当成"陈旧锁"忽略（`sync.ts:271-279`）→ 一次大同步跑 6 分钟，对端正好插进来；
3. **锁文件本身不带信息**：里面是空的，只有 mtime，无法判断"谁在推我、往哪个方向推"。

- [x] **M4-P1 角色声明** —— 已完成：`本机角色`（host/peer/manual，默认 host 保持旧行为）；发起同步前写入本机 `data/.siyuan/sync/role.json`（`{role, instanceId, nickname, updatedAt}`，对端可读）；`peer` 不主动自动同步（自动触发一律拦下，手动放行）
- [x] **M4-P2 握手互认** —— 已完成：读对端 `role.json` → 对端也是 host 且本机不是方向所有者时**拒绝**，提示点名「应由『X』主动同步，请在其中一端把本机角色改成 peer（对端：名称 · URL）」，并明确「本次未传输任何文件」
- [x] **M4-P3 锁升级** —— 已完成：锁内容改 `{instanceId, nickname, direction, startedAt, heartbeatAt}`；陈旧判定改用**心跳**（同步中每 30s 续期，旧版裸指纹锁退回文件时间）；冲突提示改为「『对端名』正在与你同步（已持续 N 秒）」
- [x] **M4-P4 方向所有权** —— 已完成：默认 `instance-id` 字典序小的一方（两端算法一致、无需沟通），可用 `方向所有者` 设置强制本机/对方（持久化在 menu-config.json，语义等价于计划里的 direction.json；多对端分别覆盖留待将来）
- [x] **M4-P5 instantSync 角色化** —— 已完成（守卫式）：`instantSyncAllowed()` = 本机为 host 且是方向所有者，否则即时推送钩子直接 return（效果等于"只在主推端挂载"，改动面更小）
- [x] **M4-P6 UI** —— 已完成：设置里新增「当前同步角色与方向」（本机角色+指纹 / 对端角色+指纹 / 方向所有者 + 建议），点刷新读取两端 `role.json`
- [x] 验收：**双端都设 host → 非所有者侧自动与手动都拒绝、零文件传输**（node 24 项断言含此组合）；host+peer 手动同步不受限；**6 分钟长同步期间对端发起 → 因 30s 心跳不再被判陈旧**（node 已验证判定逻辑）

---

## 6. M5（P3.5，1~2 天）选择性同步（自选文件）

- [x] **M5-P1 数据结构** `sync-config.json` —— 已完成（实现为 `{version:1, notebooks:{mode,ids}, dirs:{mode,paths}, rules:[{path,excludeNames}]}`；默认"排除为空"＝全选，保持旧行为）
- [x] **M5-P2 `getSyncTargets` 读配置** —— 已完成：`SyncTargetsConfig` 增可选 `syncConfig`，内部复用 `filterSyncTargets()`；`SyncManager.getSyncConfig()` 带缓存（`invalidateSyncConfig()` 在保存后调用），唯一调用点 `sync.ts` 已改为传入；另导出 `SYNC_DIR_PATHS` 供 UI 复用
- [x] **M5-P3 通配排除** —— 已完成：`sync-utils.ts` 的过滤改为 `excludedItems.some(p => matchesGlob(name, p))`（无通配时仍是精确匹配，等价旧行为）；支持 `*.ext` / 前缀 / `?` / `**`
- [x] **M5-P4 instantSync 一致化** —— 已完成：在**唯一的传输出口** `executeSyncOperation()` 里加 `isPathSyncable()` 守卫（全量扫描与即时钩子都经过它），所以"没勾选的文件被编辑后不会被同步"，日志给出 `outside the selected sync scope`
- [x] **M5-P5 冲突追踪跳过排除项** —— 已完成（结构性保证）：排除发生在**列目录阶段**（target 级 `excludedItems` + 规则合并），被排除的文件根本不会被比对，自然不会产生冲突副本
- [x] **M5-P6 UI** —— 已完成：设置里「选择性同步」＝笔记本勾选列表 + 目录勾选列表 + 排除规则文本框 + 保存/全选/全不选；**默认全选**
- [x] **M5-P7 语义文案** —— 已完成：标题与说明明确「取消勾选＝停止比对与传输，不会删除任何一边的数据」，并说明生效范围由发起同步的一方决定
- [x] 验收（node 实跑 32 项断言全过）：默认全选；include/exclude 两模式；父子目录覆盖；`*`/`?`/`**` 通配；正则元字符转义；规则继承子目录；规则并入 `excludedItems`；单文件判定（含按 id 形状识别笔记本）；脏配置容错。用例见 `docs/TEST-M5_zh_CN.md`（TC-M5-01 ~ 13）
- [x] **M5.1 嵌套子文档验证 + 永久回归测试（用户提问"选父文档，子文档会被选吗"）**
  - 先用**真实工作区结构**确认磁盘布局：`data/<nb>/<父id>.sy`（父本体）与 `data/<nb>/<父id>/<子id>.sy`（子文档，目录名＝父 id），实测到四层嵌套
  - **抓到并修复一个真 bug**：`shouldSyncFile` 里 `if (notebookId && dir === data/<nb>) continue` 会跳过**笔记本根目录层**的规则判定 → 挂在笔记本根上的排除规则（如"排掉某父文档本体"）整体失效。改为只跳过 `data` 这一层，其余各层都做目录选择 + 名字规则判定
  - 结论（已回归验证）：勾笔记本＝**所有层级子文档全同步**；只排父本体用 `<父id>.sy`；父+子孙用 `<父id>*`；只排某子文档用 `data/<nb>/<父id>: <子id>.sy`（其子孙仍同步，要连子孙就 `<子id>*`）
  - **新增 `tests/run-tests.mjs` + `npm test`**：把 M4 角色/锁与 M5 选择逻辑固化为 **63 项永久回归断言**（不需要思源运行），含本次抓到的 bug 场景
  - 仍未支持：**文档级勾选**（include 只作用于笔记本/目录级）——如需"只选某几篇文档/勾父带子"的树形 UI，另立 M5.2
  - 用例：`docs/TEST-M5_zh_CN.md` 新增 §3.5（TC-M5-14 ~ 17）

---

## 7. 贯穿项（每期都做）

- [x] i18n：M1 的中英文案已同步（后续每期继续）
- [ ] 纯函数单测：URL 解析/校验、`getSyncTargets` 过滤、进度计算、`connections.json` 匹配（建议 vitest；M1 期间用 esbuild+node 临时跑过 URL 用例，尚未固化成测试）
- [ ] 本地双实例回归：两个工作区 + 不同端口（或 docker）跑"首次全量 / 增量 / 冲突 / 中断重跑"四个剧本
- [x] 向后兼容：M1 新增设置项缺省值等于旧行为（超时 15000 与旧默认一致；URL 行为只增不减）
- [x] `npx tsc --noEmit` 干净（M1 顺带修掉了仓库原有的未使用导入）
- [ ] CHANGELOG（中英）+ `plugin.json` 版本号（当前仍 1.5.2；发版建议 bump 到 1.5.3 并打 tag）

---

## 8. 风险与开放问题

1. **Android WebView 摄像头权限未知** → 扫码可能不可用；保底：手机自带相机扫出文本 + 粘贴（M3-P2 的粘贴路径要做好用）。
2. **IP 漂移自愈手段有限**（mDNS 不可靠）→ 以「历史候选 + instanceId 指纹 + 手动重扫」为主。
3. **方向所有权（M4-P4）在设备重装后 instance-id 会变** → 需持久化"本对设备"的方向选择并允许手动覆盖。
4. **进度条在大目录并发下只能近似**；字节级进度需 XHR 改造。
5. **`conf/conf.json` token 被本机内核 401 拒绝**（实测）——M3-P1 出码前必须查清，否则会印出无效密钥。
6. **两端时钟差**：同步按 mtime 判方向；M1 已在「测试连接」里报告时钟偏差，后续可作为硬校验。
7. **手机休眠**：M1 已把锁探测从 5s 放开并可配置 + 只读请求重试，属缓解而非根治（根治＝让用户知道并在对端唤醒后自动继续）。

---

## 9. 建议实施顺序

```
M1（已完成）  让"配置错误"和"假超时"不可能再发生
M2（已完成）  让同步过程可见、可控（进度 + 并发上限）
M3（1~2天）   让连接一次成像、之后不用再扫
M4（2~3天）   让双端永不打
M5（1~2天）   让自己决定同步什么
```

每期发布前跑一遍对应"验收"行。

---

## 10. 进度日志

- **2026-09-23｜M1 完成并入包**
  - 代码：`src/libs/url-utils.ts`（新）、`src/libs/connectivity.ts`（新）、`src/api.ts`、`src/logging.ts`、`src/settings.ts`、`src/sync/sync.ts`、`src/sync/sync-utils.ts`、`src/sync/sync-targets.ts`、`public/i18n/{zh_CN,en_US}.json`
  - 规模：8 改 2 新，约 +446/−32 行；产物 62.0 kB → 74.1 kB（`dist/index.js`）
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过；URL 规则 10 例；连接诊断对真实内核验证 3 类失败
  - 追加（同日）：设置对话框「确认」后立即重新初始化同步管理器（`applyRequestSettings()` 里调 `syncManager.init()`），URL/密钥/超时改动无需重载插件即生效
  - 追加（首轮自测修复）：URL 清空时也显示红字「请填写对端设备的地址」——原先该分支静默无提示（TC-08 未复现的原因），已修并重新打包
  - 手工测试用例：`docs/TEST-M1_zh_CN.md`（TC-01 ~ TC-16，逐条写明"输入什么 → 会发生什么"）；首轮结果：除 TC-08 外全部通过，TC-08 修复后待复测
  - 产物：`release/package.zip`（97,980 B，SHA256 `6CE51DEF2882D96982DBF9FCF341B23FB62279C1D51BDBBA7C2E92A9D19ED029`）、`release/better-sync-1.5.2+m1-20260924.zip`、`release/BUILD-INFO.txt`
  - 安装：思源 `设置 → 集市 → 已下载 → 安装本地包`（或拖放 zip）；装/更新后需重载一次插件
  - 回滚：`D:\studyNotes\siyuan\data\plugins\better-sync.bak-20260923-164411`
  - 未提交：改动仍在工作区（`git status` 可见），未 commit
- **2026-09-24｜M2 完成并入包**
  - 代码：`src/types/progress.ts`（新）、`src/libs/concurrency.ts`（新）、`src/libs/local-config.ts`（新）、`src/libs/connectivity.ts`、`src/sync/sync.ts`、`src/sync/sync-utils.ts`、`src/settings.ts`、`src/index.ts`、`public/i18n/{zh_CN,en_US}.json`
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（`dist/index.js` 74.1 kB → 81.8 kB）；node 实跑验证信号量（上限 2 → 峰值 2、12/12 完成；0→8、100→64）与 `probeLocalKernel`（正确密钥 200 / 错误密钥 401 / 无前端 config 不崩）、`testPeerConnection` 新增 `repo` 步骤（真实内核返回 code -1 时判 ✘ 但整体仍 ok=true）
  - 手工测试用例：`docs/TEST-M2_zh_CN.md`（TC-M2-01 ~ TC-M2-14）
  - 产物：`release/package.zip`（103,758 B，SHA256 `F370B85D52B13556EC518073CD5846E23B9973968E707CB1FE0DD4CA32F23ECF`）、`release/better-sync-1.5.2+m2-20260924.zip`、`release/BUILD-INFO.txt`
  - 待用户自测：进度面板、并发上限行为、对端仓库状态与本机密钥自测、快照引导文案
- **2026-09-24｜M2.1 热修（用户首轮 M2 自测反馈：连点报锁错、进度不动、浮窗打扰）**
  - 代码：`src/api.ts`（请求级限流）、`src/libs/concurrency.ts`（双信号量：请求槽 + 操作槽）、`src/sync/sync.ts`（递归不再占槽；`started` 拦截；锁写入 instance-id + 自救 + 文案带锁龄）、`src/index.ts`（面板拖动/折叠/关闭 + 位置持久化 + 无传输失败不弹面板）、两个 i18n
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（81.8 kB → 85.3 kB）；node 实跑：双预算嵌套 10/10 完成（上限 2）、递归 968 次请求无死锁、**旧写法 3 秒必死锁（复现根因）**
  - 手工测试用例：`docs/TEST-M2.1_zh_CN.md`（TC-M2.1-01 ~ TC-M2.1-14）；`docs/TEST-M2_zh_CN.md` 的 TC-M2-03 预期已同步更新
  - 产物：`release/package.zip`（SHA256 `D58B270F92289A742DA55420A4C0FB71A9EAAB55E388CFDB180FFD835C0FB249`）、`release/better-sync-1.5.2+m2.1-20260924.zip`、`release/BUILD-INFO.txt`
  - 现场清理：电脑端残留锁（10:54 创建）已直接删除；手机端那份因手机休眠未连上，但已超过 5 分钟，会被自动忽略并覆盖
- **2026-09-24｜M2.2 请求槽泄漏修复（用户追问"并发=1 能跑吗"）**
  - 代码：`src/api.ts` 的 `getFileBlob`（`Promise.race` → `AbortController`，响应头到达即停表）
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（85.3 kB → 85.5 kB）；node 实测泄漏前后对比（9310ms → 105ms，槽位 1 → 0）+ 大文件 85,347 字节完整下载
  - 用例：`docs/TEST-M2.1_zh_CN.md` 新增 §2.1（TC-M2.1-15 并发=1 能跑完 / TC-M2.1-16 卡住的请求不再拖死全局）
  - 产物：`release/package.zip`（SHA256 `97B40355D68AC35789D95C0B260199E69AAF59FAB1F339000B725450268821BB`）、`release/better-sync-1.5.2+m2.2-20260924.zip`
- **2026-09-24｜M2.3 传输暂停 + 同步语义 FAQ**
  - 代码：`src/libs/concurrency.ts`（暂停闸门）、`src/index.ts`（面板 ⏸/▶ + 暂停态显示 + 命令 `togglePauseSync` + 结束自动清除暂停）、两个 i18n（新增 7 条）
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（85.5 kB → 87.1 kB）；node 实测暂停语义（暂停中 0 启动、恢复 5/5；中途暂停 4/4）
  - 文档：`docs/TEST-M2.1_zh_CN.md` 新增 §5（TC-M2.1-17 ~ 20）；本文档新增 §0.1「同步语义 FAQ」（连点行为、双向与同步范围、删除/冲突规则、时钟影响）
  - 产物：`release/package.zip`（SHA256 `519492F174728EA9C7EC95463876C14BB47F5AA807D8A6B528E1A525B3C1645A`）、`release/better-sync-1.5.2+m2.3-20260924.zip`
- **2026-09-24｜M2.4 重复点击提醒 + 取消传输**
  - 代码：`src/libs/concurrency.ts`（取消闸门 + `releaseNext()` 队列修复）、`src/api.ts`（getFileBlob 可中止 + 取消不重试）、`src/sync/sync.ts`（取消检查点 + 取消路径报告）、`src/index.ts`（⏹ 按钮、取消中/已取消面板态、`notifySyncAlreadyRunning()` 高亮提醒）、两个 i18n（新增 8 条）
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（87.1 kB → 90.0 kB）；node 实测取消语义（在飞 2 收尾 / 排队 4 拒绝 / 队列排空 / reset 可复用 / 暂停+取消不挂起）
  - 用例：`docs/TEST-M2.1_zh_CN.md` 新增 §6（TC-M2.1-21 ~ 24）
  - 产物：`release/package.zip`（SHA256 `5E731365581919E2EB9DA96F940FFE59BA66E45DD67A5421FAE156783F9EC5C8`）、`release/better-sync-1.5.2+m2.4-20260924.zip`
- **2026-09-24｜M2.5 按钮状态自洽 + 日志核对**
  - 代码：`src/index.ts`（`isSyncControllable()`：暂停/取消只在 准备/扫描/传输 显示；取消后 ⏸ 立即隐藏；`togglePauseTransfers()` 在取消中给提示）、两个 i18n（`progressPauseUnavailable`）
  - 日志核对结论（用户要求看日志）：重复点击拦截生效（`1790224397511.log` 有 `Sync is already in progress, ignoring this request.`，且该次同步最终成功、锁已释放）；全量日志无 `cancelled` → 用户点 ⏹ 时已在收尾阶段；无任何残留锁；`readDir` 超时重试后成功（手机休眠唤醒，M1-P5 重试在工作）
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（90.0 kB → 90.2 kB）
  - 用例：`docs/TEST-M2.1_zh_CN.md` 新增 TC-M2.1-25
  - 产物：`release/package.zip`（SHA256 `DF03B219474CECD44379EF2D8E5913A398D87A68B1885FF8D4B4EBA68ED005CF`）、`release/better-sync-1.5.2+m2.5-20260924.zip`
- **2026-09-24｜M3 完成（二维码配对 + 扫码接入 + 免重复扫码的连接历史）**
  - 新增：`src/libs/pairing.ts`、`src/libs/connections.ts`、`src/pairing-ui.ts`；`local-config.ts` 增 `getLocalCandidateUrls()/readLocalInstanceId()`；`settings.ts` 增三块 custom 设置项（二维码/接入/历史）；依赖 `qrcode-generator` MIT
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（90.2 kB → 126.4 kB，含二维码库）；**node 实跑 21 项断言全通过**（解析 10 + 存储 4 + 真实内核探测 3 + 候选轮询/指纹/无候选 3 + 无会话降级 1）
  - 用例：`docs/TEST-M3_zh_CN.md`（TC-M3-01 ~ 13，含"IP 变了也能找回"与"认错设备的保护"两条关键回归）
  - 产物：`release/package.zip`（SHA256 `D5BFAB75F3D9DF8AAF4E99D98892026D410B5CF7B460FD0D362FB66B1FB2A423`）、`release/better-sync-1.5.2+m3-20260924.zip`
  - 待用户自测：生成二维码、手机接入、一键连接、IP 漂移找回
- **2026-09-24｜M3.1 修二维码不可见 + 手机接入路径**
  - 代码：`src/pairing-ui.ts`（SVG 固定像素 + 尺寸兜底；新增「从剪贴板读取」）+ `src/libs/local-config.ts`（候选地址排序）+ 两个 i18n（新增 `pairingQrPhoneHint`、`pairingImportClipboard*`，改写 `pairingQrDesc`）
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（126.4 kB → 127.1 kB）；**浏览器实拍对比**（旧写法空白 / 新写法完整二维码）；node 实测 `createSvgTag` 两种形态的 svg 头（scalable 无 width/height，固定形态有 148px）
  - 用例：`docs/TEST-M3_zh_CN.md` 新增 §2.1（TC-M3-14 剪贴板读取 / TC-M3-15 直接粘贴 / TC-M3-16 插件内扫码），并修正 TC-M3-01 的预期
  - 产物：`release/package.zip`（SHA256 `E6AC7C822AD07F3EE2EE63DC2C09290DE46FE75977C98D8F46E02F39F70E093E`）、`release/better-sync-1.5.2+m3.1-20260924.zip`
- **2026-09-24｜M3.2 手机端扫码的真实解法（拍照识别）**
  - 代码：`src/pairing-ui.ts`（`pickImageFile()` + `decodeQrFromFile()` + 两个按钮）、依赖 `jsqr@1.4.0`、两个 i18n（新增 4 条）
  - 依据：实读 `siyuan-note/siyuan-android` 源码（`MainActivity.java` 的 `onPermissionRequest` 只放行 `RESOURCE_AUDIO_CAPTURE`；`onShowFileChooser` 支持 `<input capture>`）
  - 校验：`npx tsc --noEmit` 0 错误；`npm run build` 通过（127.1 kB → 259.1 kB，其中 jsQR 压缩后 130 kB）；node 实跑解码 5 种缩放尺寸全通过
  - 用例：`docs/TEST-M3_zh_CN.md` 新增 TC-M3-17（拍照识别）/ TC-M3-18（选图片识别），并在 §5 写明"为什么没有实时摄像头扫码"
  - 产物：`release/package.zip`（SHA256 `117A8BD969B1DBEBAF7DE51199C5490C7455C1AB4DAF79A0E633BC2FC4043DAF`）、`release/better-sync-1.5.2+m3.2-20260924.zip`
- **2026-09-24｜M3.3 扫码写入验证 + 两个小修**
  - 用用户实测数据核对（读取两端实际文件）：手机端 `menu-config.json` 已被自动写入 `siyuanUrl=http://192.168.100.42:6806` + 密钥，`connections.json` 记录了电脑指纹 `54899d17-…`/内核 3.8.5/`lastOkAt` → **扫码即自动填入并落盘、立即重init 同步、自动跑诊断、记入历史**（无需按确认、无需重载插件）
  - 修复①：`upsertConnection` 首次插入未去重（实测出现 `http://192.168.100.42:6806` 重复两次）→ 插入时也 `dedupe`；node 单测 PASS（含再次合并）
  - 修复②：`snapshotHint`（hint 项）被写进配置成 `null` → 改为 `getEleVal: () => undefined`，不再落盘
  - 重要发现（转 M4）：两端当前**互相指向对方**（电脑→168 手机、手机→42 电脑）→ 属"双主机互推"配置，M4 的角色声明/握手互认正是为此
  - 产物：`release/package.zip`（SHA256 `749EE501E62AD200D1CBEC8CA70084DFF60461A4D667F5C0ABA074952989B212`）
- [x] **M3.4 实时取景扫码（"能不能不拍照直接扫"）**
  - **新增 `startLiveScanner()`**：`getUserMedia({facingMode:"environment"})` 取流 → `<video>` 预览 → 每 **300ms** 抽帧、降采样到 **480px** → 有 `BarcodeDetector` 就用它，否则 **jsQR 逐帧解码**；命中即停流并自动填入/连接；按钮变「停止扫码」可手动停，**90 秒**自动停（防忘关摄像头）
  - 按钮显隐改为「有 `getUserMedia` 就显示」（不再要求 `BarcodeDetector`）
  - 失败分级：安卓 → 明确说明「App 只放行麦克风」并指引替代路径；其它平台 → 通用失败提示 + 替代路径
  - **澄清"拍照"的两件事**：① 照片**会进相册**（App `openCamera()` 把 `MediaStore.Images.Media.EXTERNAL_CONTENT_URI` 当输出目标，`MainActivity.java:1266`），插件无法删除，已在界面加提示；② **零照片的真实时扫码** = 手机相机/微信扫码 + 「从剪贴板读取」
  - 校验：`npx tsc --noEmit` 0 错误（修了 `getContext("2d", {willReadFrequently})` 重载与 jsQR `inversionAttempts` 取值两处类型问题）；`npm run build` 通过（259.2 kB → 260.4 kB）
  - 用例：`docs/TEST-M3_zh_CN.md` 更新 TC-M3-16 + §5 说明
  - 产物：`release/package.zip`（SHA256 `6D7CF8DD3AB3B4727EB8A744EC3040C2B324640B9540F8F3B6AEE7678BEA576A`）
- **2026-09-24｜M4 完成（双端角色 / 握手互认 / 锁心跳 / 方向所有权）+ 按用户要求移除摄像头扫码按钮**
  - 移除：`startLiveScanner()` 与「用摄像头扫码」按钮及相关 i18n（安卓不可用、桌面用不到；拍照识别与剪贴板读取保留）
  - 新增：`src/libs/roles.ts`（角色/锁/发起权纯逻辑）；`sync.ts` 增 `getLocalRole()/instantSyncAllowed()/checkInitiationAllowed()`、锁升级为 JSON+心跳（`writeLock/readLockContent/startLockHeartbeat`）、`syncHandler(persistentMessage, remotes, trigger)` 闸门 + 拒绝提示；`settings.ts` 增「本机角色 / 方向所有者 / 当前同步角色与方向」；`index.ts` 增 `notifySyncRefused()`，onLayoutReady 的自动同步走 `trigger="auto"`
  - 校验：`tsc` 0 错误；**node 实跑 24 项断言全过**（锁解析 3 + 角色声明 2 + 心跳陈旧 5 + 方向所有者 2 + 发起权 12 组合）；`npm run build` 通过（260.4 → 265.4 kB）
  - 关键验收：双端 host 且本机非所有者 → **自动与手动都拒绝、零文件传输**；6 分钟长同步因 30s 心跳**不再被判陈旧**；方向所有者实测 = 电脑（`54899d17…` < 手机 `606d5c4b…`，正好是常年开机那台）
  - 用例：`docs/TEST-M4_zh_CN.md`（TC-M4-01 ~ 11）
  - 产物：`release/package.zip`（SHA256 `E83FC9F84BF94F515397ADA1C7765B61719AEB2A8A65E771C8E97A4E7F439013`）、`release/better-sync-1.5.2+m4-20260924.zip`
  - ⚠️ 注意：**手机端必须也更新到这一版**，否则对端读不到 `role.json`，自动同步会被安全拦下（手动仍可）
- **2026-09-24｜M5 完成（选择性同步：自选笔记本 / 目录 / 通配排除规则）**
  - 新增：`src/libs/sync-config.ts`（选择模型 + 通配匹配 + 目标过滤 + 单文件判定，纯逻辑）；`sync-targets.ts` 增可选 `syncConfig` 与 `SYNC_DIR_PATHS` 导出；`sync-utils.ts` 排除改为 glob 匹配；`sync.ts` 增 `getSyncConfig()/invalidateSyncConfig()/isPathSyncable()` 并在**唯一传输出口** `executeSyncOperation()` 加守卫；`settings.ts` 增「选择性同步」UI
  - 设计要点：默认"排除为空＝全选"（升级零行为变化）；取消勾选只停止比对与传输、**不删除任何数据**；生效范围由发起同步的一方（结合 M4 方向所有权）决定
  - 校验：`tsc` 0 错误；**node 实跑 32 项断言全过**（默认/两模式/父子覆盖/`*` `?` `**`/元字符转义/规则继承/并入 excludedItems/单文件判定/脏配置容错）；`npm run build` 通过（265.4 → 272.8 kB）
  - 用例：`docs/TEST-M5_zh_CN.md`（TC-M5-01 ~ 13）
  - 产物：`release/package.zip`（SHA256 `A5659D55053EC2BDE78F7BF44F467C65F22FE6AA953ECBE9F4C5FD717AE4F617`）、`release/better-sync-1.5.2+m5-20260924.zip`
- **2026-09-24｜M5.1 嵌套子文档规则修复 + 回归测试固化**
  - 用户提问"嵌套子文档能选吗／选了父文档子文档会被选吗" → 用真实工作区路径回归，**发现并修复**：笔记本根目录层的规则被 `continue` 跳过（父文档本体排不掉）
  - 新增：`tests/run-tests.mjs`（`npm test`，63 项断言，覆盖 M4 角色/锁 + M5 选择/嵌套场景），把原先散落的临时 node 脚本固化为永久回归（贯穿项之一，部分完成：并发与 URL 两项仍待补）
  - 校验：`tsc` 0 错误；`npm test` **63/63 通过**；`npm run build` 通过（272.7 kB）
  - 产物：`release/package.zip`（SHA256 `44B5FD3C331E00047792E8C44AE617C1E7298FF1A732CED05C52D6CBCA28A988`）、`release/better-sync-1.5.2+m5.1-20260924.zip`
  - 待确认：是否需要"文档级勾选"（树形 UI，勾父带子）→ 记为 M5.2
