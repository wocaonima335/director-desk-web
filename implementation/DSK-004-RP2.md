# DSK-004-RP2 实施报告：确认保存后可等待的存储排空与统一退出

- 状态：REPLAN（第 2 次独立审查最终 agent_ee46ca0e 未通过，F3/F4 转入批准的关联任务 **DSK-004-RP2-ownership-01**，见文末实施记录；原两轮返工与 REPLAN 历史登记保留。ownership-01 已 IMPLEMENTED 待独立审查；不代表 DSK-004 整体 PASS，父任务仍 REWORK，RP3 未开始，未 commit/push）
- 任务单：`.zcode/workflows/tasks/DSK-004-RP2.yaml`（批准计划：远程 RP1-RP8 总体计划 + 本会话 ExitPlanMode 明确批准 files.cjs 内部接口/clean idle 退出确认 UX/三个测试文件及精确 ignore 例外）
- 源码根：`E:/myProgram/DirectorDesk/director-desk-web`；基线 `99c2582ee50e7abe1caa480628db360dd3fd9e66`，继承 RP1/validation-01 全部未提交改动（原样保留，未回滚未重做）
- 证据目录：
  - 前次被打断会话（实现+首轮红绿验证，原样保留）：`tmp/dsk-004-rp2-coder-20260917T091520Z/`
  - 本续接会话（exit 桌面脚本 + 全量重验，逐命令 CMD/UTC/CWD/EXIT）：`tmp/dsk-004-rp2-coder-20260918T013213Z/`

## 会话交接说明（如实）

前次 RP2 coder 调用（agent_c9e95a7a）在完成五个源文件实现、两个单元测试文件、具名红反例与首轮全量验证后被中断，未交付任何成功报告。本会话核实：源码 mtime（02:24—02:26 修复，测试 02:32—02:33 定稿）早于该会话全部绿日志（02:33—02:42），即当前工作树与已测绿状态逐字节一致（前会话 `source-hashes-before.txt`/`prefix-snapshot-hashes.txt` 记录修前快照 sha256：service `15f4d748…`、files `c16b9bbf…`）。本会话在其基础上仅补齐缺失项：`scripts/test-dsk-rp2-exit-desktop.mjs`（新建）、`.gitignore` 精确白名单例外、`implementation/DSK-004-RP2.md`、进度记录、任务单回填，并在全新构建产物上完整重跑全部验证。无本任务残留进程；未杀任何全机 node/electron。

## 反例先行（CP0，未修改实现上真实失败）

具名反例 CE1—CE4 经 `DSK_RP2_SERVICE_ENTRY`/`DSK_RP2_FILES_ENTRY` 指向归档修前快照运行（`red-ce-attempt2.log`，退出 1，4/4 红；失败信息均为旧行为断言，非"缺少新 API"报错）：

| 用例 | 修前实际失败（摘要） |
|---|---|
| CE1 冻结业务时钟 + 挂起请求 | `仍有请求未完成时禁止伪报正常关闭（原实现在业务时限到达后直接关库并返回）` |
| CE2 加速业务时钟 + 请求未完 | dispose 在请求仍 pending 时即关库（伪正常关闭） |
| CE3 脱离 transfer map 的后台清理 | `脱离 map 的后台清理未完成时禁止伪报成功/正常关闭` |
| CE4 保存回执 | `保存回执不得自行关闭窗口（原实现回执里直接 window.close()）；关闭责任归统一退出协调器`（closeCalls 1!==0） |

如实注明：首轮红跑 `red-ce-prefix.log` 因快照兄弟模块解析失败（esbuild 无法 resolve `./objects.cjs` 等，harness 问题非缺陷复现）退出 1，原样保留未补造；attempt2 修正快照目录结构后 4/4 真红。修后同组用例随全量单元转绿（见验证表）。

## 实现内容

1. **`desktop/files.cjs`**：原 closeRequest/allowClose 对替换为共享可等待确认。`confirmExit()` 弹三选原生框（**clean idle 也确认**：主进程不与 renderer 握手 dirty，超出本轮范围）；"保存并退出"经 `sendSaveRequest()` 发 `director-save-before-close`（带随机 id），回执 `director-save-close-result` 仅解析**自己的 id**（旧回执/伪造 id 拒绝），且**回执绝不自行关窗**——最终关闭归统一协调器；取消/保存取消/保存失败 resolve `'cancelled'`，窗口与存储服务保持完全可用；进行中重复确认共享同一 Promise；`did-start-loading` 作废进行中确认（如实 cancelled）；renderer beforeunload 导航保护保持同步框，其"保存并退出"经 `preventUnload` 返回 `save-exit-requested` 并入同一共享请求。
2. **`desktop/main.cjs`**：导出 `createExitCoordinator`（纯工厂，单元可测）。状态机 OPEN→CONFIRMING→DRAINING→READY→FINALIZING；`handleClose`/`handleQuit` 同步拦截（重入并入同一 flow，不发起第二次确认）；`prepareUpdateExit` 仅当取得 update 所有权且排空 READY 才 true，update 路径不自行关窗（quitAndInstall 归安装器）；blocked（超时/清理失败/关库失败）弹原生"退出受阻"提示，继续等待=同额预算重试同源工作，取消=解锁回 OPEN 不恢复已停 service 的编辑（不假装可继续保存）；`setInteractionLocked` 排空期间 `window.setEnabled(false)`；成功路径恰一次 `finalizeClose()`；`before-quit` 拦截 + `unloadAllowed()` 放行 will-prevent-unload。
3. **`desktop/storage/service.cjs`**：`dispose({timeoutMs})` 为唯一停服路径——首个 await 前**同步**拒新请求、推进 frameGeneration（RP1 失效语义延续）、停 sweeper；排空覆盖会话取消（closeFrameSessions 聚合，**刻意不注册进自身等待集合**避免自等死锁）、`pendingOperations`（R10 handler 计数）与 cleanup registry（`pendingCleanups`：脱离 transfer map 的清理/等待期间新增清理均跟踪并自移除）；预算为**独立真实时钟**（`Date.now()`，业务注入 `now` 冻结不影响退出等待）；超时/清理失败/`db.close()` 抛错均返回显式 blocked（含 pending 明细），**DB 保持打开，不重建不假装恢复**；重复/并发 dispose 共享同一 drainPromise，成功 `closedResult` 恰一次缓存，blocked 可控重试；unavailable 降级服务 dispose 返回一致成功形态。
4. **`desktop/integration.cjs`**：`prepareExit` 接线 `storage.dispose`；非打包测试构建允许 `DIRECTOR_STORAGE_DISPOSE_TIMEOUT_MS`（≥250ms）缩短真实预算（镜像 lease TTL 覆盖先例），打包构建恒用服务默认；`closed` 路径 `storage.dispose()` 兜底保持。
5. **`desktop/updates.cjs`**：`confirmInstall` 确认框后 `await exit.prepareUpdateExit()`——只有取得 update 所有权且统一排空 READY 才进入 `install`；`install` 同步一次性授权后 `quitAndInstall(false, true)`；取消/受阻/竞争均如实上报（phase 停留 downloaded，零安装）。未改 update-host，无真实下载/安装。
6. **测试**：`tests/dsk-rp2-dispose.test.cjs`（CE1—CE3 + dispose 共享/恰一次/清理失败/关库失败/同步停服/等待期新增清理/unavailable 共 9 例）、`tests/dsk-rp2-exit.test.cjs`（CE4 + 协调器取消/成功/重入竞争/blocked 重试与取消/update 所有权/排空崩溃 + files 共享确认/旧回执拒绝/导航保护/reload 作废 + 真实 updates.cjs 接线三例：drain 先于 install 恰一次、取消零安装、blocked 零安装——FakeUpdater 仅替身传输层，真实 main/files/updates 源码参与）。
7. **`scripts/test-dsk-rp2-exit-desktop.mjs`**（新建，真实 Electron A6）：三个真实进程跑 `.audit/desktop-app`。Phase A：close 取消→窗口保留可交互+存储服务仍可用（bootstrap ok）+零受阻提示；close 确认保存→确认→排空→关窗→退出，文档真实写盘。Phase B：`app.quit()` 全程恰一次确认、单一共享流程、干净退出。Phase C：真实 `storage.v1.backup.create` 挂在（stub 的）目录选择器上持有 pendingOperations→排空 700ms 真实预算超时→原生受阻提示（标题/按钮/明细断言）→取消后窗口保留解锁+新 dsk 请求如实拒绝（`storage-unavailable`/`存储服务已停止`）→释放选择器后再次 quit 走**真实受控重试**干净退出。主进程对话框为 CDP 注入 stub（原生框不可 CDP 驱动），驱动的产品接线为真实代码，证据标签严格区分；before-quit 终点挂起机制仅服务证据采集。
8. **`.gitignore`**：仅新增已批的精确白名单 `!/scripts/test-dsk-rp2-exit-desktop.mjs`（沿用 DSK-004 storage 脚本先例格式），其余 ignore 规则零改动。

公共 IPC/preload/renderer/schema/package/依赖/update-host 均未动；未强制产品退出、未 window.destroy、未清 dirty 绕确认、未 timeout 后强关 DB 或重建假恢复。

## 验证（本会话真实退出码，日志在 `tmp/dsk-004-rp2-coder-20260918T013213Z/`）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --experimental-strip-types --test tests/dsk-rp2-dispose.test.cjs tests/dsk-rp2-exit.test.cjs`（`green-rp2-units.log`） | 0 | 23/23（含 CE1—CE4 转绿） |
| `npm test`（`npm-test.log`） | 0 | 522/522（RP1 后 499 + RP2 新增 23） |
| `npm run build`（`npm-build.log`，含 tsc） | 0 | 通过 |
| `npm run desktop:prepare`（`desktop-prepare.log`） | 0 | 新产物经标记预检含 RP2 接线（createExitCoordinator/退出受阻/prepareUpdateExit） |
| `node scripts/test-files-desktop.mjs`（`desktop-files.log`） | 0 | 9 检查全过（含 save finishes before exit / discard unchanged，RP1 保护不回归） |
| `node scripts/test-dsk-storage-desktop.mjs`（`desktop-storage.log`） | 0 | 全阶段通过（双真实进程 lease/generation/reload 失效等，RP1 不回归） |
| `node scripts/test-dsk-rp2-exit-desktop.mjs`（`exit-desktop.log`） | 0 | PHASE-A1/A2/B/C1/C2 全过（真实 Electron 五段） |

前次会话独立绿证据（同源码状态，原样保留于 `tmp/dsk-004-rp2-coder-20260917T091520Z/`）：units 23/23（attempt2）、npm test 522/522、build/prepare 0、files/storage 桌面 0。本会话 exit 脚本开发期 4 次尝试（1：evaluate 内 require 不可用；2：blocked 场景用未完成上传被 closeFrameSessions 取消导致不阻塞；3：受阻断言字段错位；4：通过）日志均如实保留，最终整链以全新 prepare 产物复跑通过。

## 边界与剩余风险（供 reviewer 重点）

（首审前的下节内容保留原样作历史；其中"blocked 取消后……属设计内诚实降级"的结论已被第 1 轮审查否定并按 R1 修正，见文末返工章节。）

- 原生三选确认/受阻提示/保存与目录对话框的真实点击验收不可 CDP 驱动：桌面脚本以主进程 stub 替身驱动**真实产品接线**（标签已写入脚本头与输出 JSON）；原生人工交互留 RP8/人工验收，未假称已验收。
- A5（closeDB 先于 install、取消/timeout/error 零安装）的证明载体是 `tests/dsk-rp2-exit.test.cjs` 的真实 updates.cjs + 真实 createExitCoordinator + 标记的 FakeUpdater（无网络无安装）；真实 Electron 进程内不做安装类验证（非目标）。
- blocked 取消后 service 已停、编辑不可保存为**设计内诚实降级**（任务单 design/coordinator 行）；"取消退出后存储服务已停止"的 UX 文案已如实告知，是否需要进一步恢复手段属产品决策，未擅自扩大范围。
- exit 脚本的 before-quit 终点挂起是测试侧证据采集机制（stub 注册于协调器之后，仅在全部窗口关闭后的首个放行 before-quit 拦一次），不改变产品行为。
- clean idle 也弹确认框（任务单 approval 明确批准）；若 UX 复审希望 idle 免确认，需 renderer dirty 握手（本轮明确不在范围内）。

未 commit/push；RP2 IMPLEMENTED 待独立 reviewer，父任务 DSK-004 仍 REWORK，RP3—RP8 未实施。

## 第 1 轮返工实施记录（reviewer agent_dceb64db，REWORK rework_rounds=1，coder 已验证，待第 2 次独立审查）

**结论更正**：首轮报告称"blocked 取消后窗口可用、服务已停属设计内诚实降级"——该结论错误，已按 R1 修正：停服后任何失败路径一律落 BLOCKED 并**保持锁定**，绝不回 OPEN 制造可编辑假象；原生受控重试入口明确可用。旧文档原文保留未删改，以此节为准。

**R1（停服后错误解锁）**：`desktop/main.cjs` 协调器新增 BLOCKED 态。确认成功（保存/丢弃）进入排空后，storage 服务已同步停止，此后受阻取消、排空异常、最终动作失败全部 `landBlockedAfterStop()`：清除 quitReady、state=BLOCKED、**不调用解锁**；仅确认前异常（confirmExit 抛错，服务未动）仍回 OPEN 解锁可用。受控重试入口三种：BLOCKED 下的窗口 close、before-quit、应用重启（second-instance → `retryBlockedExit`）；重试同一排空新预算、**不再二次确认**（用户确认一次性，不重复打扰）；受阻提示文案如实说明"窗口保留但不可操作（存储已停止），可再次尝试退出或重新启动导演台继续处理"。

**R2（清理失败被下轮 dispose 忽略）**：`desktop/storage/service.cjs` 弃用"逐次 dispose 错误计数基线"（旧逻辑使持续 EACCES 第二次伪成功关库、.part 永久残留），改为**未解决清理台账**（`unresolvedCleanups` Map，key 含 transferId+stage+序号）：handle.close 与 tmp rm 两阶段失败分别入账（`already closed` 容忍不计）；排空循环内以 100ms 有界真实节奏**真实重试**失败资源（rm 真删、handle 真关），仅资源真清理才出账；台账非空一律 `blocked:'cleanup-failed'`（含未解决项数）且 DB 保持打开；upload.begin 迟路径的直接清理失败同样入账；CE1-CE3 原语义（等待中的已注册清理 → timeout）不变。

**R3（最终动作失败状态与授权不一致）**：finalize 前才置一次性 quitReady 授权；finalizeClose 抛错 → 捕获清授权落 BLOCKED（旧实现外层 catch 置 OPEN 但 quitReady 残留 true）；`reportFinalActionFailure(kind)` 供 updates.cjs 在 quitAndInstall 同步 throw 或异步 error 后上报（仅 FINALIZING+同 kind+已授权时生效），协调器清授权保持保护；BLOCKED 下 `prepareUpdateExit` 恒 false（一次授权一次尝试，失败安装不被静默重跑），重试入口降级为正常关窗退出。update-host/src 零改动，无真实安装。

**证据（真实退出码，`tmp/dsk-004-rp2-r1-20260918T021504Z/`）**：

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红跑（未修源码）`node --experimental-strip-types --test tests/dsk-rp2-dispose.test.cjs tests/dsk-rp2-exit.test.cjs`（`red-unfixed.log`） | 1 | 10 个具名反例红：R1×3（BLOCKED 等待超时/二次确认/排空异常解锁）、R2×4（真实重试 rm、持续失败两轮 blocked、dispose 前失败、句柄 close 记账）、R3×3（finalize 抛、updater 同步 throw、异步 error） |
| midwait 时序探针（`red-unfixed-midwait-fixprobe.log`） | 0 | 首红系探针笔误（`pendingOperationCount` 层级），修正后绿；原日志保留 |
| 修复后同组单元（`green-units.log`） | 0 | 30/30（CE1—CE4 保持；红例全转绿） |
| `npm test`（`npm-test.log`） | 0 | 529/529（499+RP2 新增 30） |
| `npm run build` / `npm run desktop:prepare`（`npm-build.log`/`desktop-prepare.log`） | 0 / 0 | 载荷含修复（staged main.cjs BLOCKED 标记 18 处） |
| `node scripts/test-files-desktop.mjs`（`desktop-files-r1.log`） | 0 | 9 检查全过，RP1 不回归 |
| `node scripts/test-dsk-storage-desktop.mjs`（`desktop-storage-r1.log`） | 0 | 全阶段通过（双真实进程 lease/generation/PHASE7 reload 失效） |
| `node scripts/test-dsk-rp2-exit-desktop.mjs`（`exit-desktop-r1.log` 失败原样保留 → `exit-desktop-r1b.log` 0） | 1 → 0 | r1 失败系 Phase D 断言机制（app 退出后 playwright 连接拆除，`process()` 不可读）；r1b 改为 launch 时挂进程 exit 钩子：**A1** 取消留窗可用、**A2** 保存→排空→关窗→退出真实写盘、**B** app.quit 恰一次确认、**C1** 真实 backup 挂起选择器→排空超时→原生受阻提示→取消后窗口**保持锁定**+dsk 如实拒绝（storage-unavailable）、**C2** BLOCKED 下 close 即受控重试（无二次确认、仍锁定、选择器未释放则提示再现）、**C3** 释放后重试真实排空干净退出（恰一次确认+两次受阻提示+全程锁定）、**D** 无插桩自然退出 **exitCode 0 + signal null**（钩子捕获，全程无强杀，不以强杀充当成功） |

**证据纠正如实说明**：等待期新增清理用例改为排空真实时序——commit 挂起保持 pending 跨 dispose 起点，closeSession 在 performDrain 内发起清理并挂起，等待期处理器续体如实失败、清理落地后同一轮排空完成；生产路径在同步停服后不存在"全新清理注册点"，该边界已在用例注释与本节说明。update 关库顺序证据升级为真实 sqlite（`dbOpenAtInstall=false`/`drainStateAtInstall='ready'` 于 quitAndInstall 时刻实测），updater 仍为标记 fake。旧反向断言（解锁/基线重置/自关窗）仅在未修源码上作为红反例有意义，不得表述为"通过"。

**遗留边界**：真实原生对话框点击验收留 RP8/人工（stub 严格标注为逻辑接线证据）；BLOCKED 锁定下真实用户重试依赖任务栏关闭或应用重启（提示文案如实），如需更丰富的原生重试交互属产品扩展，未擅自扩围。未 commit/push；IMPLEMENTED 待第 2 次独立审查。

## 第 2 轮返工实施记录（同 reviewer，REWORK rework_rounds=2，F1/F2，coder 已验证，待最终独立复审；再审不通过转 planner）

**F1（清理重试本身无界 await）**：r1 实现中 `settleUnresolvedCleanups` 被排空循环内联 await——重试的 close/rm 若挂起，整体真实截止失效（实测反例：首次 rm EACCES 入账、第二次 rm 挂起，dispose(100ms) 超 619ms 不返回；第二次 dispose 复用同一永不完成 promise）。修复（`desktop/storage/service.cjs`）：重试改为**非阻塞可观察 inflight 工作**——`startCleanupRetry` 以 `inflightCleanups` Map 登记进行中尝试（单资源跨 dispose 至多一个并发尝试），`startDueCleanupRetries` 保留 100ms 真实启动节奏但循环**不再 await 它**；整体真实截止覆盖 pending/inflight 全部；截止后不再发起新尝试；blocked 结果如实区分"失败未解决 N 项 / 重试进行中 M 项"；台账/失败/进行中全保留，仅真清理出账、全净才关库。

**F2（异常 BLOCKED 无原生提示）**：r1 实现中 prepareExit 抛、finalizeClose 抛、quitAndInstall 同步 throw/异步 error 均静默落 BLOCKED（实测 0 次提示）。修复（`desktop/main.cjs`）：排空异常转换为 internal blocked 结果进入**同一原生受阻提示**；最终动作失败与安装失败（`reportFinalActionFailure`）经 `landBlockedWithNotice` 弹同机制提示（含可理解原因）；`noticeInFlight`+`retrying` 双守卫保证单提示单重试 owner（提示挂起期间 close/quit/second-instance 仅拦截不并发重试）；提示自身抛错被捕获——按取消处理保持 BLOCKED 锁定，不放行、不未捕获、不无限循环（测试以有界应答验证）；迟到旧 updater error 被状态/kind 门拒绝，不撤新 owner 授权不重弹；确认前异常仍 OPEN 可用（与停服后异常明确区分）。

**证据（真实退出码，`tmp/dsk-004-rp2-r2-20260918T031327Z/`）**：

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红跑①（`red-unfixed.log`） | 1 | 捕获 4 具名红后**测试自身应答脚本无界**致 12 分钟 OOM 崩溃——如实记录为 **harness 失败**，不假称全部具名红在该次完成 |
| 红跑②（`red-unfixed-attempt2.log`） | 1 | 有界化后完整红记录：35 用例 8 红（F1×2：100ms 预算 619ms 未返回；F2×4：四类异常均 0 次原生提示；迟到旧 error、竞争双 owner），失败原因逐条核验非 DI 漏接/笔误；其余 27 项绿。**订正（2026-09-18）**：经日志核实，"迟到旧 error"与"竞争双 owner"两例仅失败于"提示未出现"的前置断言（`promptsAfterLanding >= 1` 与 `counts.blocked 0 !== 1`），是 F2 零提示缺陷的证据，**不能表述为已证明撤权/双 owner 行为** |
| 红验证③（`red-unfixed-attempt3-f1.log` + `pre-f1-fix-provenance.txt`/`pre-f1-fix.diff`） | 1 | F1 新测试文件在**回填 r1 内联原文的快照**上双红可靠且释放干净。快照溯源：sha256 实为 `acda4adfede8cdeb0c4caf17450bd76589ad50539faa6d380bf7318ae8af3aad`（2026-09-18 复算核实，**此前记录 `89a3294b…` 有误**），为"F1 修复文件仅回退 F1 机制（settleUnresolvedCleanups 原文恢复）"的**回填构造**，非任何 r1 时代文件的原样快照；47 行精确差异见 `pre-f1-fix.diff`，兄弟文件为工作树字节副本 |
| 修后单元（`green-units.log`） | 0 | 35/35（F1×2、F2×6 全转绿；CE1—CE4 与 R1—R3 已认可语义保持） |
| `npm test`（`npm-test.log`） | 0 | 534/534（499+RP2 单元 35） |
| `npm run build` / `desktop:prepare`（`npm-build.log`/`desktop-prepare.log`） | 0 / 0 | 载荷含 F1/F2（staged main.cjs BLOCKED/landBlockedWithNotice 标记 25 处） |
| `desktop-files-r2.log` / `desktop-storage-r2.log` | 0 / 0 | files 9 检查；storage 全阶段含 PHASE7，RP1 不回归 |
| `exit-desktop-r2.log` | 0 | A1/A2/B 全过；**C1—C3**：真实 backup 挂起→受阻提示→取消后窗口**保持锁定**+dsk 如实拒绝→BLOCKED 下 close 受控重试（无二次确认、提示再现）→释放后真实排空干净退出（恰一次确认、两次受阻提示、全程锁定）——**注意 C 含终点插桩与 CDP 触发 close，仅证明接线，不代表原生用户点击或无插桩自然退出**；**D** 无任何终点插桩的自然退出：真实进程 exitCode 0 + signal null（launch 时 exit 钩子捕获），全程无强杀。D 与 C 证据严格区分 |

**异常提示的证据边界（如实）**：四类异常的原生提示验证载体是单元级（真实 main.cjs/updates.cjs 接线 + stub 提示计数与原因断言）；桌面 exit 脚本本轮覆盖的是 blocked（timeout）提示路径的锁定/重试/诚实停服，**未在桌面进程逐一复现四类异常**，不以"桌面亲测所有异常"表述。原生对话框点击综合验收仍留 RP8/人工。

未 commit/push；IMPLEMENTED 待最终独立复审，父 DSK-004 仍 REWORK，RP3 未开始。

## 关联任务 DSK-004-RP2-ownership-01 实施记录（F3/F4 所有权，新唯一 coder 上下文接手，coder 已验证，待独立审查）

原 round2 最终复审（review agent_ee46ca0e）REPLAN：F3 提示等待期 second-instance/`retryBlockedExit` 无守卫可启动退出；F4 连续 2 次 finalize 失败时第 2 个"继续等待"因 `retrying` 未清被丢。经 Ethan ExitPlanMode 批准的最小重规划（planner agent_ebe0f86a PLAN_READY）新建本关联任务，原 RP2 两轮返工与 REPLAN 历史登记保留，不隐形重置为第三轮。源码根 `E:/myProgram/DirectorDesk/director-desk-web`，基线 `99c2582`，继承全部未提交改动（任务起止 status 路径清单一致，未 clean/reset）。

**修复（仅 `desktop/main.cjs` 的 createExitCoordinator 及 second-instance 接线归属）**：删除 `retrying` 标志与自递归的 `retryFromBlocked`/`drainUntilReady`/`landBlockedWithNotice`，改为**一个非递归 pump**：一次尝试（attemptDrain 容错排空异常为同一 blocked 形态）→ 失败则**唯一 owned notice**（ownNotice 单飞、提示崩溃按取消容纳）→ 答案即**至多一个用户 retry 决定**，由循环 `continue` **消费一次**进入下一尝试——连续失败各得一次提示、每个"继续等待"都被准确执行（F4）。`startSequence` 维护单一 flow 槽位（settled 即清）+ containment belt（意外异常仍落 BLOCKED+锁定+同一提示，不未捕获）。`retryBlockedExit`（second-instance/close/quit 共用的受控重试入口）三重守卫：`state==='BLOCKED' && !noticeInFlight && !flow` —— 提示挂起期间外部入口**只拒绝、不积压**，当前提示的决定收尾后被 pump 消费一次（F3）；`handleClose`/`handleQuit` 的 BLOCKED 分支补 `!flow` 同守卫。`reportFinalActionFailure` 保持先验归属门（FINALIZING+kind+quitReady）拒绝迟到旧回调，落地后经 startSequence 弹同一提示、答案由 pump 消费一次；update 失败照旧降级 `finalKind='close'` 普通关窗，`prepareUpdateExit` 未改（BLOCKED 恒 false，普通 close 成功不会被误报为安装许可）。工厂内绑定模块级 `exitCoordinator`，使真实注册的 second-instance 处理器在生产（createWindow 唯一调用方）与单测环境都可达。确认前取消/异常仍回 OPEN 可用，停服后一切失败路径仍 BLOCKED+锁定，公共 IPC/preload/service/integration/files/updates/update-host/src 零改动。

**测试（仅 `tests/dsk-rp2-exit.test.cjs`）**：新增 `DSK_RP2_MAIN_ENTRY` 快照入口（沿用 DSK_RP2_FILES_ENTRY 先例）、`appListeners` 捕获 main.cjs **真实注册**的 second-instance 处理器（非名义替身），3 个有界 ownership 用例：F3 混合触发（真实 handler + close + quit + retryBlockedExit 同时打向挂起提示，drain/finalize 保持 1/1，答复 retry 后恰追加一次 2/2）；F3 正向接线（BLOCKED 无提示时真实 handler 触发恰好一次受控重试）；F4 连续 2 次 finalize 失败（confirm1/notice2/drain3/finalize3，无递归无丢答案）。所有自建屏障 finally 释放，红跑有界无 OOM。桌面 exit 脚本零改动（marker 预检与全部阶段对新载荷通过）。

**证据（真实退出码，`tmp/dsk-004-rp2-ownership-01-20260918T081633Z/`，COMMANDS.txt 逐命令 CMD/UTC/CWD/EXIT+源hash）**：

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红：`DSK_RP2_MAIN_ENTRY=<未修快照> node --experimental-strip-types --test tests/dsk-rp2-exit.test.cjs`（`red-f3f4-unfixed.log`） | 1 | 24 用例 21 绿 + **恰 3 具名红**、有界 37.2s 无挂死：#22 失败于"提示挂起期间 drain 2 次"（越权启动，行为性红因）；#23 失败于真实 handler 未达协调器（快照的模块绑定仅由 createWindow 设置、单测环境不运行——测例内如实标注，修复后该接线可单元验证）；#24 失败于第二次"继续等待"被丢（BLOCKED 卡 2/2）。红因均为次数/越权/丢 retry，无"新版 DI 不调用"型假红。未修快照 sha256 `160e786d…`（PRE-FIX-MAIN-PROVENANCE.txt：真字节快照，非回填构造） |
| 修后同文件（`green-f3f4-fixed-exit-units.log`） | 0 | 24/24 |
| `node --experimental-strip-types --test tests/dsk-rp2-dispose.test.cjs tests/dsk-rp2-exit.test.cjs`（`green-units.log`） | 0 | 38/38 |
| `npm test`（`npm-test.log`） | 0 | 537/537（534+3） |
| `npm run build` / `npm run desktop:prepare`（`npm-build.log`/`desktop-prepare.log`） | 0 / 0 | 载荷含修复（createExitCoordinator 标记 x4） |
| `node scripts/test-files-desktop.mjs`（attempt1 `desktop-files.log` 空白原样保留 → attempt2 `desktop-files-attempt2.log`） | （环境失败）→ 0 | attempt1 经代理后台执行模式启动后卡死于 playwright/electron 连接（应用本身正常：直接前台探针 25s 存活、其窗口已加载；按 PID 精确清理本任务自建的 runner 2660 与测试 app 944 进程树，未触碰其他进程），前台复跑 9 检查全过——环境失败如实记录，非产品缺陷 |
| `node scripts/test-dsk-storage-desktop.mjs`（`desktop-storage.log`） | 0 | 全阶段含 RP1 lease/generation/PHASE7 不回归 |
| `node scripts/test-dsk-rp2-exit-desktop.mjs`（`exit-desktop.log`） | 0 | A1/A2/B/C1-C3/D 全过（C 仍为插桩+CDP 接线证据、D 自然退出 exitCode 0+signal null，标签不变） |

**E1 记录订正（本会话复算核实）**：r2 `pre-f1-fix` 快照实际 sha256 为 `acda4adfede8cdeb0c4caf17450bd76589ad50539faa6d380bf7318ae8af3aad`（与 pre-f1-fix-provenance.txt 一致），此前 yaml/报告/进度中记录的 `89a3294b…` **有误**，已就地订正并声明该快照是回填构造、非任何 r1 时代文件的原样存档；`red-unfixed-attempt2.log` 中"迟到 error 撤权"与"竞争双 owner"两例经日志核实仅失败于"提示未出现"前置断言（`promptsAfterLanding >= 1`、`counts.blocked 0 !== 1`），是 F2 零提示缺陷的证据，**不能表述为当时已证明撤权/双 owner 行为**。旧日志一律未改，订正写入当前结构化记录（原 RP2 yaml rework_round2、上文第 2 轮返工表格、进度.md），非仅文末补注。

**边界与剩余风险（供 reviewer 重点）**：F3 的正向接线断言（#23 真实 handler 可达协调器）依赖工厂内绑定 `exitCoordinator` 的修复侧实现，未修快照上该绑定不存在、单测环境 handler 必然空转，故红相由 #22（直接驱动 handler 所调用的同一导出）以越权/次数红因承担——两层均如实标注；提示挂起期的 second-instance 竞争验证载体为单元级（真实注册 handler + 真实 coordinator），桌面进程未复现该竞争（与既有"异常提示单元级证据"边界一致）；原生对话框点击综合验收仍留 RP8/人工。未 commit/push；本任务 IMPLEMENTED 待独立 reviewer，父 DSK-004 仍 REWORK，RP3 未启动。
