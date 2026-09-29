# DSK-006-A 第1轮返工独立复审：REWORK

reviewer agent_4ab80982-d749-4f9a-90fd-d1c39d7333da。仅A，仍可原白名单修正，不需REPLAN；派第2轮，若再未过转planner，不第三轮补丁。B/C等待。

## 基线/版本与保护

HEAD288f24aa76584965da24e90b843d8217ae4cea0c。
- suite-ids.ts b6e5f51f567f3c949bae3849890c3b9cd0aed7badd01caaa8ce9719df33db0b0
- create-shot-suite.ts 30a310d385594bb3098c6f0ca69af9983dc62f74a37d3ac4a00fe8a53c1b2d1c
- tests/shot-suites.test.ts 48b625c5ff0e536664f3195921ac19f8631a3d74f479d10e97c6960101d6260f
- catalog/input与初审相同。

独立真hash核对：原661主仓、初审snapshot15项、对应旧A证据9项、旧review/work668项均保持；返工manifest.sha25699项一致（正文98 files笔误）。最终主仓/work/attempt06 build/07 targeted/09 full五源匹配。不是mtime证明保护。
主会话审后冻结A/review-02-snapshot/106文件+manifest，含本轮源码/任务及现存logs/artifacts/diagnostics，副本hash一致。旧证据不改写。

## 初审问题闭合

- A-R1 ID已闭合：s-namespace-key有界合法，不同namespace分隔无歧义，角色排序及统一finalize表保持引用。clip实际r0-cc0而非交接r0-c0为说明笔误。测试297行a0123456789abcde仅15位，补真实16位极值，不因实现合规免测试更正。
- A-R2 yaw已闭合：enter/exit/follow等待rotationY等直线路径方向，左右与faceTarget其他分支不冲突。真实逐帧姿态完整覆盖仍归A-R4。
- A-R3原整体出画反例已闭合：真实rig/动画/脚贴合/完整顶点投影；exit按T-1/24路径位置测试，24组合与attempt10可追溯。speed随候选距离改变会产生非单调（attempt11 offset2.4到2.6最近顶点反向变化），但high只从已判offscreen候选赋值，不能仅非单调认定最终解失败。未证全合法帧时长域/独立性能。
- A-R4未闭合，见F1/F2。
- A-R5本轮留存改善成立：11次都有日志/meta/源hash/快照/EXIT；旧缺口保留。RP2因果归因仍过强，须订正。

## F1 高：帧号误当秒，构图检查实际在镜头结束后

tests/shot-suites.test.ts108-110、587-591：ndcBounds接受秒，589传frame未除24。
5秒中/末检查成为60/119秒，15秒成为180/359秒；路径夹末端、动作结束为idle，漏环绕中段/动态pose。
修复明确timeSeconds=frame/SHOT_SUITE_FPS，在采样入口断言0<=t<duration；错误帧号应被守卫立刻拒绝。真实完整模型构图不退回中心。最终用真中/末帧覆盖orbit中段、push末帧、有效point/walk动态时刻，不能改期望掩错误。

## F2 中：真实rig及相机仍未逐帧

tests196-225、558-576、44-70/134-138：基础逐帧主要entityPosition/yaw/samplePose/动作名；567明确frame+=12。相机世界姿态/目标/投影矩阵没逐帧有限检查。每半秒会漏动作切换/峰值。
在已有有限矩阵每帧执行真实animateActor后世界/关节/root变换，实际机位target/方向/world/projection有限；保留位置yaw连续和clips边界。证明每案例0..totalFrames-1全部访问，不以次数或samplePose代实际对象。模型范围至少关键时刻/动态峰值，不要求无限输入笛卡尔积或引擎改动。

## F3 低：probe异常释放建议一并修

create-shot-suite.ts202-208、286-313：正常/显式无解会dispose，但makeActor成功后初始化或动画几何求解抛错可绕closeRigProbe。当前无合法白模可复现异常，不夸为GPU泄漏。
明确try/finally覆盖已成功创建资源，逐出口释放一次且不吞错；受控失败或可审结构验证，不为测试改引擎/公共接口。

## 证据更正与实测记录

RP2建议准确表述：attempt03全套一次F1失败；新旧五源单文件均通过、最终全量通过；未发现直接代码依赖，根因未确定，未修旧模块。不能排除并行负载因果，不为此盲目重跑。

attempt01 41/45 exit1，02 45/45 exit0，03全套720/721 exit1，04旧源RP2单文件15过，05build TS18047 exit2，06最终build0，07最终45/45，08新源RP2单文件15过，09最终721/721，10四案例数值汇总0，11单exit九offset扫描0。日志均有真实EXIT/meta，日期一秒差属记录时点。最终源与build一致。

步速按新源：5秒横左exit speed.7772、15秒.2568、15秒竖右.1009；不混旧.096805，不推断runtime会按Inspector min clamp。

A1/A3/A4/A5通过；A2/A6/A7未完整验证，F1/F2阻断。C真实视觉、完整播放、UI创建/保存/撤销、人工仍未执行。

本次review只读Git/hash/代码/日志，未新跑诊断或测试/build。生成40轮×7120顶点同步开销有风险待B/C测，既有case19-58ms混合断言不是性能基准，不认定已有冻结或宣称不卡。

## 第2轮调度

原A五文件白名单，重点测试F1/F2及工厂F3；已通过ID/yaw不无关重写。新A/rework2独立验证，旧rework1/初版/两snapshot/review根保护。每次源全文/hash/命令cwdUTC/完整输出真实exit含失败追加；历史过强声明仅追加更正。完成定向/必要全套/build后停止写入等审查。扩引擎/timeline/schema/旧UI或改变参数/验收则先BLOCKED，B/C不开始。第二轮再未过转planner。
