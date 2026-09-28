# DSK-005-A 独立审查：REWORK

审查代理agent_0c1fc29e-92ff-4cd5-be24-1fa88297ba16。仅A，原方案可行，无需REPLAN。不得开始B。人工视觉及Windows DPI PENDING。

## 版本与保护

HEAD51d6042bd30e2448ed9805a61eb0ffcf05ccd159。645基线路径仅main.ts改变，继承两份provider/plan保持；业务增量为main+shell.ts/theme.css/单测，无白名单外业务修改。独立根：E:/myProgram/DirectorDesk/verify-dsk005-20260928T020909Z-351e3977/A-review-20260928T034133Z-02ff5b。

主会话审查后返工前冻结A/static-review-01-snapshot/，34文件含4业务文件、任务、现存辅助脚本/日志/截图，逐份hash一致。不是对历史每次运行输入的追认。review根与coder旧证据保护不覆盖。

## A-R1 中等/阻断：Space误触播放

shell.ts38–43只有click；既有events.ts266–269全局Space preventDefault并play。独立实测聚焦director-mode-toggle按Space后shell仍simple、播放label变暂停；Enter正常。
修复限shell白名单：隔离Space不冒泡到全局且一次正确激活，保留其他位置Space播放。验证暂停/播放×简易/高级×Space/Enter往返，模式只变一次、播放不变、焦点可见。

## A-R2 中等/阻断：状态保持有空断言

tests/director-ui-shell.test.ts110–118/149–165中state未连接ctx，无法发现状态变化；browser脚本文档JSON不含main独立dirty/revision（main62/439–445）。静态未见主动写状态，不指认破坏。
修复测试真实传入边界，补可审计实际dirty=false/true、非零revision、选择和双向切换证据，不扩AppContext/公共契约。分别记录文档、dirty/revision、选择、暂停时间；播放中应继续推进，不能要求时间冻结。若无现有可访问状态，优先测试ctx getter/调用边界及隔离验证手段并明确插桩边界，禁止冒称生产原样或添加生产调试IPC；必要范围变化先审批。

## A-R3 中等/阻断：UI必要验证不足

1. 原脚本仅查项目库位置，未实际打开或保存；独立打开旧AI/导出也不等同项目库保存回归。
2. 隐藏search focus失败不等于完整Tab/隐藏高级区/焦点恢复覆盖。
3. 两尺寸用CDP仿真，未记真实窗口bounds/Electron zoom，不能称两真实主窗口通过。
4. 窄宽只查部分控件，镜头/属性退场不是分区切换/局部滚动；允许占位但应可访问。
5. 全量测试RP2失败未有可比基线，单独复跑及无导入不证明无回归。

在A原范围补项目库/保存入口、键盘路径、真实两尺寸与窄区访问证据；不要求提前做C全存储/6缩放矩阵。全量失败保留、归因未知，或同条件隔离基线对照；不得擅改RP2或弱化断言。需要旧CSS等白名单外修改先申请。

## 独立实测与更正

- 单测5/5 exit0；browser原脚本42PASS exit0；prepare含build/hooks exit0；desktop原脚本实际21PASS exit0（coder日志同样21，撤回23/23）。
- review-diagnostic.mjs exit0仅采样完成，包含Space失败，不代表全通过。
- 高级布景/拍摄/并排往返恢复正确，不能仅因simple CSS与mode变量差异判视图回归；播放中切换保持播放。菜单ArrowDown/Escape焦点恢复、旧AI/导出弹窗打开有实证。
- 新review与coder JS/CSS字节一致、dist/staging匹配；CSS729050cc497a8aebc4f8a8390aaaefc83c6963fa3472bca864cf75722b334f66，JS8ec05791c0806884c10f15fc9e6b516de981b911a519d21ee61e0af94207e451。不依赖mtime证明当前产物，但历史每次输入仍未独立可证。
- 原全套641项640pass/1fail：RP2 handle-close cleanup-failed实timeout，归因未知。未独立重跑全套/基线对照，不能认定flaky无关。
- 截图Read未送达模型，reviewer未视觉审图，不称已看过。

## 验收与返工

A1通过；A2/A3/A5/A6未完整验证；A4失败。1280/150%有效宽约853受旧body min-width1000限制，完整005矩阵未过，C仍需处理，不得事后称A已经覆盖。人工未验收。

第1轮返工原白名单：shell/theme/测试及必要原装配范围，辅助验证在A新rework1子根；旧A/logs/shots/work及review根原样保留。新输入/产物hash、命令cwd/UTC/退出及失败逐次保留，数量与日志一致。完成停写交独立复审，B不启动；两轮未过按工作流转planner。不提交推送，不付费调用。
