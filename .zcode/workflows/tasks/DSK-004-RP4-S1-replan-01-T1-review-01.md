# T1首次独立静态审查：REWORK

审查代理agent_d0eb44ed-af9e-4352-893d-3766b8dacf03。仅静态；不是旧S1第三轮补丁。共享核心方案仍可在原T1范围内修正。T2不得开始；T5/T6 BLOCKED。父RP4轮数1、旧关联两轮REPLAN保持。

## 版本和保护

新根 E:/myProgram/DirectorDesk/verify-rp4-s1-resume-01/replan-01。
- core/RunPolicy.cs：dd9fc54a7df3cc9fc9f4593c37d3b75f168fc4c237f8f461693e172ed30db96b，705行。
- tests/RunPolicyCases.cs：8191453a40e0f69dc61a391e983de6bdc4ac7156b6195d4837e371a8427b89a2，498行。
- DESIGN.md：72fb9c09150d46120a8406840974526f1ecf15f31a703767d298b8499456708a，212行。

独立核对624主仓+51旧根路径一致，继承diff一致；64唯一案例仅阅读推演，未运行。A5纯度静态通过，A6当前可核范围通过；A1-A4失败。
主会话审查后、返工前建立evidence/t1/static-review-01-snapshot/，3候选+8检查记录+任务单共12文件，manifest及副本hash一致，不冒充更早版本。

## T1-01 高：未定义枚举可放行

RunPolicy.cs 563–658。RT-01中DeadlineWithin=(TriState)99既非Unknown亦非No，不拒绝；Evidence/Binding/ExitKnown/根/Job/管道/输出/释放类似。ExpectationKind=99落else按LaunchFailure。
修复：限定枚举合法域，必需条件只接受明确成功；完整分支default拒绝，不让T3弥补T1 fail-open。为各枚举、共同条件及各期望分支追加未定义值反例。

## T1-02 高：启动失败混同绑定拒绝

RunPolicy.cs 437–478、644–658；Cases 396–407、454–471；DESIGN 138–163。
Binding同时表示身份匹配与绑定拒绝；Binding=Yes的Create失败被拒，ResourcesCreated必须No，无法表达创建后Assign/Resume失败。零创建分类忽略RootExited=Yes、BothPipesEof=Yes、OutputCapture=Failed等矛盾事实。
修复：分离身份匹配、绑定结果、启动失败阶段，至少绑定拒绝/创建前失败/创建后未归属失败/归属后恢复失败；按真实创建归属事实要求根/Job/管道及释放确认，明确不适用条件并拒矛盾组合。保持纯规则，不实现owner。
反例：每阶段合法失败、创建后清理未知、未归属根未结束、归属后Job不空、零创建却声称退出/EOF/采集失败。

## T1-03 高：持久声明与实际退出未独立建模

RunPolicy.cs 437–462、587–618；Cases 335–337；DESIGN 152–156。
RT-05误将“记录0/进程4”解释为输出文件零字节/退出4。只有一个ExitCode，无法表示期望4/实际4但记录0冲突。
修复：完整持久记录的声明与真实进程观察独立输入，在纯消费者统一检查一致性；输出字节/采集另维度。追加记录0实际4、记录4实际0、期望4实际4记录0、缺失/截断及合法空输出一致正例，不只改案例名。

## T1-04 高：父截止与预留未接入clock

RunPolicy.cs 239–358；Cases 291–297；DESIGN 101–105、199–201。
Start无父截止，BeginCleanup只封顶自身Outer，Check自身字段；EffectiveChildDeadline只是min返回值未进入状态。子14000起算、父允许15000，子Check(16000,Run)仍Within。
修复：定义父对子运行/子清理/最终封存约束关系，让纯接口状态和Check使用有效截止；显式区别最迟进入终止阶段和最终封存截止，提供判断错过预留事实。不可要求T2自行拼额外规则。连贯测试父较早对子准备/运行/首次重复清理/提交影响、预留边界/错过边界/父已耗尽，非仅min单测。

## T1-05 中：清理后时间回退不拒

RunPolicy.cs 277–346。Start1000、BeginCleanup12000后BeginCleanup11000返回AlreadyEstablished无错，Check11000 Cleanup也可Within。
修复：至少拒绝早于已记录CleanupStart；明确最近观察时间契约，若任意时间查询需与运行观察接口区分。追加清理后回退、同刻、递增、清理加法溢出和错误后状态不变；ClockCase须验证PolicyError不只status。

## T1-06 高：异常收尾入口及创建/归属状态不足

RunPolicy.cs 33–63、379–425；Cases 111–128。
Preparing只能BindFailed，Bound只能CreatePending，超期/取消/创建前异常不能合法BeginCleanup；PendingCreate到Owned未区分挂起创建和Assign成功；FinalizeCompleted无事实，Phase可独立赋ResultReady，缺关联。
修复：允许准备/绑定合法直接收尾，显式创建与归属确认；终态构造和收尾事实关联，区分收尾已结束与收尾成功。不能伪造事件或让T2另建状态机。
连贯反例：慢绑定收尾、Bound取消、创建后Assign失败、Resume失败、收尾未结束不提交、收尾结束但失败形成拒绝终态。

## 非阻断与证据限制

- public readonly案例数组内部仍可改，AttemptClock/RunStateMachine公共字段不保证不变量。收紧接口或如实界定，未来运行器只读/副本，不夸不可变。
- 当前初始化/CheckedMath可见性未发现明显问题，编译仍未知。
- 8记录退出码0/1/0/0/1/1/0/0均保留。005/006检查器缺陷有文本支持；002旧候选全文未保存，无法完全复证只改注释。当前快照不补足该过去缺口。
- 所存verbatim python -c命令外层/内嵌引号未正确shell转义，不可称可直接重放Bash命令；返工后新检查用保存的脚本文件及准确调用，原记录保留。
- 旧三次被移除FAIL未恢复；新记录不替代旧缺口。

## 第1轮返工要求

只在原T1白名单修规则/案例/设计；原8记录和新冻结快照保持，新尝试从独立未占用编号继续，保存检查器原文/实际命令/源版本/输出/退出码及失败。T1任务只追加返工交接，不能自行PASS。新接口尚未被T2冻结，可在批准语义内修正；若必须改预算/架构/范围，停BLOCKED。完成停止写入交独立复审，T2仍等候。
