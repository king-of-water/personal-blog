---
title: Agent Loop：ReAct、Planning 与 Reflection 怎样组成一条可靠循环
description: 从最小工具循环出发，对比 ReAct、Plan-and-Execute、Reflection、Self-Refine 与 Reflexion，解释现代 Agent 如何规划、行动、验证、反思和重规划。
category: Agent
subcategory: Agent 开发
articleClass: flagship
seriesOrder: 50
featured: false
publishedAt: 2026-10-02
updatedAt: 2026-10-02
tags: [Agent, Agent Loop, ReAct, Planning, Reflection, Reflexion, Self-Refine]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

一个 Agent 能连续完成任务，表面上像是在不断“思考”。运行时看到的其实是一条循环：模型根据当前 Context 产生回答或工具调用，Harness 执行动作，把环境结果送回下一轮，直到任务完成、需要用户输入或预算耗尽。

只讲这条主循环还不够。遇到长任务时，Agent 要不要先列计划？工具失败以后应立即重试、修改计划，还是反思刚才的判断？Reflection、Reflexion 和 Self-Refine 都带“自我改进”的意味，它们写入的状态、依赖的反馈和生效范围却不同。

本文要回答的问题是：**ReAct、Planning 与 Reflection 分别改变了 Agent Loop 的哪个位置，工程上怎样把它们组合起来，而不让 Agent 陷入空想、频繁改计划或无限自我批评？**

事实边界主要来自 ReAct、Reflexion、Self-Refine、Plan-and-Solve、Tree of Thoughts、LLM+P 等原始论文，以及 Anthropic 对生产 Agent 模式的公开总结。论文结果只说明对应模型、任务集和实验配置下的表现。本文将这些机制映射到工程运行时，映射部分属于系统设计归纳，不代表任何具体商业 Agent 的未公开实现。

## 先看结论

ReAct 解决“根据新观察继续决定下一步”，Planning 解决“长任务怎样保留目标、依赖和完成条件”，Reflection 解决“已有反馈说明当前方法哪里出了问题”。三者可以同时存在，它们并非互斥框架。

现代工具调用 API 通常不要求模型把 `Thought:` 明文输出给程序。Harness 能可靠处理的是结构化工具请求、工具结果、计划状态、验证证据和退出原因。模型内部怎样组织推理可以变化，系统边界仍然可观察。

Reflection 只有拿到新证据时才值得触发。测试失败、验证器拒绝、用户反馈和环境奖励都能提供信息；让同一个模型在没有新信号时反复审阅自己的答案，可能把正确答案改错。反思应产生可执行的修正，或者明确停止，不能只生成一段听起来深刻的复盘。

![ReAct 主循环中 Planning、Verification 与 Reflection 的位置](/images/posts/agent-loop-control-points.svg)

这张图可以当作全文索引。最内层是模型与环境的行动-观察循环。计划位于循环之外，保存目标和当前阶段；验证器检查结果是否满足外部标准；失败反馈满足触发条件时，Reflection 才总结错误并决定重试、重规划或结束。

## 一、最小 Agent Loop 只负责往返

一条能使用工具的最小循环并不复杂：

```python
def run_agent(task, tools):
    messages = [user_message(task)]

    for step in range(MAX_STEPS):
        response = call_model(messages, tools)
        messages.append(response)

        calls = parse_tool_calls(response)
        if not calls:
            return final_text(response)

        for call in calls:
            result = execute_tool(call)
            messages.append(tool_result(call.id, result))

    raise BudgetExhausted(MAX_STEPS)
```

模型只出现在 `call_model`。消息管理、参数校验、动作执行和步数限制都由 Harness 负责。这条循环让模型获得外部反馈，却没有回答几个生产问题：没有工具调用是否等于完成，重复动作何时熔断，写操作超时能否重试，测试失败后是修补当前方案还是推翻计划。

因此 Agent Loop 更适合被理解为控制骨架。ReAct、计划、反思、验证、权限和恢复机制都挂在调用模型之前、执行动作之前或处理结果之后。

### Loop 的状态不能只藏在聊天里

如果运行时只保存 `messages`，很多状态需要模型从自然语言里重新推断。生产系统至少应单独维护任务状态、预算、当前计划节点、工具动作和验证结果。

```ts
type RunState = {
  status:
    | "running"
    | "waiting_tool"
    | "verifying"
    | "needs_input"
    | "completed"
    | "failed"
    | "budget_exhausted";
  step: number;
  toolCalls: number;
  activePlanItem?: string;
  lastProgressAt: string;
  repeatedActionCount: number;
  evidence: string[];
};
```

聊天内容帮助模型理解任务，`RunState` 让程序确定当前允许发生什么。模型说“已完成”时，Harness 先转到 `verifying`，通过外部验收后再进入最终状态。

## 二、ReAct 把外部观察接回决策

[ReAct](https://arxiv.org/abs/2210.03629) 的核心贡献是把语言推理和环境动作交错起来。经典轨迹常写成：

```text
Thought → Action → Observation → Thought → Action → Observation
```

纯 Chain-of-Thought 在模型已有信息上继续推导，错误前提容易沿后续步骤传播。纯动作策略缺少显式的任务状态和判断依据。ReAct 让模型在需要事实时采取行动，再利用观察更新判断。论文在 HotpotQA、FEVER、ALFWorld 和 WebShop 等任务上比较了不同方法，具体收益依赖当时的模型、提示样例和环境，不能直接当作所有工具 Agent 的通用提升幅度。

### 现代 Function Calling 仍然是 ReAct 形态

现在的 Agent 很少靠正则解析 `Action: search[...]`。模型返回结构化 tool call，Harness 校验并执行，下一轮再加入 tool result：

```json
{
  "type": "tool_call",
  "name": "run_tests",
  "arguments": {"target": "tests/auth/refresh.test.ts"}
}
```

```json
{
  "type": "tool_result",
  "call_id": "call_17",
  "status": "error",
  "exit_code": 1,
  "summary": "2 passed, 1 failed: expired refresh token returned 500",
  "artifact_ref": "artifact://run-42/test-17.txt"
}
```

系统行为仍然是行动与观察交错。区别在于可观察协议更清楚，程序无需读取模型的私有思维链。工程上需要记录的是工具、参数、结果、外部状态变化和证据。

### ReAct 容易变成局部贪心

每轮都根据最新观察选择下一步，适合路径未知的调查，也容易被最近的报错牵着走。Coding Agent 修复一个认证问题时，Lint 报错可能让它改构建配置，安装失败又让它升级依赖，几轮后已经偏离“保持 refresh token 行为不变”的目标。

ReAct 本身没有规定长期目标怎样持久化，也没有保证模型会在正确时刻停止。任务越长，越需要计划和验收条件稳定住全局方向。

## 三、Planning 需要保留调整空间

“先规划再执行”至少有三种含义。第一种是 Prompt 里的步骤分解；第二种是 Agent 运行时可更新的任务状态；第三种是交给外部规划器计算满足约束的动作序列。它们不能混成一个 Planning 标签。

[Plan-and-Solve](https://arxiv.org/abs/2305.04091) 先让模型把推理题拆成子任务，再按计划执行，主要研究一次推理调用中的 missing-step 问题。[LLM+P](https://arxiv.org/abs/2304.11477) 则把自然语言问题翻译成 PDDL，交给经典规划器求解，再翻译回自然语言。前者依赖模型生成计划，后者把可形式化的搜索交给确定性规划工具。

开放的软件工程任务通常处于两者之间。开始时可以写阶段计划，却无法提前知道会改几个文件、测试会暴露什么问题。计划需要能被外部状态修正。

### 计划应保存目标、依赖和证据

一个能参与运行时控制的计划，需要在待办句子之外记录完成条件、依赖、当前状态和证据：

```yaml
goal: 修复 refresh token 过期时返回 500 的问题
constraints:
  - 不改变公开响应 schema
  - 不降低 token 校验强度
plan:
  - id: locate
    task: 定位异常从哪里转换成 500
    status: completed
    evidence: [src/auth/middleware.ts:88]
  - id: patch
    task: 在边界层映射 ExpiredTokenError
    status: in_progress
    blocked_by: []
    acceptance: [只修改错误映射与对应测试]
  - id: verify
    task: 运行 refresh token 测试与 API schema 检查
    status: pending
    blocked_by: [patch]
```

计划的作用是跨多轮保留“为什么做”和“怎样算完成”。工具调用轨迹记录实际发生了什么，二者不应互相替代。

### 重规划需要触发证据

计划一遇到失败就重写，Agent 会在不同方案间来回跳。完全不更新又会机械执行已经失效的步骤。较稳妥的触发条件包括：前置假设被工具结果否定，计划节点连续失败，环境状态发生外部变化，预算已经不足以走原路线，或验证结果证明方案无法满足验收。

每次重规划都应记录：哪条新证据让旧计划失效，保留哪些已验证事实，删除或新增哪些节点。没有新证据的“换个思路”通常只是随机重采样，不值得把整个任务状态推倒重来。

## 四、Reflection 到底指什么

工程文章里的 Reflection 经常涵盖几种不同机制：动作后的错误分析、输出的自我批改、整条轨迹的复盘，以及把复盘写进跨 trial 记忆。它们触发时间和输出产物不同。

### 普通 Reflection：用反馈修正下一步

最常见的 Reflection 是工具或验证失败后的诊断步骤。输入包括目标、刚才的动作、外部结果和当前计划，输出应是结构化决策：继续同一节点、修改参数、回退变更、重规划、请求用户，或停止。

```json
{
  "failure": "API schema snapshot changed",
  "cause": "patch renamed error.code from TOKEN_EXPIRED to EXPIRED_TOKEN",
  "evidence": ["artifact://run-42/schema-diff.txt"],
  "decision": "revise_current_step",
  "next_action": "restore public code value and keep HTTP status mapping",
  "plan_invalidated": false
}
```

这种 Reflection 有新的外部证据，能改变下一步动作。它不要求把长篇内心独白保存下来。

### Self-Refine：对产物做生成、反馈和改写

[Self-Refine](https://arxiv.org/abs/2303.17651) 使用同一个 LLM 依次担任生成者、反馈者和改写者，对当前产物迭代优化。论文在对话、代码、数学推理等七类任务上评估了这种方法。它更像输出优化循环，适合文案、代码片段或结构化答案已有明确质量标准的场景。

Self-Refine 不一定包含环境动作，也不天然拥有任务级状态。用于 Coding Agent 时，应让反馈引用测试、类型检查、静态分析或 Review 规则。只有“请再检查一遍”而没有新证据，反馈者可能重复原判断。

### Reflexion：把语言反馈写进 episodic memory

[Reflexion](https://arxiv.org/abs/2303.11366) 是一个具体框架。Agent 完成一次 trial 后，根据环境奖励或其他反馈生成语言化反思，再把它放入 episodic memory，影响下一次 trial。模型权重没有因此更新，所以论文称其为 verbal reinforcement learning。

它与普通单轮 Reflection 的区别在于生命周期。一次测试失败后的诊断只服务于当前轨迹；Reflexion 的反思跨 trial 保存，用来避免下一次重复同类错误。写入 Memory 也增加了风险：错误归因一旦长期保留，会系统性误导后续尝试。因此反思记录需要任务范围、证据和失效条件。

### 没有外部信号的自我纠错并不稳定

[Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) 区分了依赖外部反馈的纠错与 intrinsic self-correction。论文在其推理实验中发现，没有外部反馈时，模型的自我纠错可能没有收益，甚至降低表现。后续研究对具体条件和方法仍有不同结果，因此不能把这篇论文扩展为“所有模型永远不能反思”。工程上更安全的结论是：反思机制要绑定可检查信号，并通过自己的任务集评测。

## 五、五种循环模式放在一起比较

![ReAct、Plan-and-Execute、Self-Refine、Reflexion 与搜索式推理的差异](/images/posts/agent-loop-patterns.svg)

| 模式 | 控制粒度 | 反馈来源 | 新增状态 | 适合的问题 | 主要风险 |
| --- | --- | --- | --- | --- | --- |
| ReAct | 每个动作 | 工具 Observation | 消息轨迹 | 路径未知、需边做边查 | 被最近反馈牵走 |
| Plan-and-Execute | 任务阶段 | 节点结果与进度 | 计划/Todo/Task Graph | 多步骤、依赖清楚 | 计划过早固化 |
| Reflection | 失败或检查点 | 测试、验证器、用户 | 当前修正决策 | 从具体失败恢复 | 反思过频、空洞 |
| Self-Refine | 当前产物 | 模型反馈或规则 | 产物版本 | 写作、代码、结构化输出 | 同一盲点循环 |
| Reflexion | 完整 trial | 奖励与轨迹反馈 | episodic memory | 可重复尝试的环境任务 | 错误经验长期污染 |
| Tree/Search | 多条候选路径 | 候选评分 | 搜索树与分支状态 | 小而可评估的组合搜索 | 调用量快速增长 |

[Tree of Thoughts](https://arxiv.org/abs/2305.10601) 展开多个中间候选，评估后继续搜索或回溯。它适合动作空间可控、评分相对可靠的任务。真实代码仓库里的每个分支都可能运行工具、修改文件并产生副作用，直接复制树搜索会带来隔离、合并和成本问题。生产 Coding Agent 更常见的做法是只对高不确定决策生成少量候选，或把候选放进隔离工作区验证。

这些模式的差别不在 Prompt 里用了哪个单词，而在运行时多维护了什么状态、何时多调用一次模型、反馈能否证明改动方向更好。

## 六、生产 Agent 通常是一条混合循环

一个 Coding Agent 可以先做轻量计划，在每个节点里用 ReAct 读取文件和运行工具；测试失败时触发 Reflection；根因假设被否定时重规划；最终由独立验证器决定能否完成。这里没有必要选定唯一的论文名。

```python
while budget.remaining():
    context = build_context(task, plan, state, artifacts)
    decision = model.next_action(context)

    if decision.kind == "tool_call":
        result = tools.execute_checked(decision.call)
        state.record(result)

        if reflection_policy.should_reflect(state, result):
            correction = reflect(task, plan, state, result)
            apply_correction(correction, plan, state)
        continue

    if decision.kind == "complete":
        report = verifier.check(task.acceptance, state.artifacts)
        if report.passed:
            return complete(report)
        correction = reflect(task, plan, state, report)
        apply_correction(correction, plan, state)
        continue

    if decision.kind == "needs_input":
        return pause_for_user(decision.question)

return stop_with_checkpoint(state)
```

这段代码只在条件满足时进入 Reflection。Verifier 也与 Reflection 分开：Verifier 根据验收标准产出证据，Reflection 解释失败并选择修正方向。让同一个模型同时生成、打分和决定通过，会放大共同盲点。

### 把反思触发器写成策略

可以先实现少量确定触发器：同一测试连续失败、工具返回不可重试错误、动作未产生新证据、diff 超出允许范围、模型请求完成但验收未通过。每个触发器还要有冷却与次数上限。

```ts
function shouldReflect(s: RunState, event: Event): boolean {
  if (s.reflectionCount >= 3) return false;
  if (event.type === "verification_failed") return true;
  if (event.type === "tool_error" && !event.retryable) return true;
  if (s.repeatedActionCount >= 2) return true;
  if (s.stepsSinceProgress >= 4) return true;
  return false;
}
```

模型接口限流不需要反思，运行时按退避策略重试即可；工具参数 schema 错误可以直接返回字段错误；权限拒绝必须保持边界，不能让模型通过反思“说服”系统放行。故障先分类，才能送到正确处理层。

### Reflection 的输出也要有契约

反思结果如果只是一段自由文本，下一轮很难判断它是否改变了计划。可以约束为失败归因、证据引用、决策类型、受影响计划节点、下一动作和停止理由。`plan_invalidated=true` 时才进入重规划，否则只修正当前节点。

反思不提供额外权限。它提出“需要访问生产数据库”时，Harness 仍按原权限处理；它声称“测试可以跳过”时，完成条件也不会随之改变。

## 七、什么时候该规划，什么时候该反思

一个实用判断方式是看不确定性来自哪里。

| 情况 | 优先机制 | 原因 |
| --- | --- | --- |
| 下一步依赖刚取得的事实 | ReAct | 每次观察都会改变局部选择 |
| 任务有多个依赖步骤 | Planning | 需要保存目标、顺序和完成条件 |
| 工具或测试给出明确失败 | Reflection | 已有新证据可用于修正 |
| 当前产物可反复评分 | Self-Refine / evaluator-optimizer | 每轮改写有可测目标 |
| 同类环境可重复 trial | Reflexion | 跨 trial 经验可能复用 |
| 状态可形式化、解空间可搜索 | 外部规划器或搜索 | 程序比自然语言计划更可靠 |
| 两步以内且路径明确 | 简单 Workflow | Agent 控制带来的成本没有必要 |

Planning 主要面向未来，Reflection 主要解释过去，ReAct 连接现在的行动和观察。实际循环会反复穿过三者：计划给当前节点，ReAct 执行，验证失败产生反馈，Reflection 选择局部修正或重规划。

## 八、端到端走一遍失败恢复

任务是修复 refresh token 过期时返回 500，同时保持公开响应 schema 不变。

Agent 首先建立三步计划：定位错误映射，提交局部补丁，运行行为与 schema 验证。定位节点内部使用 ReAct：读取中间件，搜索 `ExpiredTokenError`，再运行一条最小复现测试。Observation 显示异常被通用错误处理器转换为 500。

模型修改错误处理，将 HTTP 状态变成 401，也顺手把错误码从 `TOKEN_EXPIRED` 改成更自然的 `EXPIRED_TOKEN`。单元测试通过，API snapshot 验证失败。失败来自代码行为，而非基础设施或参数格式，Reflection 策略因此触发。

反思输入包含原始约束、当前 diff 和 snapshot diff。输出指出 HTTP 状态修改符合目标，错误码改名违反公开 schema；它选择 `revise_current_step`，保留已经验证的根因和原计划。Agent 恢复原错误码，再次运行两组验证。

随后集成测试发现过期 token 的审计日志缺少 request ID。这个现象与用户目标有关，但不属于原始完成条件。Agent 把它记录为 follow-up，不继续扩大补丁。最终 Verifier 检查行为测试、schema snapshot 和 diff 范围，三项通过后才将任务标记为 completed。

![一次验证失败如何触发 Reflection 并回到当前计划节点](/images/posts/agent-loop-recovery-trace.svg)

如果没有计划，Agent 可能追着审计日志继续改；没有 Reflection，它可能只看到“测试失败”并随机重写补丁；没有外部 Verifier，它也可能在单元测试通过时过早结束。三个机制各自解决了不同故障。

## 九、Reflection 最常见的失败方式

1. **每一步都反思。** 额外模型调用提高延迟和成本，还会让 Agent 对刚完成的正确动作产生不必要怀疑。没有失败、冲突或停滞信号时，继续执行计划通常更好。

2. **只写态度，不改变状态。** “下次应该更谨慎地检查边界情况”无法驱动运行时。有效结果要指出哪个假设错了、证据在哪里、当前节点如何修改、是否需要重规划。

3. **执行者给自己打满分。** 同一个 Context 和模型容易共享盲点。外部测试、编译器、规则引擎和用户反馈通常比一句“请严格审查”更有信息。必须使用 LLM evaluator 时，可以让它看到明确 rubric 和原始产物，并把判定作为信号，而非唯一真相。

4. **把错误反思写进长期 Memory。** 当前任务的偶发现象不应自动升级成通用经验。跨 trial 保存前，要记录适用任务、证据、成功复验和失效条件；后续使用时仍需重新验证。

5. **失败后立刻重规划。** 测试失败可能只是实现错误，并不说明总体路线错误。先判断失败影响当前动作、当前节点还是任务假设。只有后两者才需要局部或整体重规划。

## 十、怎样评测一条 Agent Loop

最终成功率仍然重要，但不足以解释循环为什么好或坏。两套系统都完成任务，一套可能三轮结束，另一套反思十次、重复修改文件并靠偶然通过。

至少记录以下轨迹指标：

- 任务成功率与验收证据有效率；
- 平均工具调用数、模型调用数、延迟和 token；
- 计划节点完成率、重规划次数与触发原因；
- Reflection 次数、产生有效修正的比例；
- 重复动作、无新证据轮次和预算耗尽率；
- 正确方案被反思改坏的比例；
- 越权动作尝试与被动作层拦截的次数。

评测可以分三步进行。第一步是做消融实验。同一任务集运行四个版本：基础 ReAct，增加计划，增加验证触发的 Reflection，完整混合循环。固定模型、工具和 Context 策略，才能看出新增机制是否贡献了成功率，还是只增加调用次数。

任务集还要包含短任务。复杂控制层可能在长任务上有收益，却让简单任务更慢、更容易过度处理。把不同长度和不确定性分桶，才能找到启用 Planning 与 Reflection 的条件。

第二步是检查反思内容与后续动作的因果关系。仅判断反思文字是否合理会高估效果，还应观察它是否改变下一动作，修改后是否解决原失败，有没有引入新回归。如果删除这段反思仍得到相同动作，它很可能只是解释性文本，没有承担控制作用。

第三步是回看失败样本。区分计划错误、执行错误、验证器误判、反思误归因和预算不足，才能决定下一轮应该改 Prompt、Context、工具协议还是运行时策略。只看一张总分表，很容易把控制层问题误判成模型能力问题。

## 十一、从简单循环开始实现

一套渐进路线可以这样安排：

1. 先实现结构化 tool call / tool result、步数预算和明确退出状态；
2. 增加独立验收，让“停止调用工具”和“任务完成”分开；
3. 长任务再增加轻量计划，节点带验收条件和证据；
4. 从确定失败信号开始接入 Reflection，并限制次数；
5. 只有可重复 trial 且经验能复用时，才把反思写入 episodic memory；
6. 用消融评测决定哪些任务启用更复杂的循环。

如果业务步骤固定、分支可以枚举，普通 Workflow 会更便宜也更容易审计。[Anthropic 的 Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) 也把 prompt chaining、routing、parallelization、orchestrator-workers 和 evaluator-optimizer 区分为不同组合模式，建议只在评测证明有收益时增加复杂度。

## 十二、检查表

| 检查面 | 需要回答的问题 |
| --- | --- |
| 主循环 | 模型、Harness 和环境各负责什么？ |
| 观察 | 工具结果是否结构化、可引用并说明副作用？ |
| 计划 | 是否记录目标、依赖、验收和当前节点？ |
| 重规划 | 哪条新证据让旧计划失效？ |
| Reflection | 由什么失败信号触发，最多运行几次？ |
| 外部反馈 | 测试、验证器或用户是否提供了新信息？ |
| 修正范围 | 修当前动作、当前节点还是整个计划？ |
| Memory | 反思是否真的值得跨 trial 保留？ |
| 停止 | completed、needs_input、failed 和预算耗尽是否分开？ |
| 评测 | 新机制改善了结果，还是只增加了调用？ |

## 结语

Agent Loop 的主干很短：决定动作、执行动作、观察结果、继续或退出。ReAct 让观察参与下一次决定，Planning 保留长任务的目标与依赖，Reflection 利用失败反馈修正路径。Reflexion、Self-Refine 和树搜索是在不同状态范围上扩展这条主干。

循环次数与可靠性没有直接对应关系。每次新增模型调用都应回答两个问题：它获得了什么新信息，它会怎样改变可观察状态。回答不了时，这一轮大概率只是成本更高的自言自语。

## 参考资料

- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)
- [Plan-and-Solve Prompting](https://arxiv.org/abs/2305.04091)
- [LLM+P: Empowering Large Language Models with Optimal Planning Proficiency](https://arxiv.org/abs/2304.11477)
- [Tree of Thoughts: Deliberate Problem Solving with Large Language Models](https://arxiv.org/abs/2305.10601)
- [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)
- [Anthropic: Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
