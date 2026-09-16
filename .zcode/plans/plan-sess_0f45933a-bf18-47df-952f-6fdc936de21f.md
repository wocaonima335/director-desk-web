[P]
# DSK-004 重规划：保留已有成果，分项修复并逐项审查

## 当前事实

- 已快进拉取最新提交 `66ce152ccccab068765fdff8f6968e90c81584f9`，分支为 `checkpoint/dsk-003-progress`。
- 已续接 B 段并完成第二轮返工；当前工作树包含未提交实现和测试，全部保留。
- 独立测试 **489 项通过**，但第二轮整体审查仍为 **REWORK**：实际复现了 reload 后迟到发布/登记、未排空就关闭数据库、下载突破总配额、重开后 revision 未更新等问题。
- 根据仓库工作流，两轮返工未通过必须重规划，不能直接启动第三轮修补。`director-planner` 已核实源码与反例并返回 PLAN_READY。
- DSK-003、SQLite 兼容性门禁维持 PASS，不重复迁入源码或重跑门禁。DSK-005 暂不启动。

## 本次申请的最小范围调整

保持公共 IPC、工程/SQLite/备份格式、依赖、64MiB 工程上限、host 16 传输上限不变。

新增允许两处内部实现范围：
1. **`src/scenes/scene-workspace.ts`**：补充可回滚的整档切换原语，保留旧 session、undo/redo、视图和资源；不重写普通编辑撤销。
2. **`desktop/updates.cjs`**：仅让更新重启入口复用统一退出等待，避免绕过存储排空；不修改下载逻辑，也不实际安装更新。

其余沿用已批准的 storage、renderer、integration/main、共享编码与对应测试文件。不改共享 CSS、公共契约、package/lock、代理配置或相邻仓库。

## 执行方式

拆成下列 **8 个小任务**，同一工作树仅一个 `director-coder` 写入；每项完成后交独立 `director-reviewer`，通过才启动下一项。父任务保留两轮 REWORK 历史，不重置计数，局部 PASS 不等于 DSK-004 PASS。

| 顺序 | 任务与主要位置 | 验收重点 |
|---|---|---|
| RP1 | 请求失效与取消：`desktop/storage/service.cjs`、`desktop/integration.cjs` | 每个请求绑定 frame generation 和生命周期；reload/close 同步失效；dialog/复制/发布/登记前复核。明确取消与提交的仲裁边界，禁止取消成功后仍发布或登记。 |
| RP2 | 可等待退出：storage、integration、main、updates | 窗口销毁前停止新请求、取消并排空任务、关闭数据库，再允许退出。超时不能在 pending>0 时伪报正常关闭；测试固定业务时钟、重复 dispose、迟到 dialog、模拟更新入口。 |
| RP3 | 统一 host 配额：storage service | 上传、下载及 pending 初始化共享原子预留；第17个请求被拒，混合传输、失败和取消准确归还槽位。 |
| RP4 | 全路径有界读取：objects、service | 使用已打开句柄 fstat、分块循环、超限哨兵及长度/hash核验；覆盖短读、增长、截断、上传临时文件、恢复、已有对象复用和 manifest。保留 junction 拒绝回归。 |
| RP5 | 产品保存有界编码：`shared/storage/canonical.ts`、managed controller及必要接线 | 逐 token 累计 UTF-8、深度与节点预算，不先生成超限完整树/字符串。保持 canonical hash 兼容；从实际产品保存函数验证64MiB、超1字节、规范化膨胀，并测量主进程/renderer峰值。 |
| RP6 | 可回滚文档应用：SceneWorkspace、main、app-context | prepare不改变当前状态；应用或引擎/视图重建失败时恢复文档、历史、视图和资源；回滚失败明确禁写，不伪称恢复。 |
| RP7 | 统一候选切换：managed controller、project-library、main及相关入口 | 候选所有权与清理统一；持久选择和文档应用可补偿；同项目重开成功后同时采用新版 SnapshotRef/revision；unconfirmed在controller层禁写；确认前后校验身份/版本且不重复确认。 |
| RP8 | 最终集成验收：既有测试、桌面脚本、交付记录 | 全量回归、真实UI与原生目录dialog、unknown保存恢复、并发备份和峰值证据齐全；发现生产缺陷退回对应任务，不在验收阶段混入大包修复。 |

依赖顺序：**RP1 → RP2 → RP3 → RP4 → RP5 → RP6 → RP7 → RP8**。

## 关键实现约束

- **取消**：在 DB 登记/备份发布进入不可取消阶段前仲裁；已经提交或结果不确定时如实报告，不能把排队等待解释为及时取消。
- **关闭**：采用独立计时器，不使用可能冻结的业务时钟；未完成排空则报告关闭受阻。本次不授权强制退出。
- **切换**：统一“捕获原状态 → 确认 → 准备候选 → 验证 → 持久选择确认 → 应用 → 提交/清理”。文档、binding、dirty、历史、租约和持久选择必须一起核验。
- **重开**：下载成功不提前污染旧binding；应用成功时采用真实下载版本，验证 revision1 不确定保存后重开revision2，再保存revision3成功。
- **资源**：64MiB是工程内容上限，不是总内存上限；给出同时存活缓冲预算与实际峰值证据，不能只靠 IPC helper 传输成功。

## 验证与交付

每项先保存具名反例及未修版本的失败结果，再修实现；使用新的隔离目录保留日志、测试源版本和退出码，不覆盖既有审查或 gate 证据。

最终运行：
- `npm test`
- `npm run build`
- `npm run desktop:prepare`
- `node scripts/test-dsk-contracts-desktop.mjs`
- `node scripts/test-files-desktop.mjs`
- `node scripts/test-dsk-storage-desktop.mjs`

额外必须闭合：
1. 真实产品保存入口的64MiB/超限/规范化膨胀与峰值。
2. 已提交但回执不确定 → UI查询 → 取消或确认重开 → 继续编辑保存。
3. 原生目录对话框备份、恢复与取消，mock不能替代。
4. 备份捕获revision1后另一连接保存revision2，恢复得到完整revision1视图，源项目保持revision2。
5. 分页、状态、重开等控件真实可见、可滚动、可点击，不用合成事件或强制点击绕过。

人工交互、Windows 11、断电及安装包验收分别记录；关键产品闭环未完成不能标整体PASS。

## 停止与保护规则

- 目前只完成重规划，批准前不继续编码。
- 任一前置任务未通过，停止后继任务；需要新契约、依赖或额外文件时另报批准。
- 子任务连续两轮返工仍不通过，再次重规划，不无限修补。
- 保留所有现有A/B/第二轮增量和配置；不reset/clean、不自动清理用户对象。
- 本轮不提交、推送、发布或调用真实付费服务。