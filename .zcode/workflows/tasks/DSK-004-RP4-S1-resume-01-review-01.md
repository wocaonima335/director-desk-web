# S1 文本候选：首次独立静态审查 REWORK

任务：DSK-004-RP4-S1-resume-01。审查代理：agent_3b7f63ab-4f51-4428-ae8c-161fa3d1caac。

这是审查结果与返工要求的管理摘要，不替代原始代理结果。仅静态审查；未编译、执行或操作进程。父 RP4 rework_rounds 保持1。关联任务首次预审 REWORK，当前派发第1轮文本返工；不是父任务第二轮全范围审查。

## 稳定版本和证据

- 基线：2d23931239b98bcd28e91ae256dbc9e0135fc955。
- 候选根：E:/myProgram/DirectorDesk/verify-rp4-s1-resume-01。
- 返工前快照：该根/evidence/static-review-01-snapshot/，10文件含候选、原hash/检查/F5记录及任务单；manifest.json记录hash，主会话逐副本核对一致。该快照在审查后、返工前建立，不冒充更早历史。
- reviewer确认620基线路径无变化，继承两行配置diff一致、生产零变化；7项候选hash一致。
- 原静态检查记files=13，而reviewer枚举实际12，需新增更正记录，不覆盖原检查证据。
- 任务单追加前无独立快照，无法据现有文件独立证明coder仅追加两个节，不据此认定越界；此次已有返工前快照。

## 逐项问题及最小修复

行号均指冻结候选，后续可能变化。

### ST-01 阻断：静态可确认的编译错误
- dskrun.cs 282–286、1153–1158：CreateProcessW声明IntPtr，赋给bool。
- outerwatch.cs 442、466、469、546–576：QueryJobEmpty返回bool却与1比较。
- 修复Win32 BOOL签名和消费类型，复核全部PInvoke。不能以启发式C#5扫描冒充可编译证明；本轮仍禁止编译。

### ST-02 高：Unicode封送及argv[0]
- dskrun.cs 282–286、1149–1156：CreateProcessW未指定CharSet.Unicode，payload路径作为命令行首项未正确引用。
- 明确宽字符封送、首项引用及各参数CRT quoting；场景覆盖含空格与中文的exe路径/cwd/参数。

### ST-03 高：异常安全owner与清理不闭合
- dskrun.cs 1092–1239、1242–1258、1431–1469；outerwatch.cs 334–386、486–542。
- 创建成功至owner建立存在窗口；写端重复Close；Resume/emergency忽略Terminate结果及确认；结果早于finally关闭；outer尚未Assign的child不被Job终止覆盖；线程句柄遗漏；Close/SetHandleInformation失败忽略或丢失ownership。
- 创建调用外围预置唯一owner，统一finally和资源台账；按持有句柄处理未归属进程；关闭成功立即撤销ownership；主错误/清理错误并存；真实收尾后确定结果。C7关闭失败也应影响自检结论。

### ST-04 高：预算语义失效
- dskrun.cs 1083–1089、1134–1225、1313–1372、1424–1443；outerwatch.cs 391–470；driver 304、375–405、574–582。
- setup/Create/Assign/Resume和成功提交前缺截止复查；Finalize的日志/hash/关闭超C不影响成功；outer与driver逐层追加至少10秒及drain预算；driver启动后才计时；编译仅总40秒没有R20/C10阶段。
- 传递绝对单调deadline，setup前起算，单一清理窗不重置，不额外叠加预算；超期/未知不成功。同步I/O及可信外层不能证明硬上界的部分明确BLOCKED，不靠候选彼此认证。

### ST-05 高：outer根退出就传播成功
- outerwatch.cs 418–447、512–527、579–605。
- 根退出后只查询一次Job，未知或仍有后代也close Job并传播0；双管道错误不影响成功，不等EOF，可能关闭正在ReadFile的句柄。
- 成功必须root终态+Job确认空+双管道真实EOF；reader停止与关闭顺序受剩余预算约束；错误/未知禁止成功。

### ST-06 高：driver继承串扰与失败finally遗漏
- driver 338–410、494–547、808–847、869–928。
- C5并发bInheritHandles=true没有显式继承集合，树间可能继承管道写端；C6失败finally未完整释放Job/pipe/thread；Assign失败重复等待，超过预算；Reader.Finished混同EOF和ERROR，C6据此假PASS。
- 每次启动唯一完整owner、受控句柄继承，全部出口统一清理；Reader区分EOF/ERROR/PENDING，成功要求真实EOF与进程signal。

### ST-07 高：场景与fixture矛盾
- driver 636–648、747–760；dsksample.cs 131–141、159–178；scenarios.md。
- C1a允许DSK_RP_SELFTEST_OK却断言全部DSK_RP计数0；应精确区分允许项与stale。
- C3 tree 2 1 hang产生仅sleep1ms孙代，R10秒超时时无法证明整树活跃。
- 修复精确ENV集合断言及真实持续存活孙代，增加到达/存活前置断言；不能只改说明宣称已覆盖。

### ST-08 高：非法JSON与输入绑定缺失
- dskrun.cs 1483–1531；driver 269–304、555–585。
- WriteRunOpen重复包引号、对象无键项，输出非法JSON；argv join丢边界；ENV构建晚于记录；必需bind失败不置失败；缺完整源/exe/compiler/driver绑定和原始编译输出；File.Copy覆盖共享产物；ok &=导致失败后继续编译。
- 合法结构化清单、argv数组、有效cwd与脱敏ENV计划；必需输入缺失fail-stop；唯一尝试产物、不覆盖；失败立即停并保存原始输出。本轮只写文本，不执行JSON生成候选。

### ST-09 高：封口及敏感ENV记录
- dskrun.cs 431–488、1439–1443、1512、1555–1562。
- Seal异常后writer可能活着却hash并称Sealed；TryLog不守封口；迟到reader或WriteResult catch在hash后写；证据错误不阻止exit0；CLI原样记录--env-set NAME=VALUE泄露值。
- 不可逆写入禁区；关闭失败不得称封口完成；证据错误影响最终失败状态，不回写封口日志；CLI脱敏ENV值同时保留结构化摘要。未来仅合成敏感值测试，不用真实凭据。

## 独立认可与未验证

- SDK 22621 winnt.h 870–885、12845–12854确认LARGE_INTEGER=8、四个LARGE_INTEGER+四DWORD=48，offset32/36/40/44。当前修正静态成立；运行ABI/C7仍未验证。
- F1/F2/F3/F4/F6/F7失败；F5部分静态通过；PROTECTION通过。driver前台仅收集不实时转发也需处理或明确失败，不冒充前台实证。
- 全部编译、自检、清理、可信外层、硬实时和无遗留未验证。S5_DESKTOP_BLOCKED、人工PENDING保持。

## 第1轮文本返工调度

继续原白名单及原验收，不新增模块架构、不扩大产品范围。冻结快照和原evidence/*.json只读保护；新检查/hash/更正使用candidate-text-rework1-*.json。保留初次implementation/coder_handover为历史，追加rework1交接，不覆盖旧成功宣称来掩盖失败。报告必须逐项对应ST-01至ST-09及真实静态检查，不跑候选。

候选如果需要改变架构、增加依赖、放宽预算/验收或扩围，停止并交planner；不可通过改注释绕过问题。完成后停止写入，交独立静态复审。两轮文本返工仍未通过则交planner，不无限修补；父RP4历史不清零。
