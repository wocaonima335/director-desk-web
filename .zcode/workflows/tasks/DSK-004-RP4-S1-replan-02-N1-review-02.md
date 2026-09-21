# N1 首轮返工复审：REWORK

独立reviewer agent_18e3a107-2c2e-4c9e-be5f-afed1e464c03。全文审查当前DESIGN及案例，不依赖coder闭合声明。本文件为主会话管理摘要。
版本：DESIGN 52830B sha256 99c70334e4781828e1d8bbb9da32cd14f43d16efb9a9079602decbebfa202b37；N1任务9592B sha256 546c3ef70b9bad0ab9bd55c9254e6b99ad1b20a80e2a9a5b5470d0eb55778830。HEAD90464eb，tracked/staged零diff，七项管理untracked（写本报告前）。N0 PASS保留，N2不得开始。

## 第二轮必须处理的具名问题

### R1-01 高：父有效截止被弱化（DESIGN 41–65/174–180/402–403/481）
子9000启动，父9500清理S14500，子10000清理14900封存，当前C-T07b接受，与父截止贯穿相反。仅Seal加parentSNow不足：父1000清理S6000/L10000，子7000 Start及7001 Bind仍成功，业务已超父截止。父S还错误采用原始entry+C而非受祖先约束后的有效S；有父S时公式遗漏本层Outer的min。
要求在现有纯规则接口内明确父界传递与检查，覆盖子启动前/后父S建立，Start、每次业务、首次清理、清理继续、封存；父/祖先界与本层Outer均不放宽；超期允许清理但不允许业务/接受；重复清理不延长或解除已知界。补父S<L、父已超期、多级父链及等号完整反例。坚持不追溯必须REPLAN，不能改案例绕过。

### R1-02 高：清理事实绕过阶段不变量（97–98/158–166/199–201/215–230）
反例Start0/Bind100/PrepYesYes200/CSucc300/ASucc400，未RSucc即BCl500 CancelRequested；清理登记F5Yes被允许，登记F6–F12Yes/Out0/Seal后Stage仍None，Evaluate观察Unknown却可接受，绕过运行后的退出/记录/期望校验。明确阶段事件独占事实与可补观察，禁止恢复Yes但阶段不运行的可接受组合。
另Preparation失败写F3No，但CreationIssued=false矩阵要求F3不适用null；C-S05/S14/S15依赖矛盾。统一事件产出与适用性，不只补案例名。

### R1-03 高：Unknown与NA混同、未知码被比较（94–95/267–280/294/315–322）
非运行ObservedExitKnown=Unknown代表NA，与运行未知混同；EM只有NA/Met/NotMet，无法表达适用但未知。6c没门控观察已知，rec4/obsUnknown0产生[23,24]，占位改4变[24]。未知码不应影响冲突。使用明确独立适用性或可空/封闭域，区分未知与不适用，记录比较仅观察已知时。静态推演rec0/4×观察已知/未知×记录存在/缺失/截断，精确原因；保持缺记录不吞观察未知、预期失败不吞清理未知。

### R1-04 中：接口/构造/完整出口未冻结（101–151/170–193/287–301/368–371）
非泛型struct RunOutcome却返回RunOutcome<RunRecord>；RunRecord类型及构造可见性未定，null/非法Phase/Stage/事实入口政策不明；ExitEvaluationInput struct默认值与全部必填冲突；Evaluate早退未给Stage/OnTime/Within等全部返回字段；实际接口表含14事件+NewIdle+Evaluate及RecordEquals，不能用15计数当全签名覆盖。统一现有返回类型、受控构造、非法/空/default政策及所有出口完整值，不加通用框架。

### R1-05 中：案例断言与独立性仍错（396–406/414–415/431–446/451–453）
C-T02 CSucc后ASucc被拒应保持CreatedNotOwned而非CreatePending；C-T10同。C-S03首次清理500所以S5500，不是按完成700重算5700。C-R11 EV2非法RefusedRecordIdentity早退EM应NA非Met。C-R02–09b/C-R11仍引用C-T01/C-S04全序列，不独立。C-T07b父9500事件排在子9999后，与全局有序叙述不符。展开每条全输入，全部返回字段，修精确断言并补R1-01–04反例。
已修的清理时刻回退与Out缺失不重开；被拒调用不更新时间，所以C-T05拒12500后登记12001不属回退缺陷。

### R1-06 中：旧证据被改写、全文冻结缺失
frozen-pre-r1仅有DESIGN和manifest，无6876B任务前全文。旧design-final-hash.txt改为版本历史，原五处说明丢失；README旧hash表被改，不是仅追加。attempt05 stderr实际PowerShell缺目录/输入，不是README所称Bash重定向内容。632/869保护不会覆盖新根历史证据。
先冻结当前DESIGN、任务和全部将触及证据全文；只新文件追加。能从真实来源恢复旧全文须标事后恢复，不能伪称运行前快照。明确更正，缺失不补造，不重开N0。reviewer从当前任务移除review1块所得hash吻合旧c9fcf81b，只证明implementation-only，不证明曾落盘冻结。

## 验收与可保留结论

C1–C4失败；C5失败但仓库/旧根保护子项通过。N1-02具体F12死结关闭；资源No合法与Unknown原因、状态参数、默认表、未封存[9]、成功Reason null有所改善，不等整体闭合。C-S08[35]、C-S11[42]、C-S12期望4观察4记录4而Job未知[38]/EMMet、C-R10[7,21,24,38]等片段可成立。
独立632基线及869旧根一致；attempt03/04/06各15/16/16输入hash匹配，exit0，stderr空；attempt05四已生成hash匹配，exit1/stderr1993B保留。cmd有实际捕获语句，mtime佐证先落盘但非独立后台认证。未执行检查器、候选、编译、案例、产品或探针，未写文件。

## 派发与停止

第二轮返工只在获批N1设计及独立追加证据修上述六项，不加预算、监督层、产品接口，不进N2。第二轮仍未通过转planner，无第三轮补丁。冻结v1只保留已审版本，不补回更早缺失版本。任何闭合声明须独立复审确认。
