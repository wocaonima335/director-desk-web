# S1 replan-02：获批续接方案归档

批准来源：本会话 ExitPlanMode 返回 User has approved your plan。
完整批准原文由宿主自动保存于 [plan-sess_74095f29-ff55-49ce-bdd8-bb0bcaf62f97.md](plan-sess_74095f29-ff55-49ce-bdd8-bb0bcaf62f97.md)，只读保留。
规划：director-planner agent_8e82c21f-264c-4faa-bc34-6e2ce44517c4，PLAN_READY。前次调用 Model request failed，无结论；沿用同角色重试，未替换模型。

## 基线与边界

- 真实源码根 E:/director-desk/director-desk-web，HEAD 90464eb4253b83ec5d73f256a6c9be28acf672c0。
- 拉取后初始工作树干净；批准后增加宿主自动计划文件，随后增加本方案索引和任务单，为管理增量。
- 新根 E:/director-desk/verify-rp4-s1-replan-02/ 在开工前预检不存在；E:/、E:/director-desk、源码根均无 reparse 标志。coder 创建前必须重核。
- 本机旧根 E:/director-desk/verify-rp4-rework1-ec5469ba 存在，只读保护；上一机器的 T1 根缺失，未恢复原始源码及证据。
- 旧 S1 两轮 REPLAN、旧 T1 两轮 REPLAN、父 RP4 rework_rounds=1 全保留。本关联不是第三轮补丁，不证明旧候选有效。

## 获批串行任务

1. N0：排他创建新根与保护基线；保存实际文件清单/hash、Git状态、缺失来源说明、完整检查输出及即时退出来源。
2. N1：仅 DESIGN.md 资源/状态/身份/结果/时间契约，director-reviewer 独立静态 PASS 后才能进入 N2。
3. N2：仅 core/RunPolicy.cs、tests/RunPolicyCases.cs 及追加证据；无副作用纯核心，完整独立案例，调用签名全链核查；独立静态 PASS 后停止。

资源维度分别表达，不适用不等于未知。时间显式整数单调毫秒；业务必须严格早于有效运行及最迟收尾进入时刻；收尾可等于最迟进入时刻；完成必须严格早于适用截止。首次清理建立一次截止，重复不延长；父截止贯穿；拒绝转换不改状态。收尾进入时间由纯转换记录，不接受外填 OnTime 布尔。
保留 R10/C5/外25、R20/C10/外40 与外层预留10秒，不加监督层。

## 允许范围与停止

允许新根上述文本与证据，.zcode/workflows/tasks/DSK-004-RP4-S1-replan-02*，本索引。主会话可追加进度.md、implementation/DSK-004-RP4.md、父RP4任务的本轮事实，不能改写旧失败。
每次单一director-coder编码、独立director-reviewer审查。同任务两轮返工不通过转planner，不靠编号绕过。
禁止编译/加载/解释/转译/执行候选与案例，禁止产品测试、桌面脚本、旧工具、探针和进程清理。禁止改生产、依赖、配置、公共契约和数据格式；不commit/push。T2—T6不自动解锁。
本轮仅可交付静态审查结果，不可声称编译或测试通过、运行可信、RP4完成。
