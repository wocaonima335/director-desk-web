# DirectorDesk 多模型开发工作流

## 安装内容

| Agent | 模型引用 | 职责 |
|---|---|---|
| director-planner | `6551fef7-9ece-4c0c-9adf-c79b00e991d9/gpt-6-astra` | 只读规划 |
| director-coder | `builtin:zai/GLM-5.3-Flash` | 编码和本地验证 |
| director-reviewer | `6551fef7-9ece-4c0c-9adf-c79b00e991d9/gpt-6-astra` | 独立审查与验证 |

模型 ID 使用本机已有配置。最初请求中的 `gpt-6-6astra` 未在本地配置中发现，按已说明的方案使用 `gpt-6-astra`。这三个代理不会切换主会话模型。

这是项目级配置和基于指令的调度流程，不是后台自动执行服务或强制状态机，也不自动创建 Git 提交。

## 启用

1. 在 ZCode 中打开本仓库根目录 `E:/myProgram/DirectorDesk/director-desk-web`。
2. 新建会话，让项目级 `.zcode/agents/*.md` 和 `AGENTS.md` 被加载。不要从其他项目目录或子目录启动并假定代理会自动发现。
3. 在设置的 Subagents 列表或会话 Agent 可用类型中核对三个 `director-*` 名称。
4. 若不存在，先核对工作目录与配置解析诊断；不要用普通 general-purpose 代理冒充已绑定模型的角色。

## 首次无业务代码冒烟测试

向项目新会话发送：

> 对 DirectorDesk 开发代理执行冒烟测试，不修改业务文件、不安装依赖、不提交。依次调用 director-planner、director-coder、director-reviewer，让每个代理仅返回角色名和 READY。随后核对运行详情中的实际 provider/model 是否分别为 gpt-6-astra、GLM-5.3-Flash、gpt-6-astra。输出发现、启动、模型路由三项结果；无法观察真实模型时标为未验证，不以模型自述证明路由成功。

冒烟测试豁免编码代理的业务任务批准前置条件，仅允许返回 READY，不允许任何文件修改。测试会产生少量模型调用消耗。

## 正式开发入口

可向项目会话发送：

> 按 AGENTS.md 使用 director-planner 规划以下需求，计划批准后交 director-coder 编码，再由 director-reviewer 独立审查。先核实真实源码目录和工作树，不把规划文档当成代码。需求：……

主会话调用 Agent 时以 `subagent_type` 选择代理；该工具没有可直接传入的 model 参数。例如：

```json
{
  "description": "实现已批准任务",
  "subagent_type": "director-coder",
  "prompt": "读取已批准任务单；按其中的源码目录、允许范围和验收标准实施。",
  "run_in_background": false
}
```

任务单使用同目录 `task-template.yaml`。小任务可以在交接消息中提供同样字段；多轮任务建议持久保存。

## 权限与限制

- planner 只有 Read；主会话负责文件定位并提供实际路径。
- reviewer 具有 Bash 以检查差异和运行已批准验证；“不修改业务代码”是指令约束，不是系统级写保护。强隔离请使用独立审查工作树或受限执行环境。
- 本仓库目前主要是规划文档。未确认真实源码前，功能编码任务应保持 BLOCKED。
- 源码位于另一仓库时，需将本工作流安装到实际源码工作区并核对该仓库指令，而非默认本仓库的配置能自动作用于另一项目。
- GPT provider UUID 为本机标识；其他机器需要替换为其已配置 provider。不要把任何 API key 写入仓库。
- 配置解析通过、模型在目录中存在，都不等于真实模型调用通过。运行详情中的 provider/model 才是路由证据。
- 安装不创建定时任务、后台服务、自动返工脚本，不修改全局配置。

## 卸载

仅移除本次新增的三个 `.zcode/agents/director-*.md`、本工作流目录，以及根 `AGENTS.md` 中对应工作流规则。若文件已被后续修改或合并，应人工保留新内容，不批量删除已有项目规则。
