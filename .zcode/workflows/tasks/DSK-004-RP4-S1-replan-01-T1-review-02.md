# T1第1轮返工独立静态复审：REWORK

审查代理agent_d0eb44ed-af9e-4352-893d-3766b8dacf03。仅静态人工推演，未编译/运行/转译候选。仍属原T1纯规则方案，准许第2轮原范围返工；若该轮未通过转planner。旧S1两轮REPLAN及父RP4轮数1保持。T2不得开始，T5/T6 BLOCKED。

## 版本与保护

根 E:/myProgram/DirectorDesk/verify-rp4-s1-resume-01/replan-01。
RunPolicy.cs 1210行 sha256 43a0e9b59f841aafc54281ec8be13e85534b9f28edfeaf8d1b0d32e92becc087；Cases 573行 76a4584c30f51895527e3cb15d9dc43cf341cd429f75ff26f8af2bf81b739181；DESIGN 230行 52199c9140af494cb25a12ef34d98b33a88072c98076c24a92a4c2848370bf75。
独立确认624主仓+51旧根一致、继承diff一致、初审快照12文件及001-008保持、009-013退出码0/1/0/0/0均存在，102唯一案例只证明数量。
主会话复审后、第二轮前建立 evidence/t1/static-review-02-snapshot/，19个现存候选/证据/检查器/任务文件及manifest，副本hash一致；不是缺失早期版本的恢复。

## R1-01 严重：ReasonBuffer按值传递丢弃分支拒绝

RunPolicy.cs 749–767、887、1160–1207。ReasonBuffer为struct，EvaluateConsumed/EvaluateLaunchFailure普通值参，Add只增副本count。无共同错误时原buf为空，分支CleanupUnknown、记录冲突、身份/树/终止错误被丢弃，Finish仍Accepted=true；共享items数组也无法同步count。
最小修复：所有可变收集器调用统一ref或显式返回更新值，审计全调用链。追加仅分支一个错、共同错加多个分支错的静态推演，核拒绝数量/顺序/Accepted；不改反例期望掩盖缺陷。

## R1-02 高：绑定拒绝记录仍接受错误身份

RunPolicy.cs 555–558、897–913；Cases 438–440、460–461、512–518；DESIGN 155–167。
IdentityMatched定义为消费尝试与绑定身份一致，但Refused要求No、Yes判BindingNotRefused。绑定拒绝不等于能接受另一尝试的记录。
修复：记录与尝试身份匹配独立BindingOutcome；若字段只指成功BoundLaunch，则另建拒绝记录身份事实，不能No代不适用。追加正确尝试拒绝记录、另一尝试拒绝、未知身份；Accepted创建前失败保持可表达。纯事实不实现I/O。

## R1-03 高：合法CreateFailed路径无忠实阶段

RunPolicy.cs 115–128、508–510、608–609、888–895、1129–1135。
Preparing→Bound→PendingCreate→CreateFailed→Finalizing→ResultReady合法，但最远Stage=CreatePending不被IsDefinedFailureStage接受，NotStarted又不匹配。注释称相同清理语义但没规范化。
修复：接受CreatePending或制定单一纯规范化规则；区分阶段和实际资源存在，覆盖进程未创建但部分准备资源已创建。未归属根确认不能只靠空Job，资源不适用不能伪造Yes。追加完整路径及部分资源清理未知反例。

## R1-04 高：错过预留仍未影响准入和接受

RunPolicy.cs 265–271、324–363、583–584、720–726；Cases 262–283；DESIGN 90–105、217–219。
父封顶已接入并修原16000仍Within问题。但start14000/outer15000产生terminateBegin5000，Run14999仍Within，无纯准入禁止、无实际进入终止时间事实；Evaluate仅DeadlineWithin，无法分最终没超期与已经错过预留，文档留T4另拼。
修复：明确每层传入父何截止，预留耗尽业务准入与收尾规则；统一纯判定且预留违反进入最终拒绝，按时进入后正常越过阈值封存不得误拒。不加预算/监督层。
连贯反例：边界前/等于/超过、尝试起始预留耗尽、按时入收尾后封存、过晚入收尾但未超Outer。

## R1-05 中：期限案例与调用顺序不一致

Cases 47–51、207–211、239–247、262–273、292–304。
DL-06/DL-10 ExpectedCleanupStatus未填默认Established，实际Rejected+TimeRegression/Overflow。DL-12先设BeginCleanup12000又查更早Run/Terminate并期望Within/Exceeded，与回退Invalid相冲突；若意图先查则模型未表达步骤/快照。
修复：补全status，把期限案例改有序操作或拆前后独立案例；显式核错误前后全字段不变。人工逐步核对，不称102通过。

## R1-06 中：失败检查器和输入版本仍未完整保存

attempt010引用checker-t1-static-v2.py，011明说修改正则/期望/枚举计数，012同名；无逐次脚本hash，当前脚本不是010版本。010/011输入hash不同，未见对应全文。cwd使用省略路径，缺解释器版本。
保留现有记录，登记尚未恢复的原版本缺口，不补造；如果有真实历史可按来源恢复，否则不得声称精确可重放。新尝试每次独立不可覆盖目录/文件，先保存检查器精确文本及hash、输入全文/版本、解释器版本、绝对cwd/调用，再记录完整输出/退出。修改检查器或候选后下一尝试必须新目录，不能覆盖v2或旧记录。

## 覆盖与非阻断

A1-A4失败；A5仅静态通过；A6保护子项通过、完整证据失败。主要枚举域校验、RecordedExit独立字段、清理后回退、Preparing/Bound收尾、CreatedNotOwned状态确有改善，但收集器回归破坏分支行为。
default ResultExpectation=ExitCode(0)应明确，公共字段可改已诚实界定，但残留不可变注释需一致。没发现明显C#5可见性/初始化问题，不代表编译通过。

reviewer自身一次hash核查错误把009包括进旧快照集合，FileNotFoundError exit1；改编号<=8后exit0。是检查器筛选问题，不是文件丢失，审查原结果已如实报告。旧002全文缺口及更旧3次移除FAIL仍未恢复。

## 第二轮调度

原三个T1文本+追加evidence/t1+T1任务返工交接白名单不变；新报告为主会话管理增量。旧候选快照/001-013/v2检查器/历史记录保持。优先修拒绝传递再手工审全部分支及案例，避免增加关键词检查代替语义。完成停止写入交独立复审；若需改预算/架构/验收/进入T2立即BLOCKED。第二轮仍不通过则转planner，禁止第三轮补丁。不编译、不运行、不提交推送。
