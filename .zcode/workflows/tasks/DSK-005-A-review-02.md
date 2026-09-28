# DSK-005-A 第1轮返工独立复审：REWORK

审查代理agent_0c1fc29e-92ff-4cd5-be24-1fa88297ba16。方案仍可行，原白名单内第2轮返工；A未通过，B不启动。若第2轮仍未过转planner，不无限补丁。

## 保护与证据

HEAD51d6042bd30e2448ed9805a61eb0ffcf05ccd159；645基线仅main.ts变化，继承配置/plan保持；四业务文件与coder work匹配；首轮冻结保持。新review根A-review-r1-20260928T062849Z-f9c6fc生成独立产物，新JS/CSS与coder构建一致、dist/staging一致。无白名单外业务改动。

主会话复审后、返工2前冻结A/static-review-02-snapshot/32文件+manifest（源码、任务、r1脚本/现存日志/截图），逐份hash一致；不能补造缺失的中间日志。

## A-R1未关闭：长按repeat反复切模式

shell.ts45–51未过滤repeat；单测67–76/179–205缺此覆盖。review真实Playwright down/down/down/up记录repeat false/true/true：Space advanced→simple→advanced，Enter同类往返，keyup无额外click，播放不变。短按Space误播放已修。
最小修复：识别激活键后仍preventDefault/stopPropagation，再拒绝repeat执行setMode；不能让重复Space冒泡恢复误播放。覆盖简易/高级×暂停/播放×Space/Enter，首次切一次、repeat零切、keyup零切、下次独立按压可切、焦点和全局Space保持。

## A-R2关闭

新ctx边界单测接通状态；真实duration编辑/dirty文案/文档/时间/选择及播放继续推进，加shell唯一ctx调用requestResize及engine.ts562只改resizeNeeded，足以支持A状态零写。生产私有revision没直接读，此边界保留；不增调试IPC。

## A-R3多数关闭，A-R3-W仍阻断

真实UI打开项目库、创建、编辑、模式切换dirty、版本1、保存版本2独立通过；无存储接口绕过。create时busy阻closeModal为HEAD既有瑕疵，清busy后可手动关闭，不阻A、不在A改业务。
窄区实际顺序预演→镜头→属性，局部滚动可访问，不隐藏即通过；顺序本身非阻断。

### A-R3-W：精确1920x1080未验证

r1 desktop脚本211–228请求1920x1080，实际outer1920x1040/inner1904x1001，只以innerWidth>=1840却打印目标已生效。真实1280x720（inner1264x681）及1000x720（inner984x681）已测。
这是环境验收缺口而非布局缺陷。新验证必须检查实际目标，不匹配标未验证/失败，不能凑PASS。只在本次隔离Electron测试窗口通过合法窗口API尝试，禁止改系统分辨率/DPI/任务栏等全局设置；若环境不支持保持BLOCKED，延期C需明确新批准。直接读取zoomFactor更佳，现有新profile/无产品设置/DPR1只能间接依据。不得把frameless/fullscreen或隐藏离屏窗口当普通主窗口等价而不说明差异。

### Tab表述限制

固定26/22/40步不是完整遍历，非零offset不等于可见无遮挡，高级some()仅证明命中三分区之一。无新增隐藏焦点回归实证，但不能称全部键盘/实际可视焦点已验收。按现有范围改善断言或准确限定，C完整矩阵仍待。

## 全套对照及更正

review已核四日志：current643中642/1fail(cleanup RETRY)，baseline636全过；current643全过，baseline635/1fail(handle-close)。baseline-work与archive645文件字节一致；archive与Git对象631文件CRLF差异，全部归一化一致，不称Git对象逐字节相同。13608依赖文件和1566资产逐hash一致，无单边文件。
可支持：基线可出现RP2失败、候选有全套通过样本；不能说每个失败必与A无关或同根因。原handle-close cleanup-failed/timeout与本次baseline同用例却不同断言（挂起分支未达）。撤回“非005引入”等过强结论，不要求无限重跑/擅修RP2。
任务称中间单测失败在browser-run日志，review未找到对应记录。若确有原日志提供准确位置，否则撤回留痕声明，登记未恢复，不补造。

## 本轮实际检查

新review单测7/7、browser-r1 34PASS、prepare含build/hooks、desktop-r1 35PASS均exit0，但其中1920目标声明降为未验证；held-key诊断exit0是采样完成非行为PASS。只读hash中一次括号语法错exit1，修正后0，未隐去。未重跑全量，直接核2x2证据。
A1/A2/A3/A5通过（A范围，不替代全业务）；A4失败；A6真实1280和窄区过、1920未过。review模型图像不可用，未视觉审图。人工视觉/真实Windows DPI保持PENDING。

## 第2轮调度

原A白名单修repeat+测试，新增验证A/rework2/，不动旧A/work、rework1、review根或两快照；保留初始及rework1历史，追加更正。不扩大到B/旧CSS/存储，不修改系统设置或付费调用、不commit/push。可用隔离窗口API补精确尺寸，不能补则明确BLOCKED，不自行降低A6。新构建/源hash/日志命令UTC退出逐次保存，完成停止等独立复审。
