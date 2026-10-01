---
title: Jev：为什么 Agent 需要一个比 LLM 更快的控制层
description: Jev 不生成长文本，而是对有限答案返回类型化决策与概率。本文从 REFLEX、Jev-Mem 和评测 Judge 三个场景分析这种 System One 模型怎样进入 Agent 控制平面。
category: Agent
subcategory: Agent 前沿
featured: false
publishedAt: 2026-10-01T20:03:00+08:00
updatedAt: 2026-10-01
tags: [Jev, System One Model, Agent Control Plane, Model Routing, Agentic Memory]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

一个 Agent 完成任务时，会做大量很小的判断：该调用哪个工具，这条记忆要不要写入，检索是否足够，当前结果能不能通过验收，下一步继续执行还是向用户确认。

我们习惯把这些判断全部交给 LLM。系统把状态写成 Prompt，让模型生成一段文字或 JSON，再解析成程序动作。这个方案通用，却有一个明显的不协调：为了在几个有限选项里做决定，我们启动了一个擅长生成任意字符串的大模型。

Jev 尝试提供另一种计算原语。它接收非结构化状态和类型化问题，直接返回允许答案上的概率，不生成解释文本。TypeSafe AI 将它称作 System One Model：快、便宜，适合软件内部反复发生的有界决策。

![Jev 在 Agent 中承担高频决策，大模型处理复杂推理与生成](/images/posts/jev-control-plane.svg?v=20261001)

## 一、Jev 到底是什么

[TypeSafe AI 对 Jev 的介绍](https://typesafe.ai/blog/introducing-system-one-models-and-jev)给出一个很准确的描述：unstructured state in, typed probabilistic decisions out。

假设 Agent 要根据工单内容选择动作，传统 LLM 调用可能长这样：

```text
阅读下面的用户请求，从 refund、replace、clarify 中选择一个动作。
只输出 JSON，不要解释……
```

模型仍然在做自回归生成。JSON mode 能约束输出格式，却没有改变“逐 token 生成字符串”这件事。

Jev 的调用更接近一个带语义理解能力的分类函数：

```ts
const decision = await jev.choose({
  state: ticket,
  question: "下一步应采取什么动作？",
  choices: ["refund", "replace", "clarify"],
});

// {
//   choice: "clarify",
//   probabilities: {
//     refund: 0.08,
//     replace: 0.17,
//     clarify: 0.75
//   }
// }
```

这里的关键不是 JSON 更规整，而是输出空间在调用前已经确定。软件得到一个类型化选择及其概率，可以直接设置阈值、比较候选或决定是否升级到强模型。

Jev 仍然会出错。“不生成自由文本”只意味着它不会返回类型之外的字符串，不代表它不会选择错误选项。把格式错误和语义错误分开，是理解 Jev 的第一步。

## 二、为什么叫 System One

命名来自“快思考与慢思考”的区分：

| 层 | 擅长的任务 | 在 Agent 中的例子 |
| --- | --- | --- |
| System One | 高频、有界、可类型化的快速判断 | 路由、分类、打分、继续或停止 |
| System Two | 开放式推理、规划、解释与生成 | 分析故障、编写代码、总结证据 |

这不是一条绝对边界。同一个问题可以写成有界选择，也可以要求开放推理。真正需要判断的是：动作集合是否清楚，决策错误是否可检测，输入是否包含足够信息，以及不确定时能否安全升级。

例如“从三个只读检索工具中选择一个”适合快速控制层。“是否删除生产数据库中的一批记录”即使只有 yes/no 两个答案，也不该因为输出空间小就自动执行。决策的风险不会随着选项数量一起缩小。

## 三、REFLEX：让 Jev 管 routine decisions

[REFLEX 论文](https://arxiv.org/abs/2609.26532)把 Jev 放进一个选择性控制架构：

```text
当前状态
   ↓
Jev 返回 choice + confidence
   ├── 高置信且允许自动执行 → 直接采取动作
   └── 低置信 / 需要生成 / 高风险 → Strong LLM
```

论文在冻结的 100 个任务上报告，REFLEX 取得 95% 成功率，同时比只用强模型减少 72.7% 的强模型调用。这个结果说明很多工具选择和流程判断确实不需要每次调用最强模型。

更值得关注的是细分结果。论文观察到，替代率在工具选择上达到 99%，完成判断为 77%，检索判断为 56%，澄清判断只有 28%。常规工具路由容易下放，涉及用户授权和信息是否充分的问题更难。

论文也没有把结论写成“Jev 全面替代 LLM”。在外部任务上，一个便宜的生成模型级联已经能把普通路由做得很好，Jev 的优势会缩小。选项数量增加、候选动作彼此相近时，可靠性也会下降。

所以 REFLEX 的正确读法不是“以后不用大模型做 Agent”，而是：

> 先识别 Agent Loop 中重复、类型固定的控制决策，再用置信门把困难样本送回强模型。

## 四、置信门不能只看一个数字

最简单的升级规则是：

```ts
if (decision.confidence >= 0.85) {
  return execute(decision.choice);
}
return strongModel.decide(state);
```

真实系统至少还要加入风险与决策类型：

```ts
const shouldEscalate =
  decision.confidence < thresholdByAction[decision.choice] ||
  actionRisk[decision.choice] === "high" ||
  requiresFreeFormGeneration(state) ||
  isOutOfDistribution(state);
```

统一阈值通常不够。误选一个只读搜索工具，最多损失一次调用；误选“退款”或“删除”，代价完全不同。阈值应该按动作风险、错误方向和线上数据校准。

另外，模型给出的 0.9 不天然等于“100 次里对 90 次”。上线前需要画可靠性图，检查置信区间是否校准。输入分布变化后还要重新监控，否则阈值只是一个看起来精确的常量。

## 五、Jev-Mem：控制记忆，而不是生成记忆

Agentic Memory 常把写入、分类、关联、检索和停止都交给 LLM。一次用户对话可能触发多轮模型调用：提取事实、生成摘要、判断关系、改写查询，再判断检索结果够不够。

[Jev-Mem](https://arxiv.org/abs/2609.23986)把记忆系统拆成三层：

```text
System One Control Plane
  记忆类型、关系组织、查询路由、检索预算、候选打分、停止
                         ↓
Structured Memory Plane
  多类型节点与关系
                         ↓
System Two Reasoning Plane
  复杂推理和答案生成
```

控制层处理频繁的有界决策，强模型只在需要推理和生成时出现。论文在 LoCoMo 上报告了 0.777 的 LLM-as-a-Judge 总分，相对最强基线提升 11%；记忆构建时间为 158 秒，比最快对照快 6.6 倍；平均查询延迟降到 0.93 秒，下降 36.7%。这些数字来自论文实验，不能直接外推到任意业务，但它们证明了控制路径值得单独优化。

Jev-Mem 也改变了我们设计 Memory 的视角。瓶颈未必在向量搜索，而可能在每个阶段都插入一次生成式判断。把控制决策类型化后，系统更容易测量每一步的准确率、延迟和升级比例。

## 六、Jev 作为 Judge：便宜，但错误可能相关

评测是另一个高频判断场景。传统 LLM Judge 会针对每条样本和每项 rubric 生成评价，成本会随样本量快速上升。

[JEV vs. LLMs as Rubric Judges](https://arxiv.org/abs/2609.29769)比较了 Jev 与三种 flash 级 LLM Judge。在七个基准构成的九组面板中，27 组两两比较只有 8 组出现显著准确率差异。Jev 在二元标准上表现更好，在部分分级标准上落后。三种 LLM Judge 的成本是 Jev 的 29 到 325 倍，用时是 30 到 220 倍。

论文标题里的后半句更重要：wrong in the same places。研究发现，LLM Judge 经常重复 Jev 最有信心的错误。于是“Jev 低置信就交给 LLM”虽然节省成本，却没有带来预想中的准确率提升，级联最多只改善约 1.5 到 2 个百分点。

这揭示了级联系统的一个陷阱：第二个模型更大，不代表它的错误与第一个模型独立。两者可能都误解了同一条 rubric，或者共同缺少某个背景知识。

因此 Jev 适合做大规模初筛和已验证的二元标准，但高风险验收仍需要确定性检查、真实环境结果或人工抽样。多个 AI Judge 的一致意见不能替代独立证据。

## 七、哪些决策适合交给 Jev

我会从四个条件筛选：

1. 输出集合能在执行前完整列出；
2. 大量调用具有相同的决策结构；
3. 错误可以被后续检查发现，或能够安全回退；
4. 系统能积累带标签的数据来校准阈值。

适合的例子包括：

- 从有限工具集中路由一个只读查询；
- 判断某条内容属于事实、偏好还是临时状态；
- 给检索候选打相关或不相关标签；
- 判断测试是否满足一条二元 rubric；
- 在预算耗尽前选择继续、停止或升级。

不适合直接自动执行的例子包括：

- 涉及资金、删除和外发的不可逆动作；
- 候选动作随上下文临时生成；
- 需要引用证据和解释推理链的判断；
- 标签标准本身含糊或持续变化；
- 系统无法观察真实结果，只能用另一个模型打分。

## 八、把 Jev 放在 Agent 哪一层

它最适合进入 Harness 的 Control Plane，而不是替代主模型：

| 运行环节 | Jev 的角色 | 强模型的角色 |
| --- | --- | --- |
| 工具调用前 | 工具族路由、风险分类 | 生成复杂参数、处理例外 |
| 记忆写入 | 类型、保留与关系判断 | 总结和跨记忆推理 |
| 检索过程 | 预算、候选评分、停止 | 查询改写和答案综合 |
| 输出验收 | 二元 rubric 初筛 | 复杂分级与解释 |
| 模型路由 | 判断任务是否需要升级 | 完成困难样本 |

这层设计会让 Agent 的成本结构发生变化。强模型调用次数不再等于 Agent 决策次数，大量 routine control 可以被单独观测、训练和优化。

## 九、我对 Jev 的判断

Jev 最有意思的地方不是速度数字，而是它挑战了一个默认假设：智能软件中的每个语义判断都必须通过文本生成完成。

LLM 很适合开放问题，却不是所有控制决策的天然接口。未来的 Agent Harness 很可能同时拥有几类模型：强模型负责推理和生成，小模型负责路由与提取，Embedding 模型负责相似性，Jev 这样的决策模型负责类型化选择。系统根据风险和置信度在它们之间调度。

现阶段仍需克制。Jev 刚刚进入公开使用，独立研究还不多；官方关于速度和能力的说法需要更多外部复现；已有论文也显示，它在复杂分级、授权边界和相近候选上会遇到限制。它适合成为新的控制层候选，而不是一夜之间替换全部 LLM 调用。

## 参考资料

- [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [REFLEX with Jev for Efficient Selective Control in LLM Agents](https://arxiv.org/abs/2609.26532)
- [Jev-Mem: System-One-Controlled Agentic Memory for Efficient AI Agents](https://arxiv.org/abs/2609.23986)
- [JEV vs. LLMs as Rubric Judges](https://arxiv.org/abs/2609.29769)
