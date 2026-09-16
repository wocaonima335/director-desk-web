# DSK-004-product 第1轮返工

状态：REWORK。批准依据：已批准DSK004产品计划及其原验收要求；不扩公共契约/依赖/业务范围。本轮分两段串行交同一coder，合计仍为一次返工，不能分段标PASS。

基线HEAD：0c9cb17887eda8a363ae6472d7917bb2a54c8665。当前工作树包含初始五项修改和DSK004实际实现，全部保留，不reset/clean。
独立reviewer：agent_0f730860-bdfe-4b8d-bce9-278be7441d2e。首轮返回REWORK；428→458测试通过不能替代缺失验收。已有SQLite gate PASS不重跑。

## A段：存储与并发（先实施）

### R1 高：schema识别不严格
library.cjs约62-99/413-446只检查表名与固定迁移字符串，活动库额外trigger可改revision到99，备份额外列也接受；识别前就journal_mode=WAL会改未知库。核验实际表/列/约束/索引/trigger/view及迁移checksum，先只读识别再允许写PRAGMA。不能重建不支持库。构造服务初始化失败应可在UI查询/报告而非attachIntegration直接抛阻断启动。反例：额外列/约束/trigger/view/index/伪迁移/未知版本均拒绝且原库不改。

### R2 高：同长损坏对象被复用
objects.cjs约36-46/69-83 putObject现有digest文件仅验长度，可把同长坏内容登记新可信snapshot。对已有对象核hash/长度且拒链接/junction/目录越界；不覆盖修补坏对象。保存失败current/revision不变。统一读写路径策略。

### R3 高：恢复引用关系缺失
service.cjs604-688未验证snapshot digest/length与objects闭包、唯一性、current/revision、隐藏跨项目行。篡改manifest+DB snapshot digest为不存在值仍恢复成功。登记前严格闭包+全关系校验，复制读取再次核预期hash/长度，避免校验后替换。异常不新增项目，不静默修正current。

### R7 高：传输异步竞态
service.cjs276-345/424-449检查容量在await前、登记在后，Promise.all双upload.begin均成功突破单frame限制；chunk offset同理。await前预留容量/会话slot、每transfer串行操作、await后复核frame generation/取消、reload/close回收pending，不允许迟到登记。严格base64规范与填充，不仅正则。

### R8 高：实际资源界限未落实
renderer先JSON.stringify全量再验长；扫描先压入大数组全部节点再数；规范输出没再验64MiB；manifest/对象先readFile再验证；备份整对象read/write非流式。编码/扫描/读取/规范化全阶段预算，真实文件大小先查再有界读取/流式hash-copy，renderer下载累计长度受限。测试64MiB边界/规范化增大/宽数组/超大manifest/低声明大实际文件与清理及峰值资源。

### R9 高：COMMIT真实异常分类
library.cjs107-116/156-186仅committed=true后的hook失败查证。真实exec COMMIT落盘后抛会普通storage-unavailable而实际revision已1。区分提交前确定失败与提交阶段未知，按预生成snapshotId查证；查不到/不能查分别正确分类，无法确认outcome-unknown而非普通重试提示。测试包裹真实COMMIT后抛、未落盘失败、查证失败、回执读取失败。

### R10 高：续租与busy生命周期
定时renew无catch可未捕获主进程异常；时间在等待BEGIN IMMEDIATE前采样会过期误判；isBusy只看transfers使等待dialog/backup/restore被判idle。事务内取now；续租异常受控失效不复活过期代；全操作/pending预留计数+reload/close取消/排空。真实另一进程持锁跨renew周期测试，无未捕获异常或过期续写。

## B段：renderer与闭环（A段完成后同coder续接）

### R4 高：旧新建/导入保留managed身份
main.ts246-270/events.ts189-203仅替换document不leave，保存新内容写入原A。统一确认dirty、autosave排空、成功离开managed变unmanaged、失败取消保持原状态。验证A→新建/导入B→保存不改变A。

### R5 高：跨工程undo串写
project-library.ts122-130 applyDocument(true)仅清视图，history.replace仍把A压undo；打开B后undo回A并保存进B。跨managed使用真正SceneWorkspace.reset清undo/redo及只属旧历史资源，旧unmanaged普通导入撤销语义保留。

### R6 高：候选切换/启动异步非原子
create覆盖A binding且首存失败只关B，A租约仍续；open先apply/closeA再activate，失败不能保留A；startup无epoch/revision与完整busy，旧加载覆盖新编辑、await activate后误清dirty；bootstrap失败回旧recovery；create无drain。候选session先保留原binding，准备成功和捕获编辑状态仍有效再提交切换，失败释放候选恢复原状态。启动/创建同边界，unknown bootstrap不猜unmanaged。延迟bootstrap/download/activate/首存失败/进行中autosave测试文档identity dirty租约持久选择一起正确。

### R11 中：分页和状态查看缺失
UI只前50项无nextCursor，未调用project.status，unknown却提示去无法查看状态的UI。补最小分页、状态刷新/查看、占用及健康、不确定保存的查询重开闭环。

## 验证要求
- 修复每项补直接反例测试，不仅正向demo；新单元测试仍用原批准tests/fixtures路径。
- 桌面脚本原phase启动B前terminate A，不是双活竞争；真正AB同活busy→到期/释放接管并assert generation/旧writer拒绝，不能只打印。
- managed controller单测不能代替main/modal接线；prepared真UI创建→保存→退出重开→备份恢复+失败取消，记录自动与人工边界。
- 全量npm test/build/prepare/contract+files+storage桌面回归真实命令退出码。
- 不再声称A1-A9通过若关键未测；64MiB满额等批准关键测试不能仅列未验收就完成。
- 未批准的Windows11/断电/安装包/人工项目验收继续如实列出。

执行者不修改旧冻结gate、代理配置、原计划或无关修改。不提交推送。任需越出原允许文件/新增依赖或变更已批接口先报告。两段完成后再交独立reviewer第2轮，不能自行PASS。
