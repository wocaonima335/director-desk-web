# DSK-004-RP2 第1次返工

状态：REWORK，原批准范围不变。reviewer agent_dceb64db-d0cc-41f9-a98d-2f54c8f778f3。父DSK004 REWORK、RP1 PASS保留，RP3未开始。不得commit/push、改公共IPC/src/preload/update-host/依赖。

## R1 高：停服后错误解锁
main.cjs55-60/69-73/128-133：用户确认并停服后，timeout/cleanup失败/prepare异常提示取消竟setInteractionLocked(false)、state OPEN。实测locks[true,false]、OPEN、quitReady false，丢弃路径用户能编辑却无法managed保存。修：停止服务后BLOCKED保持锁，提示关闭不能恢复OPEN；确认前取消仍正常可用；明确可用的原生受阻重试入口。修unit183-197和desktop269-290相反断言；不得用“提示已停服”当作允许编辑。保存成功/丢弃两路径+超时/cleanup失败/prepare异常测试。

## R2 高：清理失败被下一轮dispose忽略
service184-199/1065-1135：失败transfer已出map，仅cleanupErrors计数；新dispose以当前count作基线，没有重试未解资源，持续EACCES第二次竟ok true关DB。sweeper在dispose前失败也被完全忽略。修：保存未解决cleanup及资源归属，可重试则真正重试或继续blocked，不靠重置计数；pending为0才close一次。覆盖dispose前失败、首轮drain失败、持续失败多轮blocked、故障解除实际cleanup成功再关DB、handle.close及rm两类。不得把失败清理对象从账中抹除。

## R3 中：最终动作失败状态与授权不一致
main62-73/92-96 finalizeClose抛后OPEN但quitReady true；updates17-30 updater已取得授权后同步throw/async error只改quitting未通知协调器，永远FINALIZING/ready。修main/updates内部owner仲裁，失败清除错误授权，停服后保持保护与明确原生后续动作；每次授权最终动作一次。无需改update-host。fake updater同步throw/异步error及finalizeClose抛，验证状态/提示/重入重试，不真实安装。

## 验证补充与证据纠正
- “等待期间新增cleanup”原测试实际dispose前启动，改真正drain期间新注册时序。
- 现update prepareExit stub不能当真实DB.close顺序证据，补实际service关闭与更新接线集成或明确当前只能接线不完整。
- 现desktop beforequit末端拦截后再次app.quit只能说明插桩接线，不独立证明自然终止/关库顺序。加不拦截终点的自然退出smoke，真实进程exit0，无强杀。
- 保留先前日志，不覆盖；原A1/A3已有覆盖继续保留，RP1不回归。
- 按具名反例在未修实际源码上复现后修复；不依赖新版DI旧版不调用而假红，元数据一次保存足够，不造门禁框架。
- 原生dialog若stub严格标注逻辑接线，人工原生综合仍RP8。不把mock算人工PASS。
- 范围仅原RP2五生产文件、两unit/新desktop script/ignore与任务记录。若还需其他文件先报批。
- 状态REWORK rework_rounds1，完成IMPLEMENTED待第2次审查，不能自行PASS。修正implementation报告的“blocked解锁属设计”及错误测试声明。
