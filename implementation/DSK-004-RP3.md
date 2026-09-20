# DSK-004-RP3 实施报告（coder: director-coder / GLM）

- 任务：统一 host16 上传/下载及未终结初始化配额（批准计划 plan-sess_0f45933a-bf18-47df-952f-6fdc936de21f.md 第 14/30 行 RP3 项；任务单 `.zcode/workflows/tasks/DSK-004-RP3.yaml`）
- 源码根：`E:/myProgram/DirectorDesk/director-desk-web`；基线：HEAD `cc10acef36f971cfa2ad1ad82bdbd342679c01d1`
- 初始工作树：仅主会话的 RP2 / RP2-ownership-01 两处 PASS 登记修改 + 本任务单（未提交，全部保留，未触碰）
- 当前状态：**RP3 独立局部 PASS（2026-09-20，agent_441e1fc6-a996-4fe5-be6f-0e1d2aa9eacb）；DSK-004 整体仍未完成，RP4 未启动。** 以下原实施/返工记录保留历史语境；本次审查基线为 `1536c2ad2aaf44b6d168075b8248d93c05c3cfe1`，本机根为 `E:/director-desk/director-desk-web`。审后登记未提交/推送。

## 2026-09-20 独立最终复审（主会话登记）

结论：**PASS，仅限 DSK-004-RP3**。原首轮 REWORK 和一次窄返工保留；远程记录的额度中断没有结论，不计新返工。无阻断项，N1 为低严重度文案订正。

### 验收表

| 项目 | 判定 | 独立核实依据（代码位置为审查时行号） |
|---|---|---|
| A1 | PASS | 16 pending 下载占满、第17零新增I/O；ready/非末块保留、末块释放。storage测试2285—2342。 |
| A2 / R2 | PASS | mixed满16双向拒绝；16真实ready上传后的第17下载拒且getObject=0。storage测试2344—2444。 |
| A3 | PASS | 15槽同tick双方向竞争仅一准入，败者不启动I/O。storage测试2446—2493。 |
| A4 | PASS | abort/expiry/取消循环及上传reload/close共同路径，map/session归还后未settle仍占permit。storage测试2495—2656、3115—3201；service255—283。 |
| A5 | PASS | handoff同一permit；迟到resolve/reject不成功、不复活、不多释放。storage测试2658—2898。 |
| A6 | PASS | 初始化失败与ready终态、提交/登记失败、末块释放，非末块保留。storage测试2900—3055、3203—3248及既有expiry532—545。 |
| A7 / R1 | PASS | 同session resolve/reject、reload新代、跨frame四例均先新登记再旧settle，检查对象同一性/槽/permit2降1及真实完成；sender销毁不遗留。storage测试2716—2898、3057—3082。 |
| A8 | PASS | frame每方向1和session互斥不变，公共契约未变。storage测试3084—3113。 |
| A9 | PASS | handler挂起blocked→独立cleanup挂起仍blocked且close0→cleanup完成close恰1，重复dispose仍1。dispose测试731—813。 |
| R3 | PASS | open包装器门后真实open/close、自身.part清理；合法文档实际到commitSnapshot后注入失败；A9三阶段与close计数。storage测试3115—3248及dispose测试731—813。 |

### 本次新证据索引

证据根：`E:/director-desk/review-rp3-20260920T065343Z-e28d562a/evidence/`。运行CWD为同级 `workspace/`。以下每个名称均有 `.raw.log` 完整日志和 `.json` 命令/环境/退出码回执。

| 名称 | 命令及结果 |
|---|---|
| `review-two-suites-1789887374733` | `node --experimental-strip-types --test tests/dsk-storage.test.cjs tests/dsk-rp2-dispose.test.cjs`；exit0，86/86。 |
| `review-npm-test-1789887406881` | `npm test`；exit0，558/558。 |
| `review-parent-rp3-1789887571353` | 同两套文件加 `--test-name-pattern RP3`；同时设置 `DSK_RP3_SERVICE_ENTRY` 和 `DSK_RP2_SERVICE_ENTRY` 为新父基线入口；exit1，10行为红/11控制绿。 |
| `review-current-rp3-1789887612030` | 同RP3命令，清除上述两个快照入口变量；exit0，21/21。 |

父基线入口：隔离workspace下 `tmp/rp3-parent-796b980a/desktop/storage/service.cjs`，从完整Git提交 `cc10acef36f971cfa2ad1ad82bdbd342679c01d1` 用 `git show` 导出原字节，SHA256 `e8ed25eb5dc8855b89eb4f2fdf2bb1a85c2d8b414460dfb7bdbcecb0640b21c6`。来源清单 `parent-baseline-rp3-parent-796b980a-manifest.json`；依赖均来自同一父提交，LF/CRLF差异见 `parent-baseline-line-ending-comparison.json`，未更改快照字节。

- 父基线10行为红：A1、mixed A2、R2真实16上传、A3、A4四项、A7、R3 open尾段；无前置解析红。
- 11控制绿：A5、R1四项、A6三项、A8、R3登记失败、A9。A9确实消费RP2入口变量并在父基线执行，不是当前源码冒充。
- `source-copy-manifest.json` SHA256：`35f13f552930b14bd4d99984d2d42d13bebf32af789a6c9ac4d99364d187d47b`。`review-protection-1789887632360.json`证明审后登记前617 tracked+1 untracked在源/副本1236次hash比对零差异。
- 当前service SHA256：`bb7224bd91aa8b96d916918208c57e4cba98699a0882c8b61649a32edfd6fc40`。dispose测试本机CRLF字节hash为 `c836cbf23f78db8edebb650dd920d8f2ab1be0bb8fcbc0f4b928b688f6af06d2`；LF归一对应旧报告 `0759ee92…`，不误判业务差异。

### 保留边界与非阻断订正

N1：进度文案曾将首轮mixed红例误写为16真实上传方向。首轮mixed为8 ready上传+8 pending下载后的第9次getObject，16真实上传方向由round1 R2独立补测；主会话已订正进度文案，不影响A2/R2通过。

旧 `tmp/dsk-004-rp3-coder-20260919T015354Z/` 本机实际不存在；本次Git父基线新对照不等于恢复旧日志，不追认旧快照hash或历史失败归因。历史npm偶发失败原因仍未证实，本次558全绿不能证明其“非回归”。

A4/A6结合已运行场景及共同调用链，不声称穷举所有方向×取消原因。open屏障是包装器调用边界，释放后执行真实open/close，非OS内核挂起；登记失败为明确注入，非真实SQLite锁竞争。

未重跑SQLite gate、build/prepare、桌面脚本；RP1/RP2既有状态保留。原生UI、Windows11、断电及安装包未验收；不推进RP4，不将DSK-004整体标为PASS。以下旧记录保持其当时语境，证据声明不等于本机已恢复原件。

## 实际缺陷（修前核实）

1. `storage.v1.snapshot.read` 缺少 host 级总数检查：同步登记 map/session 前只查 session 互斥与 frame 方向数，`transfers.size >= 16` 从未检查 → 第 17 个跨 frame 下载直接进入 `store.getObject` I/O。
2. 仅补 size 检查不够：pending 初始化被取消时 `cancelTransfer` 立即删 map/释放 session 槽，而 `getObject`/`trustedSubdir+open` 仍在飞 → 旧实现下 map=0 可反复重入，取消循环可累积任意个并发初始化（实测旧源码 16 取消 + 16 重发 = 32 并发 getObject）。
3. `snapshot.read` 的 `requestGone()` 迟到分支（如 sender 已销毁但无 close 事件）只 `return fail`，map/session 槽/宿主占用全部泄漏（旧源码实测僵尸 transfer 留在 map）。

## 实现（仅 desktop/storage/service.cjs，+91/-15 行级增量）

- **独立身份 permit set**：`hostPermits = new Set()`（上限 `HOST_MAX_TRANSFERS = 16`）。transfer 对象即身份：初始化（上传 `trustedSubdir`/`open`，下载 `getObject`）未终结或 ready 任一成立持有恰 1 permit，两者同时不双计；pending→ready 保持同一 permit 不释放重取。`releaseHostPermit` 为 Set.delete，幂等，迟到 settle 只操作自己身份。
- **原子预留**：两方向均在第一个 await 前同步完成 `hostPermits.size >= 16 || transfers.size >= 16` 检查 + map 登记 + session 槽 + `hostPermits.add`；第 17 个同步拒绝（冻结理由 `storage.v1/transfer-limit`），不进任何 I/O。
- **取消语义**：`cancelTransfer` 立即删 map/清 session 槽；`transfer.initializing === true`（初始化 I/O 在飞）时 permit 保留，由初始化续延在 settle 时（先清 `initializing` 再幂等释放）归还；初始化永不 settle 则持续占 permit，无 fake 超时清零。ready 取消（abort/expiry/close/reload）即时释放，其后 close/rm 属 RP2 清理跟踪，不再占宿主。
- **上传覆盖面**：`trustedSubdir` 之后新增中途活性复查（cancel/map/session/requestGone），取消可跳过尚未启动的 `open`，就地终结 permit 与 rm；open 失败 catch 与 open 后迟到失败路径均先清 `initializing` 并幂等释放；成功则 `initializing=false` 完成同 permit handoff。
- **下载覆盖面**：`getObject` 以 `initializing=true` 包裹（finally 清标志）；settle 后的取消/requestGone 分支改为主动 `cancelTransfer('session-closed')` + 幂等释放——覆盖 sender 销毁无 close 事件分支；catch 路径幂等释放；末块 `final` 归还 permit，非末块保留。
- **身份守卫**：`cancelTransfer` 入口改为 `transfers.get(id) === transfer` 才动；session 槽仅在 `session.slot === id` 时清除（commit 仲裁区、末块路径同样加守卫）——旧传输迟到 settle 不能影响同 session 新传输。commit 的 permit 释放在 RP1 零 await 仲裁区内同步完成，未插入任何 await。
- **RP2 排空不受影响**：permit 不参与 `performDrain` 条件；被取消 pending 的 handler 本身计入 `pendingOperations`，dispose 仍等其 settle；初始化永不 settle 时 blocked/timeout 如实、DB 保持打开。
- **`_internal.hostPermitCount()`**：新增只读检查钩子（非公共 IPC 面），供测试断言精确记账。

未改：公共契约、host16、64MiB、frame 每方向 1、session 互斥、objects/读取算法（RP4）、退出架构、依赖与脚本。

## 测试（真实场景，不用内部数值伪造；屏障 finally 必释放）

- `tests/dsk-storage.test.cjs` 新增 RP3 段 13 用例（真实 `objects`/`library`/`randomUUID` 既有 DI，快照同构可跑；`DSK_RP3_SERVICE_ENTRY` 指向修前快照即红跑）：
  - A1：16 跨 frame pending 下载占满，第 17 个同步拒且 getObject 仍 16；handoff 后 16 ready 仍拒；非末块保留/末块归还后第 17 个准入（48KiB×3 真实多块文档）。
  - A2：8 ready 上传 + 8 pending 下载混满 16，第 17 下载与第 17 上传双方向均拒且无新 I/O。
  - A3：15 槽时 U→D、D→U 同 tick 竞争末槽，恰 1 胜出，败者零 I/O。
  - A4×4：abort pending 后 map15/槽释放但重传仍拒（settle 后同 session 重试准入）；取消循环 map=0 重发 16 全拒（并发峰值计数 ≤16，旧源码实测 32）；上传 pending 经 reload 取消后宿主仍满（settle 后准入、无 .part 残留）；sweeper idle 过期同语义。
  - A5：迟到 resolve/reject 如实失败、不复活、恰释放一次；同 session 替代完整走通。
  - A6×3：上传初始化失败（uploads 变文件、真实 'wx' 碰撞）、下载初始化失败（未知快照/查询抛错/对象读失败）逐路径释放并同 session 准入验证；ready 终态（末块/commit 成功/commit 失败/ready abort/reload）逐一精确释放。
  - A7：sender 销毁无 close 事件 → settle 后 map/permit 零遗留（旧源码红）；新 frame 下载准入证明宿主未漏。
  - A8：frame 每方向 1 与 session 互斥语义保持。
- `tests/dsk-rp2-dispose.test.cjs` 仅新增 A9 兼容用例（挂起初始化 + dispose：map 先清零、排空仍等 handler → timeout blocked DB 开；settle+清理后重试恰关一次），未弱化任何旧断言。

## 红先绿后证据（tmp/dsk-004-rp3-coder-20260919T015354Z/，旧证据未动）

- 修前快照：`pre-fix/desktop/storage/service.cjs`（sha256 `3f5a751f…`，基线真字节）；兄弟 objects/library/contracts 为工作树同字节副本仅为本 bundling 解析（`PRE-FIX-PROVENANCE.txt`、`pre-fix-sibling-provenance.txt`）。
- 红跑（`DSK_RP3_SERVICE_ENTRY` 指快照）：`red-storage-rp3.log` EXIT=1——13 用例恰 8 红且全部红在具名 RED 断言：17 下载=17 次 getObject；**mixed（8 ready 上传+8 pending 下载）的第 9 个下载=9**（非"16 真实上传之后的第一个下载"，该方向由 round1 新增独立用例补足）；15 槽同 tick 败者启动 I/O=16；abort pending 后 map0 替换入=17；map0 取消循环累积=32 并发；上传 pending 取消后新上传 trustedSubdir=17；sweeper 过期重入=32；sender 销毁僵尸=1。5 个对照（A5/A6×3/A8）绿。`red-rp2-dispose-rp3a9.log` EXIT=0（A9 对旧源码也绿，符合兼容设计）。attempt1/2/3 日志原样保留（1/2 为快照兄弟模块解析 harness 失败，3 为测试期望修正前）。
- 绿跑：storage RP3 13/13 EXIT=0；A9 1/1 EXIT=0；两套件全量 79/79 EXIT=0；npm test 551/551 EXIT=0（`green-npm-test-2.log`）。
- 逐命令 CMD/UTC/CWD/EXIT 见 `COMMANDS.txt`；基线/最终源 hash 见 `baseline-source-hashes.txt` / `final-source-hashes.txt`。

## 如实保留的问题与边界

- 修后首次 `npm test` 550/551（`green-npm-test.log`）：唯一失败为**既有** RP2 F1 用例（挂起 handle-close 重试）的 `closeParked >= 1` 断言。**具体原因未证实**：仅能确认该用例时序不确定（其重试启动节奏位于 100ms dispose 预算内）；不声称已确定"冷负载"成因，也不声称生产回归。该机制（重试节奏/预算）RP3 零触碰；同用例在两套件 79/79、独立 dispose 套件连续 3 次 15/15、npm 立即复跑 551/551 及 round1 两次 npm 全量中未再失败。按任务边界（不重写 RP2 drain、dispose 测试文件仅限新增 A9）未改动该用例，留给 reviewer/后续任务裁量。
- 红跑早期 attempt1/2 为快照 bundling 的兄弟模块解析失败（非业务红），原样保留并注明。
- 原生 UI/真实 Electron/退出桌面脚本属 RP2/RP8 边界，本轮未运行；未 commit/push。

## 验收标准对应（任务单 acceptance A1–A9）

| 项 | 结论 | 证据 |
|---|---|---|
| A1 16 pending 下载占满/第 17 拒且 I/O 仍 16 | 通过（红→绿） | red/green-storage-rp3.log A1 |
| A2 混合（8 ready 上传+8 pending 下载）满 16 双方向拒（round0 红→绿）；16 真实上传满槽后第 17 下载拒且零 getObject（round1 补，旧码红→修后绿） | 通过 | red/green-storage-rp3.log A2；round1-green-new.log / round1-r3-snapshot.log R2 |
| A3 15 槽 U↔D 同 tick 恰 1 胜、败者零 I/O | 通过（红→绿） | 同上 A3 |
| A4 abort/expiry/close/reload 取消 pending：map/session 归还、宿主仍占；两方向；无第 17 初始化累积 | 通过（红→绿） | 同上 A4×4 |
| A5 handoff 无双计无空档；迟到 resolve/reject 不成功/复活/多释放 | 通过（红绿均绿+红跑对照） | 同上 A5 |
| A6 各失败/终态路径精确释放、非末块保留 | 通过 | 同上 A6×3 |
| A7 旧传输迟到不清新槽/permit；sender 销毁无 close 不遗留 | 通过（A7 红→绿；守卫由 A5/A7 钉住） | 同上 A7 |
| A8 frame 每方向 1、session 互斥保持 | 通过（新 A8 + 既有用例不回归） | 两套件 79/79 |
| A9 取消 pending 后 map0 但 dispose 等待/blocked DB 开/settle 后恰关一次 | 通过（新旧源码均绿；round1 扩为三阶段并加 db.close 计数） | red/green-rp2-dispose-rp3a9.log；round1-green-new.log A9 |

## ROUND 1 窄返工记录（审查 agent_a4dacbb5-2523-4b73-b5ef-393aad21ca07 REWORK：R1/R2/R3 覆盖与声明问题，无已证生产缺陷；本机 2026-09-19，coder 已验证，待复审）

**原则执行情况：service.cjs 零改动**（round1 前后 sha256 均为 `bb7224bd…`），仅改两个测试文件与记录；未发现需生产修改的已证缺陷。round1 前测试源快照与哈希存 `tmp/dsk-004-rp3-coder-20260919T015354Z/round1/pre-round1/`。

**R1（旧迟到 settle 不清新槽的证明力不足）**：原 A5 的同 session 替代发生在旧 gate settle 之后，不能证明"旧请求迟到不清新槽"。新增 4 个用例（`RP3 R1 *`），使用逐调用独立可释放的真实 getObject 屏障（`io.callGates` FIFO）与确定性到达信号（`rp3Arrival`：包装器进入即 resolve，配 3s 有界超时，无 sleep 猜时序）：旧 pending 取消**未 settle** → 同 session 新 transfer 已占 map/session/permit → 旧 resolve 或 reject 迟到落地。断言新 transfer 的 map 对象**同一性**（`transfers.get(id) === before`）、session 槽仍属新 id、permit 恰降 1、新传输真实走完（read 成功+逐 chunk 到 final）。另覆盖 reload 新代（frameGeneration 断言跨代）与跨 frame 身份变体。结果：修后 4/4 绿；旧快照也 4/4 绿——**如实标为覆盖性控制**（旧码迟到 settle 本就不触碰新登记，用例钉住该语义防回归）；permit 计数断言在旧源自动跳过（无钩子），其余断言新旧可比。

**R2（名称失实+16 真实上传方向缺测）**：原 A2 名为"16 uploads"实为 8 ready 上传+8 pending 下载——保留用例并改名为"mixed"准确表述；旧红 getObject=9 **更正为 mixed 的第 9 个下载**，非"16 上传后的第一个下载"（旧 tmp 日志不改，此处与任务单 check 已纠正）。新增独立用例 `RP3 R2 red`：16 个真实完成的上传占满 host，第 17 个下载被 transfer-limit 同步拒绝且 getObject 调用数为 0、清槽后准入并真实走完。**旧快照红**（该方向此前无具名红，现为有效红）；修后绿。

**R3（open 尾段/DB 登记失败/A9 收尾三补）**：
- `RP3 R3` open 尾段：真实 fsp.open 门（RP1 fsp wrapper 扩展 openMatch/openGate/openProxyMatch/handleCloses，未武装全透传，旧/新源均可达）——15 个 ready 上传 + 1 个 open 已启动未返回的上传占满 host，单独 project.close 取消后者：map 立即 15、permit 撑满（修后）；第 17 上传同步拒；释放 open 门后迟到 handle 真实 close（代理计数差分>0）、begin 如实失败 unknown-session、其 .part 清理而其余 15 个活跃 .part 仍在、腾出的槽真实准入替代。**定位为覆盖用例**；实测旧源在"第 17 准入"断言处红——这属于 round0 已修"取消 pending 删 map 允许重入"同一缺陷族在 open 尾段的体现（permit 保留已覆盖），**不是新发现的生产缺陷**，并有独立探针（esbuild 打包旧快照复现同序）佐证，未据此改生产。
- `RP3 R3` DB 登记失败：合法文档全量上传后注入 `db.commitSnapshot` 抛错（database-locked，区别于 badJSON 的 upload-format）——map/槽/permit 释放、revision 不动、故障解除后同 session 真实保存成功。新旧源均绿（覆盖性）。
- A9 重写为三阶段：①handler 挂起→dispose blocked/DB 开/db.close=0（同步断言 map 清零，到达用 entry 信号）；②settle 后 handler 结束但 **detached cleanup rm 独立挂起**→再次 dispose 仍 blocked/DB 开/close=0；③cleanup 落地→重试关库且 **db.close 计数恰 1**、重复 dispose 返回缓存结果计数仍 1（dbOpen false 不再作为 close-once 证据）。关闭计数经 library 包装器实测；新旧源均绿（兼容覆盖）。

**ROUND1 验证**（逐条 CMD/UTC/CWD/EXIT 见 COMMANDS.txt ROUND1 段）：新/改名用例工作树 9/9 绿（`round1-green-new.log`）；快照行为定界（`round1-snapshot-behavior.log` 及修正入口后的 `round1-r3-snapshot.log`，其中 R3-a 首次快照跑因 `buildGatedService` 未走 DSK_RP3_SERVICE_ENTRY 实际打包了工作树源——结果作废已注明并被修正跑取代）；RP3 全集 21/21 绿（`round1-green-rp3-all.log`）；两套件 86/86 绿（`round1-green-two-suites.log`）；npm test 首跑 546/558——两个失败文件（desktop-dev launcher 子进程状态 null、dsk-rp2-exit 自 209 起 event-loop 级联）**均非本任务改动文件**，隔离复跑分别 3/3、24/24 全绿，成因未证实（仅记录为负载/顺序抖动疑点，不声称生产回归，旧日志原样保留）；立即复跑 558/558 绿（`round1-green-npm-2.log`）。round0 的 F1 closeParked 失败在本两轮 npm 未复现。

**ROUND1 测试源最终哈希**：dsk-storage `568dbe94…`、dsk-rp2-dispose `0759ee92…`、service `bb7224bd…`（未改）。未 commit/push；父 DSK-004 仍 REWORK，RP4 未启动。
