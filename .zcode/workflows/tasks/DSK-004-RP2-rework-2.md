# DSK-004-RP2 第二次返工

状态：REWORK。依据独立reviewer agent_dceb64db-d0cc-41f9-a98d-2f54c8f778f3 第2次审查，原批准范围不变，rework_rounds=2；本次复审若仍未通过转planner，不直接第三次返工。RP1及validation01 PASS保留，父DSK004仍REWORK，RP3未开始。

## F1 高：重试本身无界await

service.cjs约166-187/1125-1130：settleUnresolvedCleanups直接await close/rm，performDrain再await该函数，截止后还执行一次。100ms只限重试频率不限制单次耗时。真实反例：首次rm EACCES入账，第二次rm pending，dispose(timeout100ms)超过450ms仍挂，第二次dispose返回同一个永不完成Promise；释放后才成功。

修复要求：清理重试作为可观察的进行中工作发起和登记；排空循环不能无界await它，整体真实计时覆盖所有pending。超时返回blocked而不是强杀或忘掉操作，保留资源/失败/进行中台账；同资源在跨dispose重试时不得重复并发启动。只有实际close/rm成功才出账，所有pending及cleanup结束才能closeDB，截止后不得额外发起清理。

必要反例：close和rm各自首次拒绝、下一次挂起；断言确实进入挂起分支、真实预算内blocked、DB.close=0、多轮dispose不增加同资源并发、释放后真正清理及DB恰一次关闭。冻结业务now与真实定时器分开。不以测试等待超时代替故障复现。

## F2 中：异常BLOCKED无原生提示

main.cjs约65-81/95-108/148-151及updates.cjs36-46：prepareExit抛、finalizeClose抛、quitAndInstall同步throw/异步error仅landBlockedAfterStop无showBlockedDialog。审查实测stateBLOCKED、quitReadyfalse、锁true、提示0。禁用窗口内renderer错误状态不能替代原生提示。

修复要求：异常原因进入同一受阻提示/重试机制，保持锁定且不OPEN，不重开库；区分确认前取消与停服后异常。异步updater error/重复回调/close/quit/second-instance竞争只有一个提示及重试owner；迟到旧回调不能撤销新owner授权或重复提示。更新失败后重试普通close，不自动重装。

必要反例：四种异常各断言提示调用/可理解原因/后续动作、锁、授权清除、受控重试次数；迟到重复updater error与正常close重试竞争；提示自身错误不未捕获、不放行、不无限提示循环。

## 已认可与证据边界

- 原R1停服不解锁、R2不忽略失败台账、R3清错误授权修复保留，不回归。
- update真实service SQLite在fake install前dbOpenfalse/drainready证据保留。
- Phase D无终点插桩自然退出code0/signalnull有效；Phase C仍有终点插桩/CDP触发close，不能说它证明原生用户点击或无插桩自然退出。原生综合留RP8。
- 原midwait红有1项探针笔误，其他10项为原缺陷；历史日志不改。

## 执行与验证

唯一coder，仅原RP2五生产文件、两unit及已批退出桌面脚本、任务/实施/进度记录。先在修前实际实现上跑有效具名反例，旧snapshot可隔离打包，不能靠新版DI旧版忽略造成假红。新唯一tmp记录真实CMD/UTC/CWD/EXIT及源/测试版本，不覆盖任何旧失败日志。

修后定向/两unit/npm/build/prepare/files/storage/exit桌面验证；必要分阶段报告IN_PROGRESS，不假IMPLEMENTED。不得改src/preload/publicIPC/update-host/依赖/provider，不真实安装更新、强制产品退出、提交或推送。不顺带做RP3或重新SQLite gate。完成IMPLEMENTED待独立最终复审，不自行PASS。
