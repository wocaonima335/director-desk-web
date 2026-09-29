# DSK-006-A 初次独立审查：REWORK

正式接续reviewer：agent_4ab80982-d749-4f9a-90fd-d1c39d7333da。前reviewer agent_bae6f440-a91b-4648-98c5-585d23b1357d已有阶段REWORK摘要/数值诊断但工具额度中断；恢复原实例失败后同一指定角色接手。本次为同一初审最终交接，不加返工轮数。

原A业务白名单可修，目前不需REPLAN；不得修改引擎/timeline/schema/旧UI，若需扩围先批准。B/C未开始。

## 基线与证据

HEAD288f24aa76584965da24e90b843d8217ae4cea0c；原661路径hash全部一致，当前668=原基线+2任务+5业务；主仓/独立review副本/五源artifact匹配。继承provider和批准plan差异保持，无依赖/公共契约改动。
证据根 E:/myProgram/DirectorDesk/verify-dsk006-20260929T013925Z-be2c34d1。
主会话初审后冻结A/review-01-snapshot/，15文件（五源码、任务、三日志、五源快照及原manifest）及新manifest，逐份hash一致；不补足中间失败版本。

## A-R1 高：ID违反冻结契约

suite-ids.ts32-34；create-shot-suite.ts371-376；测试83-93；shared/contracts/schema.ts34-35。
namespace:key含冒号，允许数字起始的namespace不满足EntityId字母开头，64位合法role产生79位entity，clip更长。assertProject1-200规则宽松，往返通过不能证明EntityIdSchema合规。
修复本地受控ID编码：字母开头、合法字符、长度有界、namespace隔离、确定稳定。从登记表统一取最终ID和roleMap，避免工厂二次拼接；全部实际引用重写保持，不改共享schema/全局工厂。
直接测试冻结EntityIdSchema与适用clip ID规则，覆盖数字namespace、8/16位namespace、2/64位role、相似长角色、唯一性、重排/改名/参数变化映射稳定和跨namespace不相交。

## A-R2 高：等待转行走根朝向90度突变

工厂231-238、254-262；timeline62-79；engine252-259；测试105-125。
等待段同点路径无非零方向回退rotationY=0；行走起返回±pi/2，引擎直接设置根旋转，关节混合不能消除。前review诊断默认10秒左tracking2.708333→2.75秒0→-pi/2；exit3.458333→3.5同样。
在生成侧令等待朝向与直线路径一致，或既有数据表达明确平滑转向，不改timeline。左右跟拍/离场与5/10/15边界检查wrapped yaw差、实际rig姿态、hold/walk/stop交界，保留同位移。

## A-R3 高：中心出画不等整体白模出画

工厂85-92、223-230；测试193-218。
中心视锥交点加固定.35m未覆盖动态白模；exit端点在T而验收T-1/24。胸点abs(x)>1不证明fully off-screen。
前reviewer真实资产链makeActor/scaleHuman/animateActor/entityPosition/entityYaw/fitFeetToSurface平地/configureCamera及mesh顶点投影：15秒横enter左右各219可见，横exit1540/1055，竖exit231/744。接续reviewer静态核链一致，未重跑；归档为主会话从消息转录，不是原工具stdout或本次新运行。
按真实动画范围或已实证保守包围范围求端点，纳入朝向/画幅/首末可播放帧，重新算路程与步速。两画幅×enter/exit×左右×5/10/15检查整个白模在指定画边外、落位正确，不能胸点代替。C另做视觉。

## A-R4 中：必要实际采样与分支覆盖不足

测试105-143、193-321：30基础默认分支，专项多横10秒；竖exit/orbit/双人边界方向缺组合验证。samplePose仅手调参数不等animateActor后rig；yaw有限不等连续；相机姿态/投影和动态白模范围未逐帧覆盖。
在原测试文件建立明确有限覆盖矩阵，使用真实资产/运行链逐帧核世界位置/朝向/动画后姿态/相机变换与投影、时序及边界。补A-R1-3行为反例；无需昂贵全合法输入笛卡尔积。2410生成/clip-end检查不冒全部运行时覆盖。

## A-R5 中：失败证据未保留与日志路径笔误

coder承认中途12失败及后续失败用tail/grep摘要，runner退出码没捕获，中间源码覆盖，另tsc失败无完整留存。不能称全部失败保留，不重建冒充原存档。最终3成功日志仍有效。
任务npm log字段023613不存在，实际为A/logs/20260929T023625Z_npm-test-full.log，UTC02:36:25正确。追加更正并修链接，保留旧版本于快照。之后每次先保存源版本/hash及准确cmd/cwd/UTC，完整stdout/stderr与真实exit，包括失败，不用管道尾命令退出冒runner退出。

## 验收

A1/A3/A4在已审范围通过；A2未完整验证；A5 ID失败，A6朝向/真实采样失败，A7整体出画失败。改名指显示名称，不是更换roleId集合；speaker/lead/distance字面命名未被计划固定，不报越权。
15秒竖walk.speed约.096805低于Inspector .1，但Project只>0且timeline直接使用，未发现运行时clamp；是编辑兼容/步滑待验风险，不盲clamp破坏路程节奏。

## 实际检查边界

接续reviewer只读Git/hash/源码/日志/归档，无新数值重跑/全套/build。核最终41/41、717/717、build0与相应日志，类型/Vite/privacy通过，chunk警告非阻断。review node_modules junction指令只读不是OS隔离。
前review两次stdin退出0是采样完成非验收通过；主会话归档diagnostics明确消息转录/缺tool ID，不能假称原始文件。人工图像、步滑/穿模/播放、UI新建/保存/撤销均待B/C，006整体未完成。

## 首轮返工

在原A五业务文件内修复并补测试；新证据A/rework1/，原A/work/logs/artifacts、review根与snapshot保护不改。任务只追加implementation.rework1，不自行PASS。若超范围先BLOCKED。完成定向/全套/build与保护检查，准确记录失败后停止写入交独立复审，不开始B。
