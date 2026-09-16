[P]
# DSK-004：项目库与不可变快照实施计划

## 当前基础与本次需补充批准的内容

DSK-001～003 已技术审查通过，SQLite 兼容性门禁 G1—G8 也已独立 PASS，**不再重复门禁实验**。

源码检查确认：DSK-003 目前只有项目创建/打开/查询契约，还没有真实工程内容传输、快照保存、备份恢复和具体返回数据类型。因此需要在原 DSK-004 产品范围内，明确批准这些公共接口增量和必要的界面接线。

本次采用一个产品任务 `DSK-004-product`，按存储→接口→界面→验收的顺序串行实施。整体目标仍为 001～008＋016，不新增后续业务任务。

## 1. 交付的用户操作闭环

在现有“文件”菜单增加“项目库”，复用已有弹窗与提示，不提前重做 DSK-005 界面。

支持：
- 列出项目、将当前完整工程创建为受管理项目。
- 打开项目、保存不可变快照、关闭受管理项目。
- 备份已保存的项目及历史快照。
- 从备份恢复为一个**新项目**，不覆盖原工程。
- 显示项目版本、完整性状态、写入占用及失败原因。

保存对象是完整 `SceneDocument` v3，包括全部戏段和共享资源，不能只保存当前场景。

## 2. 主进程存储设计

沿用已验证的 Electron 内置 `node:sqlite`，不增加依赖。

项目库固定放在当前应用 `userData/managed/`：
- SQLite 存放项目、快照登记、迁移记录、写入租约及上次会话选择。
- 各项目独立目录保存以 SHA-256 命名的不可变工程对象与临时文件。
- renderer 不接收或指定数据库、对象文件的真实路径。

新增 SQLite schema v1：
- `schema_migrations`：版本、迁移校验值与执行时间。
- `projects`：项目名称、当前快照、revision 和时间。
- `snapshots`：所属项目、revision、digest、长度与时间；项目/revision 唯一。
- `project_leases`：主进程所有者随机值、generation、到期时间。
- `app_state`：最后成功确认的 managed/unmanaged 会话选择。

只支持空库初始化到 v1；未知版本、损坏数据库或迁移记录不一致时拒绝写入，不删除重建，不自动迁移旧用户数据。

### 快照提交顺序

1. 工程内容有界上传到主进程临时文件。
2. 主进程重新解析并使用现有 `assertSceneDocument` 验证完整工程。
3. 按明确、跨端一致的 JSON 规范排序并序列化，计算 UTF-8 字节的 SHA-256；不复用 `localeCompare` 或单场景 hash。
4. 写完规范临时文件，刷新、关闭，再同盘 rename 发布对象。
5. 在 SQLite 短事务内重新检查租约、generation 和 expectedRevision，登记快照并更新可信指针。
6. 提交成功后返回 SnapshotRef。

写入或登记失败不得让数据库指向半文件。文件已发布而登记失败时可留下孤立对象，但不能把它当成当前版本。识别缺失、损坏和孤立对象，不自动删除或偷偷回退可信指针。

若数据库提交结果不确定，先按预生成快照 ID 查询确认；仍不能确定时返回 `OUTCOME_UNKNOWN`，保留 dirty 状态，禁止自动盲重试。

## 3. 写入租约及进程生命周期

采用 SQLite 中的短事务租约与 generation 校验，不使用 PID 猜测来清锁：
- 默认有效期30秒，主进程每10秒续租。
- 租约过期后的新获取递增 generation。
- 每次快照提交在同一事务内检查 owner、generation、到期时间及项目 revision。
- 老进程恢复后不能凭过期身份继续提交。
- 窗口关闭、重载及关闭项目时释放匹配租约并取消传输；崩溃后等待租约到期。
- 占用和租约丢失明确报错，不抢占、不覆盖；保留编辑器未保存内容。

只承诺本机项目库，不宣称网络共享文件系统或跨版本并发迁移支持。

## 4. 公共契约增量与有界传输

保持现有 `dsk.v1` 信封、原 SnapshotRef、原动作输入以及单条 IPC 限制不变。新增 `storage.v1.*` 动作命名空间及严格的请求/结果 schema。

### 具体新增能力

| 接口组 | 主要内容 |
|---|---|
| 现有 `project.list/status/create/open` | 实现真实 handler；返回受校验 ProjectSummary、ProjectStatus、会话 ID，而非任意对象 |
| `storage.v1.project.list/close` | 分页查询、关闭主进程绑定的会话 |
| `storage.v1.session.bootstrap/activate/leave` | 查询上次启动模式与候选项目；目标加载成功后显式确认 managed 身份；显式离开后记录 unmanaged，避免仅打开候选项目就改变重启行为 |
| `storage.v1.upload.begin/chunk/commit` | 按 session、expectedRevision、声明长度上传并创建快照 |
| `storage.v1.transfer.abort` | 取消并回收本次传输 |
| `storage.v1.snapshot.read/download.chunk` | 只读取本会话项目中已登记的快照 |
| `storage.v1.backup.create/restore` | 主进程弹原生目录选择框，备份或恢复；renderer 不传 raw path |

补充约束：
- bootstrap 只返回模式与不透明项目标识，不静默加载 IndexedDB 或写入旧数据。
- activate 接收主进程已签发且属于当前 frame 的 sessionId；成功加载后才更新最后项目。
- leave 在用户明确确认离开后清除持久 managed 选择；自动销毁窗口不等同选择 unmanaged。
- ProjectSummary 含名称、revision、当前 SnapshotRef/null、时间；ProjectStatus 增加完整性、租约状态和孤立对象数量。
- session/transfer ID 绑定可信 sender、真实主 frame 和加载 generation，不能跨窗口复用。
- 既有通用错误码不变；业务错误用 `ACTION_FAILED` 加冻结的 `storage.v1/<reason>`，不泄漏绝对路径、堆栈或内部租约随机值。
- 对话框取消返回明确的 cancelled，不当成保存成功。

### 传输限制

不放宽当前单条消息262144字符、32层、20000节点限制。

新增工程分块上传/下载：
- 单工程输入和规范化 JSON 各最多 **64 MiB**。
- 每块解码后最多48 KiB；严格 base64、顺序 offset 和总长度校验。
- 每 frame 最多一个上传和一个下载，另设 host 总会话数与临时容量上限。
- 空闲60秒或总时长10分钟后中止；reload/close 回收会话。
- 主进程逐块落盘，完成后有界解析；renderer 同样限制遍历与编码，不无界并行序列化。
- 超限明确拒绝 managed 保存，原 `.director` 导出能力保留；不截断资源。

复用现有工程验证器，但新增无 DOM 导入测试及打包依赖检查，避免将 Engine/UI/浏览器副作用引入主进程。不能复制出一套悄悄不一致的工程规则。

## 5. 备份与恢复

- 备份选定项目全部已登记快照及去重对象，不含未保存编辑。
- 在 SQLite 一致读视图中获取元数据，创建独立备份数据库；不直接复制活动数据库/WAL，不携带租约及 app_state。
- 明确备份 schema 白名单，仅包含必要项目/快照/版本数据；拒绝额外触发器、视图等不支持结构，不执行备份提供的 SQL。
- 备份限制最多10000个快照、总对象10 GiB；对象流式复制并核对长度/hash。
- 所有数据完成后才发布唯一备份目录；未完成暂存目录不能当作有效备份。
- 恢复时只读校验备份 schema、关系、清单、上限和全部工程对象；不信任备份内路径，拒绝符号链接/junction 越界。
- 在项目库里创建新 projectId、新目录并重新映射快照标识，全部对象准备完毕后再事务登记。
- 恢复不自动切换编辑器；用户确认打开后再加载。失败不覆盖现有项目。

## 6. 编辑器接线与 IndexedDB 隔离

- managed/unmanaged 是明确的会话身份，不从文档内容猜测。
- managed 下保存、Ctrl+S、保存并退出走快照；导出副本不等于 managed 保存成功。
- **managed 本阶段仅显式保存快照**，不向旧全局 IndexedDB recovery 写入；UI说明未保存编辑不承诺崩溃恢复。
- unmanaged 保持原 IndexedDB 恢复行为，不删除旧 recovery。
- 启动先判断持久会话选择。上次为 managed 时，损坏或忙应显示错误/项目库入口，不让旧 IndexedDB 覆盖它。
- 异步打开、资源准备、保存和恢复使用 epoch/revision 防止旧结果覆盖新会话或清掉新工程 dirty。
- 切换前取消/排空旧 autosave，跨 managed 工程建立新的撤销历史。
- 打开目标成功完成下载、验证和资源准备后才确认切换；失败保留原文档并释放目标临时租约。
- 创建当前工程首存失败时，新项目标为空，原编辑内容保留且不清 dirty。
- 拖动、draft、导出、AI 写入或未结束存储操作期间禁止切换；主进程 busy 与退出流程接入存储生命周期。

## 7. 允许修改范围

新增：
- `shared/contracts/storage.ts`、`shared/storage/`
- `desktop/storage/`
- `src/editor/managed-project.ts`
- `src/ui/project-library.ts`
- `tests/dsk-storage.test.cjs`、`tests/managed-project.test.ts`、`tests/fixtures/dsk-storage/`
- `scripts/test-dsk-storage-desktop.mjs`
- DSK-004 产品任务单、实施报告及进度记录。

必要接线修改：
- `shared/contracts/actions.ts`、`index.ts`
- `desktop/integration.cjs`、`main.cjs`
- `src/automation/desktop-types.ts`、`src/main.ts`、`src/app-context.ts`
- `src/editor/recovery-autosave.ts`
- `src/ui/project-save.ts`、`events.ts`、`application-menu.ts`
- 既有契约、recovery、scene-workspace 相关测试与 `scripts/test-dsk-contracts-desktop.mjs`
- `.gitignore` 仅在必要时为确切新增交付脚本/fixture提供最小例外，避免源码被忽略。

不修改包版本或锁文件；默认复用现有 preload 和 integration 的 esbuild 接线，不改原 file-host。若实际必须扩大文件范围或改变旧契约语义，先报告，不静默越界。

## 8. 验收要求

1. **契约兼容**：新旧请求和结果严格校验，源端/CJS同 fixture，非法 frame/会话/路径拒绝。
2. **完整保存**：多戏段及共享资源保存、重开无丢失；规范hash跨端一致。
3. **故障处理**：写、sync、rename、DB登记、提交回执故障注入，验证可信指针和不确定结果处理。
4. **真实竞争**：两个独立进程争用、到期接管、旧generation拒绝、释放后重获。
5. **完整性**：缺对象、坏hash/JSON、未知schema、孤立对象明确识别，不偷偷修复。
6. **分块边界**：超过单条消息上限的真实工程成功传输；超64 MiB、越序、坏base64、超时、跨frame拒绝。
7. **备份回还**：并发保存时备份仍是一致视图；恢复为新项目，历史对象一致，恶意结构/路径拒绝。
8. **恢复隔离**：延迟autosave/recover/加载不污染新身份；旧保存不清新dirty；启动managed不加载旧recovery。
9. **真实桌面闭环**：菜单创建→编辑→保存→退出重开→备份→恢复；取消和失败保持原工程。
10. **原功能回归**：旧导入导出、浏览器unmanaged、多戏段及撤销不被破坏。

运行现有 `npm test`、`npm run build`、`npm run desktop:prepare`、契约桌面和文件桌面回归，以及新增存储桌面测试。允许这些原有构建产物和隔离本地测试副作用，不安装新包、不访问付费资源、不提交推送。

测试保留命令、退出码和必要断言即可，**不再重复门禁的多层冻结探针流程**。coder 实施后由独立 reviewer 审查，人工交互、Windows 11、突然断电和安装包未验证项如实保留，不冒称完成。

## 本次批准重点

新增存储接口与结果契约、64 MiB 工程上限、TTL/generation 写入租约、managed 仅显式快照保存、最小文件菜单闭环及上述修改范围。批准后直接交 `director-coder` 实施 DSK-004，不重新运行 SQLite 兼容性门禁。