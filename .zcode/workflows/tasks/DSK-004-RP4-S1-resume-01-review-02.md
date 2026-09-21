# S1 第1轮文本返工静态复审：REWORK

审查代理：agent_3b7f63ab-4f51-4428-ae8c-161fa3d1caac。本文是原始代理结果的管理摘要与第2轮返工要求。仅静态，不授权编译运行。父RP4 rework_rounds=1不变；关联任务第1轮返工未通过，允许原范围内第2轮，若仍未通过必须转planner。

## 保护与版本

主仓HEAD 2d23931239b98bcd28e91ae256dbc9e0135fc955。独立核验620路径零差异、完整tracked diff仍仅两行provider映射；首次快照10文件、原三份证据、历史implementation/coder_handover均保持；返工候选6文件hash一致。验证根26文件，无exe/dll/pdb/log/jsonl。生产零变化。

本次审查后、返工2前主会话冻结：E:/myProgram/DirectorDesk/verify-rp4-s1-resume-01/evidence/static-review-02-snapshot/，10文件及manifest；逐副本hash一致，不冒充更早存档。旧快照与原证据只读保护。

## 已改善但不等于验收

- ST-02 Unicode和argv[0]原缺陷静态关闭，往返未运行。
- ST-05根退出后等待Job空+双EOF已接入，但截止和清理失败协议未闭合。
- ST-07 C1a允许项与C3持续挂起孙代矛盾已修，两次早期心跳不能证明截止时存活。
- F5的48字节布局继续正确；C7默认负预算使正常自检失败。
- ST-01/03/04/06/08/09未闭合。17/17源码构造检查不证明类型、owner和deadline正确。

## R1-01 阻断：新增类型错误

位置：dskrun.cs 380–385、807–811；driver 211–215、386–399。
Budget访问private Program._log；driver CreateProcessW签名ref STARTUPINFOW而实参ref STARTUPINFOEXW。
要求：受控日志接口或显式传递，匹配扩展结构原生声明。逐个调用核可见性/实参，不只扫返回类型。禁止编译，编译证据待另批。

## R1-02 高：owner与资源生命周期

位置：outerwatch.cs 366–398、528–586、913–927；dskrun.cs 296–310、1235–1269、1483–1585。
outer EmergencyFinalize只终止Job，未使用_childAssigned区分尚未归属child；Ledger关闭前移除记录，失败丢owner；dskrun直接StringToHGlobalUni实参不保存释放；_finalized提前置true，收尾异常后后续资源跳过且不能再进。
要求：真实创建/归属状态分支；成功关闭才撤ownership；环境块独立owner/finally；每资源独立收尾，主错清理错保全，不能一错跳过余项。不要用owner名称/注释代替实际释放。

## R1-03 高：预算仍扩张

位置：driver 533–634、714–766；outerwatch.cs 293–398、437–455、481–550；dskrun.cs 380–386、1228–1255、1392–1430、1551–1589。
driver Create/Assign/Resume后才计时；超时追加10秒、join3秒、finally再10秒；outer确认/未归属/Finish另建10秒；Create/Resume/quiet-success缺临界检查；RExpiredAt先判定后阻塞日志，返回旧值；C0在输出/hash/bind前计finalize时间；最终前台RESULT在最后C检查外。
要求：setup前绝对单调截止，同一剩余预算贯穿所有等待和收尾，不临时加窗；日志后复查，成功提交前检查；同步I/O无硬保证明确BLOCKED，不以此放弃可实现的预算逻辑。列每层deadline表。

## R1-04 高：清理失败仍成功、结果先成功后降级

位置：dskrun.cs 1547–1573、1721–1750；outerwatch.cs 536–564；driver 605–634。
忽略Ledger.Close/CloseAll失败；outer Findings不影响exit0、确认到期未记未确认；driver finally忽略Terminate/Wait/Close；dskrun先WriteResult再降级，文件exit0与进程4可冲突。结果写失败本轮已会降级，不能继续说该路径仍直接0；其他缺口保留。
要求：结构化业务状态/清理状态/证据状态；清理未知不成功；明确结果提交及提交失败协议，不能把未过收尾门的0作为最终持久结论。声明及自检核对文件与进程码一致性，不伪造同步I/O绝对时限。

## R1-05 高：属性列表、helper与driver finally

位置：driver 345–422、547–634、1064–1137。
SetHandleInformation未查；未初始化也DeleteProcThreadAttributeList；先free pin后Delete；LaunchChild抛异常读端无释放；C6 Created=false丢read；Job close失败仍清零；generic runner根退出不等Job空/EOF，finally可能杀后代却接受成功；等待仍重复。
要求：已分配/已初始化分离，销毁列表后释放引用存储；全部异常出口明确owner移交/释放；失败关闭保持可操作身份与失败结果；正常成功要求树和管道终态。

## R1-06 高：布局自检负预算

位置：dskrun.cs 781–782、855–860、962、1063–1065、1569–1572；driver 1160–1174。
C7只传selfcheck/run-root/label，跳正预算校验但默认R/C=-1；Finalize必判超期。
要求：布局自检明确使用已批准R20/C10短验证预算，显式传递并校验，不禁用清理失败检查。核C7实参到Budget全链。

## R1-07 高：预绑定仍缺失

位置：driver 703–766、1207–1243；dskrun.cs 1626–1707。
C0先启动编译后写“编译前”清单/源hash；普通链没完整源/exe/fixture/driver绑定；自身exe hash失败null不拒；bind_targets为JSON字符串数组非对象数组；失败记录再hash可抛；Reader丢无换行尾段，逐块解码/按行重写非原始输出。
要求：Create前完成并落盘完整命令/输入绑定，产物链可追踪；必需hash失败fail-stop；失败记录不再次依赖失败hash；明确JSON类型；保存原始字节或如实标非原始并补必要取证，不能只改称谓弱化验收。

## R1-08 高：日志错误可被Seal掩盖

位置：dskrun.cs 464–466、472–505、1553–1559；outerwatch.cs 734–774。
TryLog曾失败但后flush/hash成功仍Seal true；outer吞异常；关闭失败writer可能未释放。
要求：不可逆evidence-error状态，后续Seal不能抹去；独立不再写日志的释放路径，未知/未释放如实报告。保留封口屏障。

## R1-09 中：分隔符与存活证明

位置：outerwatch.cs 788–843；driver 938–954；scenarios.md 31。
raw IndexOf(" -- ")不识别引号，路径/label内子串会误截；C3任意两次早期心跳不能证明R截止仍活。
要求：引号感知与实际argv对应解析，或明确校验拒绝不支持值；增加截止附近存活证据/提前退出反例，收窄不成立的声明但不削弱真实整树超时验收。

## 第二轮调度

在原白名单修真实代码，无新增依赖/产品范围/预算/验收变更。候选与两个快照、所有旧证据保护；新证据使用candidate-text-rework2-*.json，任务仅追加rework2_coder。原rework1全部完成/不叠预算/完整绑定的声明保留为历史并明确撤回对应过强部分，以独立复审优先。

完成后停止写入并提供逐R1映射、实际静态检查和未运行项，交独立复审。若必须换架构/放宽预算/改变验收，立即BLOCKED转planner；第二轮返工仍不通过则REPLAN，不第三轮补丁。运行门BLOCKED、可信外层未建立、S5_DESKTOP_BLOCKED、人工PENDING保持。
