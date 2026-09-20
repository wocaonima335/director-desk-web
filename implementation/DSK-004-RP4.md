# DSK-004-RP4 实施报告：objects/service 全路径有界读取

## 冻结结论（2026-09-20，覆盖下方过程历史）

**RP4 正式 REWORK；S1 工具独立预审 REWORK / 执行 BLOCKED；S5_DESKTOP_BLOCKED；人工 PENDING。** 按负责人要求冻结源码、测试和记录，停止实施。分支 `checkpoint/dsk-003-progress`，父提交 `1536c2ad2aaf44b6d168075b8248d93c05c3cfe1`；新提交及推送结果以 Git 核验为准。本检查点不是发布、RP4 PASS 或 DSK-004 完成。

### RP4 首次全范围独立审查

审查人 `agent_118a54e7-7c5e-4907-bbea-8b545e2d220f`；本机隔离目录 `E:/director-desk/review-rp4-final-20260920T150010Z-631db679/`，source-manifest SHA256 `831cb98620c4507d377250af3db0d098b4fd8b3ea578fac971bb3350de7e23ca`。静态/历史证据审查返回 REWORK，因执行工具不安全未重跑测试。

| 项 | 未关闭的问题 |
|---|---|
| F1 | 无 owner 的 close failure 未交接可操作资源；多资源错误可能丢失，资源身份/单飞需闭合 |
| F2 | `streamFileToObject` 在源 close 成功之前 rename 发布；close 失败或挂起时 final 已暴露 |
| F3 | A1—A12 子场景覆盖不足，如真正部分读取后变动、A7 字节验证、A8 复制后复核、A10 组合错误/挂起/并发计数 |
| F4 | runner 稳定归属、root 退出后管道/后代监督、整树运行与清理截止不成立 |
| F5 | 实际 bundle inputs/hash、入口环境及逐运行绑定不足；报告存在过强声明 |

F1/F2 **尚未生产返工**。12/12、dispose 15/15、两套 98/98 和 npm 570/570 保留为对应历史运行结果，不替代全部验收，也不证明 runner 超时安全。任务单 `review.rework_rounds: 1` 是首次全范围审查后的返工计数；早期阻塞诊断与下述 S1 工具预审不另计一次全范围复审。

### S1 工具独立预审：未放行

审查人 `agent_aabc4053-b96d-4c5e-8e14-4b2df99f1ce7`，**只做独立静态安全预审，未编译或执行候选、自检、产品测试**。候选根 `E:/director-desk/verify-rp4-rework1-ec5469ba/`。下方第九节是 coder 交接历史，不是独立认可。

1. **S1-F1 异常清理**：CreateProcess 挂起后、Assign 前日志异常可能使未归属进程遗留；finally 的日志也可打断清理。Terminate/Wait 返回值被忽略，固定 5000ms 不等于剩余 C。
2. **S1-F2 驱动**：WaitForExit(25000) 超时只记 outerKilled，没有实际停止；Stop-Process -Id 不是持有原始句柄的清理，finally 未兜住子进程，仍存在无参数 WaitForExit。
3. **S1-F3 截止**：setup/Resume 前未完整检查 R；先成功后判 deadline；C 建立晚于终止和日志；同步日志写、flush、hash、关闭未覆盖完整生命周期。
4. **S1-F4 管道**：Peek/Read 的非 BROKEN_PIPE 错误也作 EOF，可能假 SUCCESS。
5. **S1-F5 布局**：`JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` 漏 `TotalPageFaultCount`。正确 offset 为 page faults32、total36、active40、terminated44。撤回“Windows ActiveProcesses 会计不可用”的归因。`0x7A` 是 ERROR_INSUFFICIENT_BUFFER；ERROR_MORE_DATA 为 234/0xEA。
6. **S1-F6 取证**：六份 meta.log 的 hash 均与最终文件不符，Finish hash 后仍写 result_written/close/tool_end；源/exe hash 只在 finally 登记，缺运行前绑定；summary 有覆盖，全部探针/清理原始输出与冻结版本未找到。
7. **S1-F7 环境与交互**：ENV 仅 hash 不足以定位实际入口，cwd 未传则记 null；自检只有 ASCII argv/变量存在性，缺中文及精确 ENV；仅写文件不等于持续向前台输出。

**过程偏离同样保留**：`cleanup-probe-leftovers.ps1` 使用 CIM 命令行通配 + 裸 PID Stop-Process，违反批准约束；“11/11”身份与无误伤未独立证实。probejob/probejob2 在 Assign 失败仍 Resume，不可原样复跑。监督器死后日志冻结不证明子树实际退出；撤回“全绿已证明整树硬上界、零遗留且无误伤”声明。本次冻结不启动或清理这些工具，也未认证当前全系统零遗留。

### 历史声明的适用边界

- 撤回“生产无死锁、真实 rm 必落地、唯一阻断点”、旧 runner 已证明整树安全、各 A 项已完整验收等过强声明；下方旧表的 PASS 仅是当时 coder 对局部测试的总结。
- 旧 npm 实际 565 pass + 1 文件级 fail、约 1021s；420s 是名义预算。适配后 570/570 结果不改写旧失败。
- 诊断 summary 的 disposeStartedBeforeRmMatch 与时间戳反向，以 trace 时间戳为准，不改原文件。A6 旧红只到 (a)，不追认 (b)/(c) 行为红。逐运行实际 esbuild inputs 仍有缺口，不以第八节旧取证声明当作问题已关闭。
- 本会话计划文件被审批工具更新过，不能称始终原字节未改，也不把审批工具写入归责 coder。
- 已有 RP1—RP3、SQLite PASS 保留；RP4/S1 问题不由这些历史 PASS 抵消。原生备份/恢复/取消、Windows11、断电、安装包仍未验收。

### 保存范围与恢复

完整精简本机试跑方案未获批准、未执行，已被冻结指令取代。冻结批准仅允许整理记录、commit 和普通 push，不授权继续工具返工/生产修复/试跑或发布。此次不运行测试、build、prepare、产品或 SQLite gate。

仓库保存 RP4 源码与测试候选、dispose #11 适配、RP3 独立结论和相关管理记录。四个生产/测试文件冻结前的本机字节 SHA256（Git LF/CRLF转换后可不同）：

| 文件 | SHA256 |
|---|---|
| desktop/storage/objects.cjs | d8c8cf3e49f5708e98a7c10fbbeee4c3de201010786d911629cd5fa9da5a1582 |
| desktop/storage/service.cjs | 857f67b7ab797903e9d0a46c9bd6300a6e56346e6be3b274cc4f768ac73fb468 |
| tests/dsk-storage.test.cjs | 71355b652dbebdaeb793f1395eda910a503e9ad9de6678ee3e26c5b3e9ead74e |
| tests/dsk-rp2-dispose.test.cjs | aa72a53d9381b411da5823ee3cc9335f98003f51b7eea34c3aa34ac80c8d834b |

原始日志、S1 工具源码/二进制/自检在上述仓库外验证根，仅留本机，不随 Git 上传；summary SHA256 `e9e0b84511a1b3060a918d06770793e097e1f98703ed1d304a83a7d71e022dcf`、attempts SHA256 `5935cc2bbc7c86c2cf155de9fae60e6883fc6d3c1cc3402268a0c895f20a0f6c` 仅标识已有文件，不消除内容或历史缺口。拉取检查点的人不能假称已拿到这些证据。

恢复入口是 `进度.md` 顶部与 RP4 任务单；先核对实际工作树及新的授权，再按 planner/coder/reviewer 分工续接，不默认恢复旧 runner、自检或试跑。保留所有失败及返工计数，不 reset/clean，不操作旧 PID。

## 以下为编码代理过程历史（与冻结结论冲突时以上文为准）

- 状态：**BLOCKED**（仅剩一项白名单外测试适配待批；其余编码与验证已闭环）
- 任务 ID：DSK-004-RP4（同一已批准任务续接，非新任务，返工轮次未重置）
- 源码根：E:/director-desk/director-desk-web；基线 HEAD：1536c2ad2aaf44b6d168075b8248d93c05c3cfe1
- 续接根（隔离验证）：E:/director-desk/verify-rp4-20260920T091147Z-c7ab2852
- 本次 resume 证据子目录：evidence/resume-coder2-20260920T192500Z/（handover.md、notes.md、index.jsonl、logs/）
- 旧 coder 交接：agent_7fd708dd… 已由 TaskStop 停止；其实现（objects d8c8cf3e…、service 857f67b7…）与其全部红/绿日志原样保留，未覆盖未重置；pre-task 冻结 618 文件与 manifest hash f4a4e8a4… 核实一致。

## 一、阶段1 交接诊断（只读）

1. 旧 coder 报告的"卡住25分钟的 node PID 1060"实为 ZCode 自身 `zcode-agent-filter.js app-server`（创建 14:49:22+08，父 13192，WS≈550-576MB），不是测试进程，未触碰。
2. 全系统命令行搜索 verify-rp4/run-and-log：无遗留测试进程。run-and-log.mjs（spawnSync 全缓冲、无 timeout）两套 final 运行实际已自行完成并落盘：红（10:43Z，exit 1，9红+3控制绿）、绿（10:45Z，exit 0，12/12，但含 A6 note）。
3. 三方 hash：主树==副本（objects/service 一致）；测试文件主树 c5fae083 比副本 0e89fba1 多出 3 行（(c) 前 `fs.rmSync(dest)` 修复+注释），该修复版从未被任何日志运行过；pre-task 三文件为 RP3 冻结态（service bb7224bd 与进度.md RP3 hash 一致）。

## 二、本次编码改动

- tests/dsk-storage.test.cjs（71355b652db…）：
  1. 保留 (c) 前置 `fs.rmSync(dest)`（使 'wx' 打开真实到达 sink——候选 sink 路径为 `fsp.open(destPath,'wx')`，objects.cjs:489）；
  2. (b) 新增硬接通断言：`writeCalls` 必须增加（部分写循环只有经计数的代理 fsp.open 句柄才是真实覆盖）；
  3. (c) 将原静默 else-note（"sink-write injection did not engage"）改为硬断言：注入必须接通 + 失败导出 reason=io-failure + 自身目标被删除。
  红跑有效性不受影响：修前源在 (a) 即失败（bounded 层被绕过），(b)/(c) 不可达。
- desktop/storage/objects.cjs、service.cjs：旧 coder 实现，本 coder **零改动**，经本报告全量验证后保留。
- 其余：本任务单 implementation 节登记、本报告新建、进度.md 仅追加 RP4 节。

## 三、验收对照

| 项 | 结果 | 证据 |
|---|---|---|
| A1 | PASS（绿跑） | 非法/超限 limit 拒绝于打开前零内容读；句柄超限 fstat 屏障拒绝 |
| A2 | PASS | 强制真实短读完整读齐、hash 一致（get/put-verify/copy） |
| A3 | PASS | fstat 先于首读；截断拒绝；累计实读 ≤limit+1 |
| A4 | PASS（红绿均过，控制组） | 真实 snapshot.read 触达有界核；同名篡改不覆盖 |
| A5 | PASS | tmp 读经有界核（never readFile）；tmp close 失败致 commit 失败 |
| A6 | PASS（本次补齐有效覆盖） | (a) 64KiB 请求上界；(b) 部分写循环（接通已断言）；(c) sink 写失败→io-failure+仅删自身目标（接通已断言，原静默 note 已消除） |
| A7 | PASS | 导入既有目标有界校验；篡改不动；失败不删无关对象 |
| A8 | PASS | restore manifest/逐对象校验/流式导入均经有界核；拒绝无登记 |
| A9 | PASS | 4MiB-1/4MiB 可恢复、+1 拒、写侧超限 transfer-limit 不发布；10000 独立 digest 往返（distinctDigests=10000，manifest UTF8 3439133B，对象 84468890B）；旧 5000/10000 场景保留 |
| A10 | PASS | close 失败不吞：瞬时重试至真实关闭且 DB 恰一次；持续失败 blocked 且 DB 开 |
| A11 | PASS（红绿均过，控制组）+ storage 全量 83/83 | junction 拒绝、哨兵不变、reload 竞争不迟到投递；RP3 permit/RP2 drain 由 storage 全量与 dispose #1-#10、#12-#15 对候选通过共同佐证 |
| A12 | 部分完成 | 同一测试版本（71355b65）真实旧源红（9行为红）→新绿（12/12）；build/prepare/三桌面通过；**两套完整命令与 npm test 因唯一过时用例未能 exit 0，见第四节** |

红跑红因（9 项均为行为性红，无缺方法/解析假红）：A1 NaN limit 抛 RangeError 而非 corrupt-object；A2 短读致长度不符；A3 handle.stat 0 次；A5 tmp 走 fsp.readFile；A6 导出完全绕过有界层（源未经计数 fsp.open）；A7 校验用无界 readFile；A8 manifest+对象 3 次无界 readFile；A9 超限清单报 storage-unavailable 而非 transfer-limit；A10 close 失败仍报成功。

## 四、唯一阻断点（BLOCKED 原因）

`tests/dsk-rp2-dispose.test.cjs` 第 11 例（545 行 "RP2: drain-initiated cleanup parks the loop and settles mid-wait"）对 RP4 后生产读取路径过时：

- 该测试用 `readFileGate`（fsp.readFile）停靠 upload commit——RP2 时代路径；RP4 按批准设计将 tmp 读取改为 `store.readBoundedFile`（A5 断言 never readFile，不可回退）。
- 于是 commit 在 dispose 前即失败；其 `cancelTransfer()` 内联 `await fsp.rm(partPath)`（RP2 原码，未改）恰被该测试的 `rmGate` 停住 → `await committing` 永久挂起。
- 修前源通过是因为 dispose 先取消停靠中的 transfer，身份守卫使二次 cancelTransfer 空转——该时序被 RP4 合法改变。
- **生产无死锁**：真实 fsp.rm 会落地；RP2 账本处理的是 rm 失败而非 rm 永久停顿（测试器专用停顿）。
- 二分证据：pre-task 全栈 0.6s PASS；候选 objects + 修前 service 0.6s PASS（objects 排除）；候选 service 触发；dispose #1-#10 与 #12-#15 对候选全部通过（14/15）。
- 影响的两条批准命令：两套 storage+dispose（TIMEOUT-FAIL 540s）、npm test（TIMEOUT-FAIL 420s；565 通过、0 真实失败，仅该文件级挂起）。
- 最小修复建议（供批准）：仅改该测试停靠方式——停靠有界读取入口（如对 .part 的 `fsp.open` 用 openMatch 停靠，替代 readFileGate），断言不变。该文件不在 allowed_changes，本 coder 未改。

## 五、命令与退出码汇总（全部在隔离 workspace，流式日志+明确 timeout）

| 命令 | 退出 | 日志（resume-coder2-20260920T192500Z/logs/） |
|---|---|---|
| RP4 pattern（ENV→pre-task） | exit 1（有效红 9+3） | 2026-09-20T11-32-39-102Z-red-rp4-resume2.log |
| RP4 pattern（ENV={}） | exit 0，12/12 | 2026-09-20T11-34-58-094Z-green-rp4-resume2.log |
| storage 单文件全量 | exit 0，83/83 | 2026-09-20T12-05-*…storage-full-alone（12:06 完成） |
| 两套 storage+dispose | TIMEOUT-FAIL 540s | 2026-09-20T11-35-59-980Z-two-suites-resume2.log |
| dispose 单文件 | TIMEOUT-FAIL 240s | *-dispose-only-diag.log |
| dispose #11 单独 | TIMEOUT-FAIL 120s | *-dispose-test11-alone.log |
| dispose 对照（pre-task 镜像栈） | exit 0，0.6s | *-dispose-test11-ctrl-preservice3.log |
| dispose 对照（候选 objects+修前 service） | exit 0，0.6s | *-dispose-test11-ctrl-svc-cand-obj.log |
| dispose #12-#15 各自 | exit 0 ×4 | *-dispose-tail-*.log |
| npm test | TIMEOUT-FAIL 420s（565 通过/0 败） | 2026-09-20T12-10-54-644Z-npm-test-resume2.log |
| npm run build | exit 0 | *-npm-build-resume2.log |
| npm run desktop:prepare | exit 0 | *-desktop-prepare-resume2.log |
| storage/files/rp2-exit 三桌面 | exit 0 ×3 | *-desktop-*-resume2.log |

失败尝试全部保留记录（runner flags bug、npm ENOENT、两次无效对照的 esbuild 解析失败）：见 notes.md。任何超时均标 TIMEOUT-FAIL，未计为 PASS。

## 六、Hash 与变更范围

- 当前源 hash：objects d8c8cf3e49f5708e98a7c10fbbeee4c3de201010786d911629cd5fa9da5a1582；service 857f67b7ab797903e9d0a46c9bd6300a6e56346e6be3b274cc4f768ac73fb468；tests/dsk-storage.test.cjs 71355b652dbebdaeb793f1395eda910a503e9ad9de6678ee3e26c5b3e9ead74e；tests/dsk-rp2-dispose.test.cjs c836cbf23f78db8edebb650dd920d8f2ab1be0bb8fcbc0f4b928b688f6af06d2（主树==副本，未改）。
- 主树改动仅：objects.cjs、service.cjs、tests/dsk-storage.test.cjs（三个批准源文件）+ RP4 任务单/本报告/进度.md；继承改动（planner/reviewer provider、RP3 任务/报告/进度、untracked 计划）原样保留。未 commit/push，未安装下载，未重跑 SQLite gate，未进入 RP5。

## 七、人工验收与剩余风险

- 人工原生目录选择备份/恢复/取消：仍 PENDING（桌面脚本输出如实标注 native picker 不可 CDP 驱动）；本报告不宣告 RP4 完整 PASS。
- 剩余风险：1) dispose #11 适配获批后需重跑两套/npm test 才可关闭 A12；2) runner shell:true 在 Windows 不杀整树（已按精确 PID 清理自有残留，未来 runner 建议避免 shell 或按树终止）；3) 机器上 python 进程（8.8GB WS）与 ZCode 基础设施造成约 25% 波动，重跑时长可能有 ±30s 差异。

## 八、追加（2026-09-20T14:27Z 起的批准单文件适配轮）：dispose #11 适配完成，A12 两条命令已补齐

- 批准依据：任务单 approved_dispose_adaptation 段（已明确批准）；本次不动生产，白名单仅 tests/dsk-rp2-dispose.test.cjs 第11例 + RP2_FSP_WRAPPER 必要增量 + RP4 任务/报告/进度事实记录。
- 隔离根：E:/director-desk/verify-rp4-dispose-adapt-20260920T142712Z-493c7be1（before=620 文件当前字节冻结，manifest sha256 2d63ab7d… 复核一致；coder-workspace 含候选+依赖+资产独立副本）。

### 8.1 对旧记录的更正（不修改任何旧日志，仅在此更正）

1. 旧 npm test 实际为 **565 通过 + 1 个文件级失败（dsk-rp2-dispose 文件级挂起），全程约 1021s**；不是"0 失败/420s 完整终止"。420s 仅旧 runner 名义预算，非整树硬上界。本次 npm 全量 570 通过与旧 565 通过之差恰为第 11 例挂起时该文件未跑到的 5 例（#11–#15），总数互相印证。
2. 旧二分 runner 日志只记了 RP4 相关 ENV，缺 RP2 入口（DSK_RP2_SERVICE_ENTRY）与 esbuild 实际输入记录，不能追认旧对照的具体输入组合；本次所有运行已登记实际入口 ENV、输入 hash 与 esbuild 输入。
3. 第 11 例失配机制已由源码推导升级为实际 trace 实证（见 8.2）：候选 commit 路径不再有任何 fsp.readFile 调用；挂起的 rm 是 commit 自身 bad-json cancelTransfer 的内联 rm，先于 dispose 挂起；测试的 releaseRead 实为空操作，`await committing` 死等。
4. "生产无死锁"结论维持，但表述收紧：真实 fsp.rm 会落地、RP2 账本管理 rm 失败；不能据此声称真实 I/O 必然落地或生产绝无死锁（真实 rm 若挂起应由 dispose 有界 blocked）。

### 8.2 阶段1诊断（独立诊断目录，未集成主树）

- 脚本：verify 根 `diagnostics/diagnose-old-fixture.cjs`（旧 fixture 机制原样 + 仅加 trace/watchdog，固定同候选生产，失败必释放）。
- 结果：exit 0（1.3s），三项发现全部实证：
  - F1 旧门未达：trace 仅 `open(part,'wx')` → `open(part,'r')` → `rm(part)`，无任何 readFile；readFileGateMatched=false。
  - F2 rm 提前：rmMatchedAt 早于 disposeStartedAt，dispose 开始时 transfers.size=0、pendingCleanupCount=0、pendingOperationCount=1——挂起的 rm 在 commit handler 内联，不经 trackCleanup。
  - F3 commit 未完：releaseRead 后 500ms committing 仍未 settle；失败释放后 commit=storage.v1/upload-format（bad JSON）、drain ok、dbClose=1。
- 日志：`diagnostics/logs/diagnose-old-fixture-2026-09-20T14-47-02-330Z.log` 与 `-summary.json`（含完整 trace）。

### 8.3 阶段2适配（同候选生产）

- 改动：仅 RP2_FSP_WRAPPER 增量（一次性 open 读屏障——精确 `fsp.open(part,'r')` 且 open 执行前停靠、不拦 'wx' 写；read/rm 到达信号与调用计数；保留旧 readFile 分支及信号作为 pre-task 兼容控制，分支显式）+ 第 11 例重写（信号替代 sleep 猜时序；db.close 恰一次计数；重复 dispose 不二次关闭；5000ms 预算与 <4900ms 成功要求保留；finally 失败必释放并清状态）。其余 14 例断言零改动。
- 适配后 hash：aa72a53d9381b411da5823ee3cc9335f98003f51b7eea34c3aa34ac80c8d834b（主树==副本）；objects/service/storage-test 与 before 冻结字节一致（禁改文件复核通过）；before 620 文件对照唯一 diff 即本测试文件。

### 8.4 重跑结果（全部经本次新建前台实时 runner：无 shell、2s 心跳、整树硬上界、超时仅终止本次新建且归属核实的进程树；本次零超时）

| 阶段 | 命令要点 | 预算 | 实际 | 退出 | 结果 |
|---|---|---|---|---|---|
| 短定向 | `--test-name-pattern "drain-initiated cleanup parks the loop"` tests/dsk-rp2-dispose.test.cjs | 20s | 0.3s | 0 | 1/1 |
| dispose 全套 | `node --experimental-strip-types --test tests/dsk-rp2-dispose.test.cjs` | 60s | 9.1s | 0 | 15/15 |
| 两套 | 同上 + tests/dsk-storage.test.cjs | 180s | 52.4s | 0 | 98/98 |
| npm 全量 | `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" test`（无 shell 等价 npm test） | 420s | 59.6s | 0 | 570/570 |
| pre-task 兼容控制 | ENV→RP3 冻结 service（bb7224bd，只读取自旧 verify 根、镜像进 workspace tmp 后运行） | 20s | 0.3s | 0 | 1/1，明确走 readFileGate 分支 |

- pre-task 控制首次直指旧根 entry 失败（exit 1）：esbuild 从旧根无法解析 zod——与 8.1 第 2 条及旧 notes 的失败同因，已如实保留该失败日志。
- 证据：verify 根 `evidence/index.jsonl`（每阶段 argv/cwd/ENV/起止 UTC/退出码/时长/日志路径）与 `evidence/logs/`；诊断另存 `diagnostics/logs/`。
- 入口 ENV 事实：四条批准命令均 DSK_RP2_SERVICE_ENTRY 未设（候选生产）；兼容控制显式设为镜像 entry。

### 8.5 状态与剩余

- 适配轮编码与验证完成（IMPLEMENTED 待独立审查）；**DSK-004-RP4 整体仍 BLOCKED**：不提前 PASS、不清零历史；manual 原生 backup/restore/cancel 仍 PENDING。
- 本次旧 build/prepare/三桌面记录仅核验来源适用性，未冒称重跑；未重跑 SQLite gate；未进入 RP5；未安装下载；未 commit/push。
- 审查重点建议：适配测试的分支实现（readFileGate vs open 一次性屏障）与"不弱化其余断言"声明；runner 整树终止机制的归属核实逻辑；8.1 更正与旧日志的一致性。

## 九、RP4 首轮返工 S1：Job 宿主工具候选实现与自检（2026-09-20，IMPLEMENTED 待独立工具审查）

- 派发仅 S1；《RP4 首轮返工：F1—F5 分阶段实施》S0—S6 已批准、S1 独立门槛。工作根 `E:/director-desk/verify-rp4-rework1-ec5469ba`（新根）；before 620 文件与 `evidence/s0-manifest.json`（sha256 76d372298cc32fb7e22072a682c4e6ad9666daac7f5c3c783d27ff4bac36ebd7）编码后复核一致、零改动；三个旧验证根只读未动。stage 保持 S1_TOOL_PENDING；本节是 coder 候选交接，**不是门禁 PASS、不是验收**。

### 9.1 工具（候选）

- 源：`coder/tools/dskrun.cs`（C#5，.NET4，离线 csc 4.8.9221.0，无新依赖）；`dsksample.cs` 为自检 fixture；`probe87/probejob/probejob2.cs` 为一次性诊断探针（保留作为证据）。驱动 `selftest/run-selftests.ps1`（PS 5.1 前台串行）。
- 产物：`coder/tools/build/dskrun.exe` sha256 `9bde35ee1335feb36fa83948a4018d70cb467c71f415dfbe7c5291bc61330182`；源 sha256 `9f0019641c8a516074c68ee37e83d7aefdb2b14d56d37d594ad7c15bc63d1798`（fixture 84442158…、driver 51df9bcd…、见 evidence/s1/summary.json）。
- 语义：CreateProcess(CREATE_SUSPENDED+CREATE_UNICODE_ENVIRONMENT) → AssignProcessToJobObject → ResumeThread；任一步失败不恢复、仅终止并释放自建挂起进程；Job 仅 KILL_ON_JOB_CLOSE、job/process/thread 句柄不继承、无 breakaway、无 PID 扫描、无 taskkill 兜底；root 退出不撤 deadline，继续监控 Job 成员与 stdout/stderr 管道；setup/启动/子树/管道全计 R，C 为单一全局清理窗（终止+确认+日志收尾，不逐成员延时）；超 R TIMEOUT-FAIL、C 内未确认 CLEANUP-BLOCKED 停止；成功=root 业务 0 + Job 空 + 双管道 EOF；ENV 先清全部 DSK_RP*（大小写不敏感前缀）再施白名单并记录（仅名字+值 sha256，不打印值）；无 shell、精确 argv quoting（含引号/空格/&|<>/尾反斜杠）；UTC+单调时间、runID、句柄生命周期元数据、日志 sha256、结构化 result.json；退出码 0 SUCCESS/1 CHILD_FAIL/2 USAGE_ERROR/3 TIMEOUT_FAIL/4 CLEANUP_BLOCKED/5 LAUNCH 系列/6 INTERNAL。
- 编译命令：`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe -nologo -target:exe -optimize+ -r:System.dll -out:<build>\dskrun.exe <tools>\dskrun.cs`（dsksample 同式）。

### 9.2 本轮实证的工具级发现（供审查重点）

1. **本机 ActiveProcesses 会计不可用**：`JobObjectBasicAccountingInformation` 对全新单成员 Job 返回聚合垃圾值（probejob：total=742→2189、active 恒 1），据此判"Job 空"会永远 CLEANUP_BLOCKED。已改用 `JobObjectBasicProcessIdList`（probejob2 实证：分配后恰含子 PID；自然退出清空；Terminate 后清空；TerminateJobObject 只杀本 Job 成员不伤外层）。
2. **CreateProcessW + UTF-16 env 块必须带 CREATE_UNICODE_ENVIRONMENT (0x400)**，否则 win32=87（probe87 隔离实证）。
3. probe87 v1 曾泄漏 11 个挂起 dsksample 进程并锁住构建产物；按精确 CommandLine（本根 build\dsksample.exe + " exitcode 0"）清理 11/11、REMAINING=0，未触碰任何无关进程；probe 已修复为 resume。

### 9.3 自检（最终运行 2026-09-20T16-54-44-860Z，全绿，driver exit 0）

| 用例 | 期望 | 实测 |
|---|---|---|
| 编译 | 各 20s 预算 | dskrun 131ms / dsksample 102ms |
| case1a 正常+ENV | SUCCESS；DSK_RP3_STALE/dsk_rp_lowercase 清除、DSK_RP_SELFTEST_OK 白名单 | exit0/SUCCESS；工具侧 removed 两名+applied 一名；子进程 ENVPRESENT=NO/NO/YES |
| case1b quoting | 精确往返 | argv[2]=`hello world & | <> "quote" end\` 完整还原，重引号行含 `\"quote\" end\\` |
| case2 rootexit+管道 | root 早退但须等成员+EOF | root 56ms 退，3322ms 才 SUCCESS，8 条心跳，deadline 未撤 |
| case3 超时整树 | tree-hang(2) 超 R=10s → TIMEOUT-FAIL，C=5s 内确认 | exit3，10037ms 决策，root_exit_code=1，meta 含 deadline_reached/job_terminated/cleanup_confirmed，leftover=0 |
| case4 启动归属失败 | 缺失 exe→失败、负载不执行、无兜底 | exit5 LAUNCH_FAILED，win32=2，无 process_created/resumed 事件，marker 不存在 |
| case5 未知目标+哨兵 | USAGE_ERROR 未启动任何进程；外部哨兵不受影响 | exit2/USAGE_ERROR；哨兵心跳 2→3→6，仅被 harness 自有句柄停止后停在 6 |
| case6 监督器异常 | 杀监督器后子树实际结束 | 杀于 3.2s（3 条心跳后），leftover=0，日志冻结 41=41 字节（KILL_ON_JOB_CLOSE） |

每例 R=10/C=5/外层 25s，编译 20/10/外层 40s，全部符合且远低于上限。9 次运行完整历史（3 个工具缺陷、probe 泄漏与清理、4 处驱动缺陷，每次失败即停、修复后才重跑）保留于 `evidence/s1/attempts.txt`、各 `index-*.jsonl` 与 `selftest/logs/`，未删除未改写。ASSIGN/RESUME 失败路径无法确定性触发（代码在、审计可及）；修复后 CLEANUP_BLOCKED 未再触发（run5 曾实证其如实停止）。

### 9.4 桌面安全门：S5_DESKTOP_BLOCKED

- 只读审计（未运行脚本）：`scripts/test-dsk-storage-desktop.mjs` L78-81 `killTree = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])`；L83 `process.on('exit')` 对 children 数组中**含正常退出且从未 kill 过的子进程**再执行 taskkill /T /F；L89 `child.kill()` + 5s 兜底 killTree。`test-files-desktop.mjs`、`test-dsk-rp2-exit-desktop.mjs` 走 playwright-core `_electron.launch`/`close()`（finally 收尾）。
- 判定：外层 Job 能提供 R 整树硬上界（Electron 等孙代自动入 Job、Terminate 只及本 Job 成员已实证），但**不能消除脚本内部裸 PID taskkill**——尤其 exit 钩子对已退出 PID 的 taskkill 存在 PID 复用误伤窗口。工具层无法在不改脚本的前提下安全修复；本阶段禁止改桌面脚本。→ S5 需最小额外批准（脚本内改真实已创建句柄/子 Job 控制通道 + 未知目标拒绝 + 完整语义与自检），不得以清空/覆盖 taskkill 冒称通过。核心工具是否成立与此门独立报告。
- 本阶段未运行任何产品桌面脚本、npm、build。

### 9.5 S0 更正追认与保护

追认主会话已登记更正为事实（只追加，不改写旧 summary）：首次全范围 review agent_118a54e7 REWORK、前阻塞诊断 agent_41df458c 不计轮次；旧 npm 实为 565 pass+1 文件级 fail 约 1021s；撤回"生产无死锁/真实 rm 必落地/旧 runner 整树安全"声明；诊断 summary disposeStartedBeforeRmMatch 字段按原 trace 时间戳反向解释、原文件不改；A6 旧红只到 (a) 可达；审批工具的 plan 更新不归责 coder。S0 冻结后保护核验：before 620 文件、s0-manifest.json sha256 复核一致。

### 9.6 边界

未 commit/push；未安装下载；未进入 S2—S5 生产返工或 RP5；未重跑 SQLite gate；人工原生验收仍 PENDING。审查重点建议：pidlist 替代会计的正确性、C 窗口语义、env 白名单记录方式（值仅 hash）、桌面 taskkill 风险评估是否成立。
