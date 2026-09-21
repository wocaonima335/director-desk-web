# S1 第2轮文本返工独立静态复审：REPLAN

审查代理：agent_3b7f63ab-4f51-4428-ae8c-161fa3d1caac。此前额度中断无结论，不计技术失败；续接审查已完成。本文为原始审查结果的管理摘要，不是运行证据。

## 停止决定

两轮文本返工均未达到必要条件，必须转director-planner；不得第三轮coder补丁。新设计/范围经人工批准才可实施。父RP4 rework_rounds仍1，本关联文本任务保留2轮及REPLAN历史。运行BLOCKED、S5_DESKTOP_BLOCKED、人工PENDING。Job路线未被否定，但owner、截止、提交协议与故障验证需整体重规划。

## 基线与保护

HEAD 2d23931239b98bcd28e91ae256dbc9e0135fc955；620基线路径零差异，两行provider diff保持；两份快照各10文件及旧6证据一致；6份当前候选hash匹配rework2清单，历史交接保持，生产零变化。审查时验证根实际40文件，不是coder所说41；static-checks自身也是40。无exe/dll/pdb/log/jsonl。

主会话在本次审查后建立 evidence/static-review-03-snapshot/，保存当前6候选+3份rework2证据+任务单，共10文件及manifest，副本hash核对一致；不冒充早期证据。验证根为 E:/myProgram/DirectorDesk/verify-rp4-s1-resume-01。

## R2-01 阻断：未声明字段

outerwatch.cs 406–418、508–529、825–834使用_hChildReadOut/_hChildReadErr但无声明。需恢复完整唯一管道owner及声明/使用核对，不只补字段就宣称资源模型完成。

## R2-02 高：finally无法撤销已求值成功

driver 1320–1352 C6 return ok后finally改ok=false不能影响待返回bool；generic thread close、LaunchChild写端和失败释放忽略结果；C3/C4/C5未统一消费Findings（648–649、716、377、443、449–453等）。
规划统一结果对象和收尾后的唯一提交点，所有关闭/终止/确认进入同一协议。未来故障验证case、summary、进程码一致，不以局部bool修补。

## R2-03 高：完整生命周期预算仍不成立

driver 583–755、868–954、1235–1236、1251–1358；dskrun 999–1059、1380–1414；outerwatch 641–648、722–782。
- generic启动前缺deadline消费，慢setup可超时恢复。
- C6独立ready10秒、证明10秒、join3秒、finally5秒；C5执行链后sentinel再完整25秒join。
- C0绑定/hash在R外，rawSink.Dispose在C前，40秒仅事后比较。
- C7虽传20/10，主体不查R；日志/查询慢仍成功。
- dskrun成功检查后写同步SUCCESS日志；outer quiet/封口/最终输出后缺最终判定。
- outer/driver到总截止才终止，未给确认留预算。
要求规划每层及C0/C6/C7统一起点、R/C边界、终止阈值/确认余量、收尾覆盖。不得加预算或重解释setup；同步I/O硬上界未知保持阻塞。

## R2-04 高：持久结果与进程结果冲突

dskrun 1539–1605、1764–1789：cleanupOk在Seal前缓存；Seal/hash超C仍用旧值；result先0、RESULT后超期改进程4，消费者未消费更正行；部分写成功内容后异常无未提交协议；只对SUCCESS降级，业务3/5可掩盖清理未确认并打印cleanup_confirmed=true。
需先规划业务结果/清理状态/证据提交状态及权威记录，所有消费者同一协议，不能仅“先定码后写”或“补更正行”。未来覆盖部分写、完成写但超C、业务非零叠加未知清理。

## R2-05 高：终止请求不等于结束确认，日志失败阻断释放

outerwatch 722–787、791–816、329–355；dskrun 473–509、1241–1261、1521–1537。
outer Emergency设置terminateRequested后Finish跳确认；整段try/catch仍一错跳余项。两日志Seal在evidenceError时直接return不释放writer。dskrun Create后环境释放/Attach/关写端仍在owner try前；组内一错跳过其余资源。
规划每资源owner完整范围、requested/confirmed独立状态，日志失败独立释放，逐资源错误保全。

## R2-06 高：启动前完整绑定未建立

driver 819–844、977–985、1033–1035、1085–1088、1189、1269、1375、1412–1494。
chain-bind缺源/driver源/构建对应关系，命令含省略号摘要；C1d忽略绑定写失败；C4/C6/C7绕完整门；普通链未向dskrun传必需集合；单case任意exe未核C0产物关联。
规划唯一构建输入→产物→运行尝试身份链，所有启动必经门，写失败无启动；实际完整argv/cwd/脱敏ENV而非摘要；缺源/换exe/清单失败反例。

## R2-07 高：自检新增回归

dskrun 1152–1156、1833–1870；driver 993–995、926。
C1a仍在log找被删除的ENV逐项文本，实际改入run-open；C0强制raw输出长度>0，但csc -nologo成功无诊断可合法零字节。
断言需消费真实权威记录，保留精确ENV对照；区别完整EOF零输出与丢失文件，不弱化验证。

## R2-08 中：分隔符消费与存活证明边界

outerwatch 879–925、939–995；driver 1118–1154；dsksample 171–198。
scanner不识别--作为选项值，Parse允许--label --却被截；带引号"--"切片idx+2非token末尾。C3 t为孙代本地循环，t>=8比早期心跳强但未关联host deadline/终止，提前退出仍可过。
规划与实际参数消费一致解析或明确拒绝；宿主时间/成员确认关联心跳，保留提前退出反例。

## R2-09 中：检查器失败证据缺失

rework2-static-checks.json 58–62、86–90、138及任务checks：三个superseded FAIL被移除，只剩notes，40文件中未见原始完整命令/检查器版本/输出/退出记录。不能证明完全是检查器错误；两旧快照无法补足。41/40更正。
若有外部原记录可准确引用，未定位则标缺失，不补造。主会话目前未验证外部原记录是否可恢复，不声称已恢复或确定永久丢失。后续每次尝试追加保留失败和检查器版本，17PASS只指当前记录。

## 验收状态与后续

F1/F3/F6失败；F2/F4部分改善未过；F5静态48字节布局正确但C7实际未验证且缺deadline；F7改善保留但解析/C1a回归；PROTECTION通过。无编译/加载/自检/probe/产品测试/build/prepare/桌面/进程操作/下载/提交。

planner须读取实际源码，优先消除三份启动/清理逻辑重复产生的不一致，评估最小可验证任务切分；不能默认扩大生产/脚本/依赖范围或放宽预算。必须明确首次编译/验证可信外层自举，不允许候选互相认证，无法核实则明确BLOCKED。重规划提出后重新审批，再由coder单任务实现。
