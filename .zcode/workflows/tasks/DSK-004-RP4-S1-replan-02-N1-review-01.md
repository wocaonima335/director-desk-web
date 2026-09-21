# N1 初审：REWORK

Reviewer agent_18e3a107-2c2e-4c9e-be5f-afed1e464c03，完整读取DESIGN并静态推演。候选37097B，sha256 8a4176a7b5b746f586d5026acab4eddfb2e75048ef2dc1f96d70ec6d6ee7980c。HEAD90464eb，tracked/staged无diff，六项管理untracked。N0 PASS保留。以下为管理摘要，行号对应该版DESIGN。

## 必须修复的六项

1. N1-01 高，36–54/156/339：父清理截止传递冲突。§2.9允许parentL有值而parentS空，Start出口要求两者同时空或同时有值；C-T07 Start(9000,SC,10000,null)按表应拒绝。父界在Start冻结但Seal又要求父当前S，没有更新接口。反例：子9000启动，父9500清理S14500，子10000清理S15000、14900封存；按父当前S超期，按冻结空S通过。明确父尚未清理合法输入、后建立S的传递方式与生效时刻，统一签名公式与案例，不留N2猜。
2. N1-02 高，192/194–204/358：F12 OutputCaptured仅F5=Yes可登记，但Seal要求F4=Yes时F5/F12必填。ASucc→RFail使F4Yes/F5No，F12禁止登记又必填，C-S09无法Seal；归属后未恢复取消同问题。统一Required/Forbidden，分别推演恢复失败、归属后取消、恢复未知和Running。
3. N1-03 高，172–197/254–280/351–358：所有Required必须Yes与合法资源不存在矛盾。F1/F2恒Required，合法无资源/仅管道却为No；F3/F4/F5也允许No。F1/F2 Unknown/No缺原因规则。Start→BRef(500,Unknown,Unknown)→Seal(700)可登记但最终拒绝原因未定义。区分资源存在事实与成功清理确认，给每项Yes/No/Unknown判定及精确原因。覆盖无资源、仅管道、仅Job、准备资源未知。
4. N1-04 高，88–129/145–168/236–245/304–310：14 static事件接口无RunRecord输入；NewIdle未定义全字段默认值；Start拒绝返回记录不明；Tri无NA但ExpectationMet使用NA且混同未知；Evaluate任意相位/空输入/完成时间空出口不明；RunOutcome.Reason成功值不明。补真正完整纯签名、最小构造、成功与拒绝形态、默认/未封存输入政策，逐调用核查，不能留N2添加参数出口。
5. N1-05 高，255–265/367–377：条件6仅条件5通过才评估观察已知与码一致，但C-R10缺记录仍要ExitObservationUnknown；条件7 EM不是Yes则ExpectationNotMet，但C-R06 Unknown仅[24]而非含[25]。明确记录完整性、观察已知、码比较、期望比较分别门控与原因，不单改案例迁就。完整真值覆盖缺失/截断、未知、冲突、预期失败满足但清理未知。
6. N1-06 中，320–383：C-T02 BCl10001后事实1002..1008均TimeRegression；C-R10 BCl12000后1001..1008也回退。C-T05/T08/T11有F12Yes却缺OutputByteCount。多处同C-T01/EV同上/省略号/任意不满足独立完整输入，缺BCl reason/时刻/ExpectedExitCode/RefusedRecordIdentity。C-S12期望0实际0不是期望失败4满足+清理未知。每条展开独立初态/全部事件参数/全部EV字段/逐步成功拒绝不变性与最终精确原因；coder先逐条人工静态推演，禁止说推演仅reviewer职责。

## 验收与保护

C1–C4失败，C5通过（当前文件与台账范围）。根R/C等号、迟入与完成独立、重复清理不延长、回退溢出拒绝方向可成立，不意味着整案例通过。
独立保护632仓库基线、869旧根、两次attempt各15输入均匹配；N1任务仅implementation变化；完整cmd含ec=$?。没有运行检查器/候选/编译/测试/探针。DESIGN在attempt02后五项修改说明存在但无修改前全文，不能独立证明恰好五处；当前最终字节已完整审查。保留缺口，不追认。

## 续接边界

本轮REWORK不REPLAN，共享核心方向仍可行。不增加预算或监督架构。首轮返工先冻结此版DESIGN/任务/证据；只改已批N1设计及新证据，N2不开始。第二轮仍未通过转planner，不靠新编号延长补丁链。
