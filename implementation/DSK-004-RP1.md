# DSK-004-RP1 实施报告：请求 frame generation 失效与取消/提交仲裁

- 状态：最终复审 REPLAN（agent_321df250-c394-451a-b119-fd1fe13392af，唯一阻断为验证问题、业务 A1-A4 认可）；批准的关联验证 DSK-004-RP1-validation-01 已完成最小验证补正（见文末章节），待独立复审；不代表整体 DSK-004 PASS，父任务保持 REWORK
- 任务单：`.zcode/workflows/tasks/DSK-004-RP1.yaml`（批准计划 `.zcode/plans/plan-sess_0f45933a-bf18-47df-952f-6fdc936de21f.md` RP1 行）
- 源码根：`E:/myProgram/DirectorDesk/director-desk-web`；基线 `99c2582ee50e7abe1caa480628db360dd3fd9e66`（编码开始时 service/integration 与 HEAD 逐字节一致，仅行尾差异，见 `git-diff-empty-check.txt`）
- 隔离证据目录（本轮新建，未覆盖历史）：`tmp/dsk-004-rp1-coder-20260916-183053/`；第 2 轮返工证据：`tmp/dsk-004-rp1-r2-20260917T021249Z/`

## 第 1 轮报告更正（reviewer 指出）

- 第 1 轮 service.cjs 实际 diff 为 **+75/-19**（`git diff --numstat`，见 `tmp/dsk-004-rp1-r2-20260917T021249Z/pre-fix-snapshot/numstat-before-r2.txt`），此前报告误将 `--stat` 图示总行数 94 写成"+94/-20"。
- 第 1 轮桌面第一轮日志 `tmp/dsk-004-rp1-coder-20260916-183053/desktop-storage.log` **同时包含 DESKTOP-STORAGE-FAIL（退出 1）与此前各阶段 PHASE-OK 行**；引用时必须如实呈现两者，不能只引 PHASE-OK。该目录完整保留，未做任何改写。

## 针对缺陷（R2-01 / RP1 目标）

修复前 `requestGone()` 仅检查 `disposed` 与 `sender.isDestroyed()`。reload（`did-start-loading`）后 sender 未销毁、服务未停止，因此：
- 迟到的备份在 dialog 返回后仍然发布（CE1 实测 `ok:true` 并生成备份目录）；
- 迟到的恢复仍然登记为新项目（CE2/CE3 实测 `ok:true` 且 project.list 增长）；
- 旧代请求与新代请求无任何仲裁边界。

## 反例先行（CP0，未修改实现上真实失败）

具名反例与对照先写入 `tests/dsk-storage.test.cjs`，在未修改实现上运行：
`node --test --test-name-pattern "RP1" tests/dsk-storage.test.cjs` → **退出码 1**（`red-unfixed.log` / `red-unfixed.exitcode`）：

| 用例 | 结果 | 实际失败信息（摘要） |
|---|---|---|
| RP1 CE1：dialog 返回前 reload，备份仍发布 | FAIL（红） | `ok:true`，目标目录出现第二个 `director-desk-backup-*` |
| RP1 CE2：dialog 返回前 reload，恢复仍登记 | FAIL（红） | `ok:true`，project.list 增至 2 |
| RP1 CE3：复制中途 reload，恢复仍登记 | FAIL（红） | `ok:true`，新项目已登记 |
| RP1 CE5：旧代备份 dialog 挂起期间 reload + 新代并行 | FAIL（红） | 旧代备份最终 `ok:true` 并发布 |
| RP1 对照：已发布备份在 reload/dispose 后保留 | PASS（先于修复即过，钉住边界） | — |
| RP1 对照：commit 与 reload 竞态至多登记一次 | PASS（对照） | — |

四条红的失败原因均为"迟到请求在 reload 后照常发布/登记"，与审查发现 R2-01 一致，非崩溃误报。

## 实现内容（仅 `desktop/storage/service.cjs`；`desktop/integration.cjs` 零改动）

1. **代捕获**：新增 `frameGeneration` 计数器；`runInRequestContext` 在每次 IPC 派发时同步捕获 `{ event, generation }` 作为请求令牌（AsyncLocalStorage 存储对象由裸 event 变为令牌，`currentEvent()` 相应取 `token.event`，外部行为不变）。
2. **同步失效**：`closeFrameSessions()` 在任何 await 之前先 `frameGeneration += 1`（dispose 经同一路径推进）；reload/close 的失效与事件同步发生，返回的 Promise 只覆盖 tmp 排空（F04/F12 语义保留）。
3. **复核点全面接入 generation**：`requestGone()` 依次检查 `disposed` → 令牌代与当前代不一致（"页面已重新载入"）→ sender 已销毁（"页面已关闭"）。无令牌的内部直调保持旧行为。接入点：
   - 备份：dialog 返回后（既有）、**对象复制每次迭代完成后**（新增）、发布 rename 前（既有，现含代判断）；rename 一经开始即不可取消，结果如实返回（F07 式回据），任何清理路径不删除已发布目录（对照用例钉住）。
   - 恢复：dialog 返回后（既有）、**复制开始前**、**每次复制迭代完成后**、**DB 登记前**（均新增）。登记事务 `runImmediate` 同步完成，最后复核与事务之间无 await，构成原子边界；失效时走既有 catch 清理暂存对象并如实报 `storage-unavailable`，原项目与既有备份不受影响。
   - 上传/下载：`upload.begin` 打开 tmp 后、`upload.chunk`/`commit`/`abort` 队列操作开始处、`commit` 读取与 putObject 之后、`snapshot.read` 读取之后，全部并入 `requestGone()`。
4. **提交原子仲裁（RP1-A3）**：`upload.commit` 的最终活性+代复核之后、同步 `db.commitSnapshot` 之前**不再有任何 await**（原先中间有一次 `fsp.rm(tmpPath)`，已移到登记结果之后/失败分支内），reload/close 无法插入登记窗口；输掉仲裁的传输如实返回 `unknown-transfer`，不存在"取消成功后迟到提交"。
5. **恢复清理补全**：失效恢复在 `removeProject` 清空对象后追加一次**仅删空目录**的 `rmdir`（非空即失败忽略，构造上不可能误删任何非空数据），取消的恢复不再残留空项目目录壳。

`desktop/integration.cjs` 无需改动：`did-start-loading → storage.closeFrameSessions()` 与 `closed → storage.dispose()` 接线既有，代推进在 closeFrameSessions 内同步完成；`director-dsk` 派发已经由 `runInRequestContext` 在 IPC 到达时同步捕获代。公共契约、错误映射、DB/备份格式、64MiB、host16、依赖均未动。

## 修复后验证（真实退出码，日志在证据目录）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --test-name-pattern "RP1" tests/dsk-storage.test.cjs`（`green-fixed.log`） | 0 | RP1 6/6 通过（4 反例转绿 + 2 对照保持） |
| `node --test tests/dsk-storage.test.cjs`（`full-storage-suite.log`） | 0 | 47/47（41 既有 + 6 新增；无跳过） |
| `npm test`（`npm-test.log`） | 0 | 495/495（原 489 + 6 新增） |
| `npm run build`（`npm-build.log`，含 `tsc --noEmit`） | 0 | 通过 |
| `npm run desktop:prepare`（`desktop-prepare.log`） | 0 | 新产物含本轮 service（未用拉取前旧 prepared 冒充） |
| `node scripts/test-dsk-storage-desktop.mjs`（`desktop-storage.log`、`desktop-storage-2.log`） | 1 → 0 | 真实 Electron 全阶段通过，含新增 PHASE7 |

## 真实接线验证（桌面脚本新增 Phase 7，RP1）

真实 renderer `page.reload()` 触发真实 `did-start-loading`：未提交的上传传输（句柄打开、全部块已写）被失效——旧 sessionId `activate` 拒绝、旧 transferId `commit` 拒绝、该传输的 `.part` 文件被清除（有界轮询内）、reload 未产生任何新 `.part`；随后新代 `project.open` + 完整上传提交 revision 1 成功。原生目录对话框的备份/恢复失效路径由单测注入 dialog 覆盖，真实 UI 验收仍按计划留 RP8/人工边界，未用 mock 假称。

第一轮桌面运行失败如实保留（`desktop-storage.log`，退出 1）：`.part` 全目录断言误伤了 Phase 5 被 `taskkill /F` 硬杀进程遗留的 `.part`（硬杀无法执行任何清理）。经独立探针（`probe-part.cjs`：reload 时句柄打开的传输在 50ms 内清理干净）确认非 reload 清理缺陷后，把断言精确到本轮传输并加 reload 前基线对比，第二轮通过。该硬杀残留属于退出排空范畴，**记录为 RP2（可等待退出）的输入**，本轮按边界不处理。

## 验收对应

- RP1-A1：请求派发捕获代令牌；closeFrameSessions/dispose 同步推进代；旧请求（CE1/CE2/CE3/CE5）与旧 ID（桌面 PHASE7 stale activate/commit、单测 late chunk）在新代被拒。✔
- RP1-A2：dialog 返回、复制开始/每次迭代完成、发布前、登记前全部复核；失效后不发布、不登记；原项目与既有备份保留（CE1/CE2/CE3、对照用例）。✔
- RP1-A3：commit 临界区复核与同步登记之间无 await，原子仲裁；已提交如实返回成功、未提交如实失败（对照用例两分支断言）；无取消成功后迟到提交（既有 F04 abort 竞态回归保持）。✔
- RP1-A4：CE5 与桌面 PHASE7 证明新代请求正常成功，旧代迟到结果不破坏新代 session/传输；拒绝与错误映射沿用冻结契约（`storage-unavailable`/`unknown-transfer`/`unknown-session`）。✔
- RP1-A5：以关联任务 `DSK-004-RP1-validation-01` 的最新模拟清理故障验证及独立审查为准。核心竞态红绿已独立核实；旧r+持锁对照没有触发删除失败，故障覆盖声明撤销。关联任务三份成功日志具有命令/UTC/CWD/摘要及退出码，review独立storage复跑51/51通过；首次SyntaxError原始输出未保留，仅有coder NOTE，不声称全部失败证据完整。历史红runner只记录屏障、旧部分日志仅摘要、esbuild outfile落盘的限制保留，旧日志不补造。当前等待管理记录订正窄复核，不提前标关联或RP1 PASS。

## 未执行/边界与剩余风险

- 未实施 RP2 退出等待、RP3 配额等（non_goals）；发现项（硬杀 `.part` 残留）已记录交 RP2。
- 原生目录对话框的真实 UI 失效场景、Windows 11/断电/安装包验收按计划留 RP8 与人工边界。
- `createUnavailableStorageService` 的降级服务无代概念（所有动作直接返回冻结失败），不涉及本缺陷。
- 风险：代失效的"取消"以失败应答呈现（`storage-unavailable`，detail 含"页面已重新载入"），请求方大概率已被 reload 销毁、读不到该应答；这是如实报告而非静默，最终 UI 呈现策略归 RP8。
- 未 commit/push、未改依赖/provider/上游；`git status` 仅含本任务允许文件与任务单本身。

## 第 2 轮返工（review agent_02369570-b08e-4a50-9a58-129b73fcdfdb：R01/R02，rework_rounds=1）

证据目录 `tmp/dsk-004-rp1-r2-20260917T021249Z/`：修前源快照（第 1 轮版 service/tests/script）、修后精确 filediff（`service-r1-to-r2.filediff`）、全部命令含 UTC/CWD/真实退出码（red、red-verified、green、全套日志）。旧证据目录原样保留。

### R01（高）：提交后回据未固定 + 迟到 rename 污染新代

缺陷：commit 已登记后 `await fsp.rm`（收尾 await）期间 reload，恢复后 `db.getProject` 读取**最新** revision 生成回据（旧 snapshotId 配未来 revision），并把项目 rename 为本请求旧名，覆盖新代刚保存的 NEW。review 实测 oldReceiptRevision2/oldSnapshotRow1/newReceipt2/finalNameOLD。

修复（`desktop/storage/service.cjs`）：整个提交后收尾（固定回据 → getProject 仅取名 → rename → 回执构造）并入与 `db.commitSnapshot` 相同的**同步仲裁区**（中间零 await）：回据 revision 直接固定为 `expectedRevision+1`（事务守卫保证，绝不读未来 latest）；rename 与登记原子完成，reload 后不再执行；进入该区即如实返回成功，之后 tmp 清理（`removeTmp` 注入点，默认 `fsp.rm`）挂起或失败都不改变回执、不得报为未提交。`getProject` 失败仍按 F07 如实报成功。

### R02（中）：staging mkdir 与首次复制间的未检查窗口

缺陷：dialog 返回并复核后 `await fsp.mkdir(staging/objects)` 期间 reload，随后未经检查即 `createBackupDatabase` 并完成第一次 `streamObjectToFile`，直到复制迭代末才拒绝——staging 已有复制产物。

修复：mkdir await 之后、建库与首次复制之前新增 `requestGone()` 复核；失效则仅清理本次 staging（无复制/无发布/既有数据不动）。

### 反例与保持性测试（先红后绿，注入即屏障）

新增 4 条（`tests/dsk-storage.test.cjs`）：R01 red（removeTmp 挂清理→轮询进入屏障→reload→新代 open/save rev2/NEW→恢复旧；断言旧回据 revision=1、oldSnapshotRow=1、新代行=2、终名 NEW、current 指向新代、commit.ok=true）、R02 red（ensureDir 挂 mkdir→reload→断言 copies=0、无 staging 残留、无发布、list/revision 不变）、R01 control×2（已完成的 rename 在其后 reload 仍如实成功；已登记 commit 的清理失败仍报成功——reviewer 要求不得倒退的两项行为钉住回归）。

**红（修前实现实跑验证）**：将 `pre-fix-snapshot/service.cjs` 临时回换运行 `node --test --test-name-pattern "RP1 R0" tests/dsk-storage.test.cjs` → **exit 1**：R01 红（修前实现无 removeTmp 注入/无回据固定，屏障不可布置）、R02 红（reload 后备份仍 `ok:true` 发布）、两 control 绿；随后恢复修后版本（`red-verified-presnapshot.log`）。首次红跑（`red-r01-r02.log`，exit 1）与一次测试自身屏障误挂种子提交导致的死锁尝试（`green-r01-r02.log`、`green-r01-r02-attempt2.log`）均原样保留。

**绿（修后）**：同 pattern → exit 0，4/4（`green-r01-r02-attempt3.log`）。注入仅挂被测请求（按 cleanupCalls 计数），新代自身 commit 正常放行。

### 第 2 轮验证（真实退出码，命令/UTC/CWD 见各日志头）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test tests/dsk-storage.test.cjs`（`full-storage-suite.log`） | 0 | 51/51（47 + 4 新增） |
| `npm test`（`npm-test.log`） | 0 | 499/499 |
| `npm run build`（`npm-build.log`，含 `tsc --noEmit`） | 0 | 通过 |
| `npm run desktop:prepare`（`desktop-prepare.log`） | 0 | 新产物含第 2 轮 service |
| `node scripts/test-dsk-storage-desktop.mjs`（`desktop-storage.log`） | 0 | 全阶段含 PHASE7（真实 reload 失效）通过 |

保持性确认：既有 RP1/F04 相关 9 项及全部既有存储回归通过；"rename 进入（同步区）后 reload 如实成功"与"已 commit 清理失败仍成功"由新增 control 显式钉住。第 2 轮 service.cjs 相对第 1 轮精确增量 +27/-10（累计相对 HEAD +102/-29，`numstat-after-r2.txt`）。原生 dialog UI 验收仍留 RP8/人工边界。

**第 2 轮证据如实降级声明（reviewer 第 2 次审查 V01 指出，未通过）**：第 2 轮的 R01/R02 红验证依赖当时新增的 `removeTmp`/`ensureDir` 构造参数，而修前（第 1 轮）源码解构忽略未知参数——R01 红跑根本没到 cleanup 屏障（`red-verified-presnapshot.log` 的 `true !== false` 即屏障断言失败，非缺陷复现），R02 红跑轮询超时 2s 后 reload 时备份已可能结束，均不能复现原竞态。`green-r01-r02-attempt3.log` 亦缺完整元数据（仅 TAP 输出，无 UTC/CWD/命令头尾）。上述文件全部原样保留在 `tmp/dsk-004-rp1-r2-20260917T021249Z/`，不补造元数据、不改写，自本声明起降级为无效历史；有效红/绿证据以第 3 轮目录为准。

## 第 3 轮窄返工（review 第 2 次审查：V01 有效红测 + V02 表述，rework_rounds=2）

证据目录 `tmp/dsk-004-rp1-r3-20260917T024441Z/`（完整元数据：每条命令/UTC/CWD/被测源 sha256/EXIT）。业务代码本轮不改语义：service.cjs 仅注释订正（V02），其余改动仅 tests/实施/任务/进度记录。

### V01：真实 fsp 屏障的具名稳定回归 + 内存打包修前 snapshot 的红验证

- **tests/ 具名回归改造**：新增 esbuild 插件在打包层把 `node:fs/promises` 替换为包装模块（`rm`/`mkdir` 仍执行**真实 fs 操作**，仅首个匹配谓词的调用被门挂起；state 以 `globalThis.__rp1FspGates` 幂等共享，多 bundle 不互相顶替）。R01 用真实 `fsp.rm` 门（首个 `.part` 清理），R02 用真实 `fsp.mkdir` 门（`.staging-` 目录创建）；两者**到达屏障均有 assert**（`gates.rmMatched`/`gates.mkdirMatched`）。不再依赖 `removeTmp`/`ensureDir` 构造参数证旧缺陷（该 DI 保留在源码中未用）。
- **对照修正**：清理失败对照改为**真实 fsp.rm 异常**——测试以 `r+` 打开 `.part` 持锁（Windows libuv 不共享 DELETE → unlink EPERM），服务真实 rm 抛真实 fs 错误后已登记提交仍报成功；rename 对照明确标注为**项目 rename**（commit 收尾内的 `db.renameProject`），备份发布 rename（`fsp.rename`）由既有"已发布备份在 reload/dispose 后保留"对照覆盖，两者不再混称。
- **红验证（修前 snapshot，不回换工作树）**：`red-runner-r3.cjs` 用内存 esbuild 打包 `pre-fix-snapshot/service.cjs`（sha256 `8b137b7351b1eae322a24114953f4b3cd8828b132c5b0b31a2ebd0c1683c0598`，`source-hashes.txt`；objects/library/contract 显式映射到当前工作树模块并记录），同款 fsp 门控，收集式输出实际失败值 → **exit 1**（`red-verified-inmemory.log` + `.exitcode`）：
  - R01：barrierReached=true，回据 revision **实际 2**（期望 1）、终名 **实际 "OLD"**（期望 "NEW"）——与 reviewer 实测 oldReceiptRevision2/finalNameOLD 一致；
  - R02：barrierReached=true，copies **实际 1**（期望 0）。
- **绿（当前源码）**：同组具名回归 `node --test --test-name-pattern "RP1 R0" tests/dsk-storage.test.cjs` → **exit 0（4/4）**（`green-named-regressions.log`，被测源 sha256 `15f4d7484173b426b99abbbffb1adc49a6bdcb4080810dd2a31799beb81d5d32`）。红绿使用同一屏障机制，旧/新源码均真实到达。

### V02：仲裁表述订正（仅注释/文档，不改语义）

service.cjs 提交收尾注释由"rename 与登记原子"订正为："**同一主进程零 await 事件循环轮次内仲裁**——不是同一个数据库事务，也不是跨进程原子；跨进程仍由租约隔离"。不扩大事务范围。文档同步。

### 第 3 轮验证（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node tmp/dsk-004-rp1-r3-*/red-runner-r3.cjs`（修前 snapshot 内存打包） | 1 | R01 失败于 revision=2/nameOLD、R02 失败于 copies=1（预期红） |
| `node --test --test-name-pattern "RP1 R0" tests/dsk-storage.test.cjs` | 0 | 4/4（真实屏障回归+两对照） |
| `node --test tests/dsk-storage.test.cjs`（`full-storage-suite.log`） | 0 | 51/51 |
| `npm test`（`npm-test.log`） | 0 | 499/499 |

业务语义未变，未重跑 build/desktop:prepare/Electron（第 2 轮已全通过且此后无业务代码改动，仅注释与测试）。独立 review 确认"commit 后 getProject/rename 抛也如实成功"——现实现 getProject/rename 均在 try/catch 内不影响成功回据，保持。未 commit/push；如本轮复审仍不通过，按流程转 planner，不进行第三次修补。

## 关联验证 DSK-004-RP1-validation-01（本机，2026-09-17，coder 已验证，待独立复审）

最终复审（agent_321df250-c394-451a-b119-fd1fe13392af）判 REPLAN：唯一阻断为**清理失败对照假阳性**——旧用例以 `r+` 打开 `.part` 持锁并假设真实 unlink EPERM，但仅 `assert commit.ok`，从未断言 rm 实际失败。本节为批准的最小验证补正（planner agent_3e02c028 PLAN_READY、负责人 ExitPlanMode 批准）；**生产代码本轮零改动**，`desktop/storage/service.cjs` 变更前后 sha256 一致（`15f4d748…`，cmp IDENTICAL）。证据目录 `tmp/dsk-004-rp1-validation-01-20260917T075926Z/`（status 前后、diff-stat、5 文件变更前备份、前后 sha256、探针、3 命令完整 CMD/UTC/CWD/NODE/输出/真实退出码）。

### 假阳性实测与降级声明（旧文件原样保留，不补造数据）

- **r+ 文件锁假阳性（本轮实测降级）**：探针 `probe-filelock-rplus.cjs`（node v22.14.0，本机 win32）——持有 `r+` 句柄时 `fsp.rm(target,{force:true})` 仍**成功删除文件**（`rplus_fsp_rm: SUCCEEDED`、文件已消失）。旧对照"真实 fsp.rm 失败后仍报成功"在本机从未真正触发 rm 失败，其"真实 EPERM"声明为假阳性；该用例已由下述注入版替换，r+ 路线退役。
- **旧红 runner 只记录屏障、非 assert**：`red-runner-r3.cjs` 对屏障仅 `findings.r01_barrierReached = gates.rmMatched` 后打印（当时恰为 `true`），并无断言；"到屏障 assert"仅适用于 `tests/dsk-storage.test.cjs` 内的具名回归（`assert.ok(gates.rmMatched…)`）。此前文档将该表述笼统用于红验证，特此订正。
- **esbuild 产物落盘、非纯内存**：红 runner 与测试 harness 的 `esbuild.build` 均带 `outfile`（`pack-*.cjs`/`dsk-storage-*.cjs`）**写盘后 require**；"内存 esbuild 打包"表述不准确，订正为"esbuild 打包（产物落盘 tmp 后加载）"。
- **部分旧日志仅摘要、无逐条 hash**：`full-storage-suite.log`/`npm-test.log` 头部仅 CMD/UTC/CWD；`source-hashes.txt` 仅 2 条（修前 snapshot service + 当前 service），未逐条记录 objects/library/contracts 映射模块 hash。旧日志原样保留，不补造。

### 测试改动（仅 `tests/dsk-storage.test.cjs`；R01/R02 屏障用例语义未改）

1. **wrapper 扩展（一次）**：共享门状态新增 `rmRejectMatch/rmRejectCalls/rmRejectPath/rmRejectCode/rmRejectError`；`rm` 命中精确谓词时**不调用真实 fs**，返回注入的 Promise 拒绝——`code` 为 EPERM 或 EACCES、`error.simulated=true`、消息含 "SIMULATED …（not a real OS permission failure）"，其余所有调用透传真实 fs；不改全局原生 `fsp.rm`。旧 `rmMatch`/`mkdirMatch` 门与跨 bundle 共享语义不变。
2. **清理失败对照重写**（用例数 1:1 替换，名称仍以 "RP1 R01 control:" 匹配 "RP1 R0" pattern）：断言注入**恰好 1 次**（无重试）、路径与本次传输 `.part` **精确相等**、实际抛错 `code` 为注入的 EACCES/EPERM、SIMULATED 标记在 error 上；**注入发生在真实 COMMIT 之后**由谓词在 rm 时刻同步捕获 DB 证明（`db.getProject` revision 已=1 且 `current.snapshotId`=本次 snapshotId）；`commit.ok=true`、回据 `revision=1`、`snapshot.revision=1`、`db.getSnapshot(projectId, snapshotId).revision=1`、`getProject().revision=1` 且 `current.snapshotId` 一致。`finally` 先快照观测值再恢复注入门（`rmRejectMatch/Code/Path/Error/Calls` 归零），断言失败也不泄漏。
3. 区段头部注释订正：旧 DI（removeTmp/ensureDir）描述已过时，如实注明第 3 轮改为 esbuild 真实 fsp 屏障、validation-01 增加显式 SIMULATED 注入。

### 验证（真实退出码；attempt1 如实记录）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node --test --test-name-pattern "RP1 R0" tests/dsk-storage.test.cjs`（`1-named-rp1-r0.log`） | 0 | 4/4（R01/R02 屏障 + rename 对照 + 注入版清理对照） |
| `node --test tests/dsk-storage.test.cjs`（`2-storage-suite.log`） | 0 | 51/51，无跳过 |
| `npm test`（`3-npm-test.log`） | 0 | 499/499 |
| `node tmp/dsk-004-rp1-validation-01-20260917T075926Z/probe-filelock-rplus.cjs`（`probe-filelock-rplus.log`） | 0 | r+ 持锁时 rm 成功——假阳性事实存证 |

attempt1（2026-09-17T08:03:24.560Z）在任何测试执行前因新文档注释内 glob `"-01-*/"` 误闭合块注释 SyntaxError 退出 1；修正后重跑，该次日志就地覆盖未保留，已在日志 NOTE 与此如实注明，非测试失败。

未 build/prepare/Electron/SQLite gate，未 commit/push；`service.cjs`、`integration.cjs` 及其他生产源码零改动。本关联 review PENDING；原 RP1 最终复审 REPLAN 保持，不提前 PASS。
