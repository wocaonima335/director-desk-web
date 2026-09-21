# T1 第2轮返工独立静态复审：REPLAN

审查代理agent_d0eb44ed-af9e-4352-893d-3766b8dacf03。两轮返工仍未达到必要条件，停止T1补丁链，转director-planner；新方案重新批准前不编码，不派第三轮。T2未开始，T5/T6 BLOCKED；旧S1两轮REPLAN、当前T1两轮历史、父RP4轮数1保留。本文为原始审查结果的管理摘要。

## 版本与保护

HEAD 2d23931239b98bcd28e91ae256dbc9e0135fc955。根 E:/myProgram/DirectorDesk/verify-rp4-s1-resume-01/replan-01。
- RunPolicy.cs 1340行，db4f73d7bd255cdee8f34bcc8dbf07fb529012133ad763ec564af91e638d031c。
- RunPolicyCases.cs 623行，9251aa46ea50b97e9c3326afcc00f2d5843635e7cb436922f67ec7e9e566a073。
- DESIGN.md 188行，1639c83854e73a7530376c8f92987ab662ab75ae4fce859eada8eaf2914285e2。

独立核实624主仓+51旧根路径无变化、继承diff一致、快照12项/19项及旧001-013/v2检查器保持；新管理记录单列。主会话本次审查后冻结evidence/t1/static-review-03-snapshot/，64现存候选/检查器/尝试/任务文件及manifest，副本hash一致，不声称恢复早期缺失版本。

## R2-01 阻断：Finish调用漏ref

RunPolicy.cs 746–750、1289–1299：非法期望出口return Finish(buf, RejectionReason.ExpectationInvalid)，唯一声明为Finish(ref ReasonBuffer buf,...)。整个候选静态类型不一致，不是仅该分支执行才失败。两分支和正常出口ref确已改善，但“全链审计”不成立；计数ref声明不能检查调用。
规划完整收集器调用图与签名一致核查；不直接第三轮一行补丁。未来编译仍需T5批准。

## R2-02 高：资源事实适用性矩阵不完整

RunPolicy.cs 577–581、818–930、1073–1145；Cases 518–541；DESIGN 40–41、98–105。
- EvaluateConsumed不检查ProcessCreated/PreparationResourcesCreated；RT-01改ProcessCreated=No或GreenExit本身默认Unknown仍无拒绝。
- LF-01绑定Refused/NotStarted可接受PreparationResourcesCreated=Yes及JobEmptyConfirmed=Yes，违背零创建定义。
- 准备资源含管道/Job，却一律等同Job存在；仅管道创建、Job失败且管道释放不能忠实表达，被迫虚构Job空。
规划先冻结Stage/Binding/进程/Job/管道适用性矩阵，不继续堆布尔。覆盖Running+进程No/Unknown、拒绝+有资源、仅管道无Job、未归属根未退出、释放未知。

## R2-03 高：预留规则仍是外部填写的布尔

RunPolicy.cs 267–275、351–366、608–611、767–776；Cases 289–305、445–451；DESIGN 55–68、141–142、170–173。
起始预留耗尽拒绝及OnTime No/Unknown最终拒绝成立。但start14000、terminateBegin20000、RunDeadline24000，在21000 CheckRun仍Within，无统一继续业务准入，无实际进入时刻登记；TO-01只赋Yes，没有时间输入关联。注释“不晚于”与阈值等号Exceeded矛盾。
规划显式时间输入的业务准入、阶段进入登记及最终期限判定，统一父运行/清理/总截止传递。区分按时入收尾后跨阈值、过晚入但未超Outer、阈值已到仍继续业务，不加预算/监督层。

## R2-04 中：案例基准残留不适用身份

Cases 499–504、555–581。LF-21/22/23从GreenLaunchRefused继承RefusedRecordIdentity=Yes，改Binding Accepted未清Unknown，按正确规则必加RefusedRecordContradiction。
因此LF21实际多一拒绝；LF22不应接受；LF23也多拒绝。不是修改规则迁就案例，LF27已正确覆盖该矛盾。规划完整事实构造/审查，每条案例核全部输入而非最后赋值。

## 已改善与验收

身份维度基本修复，记录码与实际码独立、合法分支ref传播方向正确；CreatePending已接受；清理回退及DL06/10/前后拆分原具体问题关闭。default expectation和公共字段契约如实保留。文件头REWORK1未更新为REWORK2属非阻断说明问题。
A1-A5未过（纯度子项通过，但调用签名失败）；A6保护通过，部分来源未验证。116唯一案例TR26/DL22/结果68只证明文本数量，全部未执行。

## 014-018证据与限制

退出记录0/1/0/0/0；015失败保留。逐次checker hash匹配，015-017输入副本与清单/输出hash一致；017三个输入==live。016/017脚本仅计数115→116及DL21→22差异可核。
015 exitcode为事后补记，文本支持该失败分支选择1，但没有引用即时工具退出来源/捕获过程，不升格为即时OS退出实证。postscript承认live-vs-inputs未生成，覆盖meta“已断言”的冲突声明。当前主会话未检索该外部即时记录，不宣称确定永久丢失或已恢复。
002全文、010/011中间版本、更早3次FAIL未恢复；新快照不补足历史。所有本轮审查Bash exit0，仅已有LF/CRLF提示；只读审查，无编译、执行、转译或写文件。

## 重规划要求

1. 收集器调用签名审计方法，避免关键词计数当类型证明。
2. 绑定/阶段/进程/准备资源的最小适用性矩阵，消除相互矛盾字段。
3. 实际时间输入的准入/进入/收尾纯规则，统一等号边界。
4. 完整事实案例，避免基准继承污染。
5. 每次检查不可覆盖版本和失败退出可靠捕获；缺口诚实登记。

共享核心路线未被否定；新方案不得默认扩大预算、产品范围或监督架构。停T1，T2不推进，可信外层及编译/运行均未核实。
