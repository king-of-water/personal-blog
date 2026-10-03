---
title: Subagent 与多 Agent：任务拆分、通信与结果汇总
description: 区分 Subagent、Agent-as-Tool、Handoff 与 Agent Team，用一个跨服务 API 迁移任务说明怎样拆分并行工作、约束通信、合并证据并控制协调成本。
category: Agent
subcategory: Agent 开发
articleClass: focused
seriesOrder: 130
featured: false
publishedAt: 2026-10-03T10:00:00+08:00
updatedAt: 2026-10-03
tags: [Agent, Subagent, Multi-Agent, Orchestration, Handoff, Parallelism]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

给一个 Agent 增加“再启动几个 Agent”的能力很容易。难的是判断哪些工作值得拆、每个子任务应该看到什么、结果用什么协议返回，以及主 Agent 怎样发现重复、冲突和遗漏。

多 Agent 常被描述成一群角色开会。真实系统里更有用的视角是并行计算与上下文隔离：把可以独立推进的分支放进不同 Context，让它们各自产生证据，再由一个明确的 Owner 合并。拆分失败时，系统只是用更多 Token 制造更多互相矛盾的中间结论。

这篇文章以一次跨服务 API 迁移为例，讨论 Subagent、Agent-as-Tool、Handoff 和 Agent Team 的边界。研究依据包括 Anthropic 公开的 Research 多 Agent 架构、OpenAI Agents SDK 的 handoff 语义，以及 Claude Code 等产品公开的 Subagent 机制。产品实现会更新，文章关注较稳定的任务图、权限和通信问题。

![Subagent 从拆分、隔离执行到证据汇总的协作路径](/images/posts/subagent-orchestration.svg?v=20261003)

## 一、先判断问题能不能并行

任务只有同时满足“分支相对独立”和“结果可以汇总”时，才适合并行 Subagent。

假设要把订单 API 从 v1 迁移到 v2。可以并行调查服务端调用者、Web 前端影响、移动端兼容和文档示例，因为四个分支读取的文件不同，输出都能归一成“调用位置、旧行为、新约束、风险、证据”。调查结束后，再由主 Agent 形成迁移计划。

实现阶段未必适合照样并行。后端接口尚未确定时，前端和客户端同时改代码会围绕不同假设工作。多个 Agent 修改同一个 Schema 或同一组公共文件，还会产生合并冲突。此时应先完成接口契约，再把互不重叠的实现分支并行化。

可以用四个问题判断：

1. 子任务之间是否需要频繁读取彼此的最新结果？
2. 子任务是否会修改同一资源？
3. 每个子任务能否写出独立验收条件？
4. 合并结果是否比重新执行更便宜？

前两项越强，多 Agent 越不划算；后两项越清楚，拆分越安全。

[Anthropic 的 Research 系统](https://www.anthropic.com/engineering/multi-agent-research-system) 使用 orchestrator-worker 模式，让 Lead Agent 创建并行研究分支。官方文章也明确给出限制：多 Agent 更适合广度优先、可并行、信息超过单个 Context 的高价值任务；共享上下文多、依赖关系强的领域并不适合。其内部研究评测中的 90.2% 提升和约 15 倍聊天 Token 消耗，只能说明那套研究任务与配置下的取舍，不能外推为所有任务都应使用多 Agent。

## 二、四种协作方式不要混用

“调用另一个 Agent”可能对应四种完全不同的控制权关系。

| 方式 | 谁保留控制权 | 子 Agent 得到什么 | 适合场景 |
| --- | --- | --- | --- |
| Subagent | 主 Agent | 一个有边界的子任务与独立 Context | 调查、验证、局部实现 |
| Agent-as-Tool | 调用方 Agent | 像工具一样的输入，返回结构化结果 | 专项能力服务 |
| Handoff | 被转交的 Agent | 会话或任务控制权 | 路由到专业处理者 |
| Agent Team | 团队协议决定 | 独立任务、邮箱或共享状态 | 多个长期自治成员 |

Subagent 通常有自己的模型循环、Context 和工具，但生命周期属于父任务。它完成后返回结果，主 Agent 继续决策。父任务可以限制它只能读文件、最多调用十次工具、不能再创建子 Agent。

Agent-as-Tool 更接近函数调用。调用方知道自己需要某项专业结果，例如“分析 SQL 执行计划”或“检查这份变更的安全风险”，工具内部是否用模型循环对调用方透明。控制权没有转移。

Handoff 会把后续对话交给另一个 Agent。OpenAI Agents SDK 的 [Handoffs 文档](https://openai.github.io/openai-agents-python/handoffs/) 把 handoff 暴露成模型可调用的工具，并允许定义输入 Schema 与过滤后的历史。客服分流适合这种模式：退款 Agent 接管用户会话后，原分流 Agent 不必逐轮中转。

Agent Team 再多一层。成员可能有独立会话、共享任务图、点对点消息和较长生命周期。只有任务确实需要成员互相协调时才值得引入。多数应用使用主 Agent 加有限 Subagent 已经足够。

## 三、任务拆分要写成契约

一句“调查前端影响”不是合格的委派。子 Agent 不知道搜索范围、需要多少证据、何时停止，也不知道主 Agent怎样使用结果。一个任务契约至少包含目标、范围、输入引用、允许工具、禁止动作、输出 Schema、预算和完成条件。

```yaml
task_id: api-v2/web-impact
objective: 找出 Web 项目中所有订单 v1 API 调用并评估迁移影响
scope:
  include: [apps/web, packages/order-client]
  exclude: [apps/admin, generated]
tools: [search, read_file, run_readonly_command]
constraints:
  - 不修改文件
  - 每个结论必须给出文件和行号
output_schema:
  findings:
    - location: string
      current_behavior: string
      v2_impact: string
      evidence: string[]
  gaps: string[]
  confidence: high | medium | low
budget:
  max_tool_calls: 18
  deadline_seconds: 240
```

范围最好按信息源、组件或假设拆，而不是给不同 Agent 相同问题。三个 Agent 都“研究 API 迁移”只会重复搜索。可以让一个负责调用面，一个负责数据契约，一个负责发布兼容；三者的交集和空白都容易检查。

任务契约还要声明依赖。`implement-web` 依赖 `approve-api-schema`，调度器就不能为了追求并发提前启动。把依赖留给模型临时判断，会出现子 Agent 围绕过期假设工作。

### 拆分粒度怎样控制

任务太大，Subagent 仍会 Context 膨胀，父 Agent 也无法判断它是否完整。任务太小，启动模型、传递背景和汇总结果的成本超过实际工作。

一个实用粒度是：子任务能在独立 Context 中完成，产物可以单独验收，并且结果明显小于其读取的信息。代码搜索读取几十个文件，返回十条有证据的调用点，压缩比很高；把一个两行配置修改交给 Subagent，通常没有收益。

设置最大深度与最大扇出。允许每个 Agent 无限递归委派，会让任务树指数增长。第一版可以只允许主 Agent 创建子任务，Subagent 不得继续派生。真的出现稳定的二级分工后，再开放一层，并把总预算绑定到根任务。

## 四、Context 隔离既是收益也是风险

Subagent 往往通过额外 Context 产生收益。它可以读取大量局部材料，只把压缩后的证据返回主 Agent，避免中间噪声污染主窗口。

父 Agent 不应把完整对话复制给每个子任务。委派 Context 分三部分：稳定目标与约束、该分支需要的输入引用、输出契约。其余信息按需读取。这样既省 Token，也减少无关指令冲突。

隔离也会造成信息缺口。主 Agent 已经知道 v2 接口取消某字段，但没有把事实放进子任务，前端 Agent 可能仍按旧约束分析。维护一份版本化的任务 Brief，可以在不复制全部历史的情况下同步重要事实；Brief 更新后，把受影响的子任务标记为过期或重新验证。

权限应随子任务缩小。调查 Agent 只需要搜索与读取；测试 Agent 可以运行受限命令；负责提交的 Agent 也不该自动得到部署权限。OWASP 对 [Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) 的建议包括减少可用扩展、缩小扩展功能和权限，并为高影响动作保留独立批准。多 Agent 系统还要防止权限经委派扩散。

## 五、通信协议要传事实，不传思维过程

让 Agent 在共享聊天室里不断更新进度，容易制造大量低价值消息。每条消息都进入 Context 后，成员开始阅读彼此的草稿、猜测和重复结论，协调开销迅速上升。

更稳定的通信分三类：

- 控制消息：创建、取消、超时、重新分配和依赖解除；
- 状态消息：已开始、阻塞、完成，以及预算使用；
- 产物消息：符合 Schema 的发现、补丁、测试或证据引用。

中间推理通常保留在各自 Trace，不进入共享上下文。只有会改变其他分支决策的事实才广播，例如“API v2 实际仍保留旧字段，但只读”。这类事实要附来源，并由协调者写入共享 Brief。

```json
{
  "type": "finding",
  "task_id": "api-v2/web-impact",
  "claim": "Web 端有 6 处直接调用 v1，其中 2 处依赖 removed_field",
  "evidence": [
    {"path": "apps/web/src/order.ts", "line": 84},
    {"path": "packages/order-client/src/types.ts", "line": 31}
  ],
  "gaps": ["运行时动态拼接 URL 的调用未能静态确认"],
  "confidence": "medium"
}
```

通信需要去重和版本。子任务重试可能重复提交产物；共享 Brief 更新后，旧产物可能基于过期版本。消息应带 `task_attempt`、`brief_revision` 和唯一 ID，汇总器才能判断是重复、补充还是失效结果。

## 六、主 Agent 的工作是合并与查漏

协调者不能把子 Agent 的文本首尾相接。它需要执行四项检查：覆盖范围是否完整，证据是否支持结论，多个分支是否冲突，最终方案是否满足根任务约束。

先用任务矩阵查覆盖：每个预定分支都应有成功、明确无发现或已解释失败。一个 Subagent 超时不应被安静忽略。缺失项可以重试、降级为主 Agent 处理，或在最终结果中标明未知。

再按实体合并。两个分支都提到同一个 API、文件或风险时，把它们放到同一记录中比较证据。冲突不能靠多数投票解决。一个 Agent 说字段已删除，另一个说仍然存在，协调者应读取权威 Schema 或启动一个只针对冲突的验证任务。

最后把产物映射回根任务验收条件。迁移计划需要影响清单、依赖顺序、兼容策略、测试和回滚。子 Agent 可能分别交出高质量局部报告，却没有人负责最终可执行性。根任务 Owner 必须唯一。

### 结果汇总也需要预算

子 Agent 返回整份长报告会挤爆主 Context。输出 Schema 可以要求“结论不超过 N 条，每条必须附证据；大文件保存到产物库，只返回引用”。主 Agent 先读取摘要，在冲突或低置信度时再展开原始材料。

分层汇总适合大扇出任务。十个 Worker 先由两个中间汇总器按主题合并，再交给根 Agent。不过每多一层都会损失细节并增加错误归因。能够由程序完成的去重、排序、Schema 校验和覆盖统计，应交给代码，不必再开一个模型。

## 七、一次跨服务迁移怎样协作

根任务先固定 v2 Schema、仓库范围和完成条件。协调者创建四个只读调查任务：服务端调用、Web、移动端、文档与示例。它们并行读取各自代码，输出统一的影响记录。调度器限制总并发为四，每个任务有独立工具预算。

四份结果返回后，汇总器发现 Web 与服务端对 `legacy_discount` 是否保留存在冲突。它没有让两个 Agent 继续辩论，而是读取生成接口的 OpenAPI 文件，确认字段只在响应兼容层保留。共享 Brief 更新到 revision 3，受影响记录重新计算。

协调者据此生成依赖图：先发布兼容服务端，再更新公共客户端，随后让 Web 和移动端在独立 Worktree 修改，最后更新文档。两个实现 Agent 只获得各自目录写权限。公共客户端由单独任务修改并先合并，避免三个 Agent 同时碰同一文件。

每个实现分支返回 Diff、测试和未解决风险。主 Agent 在集成分支运行跨服务测试，发现移动端仍发送废弃枚举值，于是把失败日志和固定范围交回原任务修复。所有验证通过后，主 Agent 生成一个迁移结果，而不是四份报告。

这条路径里，并行只出现在依赖允许的位置。调查可以全并行，公共契约必须串行，互不重叠的实现再次并行，最终集成回到单一 Owner。

## 八、失败模式比角色设计更重要

最常见失败是重复劳动。任务描述过宽、工具相同、没有范围字段时，所有 Agent 会沿同一路径搜索。检查不同分支的文件、URL 和结论重合度，可以量化是否真的形成分工。

第二类是空洞交接。Subagent 返回“可能需要关注兼容性”，没有文件、行号或实验。父 Agent 只能重新调查。把证据设为必填，并用程序拒绝缺字段结果，可以在边界处挡住这类输出。

第三类是协调风暴。Agent 频繁广播进度，主 Agent 不断重规划，任务图反复变化。限制控制消息类型，设置最小重规划间隔，并要求只有新证据才能触发任务调整。

第四类是权限扩大。父 Agent 有部署权限，子 Agent 自动继承全部工具，任意研究分支便能触发生产动作。权限应该显式授予，默认不继承；凭证绑定任务、租户、资源和期限。

第五类是无人收口。所有成员都认为自己只负责局部，根任务长期处于“几乎完成”。任务图需要唯一 Owner、明确终态和剩余工作查询。Subagent 完成不等于根任务完成。

## 九、怎样评测多 Agent 是否值得

比较对象应包括单 Agent 基线，而不是只观察多 Agent 版本能否完成。使用相同任务、模型预算和验收标准，测结果质量、端到端延迟、Token、工具调用、重复工作、人工介入与失败恢复。

多 Agent 的预期收益通常是降低墙钟时间、扩大搜索覆盖或隔离 Context。若完成率相同、时间没有下降、成本明显上升，就没有理由保留复杂度。对强依赖代码任务，单 Agent 配合并行工具调用可能更便宜。

轨迹评测还要看任务图：拆分是否覆盖问题，依赖是否正确，是否产生大量取消任务，冲突如何解决，子任务结果有多少被最终答案采用。只看最终答案，会看不到系统用十五倍 Token 重复搜索后碰巧成功。

建议准备三类样本：天然可并行的广度任务、部分依赖的混合任务、强顺序任务。一个可靠协调器应该在第一类扩展，在第二类建立依赖，在第三类主动不拆。永远选择多 Agent 的路由器本身就是失败。

## 十、从一个受控 Subagent 开始

第一版只增加一种能力：主 Agent 可以把只读调查交给一个 Subagent，输入与输出使用固定 Schema。先测它是否减少主 Context 噪声、是否稳定返回证据。有效后再开放并发和多个任务类型。

随后补任务 ID、预算、超时、取消、Trace 与覆盖检查。并发稳定后再考虑共享 Brief 和依赖图。Handoff、团队消息和递归委派应由真实需求推动，因为它们各自增加新的控制权和恢复问题。

设计评审可以沿着六个问题走：为什么要拆，分支是否独立，每个分支拥有哪些 Context 与权限，产物 Schema 是什么，冲突由谁裁决，根任务由谁验收。回答不了其中任何一项时，多开几个 Agent 只会把不清楚的责任复制几份。

Subagent 的价值来自受控隔离。多 Agent 的价值来自并行且可合并的工作。清楚的任务图、证据协议与唯一 Owner 可以直接决定协作是否缩短了路径，角色名称和拟人化对话不会替系统补齐这些条件。

## 参考资料

- [Anthropic：How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [OpenAI Agents SDK：Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [OWASP：Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
