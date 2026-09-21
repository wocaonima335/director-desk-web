# N0 首轮独立审查：REWORK

Reviewer：agent_1b52b071-7979-45c6-acf4-a0777adbe253。以下为主会话保存的审查摘要，不替代原始执行材料。

## 实测通过

HEAD 90464eb；tracked零diff；管理untracked三项。规范基线629 tracked+3 untracked、旧根869、基线输入37均由独立只读hash与集合核查确认，任务单授权后hash一致。ignored19148单列，19个reparse目录记录且不跟随。新根仅evidence，无N1/N2提前实现。未运行检查器、候选、编译、测试或清理。

## 阻断与最小返工

- N0-R1 高：attempt03无cmd.txt；attempt04/05的cmd使用未定义$GC，缺完整输出重定向和即时退出捕获语句；共用脚本manifest晚于attempt03，不能证明当时运行字节。保留旧记录并说明限制，新增一次运行前冻结脚本、捕获入口和输入的独立检查，保存完整命令/cwd/解释器/输出和即时退出来源。不回填历史原始命令。
- N0-R2 中：preflight输出只有创建后复核，未保留ABSENT和CREATED原输出。当前路径安全已核实，创建前及动作溯源未完整。优先引用主会话/原始工具记录；不能恢复则登记历史限制，须批准方接受，不删除重建。主会话本会话创建前Bash已实测新根exists=False、祖先无reparse、NEW_ROOT_PREFLIGHT_OK；这是独立预检，不冒称coder的New-Item原始输出。
- N0-R3 高：protect-check.ps1 145—183缺失文件continue可能漏报；未要求应有退出文件齐全；build-baseline.ps1未检查Git退出状态。另存新版保留旧字节，缺失/数量不符/缺记录/非零退出均失败。新检查只读保护对象，输出仅新证据目录。无需产品测试。
- N0-R4 中：授权delta仅存前后hash，无任务单前字节，无法证明只改implementation。原任务单由主会话Write创建，主会话可提供该次工具输入的逐字节副本并核验历史hash36d470a9...；必须标明来源为会话工具输入恢复，而非当时已有磁盘快照。未来修改保存前字节。

P1部分未验证；P2通过；P3失败；P4部分未验证。未发现生产/依赖/配置越界。

## 不可抹去的限制

attempt02原脚本未保存且就地修复；失败材料保留，exit0/误报PASS是缺陷，不可信证明。此不可恢复缺口可以保留，不要求无限返工，但必须用新的完整记录建立向前溯源。其stderr抽读为ContainsKey(null)/null索引等运行时异常，不能笼统声称只是语法解析错误。Git ignored枚举有18条junction warning，不能称全部stderr为空。

## 派发约束

首轮返工仅修上述具名项，不进入N1/N2；保留旧S1与T1两轮REPLAN、父RP4轮数1。本任务返工从第1轮开始，第二轮仍失败转planner。
