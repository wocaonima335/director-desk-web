# N1 第二轮最终独立审查：REPLAN

Reviewer：agent_18e3a107-2c2e-4c9e-be5f-afed1e464c03。初审REWORK→首轮复审REWORK→第二轮最终REPLAN。停止N1补丁链，禁止第三轮，N2不得开始；新方案须planner及重新人工批准。本文件是主会话管理摘要。

## 审查版本

HEAD90464eb4253b83ec5d73f256a6c9be28acf672c0；tracked/staged零diff，审前8项管理untracked。DESIGN v3 51755B SHA256 ce0383052d54beed7fdab13b1f322097899f1e125461d77e891684132a696b48；冻结v2 52830B 99c70334e4781828e1d8bbb9da32cd14f43d16efb9a9079602decbebfa202b37。审前N1任务12853B e59631c9f54ff1b902bca3be39e5677ca4b3802f59e7cbb772aecafb2efe3937，仅implementation.review2追加。N0 PASS保留；无生产/依赖/配置修改。

## 最终未闭合问题

以下行号对应当前DESIGN：

- R2-01 高（24–27/44–68/121–124/173–176）：子清理后父界不再传入，‘后现父界必更松’证明错误地假设父子C相同。合法反例：父SC Start0；子SV Start100，子1000清理S11000、1001/1002登记无资源；父2000清理S7000；子8000 Seal按自身S接受却已超父S。混合profile、同刻清理、祖先后收紧均未覆盖。应区分固定自身C与可后收紧外部界，不用未被强制的假设省略传递。
- R2-02 高（41–68/121–124/174–176/185–196）：已知父界可被后续null或更大值解除。子Start100已知父S6000，Bind7000传父S=null却获准。父快照校验不能仅正数。min(entry+C,parentS??Outer)父S非空时遗漏自身Outer：子SC Outer25000、父S30000、24000清理得到S29000，26000完成仍Within=true。必须约束所有已知上界，不以其他拒绝原因掩盖独立总截止错误。
- R2-03 高（394–397）：关键案例不遵守自身状态机。C-T07/T07b CSucc后F3Yes，清理改No应FactAlreadyRecorded[14]，缺F4/F6/F8导致Seal[12]、Evaluate未封存[9]，不能得到所称接受/[8]。C-T07d已Running还改F3No且缺清理/输出，补齐后观察NA仍应[20]。先证明相位可达，再验证时间，不能改写存在事实简化路径。
- R2-04 高（251–271/308–327/330–332）：记录适用性重写丢失。Completed/绑定后失败/BindRefused要求记录存在、未绑定取消要求缺席、拒绝/未绑定取消RecordIdentity=null未完整定义；§5.5实际是观察而非记录。5b不以Present门控截断，真值表缺记录时却忽略Truncated：present=false/trunc=true/obsConfirmed，条件表[21,22]，真值表[21]。需记录存在、身份、观察三个独立维度及一致门控。
- R2-05 中（374–381/391/395/415/430–443/447–450/470）：仍有C-T04同C-T03、C-T07b父同C-T07、C-S08b同C-S08、C-R03–08/R09b/R11/R13同C-R02序列等引用，违背完整独立要求及交接‘全部内联’。C-T07c全局时间叙述亦未按声称排序。不能以人工推演声明替代完整正确输入。
- R2-06 中：rework2/recovered/design-final-hash.v1.recovered.txt实际是36850B/92cbebab中间版本说明，不是首审37097B/8a4176a7最终说明，缺后者C-T09/C-R10等NOTE。corrections-r1-06.txt不得称最终说明已恢复；‘从未hashed’又列hash也冲突。保留中间版本转录并明确来源，最终说明仍未恢复。不重开N0。

## 已改善但不足以通过

F5清理登记Yes绕过阶段路径已堵；PreCreateFailed事件F3No语义明确；F12恢复失败死结关闭；观察Unknown与NA区分且未知码不比较；预期失败不吞清理未知；Outcome类型/default/早退出字段及部分案例具体错误已改善。internal构造不等于程序集内非法状态绝不可能，尚无实现类型证明。

C1/C2/C3/C4均失败；C5失败但当前保护子项通过。

## 独立证据核验与限制

632仓库基线及869旧根匹配（N0任务历史授权尾值例外保持）。attempt07/08/09各16输入hash匹配，现存exit0、stderr空、stdout PASS；cmd含实际捕获语句，时间戳佐证先落盘但非后台认证。
快照143项准确构成为137旧N1证据、DESIGN/任务/review02三个副本、三个recovered文件，不是143旧文件再加副本。137旧证据本轮逐字未改，失败attempt05保留。6876B任务事后恢复hash匹配c9fcf81b，不追认为改前已落盘。当前DESIGN与attempt08/09 hash一致，但保护检查不证明业务语义正确。
reviewer仅只读Git/文件/hash/静态推演，未执行保护检查器/候选/纯规则/编译/测试，未直接访问coder原始工具后台。旧缺失全文和运行版本未因冻结恢复。

## 交planner

重新明确动态父/祖先约束、已知界不放宽及输入真实性边界；完整结果适用表；先相位可达再期限结果的独立案例格式；历史证据恢复对象准确命名。保留本轮和旧两条REPLAN历史，父RP4轮数仍1，N0 PASS保持。不得直接第三轮修补，不自动解锁N2/编译/运行/RP5。
