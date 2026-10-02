---
title: Context Engineering：Agent 每一步究竟看到了什么
description: 从一次 Coding Agent 故障排查出发，拆解 Context 的装配、检索、裁剪、压缩与观测，说明长上下文为什么仍会遗忘，以及 Prompt、RAG、Memory 各自负责什么。
category: Agent
subcategory: Agent 开发
articleClass: flagship
seriesOrder: 40
featured: false
publishedAt: 2026-10-02
updatedAt: 2026-10-02
tags: [Agent, Context Engineering, Context Window, Compaction, RAG, Memory, AI Coding]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

一个 Coding Agent 接到任务：“修复订单服务偶发超时，不要改变 API 行为。”它先读仓库规则，搜索调用链，打开三个文件，运行测试，得到两百行日志，又尝试了一条错误路径。十几轮以后，模型仍然知道任务名称，却忘了用户禁止改 API，还把第一次搜索得到的旧实现当成当前代码。

从聊天记录看，信息都出现过。对模型来说，“曾经出现过”和“这一轮能够可靠使用”是两回事。每次推理只依赖当前请求里的 token：系统指令、工具定义、对话历史、文件片段、工具结果、摘要和刚收到的用户消息。运行时如何选择、排列和更新这些内容，决定了 Agent 此刻究竟活在哪个世界里。

Context Engineering 处理的正是这个问题：**在不断变化的信息集合中，为下一次模型调用组装哪一小部分内容，才能让 Agent 做出当前步骤需要的决定？**

本文的事实依据主要来自 OpenAI 与 Anthropic 的开发文档，以及长上下文利用、位置偏差和 Prompt 压缩的原始论文。具体模型的窗口长度、缓存方式和 SDK 参数会变化，文章讨论的是更稳定的工程责任：信息如何进入 Context，何时离开，压缩后怎样校验，出错时如何还原模型当时看到的输入。

## 先看一张地图

Context 不等于聊天记录，也不等于所有可用知识。它是某一次模型调用的实际输入。一个 Agent 的外部世界可以很大：整个代码仓库、组织知识库、历史会话、工单系统和互联网；模型这一轮只看到 Context Builder 选中的切片。

一套可用的 Context 系统需要完成五件事：保留始终生效的任务契约，取得当前步骤需要的事实，把大结果变成引用或摘要，淘汰已经失效的信息，并留下可以回放的装配记录。窗口容量只是预算上限，不能替代这套选择机制。

![Agent Context 从信息源到模型输入的装配过程](/images/posts/context-engineering-assembly.svg)

图中有两条边界。左边是长期存在但不会全部进入模型的信息空间；右边是单次调用的 Context。中间的 Context Builder 负责选取、标记来源、控制预算和排序。模型返回候选动作后，工具结果又成为下一轮的候选材料，于是 Context 会随着轨迹不断重建。

## 一、先给 Context 一个精确定义

在 LLM 应用里，Context 是模型生成下一段内容时可以注意到的 token 集合。它通常包括：

- 平台与开发者指令；
- 当前用户请求和必要的对话历史；
- 工具名称、参数 schema 与使用说明；
- 检索到的文档、代码和业务事实；
- 之前的模型输出与工具返回；
- 运行时生成的计划、摘要、检查点和状态。

这些内容最终可能被编码成同一串 token，但来源、权限、时效和用途并不相同。开发者指令可以定义任务，网页正文只能提供证据，五分钟前的文件内容可能已经被 Agent 自己改掉。Context Engineering 不能只做字符串拼接，它需要维护这些差异。

### Context Window 只规定容量上限

Context Window 指模型一次调用最多能够处理的输入与输出范围。窗口变长确实让系统可以容纳更多文件和历史，但“放得下”不代表模型会平等、稳定地使用每一段内容。

[Lost in the Middle](https://arxiv.org/abs/2307.03172) 在多文档问答和键值检索任务中观察到明显的位置效应：相关信息位于输入开头或结尾时表现较好，落在长输入中部时性能会下降。这个结论来自特定模型和任务，不能直接推导出所有现代模型都有相同曲线。它至少证明了一个工程事实：标称窗口长度不是有效信息容量的同义词。

长输入还会增加首 token 延迟、推理成本和 KV Cache 压力。更隐蔽的问题是冲突。旧计划、新计划、修改前代码、修改后 diff 和重复日志同时存在时，模型必须先判断哪一份有效，才有机会解决真正的任务。

从运行时看，数据库里保存了完整轨迹，不代表每轮都要把完整轨迹发给模型。持久化层保存事实和历史，Context Builder 根据当前状态生成一份运行时视图。

```ts
type ContextItem = {
  id: string;
  kind: "instruction" | "task" | "fact" | "artifact" | "event" | "summary";
  source: string;
  trust: "system" | "user" | "tool" | "external";
  createdAt: string;
  validUntil?: string;
  supersedes?: string[];
  tokenEstimate: number;
  content: unknown;
};
```

这个结构比 `messages: Message[]` 多出的字段，恰好是装配 Context 时需要回答的问题：它从哪里来，现在还有效吗，是否替代了旧版本，占多少预算，应以原文、摘要还是引用进入模型。

## 二、Prompt、RAG、Memory 与 Context Engineering 的边界

这四个词经常在同一篇教程里出现，因为它们最终都会影响模型输入。它们关注的对象不同。

| 概念 | 主要问题 | 典型产物 | 常见误用 |
| --- | --- | --- | --- |
| Prompt Engineering | 任务和规则怎样表达 | System Prompt、示例、输出契约 | 用措辞补救缺失事实 |
| RAG | 怎样从外部语料找候选证据 | 检索结果、引用片段 | 把相似度最高当成足够相关 |
| Memory | 哪些信息要跨轮次或跨会话保留 | 用户偏好、检查点、经验记录 | 把未经验证的模型结论永久保存 |
| Context Engineering | 下一次调用实际带哪些内容 | 一份带来源、顺序和预算的输入视图 | 把所有材料塞满窗口 |

Prompt 是 Context 的一部分；RAG 和 Memory 是 Context 的候选来源；Context Engineering 决定当前轮是否取用、以什么粒度取用，以及与哪些其他内容一起出现。Harness 则执行这个策略，并负责工具调用、状态和权限。

### RAG 解决“找什么”，Context 还要解决“怎么用”

检索系统返回五个代码片段后，Context Builder 仍要判断版本、去重、拼接依赖，并明确告诉模型这些片段是不是完整文件。只看语义相似度，容易把测试夹具、旧文档和同名函数排在真实实现前面。

代码任务尤其依赖结构关系。一个函数本身与问题高度相关，但它调用的超时配置、接口定义和测试断言可能分别位于其他文件。RAG 可以发现候选入口，Context 策略需要补齐闭包：定义、调用方、配置和当前 diff 中，哪些是本轮判断不可缺的。

Memory 的写入发生在一次任务或一次会话之后，Context 的装配发生在每次模型调用之前。把某条信息存进 Memory，只是获得了未来被检索的资格。

例如“订单服务使用 300 ms 超时”来自一次临时观察。它不适合作为长期事实写入；“该仓库禁止修改公开 API，规则见 `AGENTS.md`”有稳定来源和适用范围，可以作为项目记忆。二者未来进入 Context 时，还应重新检查来源是否有效。

## 三、Context Builder 怎样组装一次调用

把所有候选材料按时间排序再截断，是最容易实现、也最容易出问题的策略。有效的装配过程更像查询计划：先确定当前决策需要什么，再从不同存储层取得材料，最后在预算内排序。

### 固定骨架与动态内容

每轮 Context 可以分成两部分。固定骨架包括任务契约、权限边界、工具协议和输出格式。动态内容包括当前步骤、最近事件、检索证据、文件状态和工具结果。

固定不代表永远原样复制。工具很多时，可以根据任务阶段只暴露相关工具；大型规则集可以保留索引，遇到对应路径时再加载正文。不能被摘要改写的权限和完成条件，则应固定保留原文或交给模型之外的程序执行。

动态内容需要围绕“下一步决策”组织。模型准备修改代码时，应看到当前文件版本、相关测试、用户约束和计划中的当前节点。早期搜索的几十条候选结果已经完成导航作用，没有必要继续占据同等位置。

```ts
function buildContext(state: RunState, budget: number): ContextItem[] {
  const pinned = loadPinnedInstructions(state.projectId);
  const task = loadCurrentTask(state.runId);
  const step = loadActiveStep(state.runId);
  const recent = loadRecentEvents(state.runId, 8);
  const evidence = retrieveEvidence(step.query, step.requiredKinds);
  const checkpoint = loadLatestCheckpoint(state.runId);

  return allocateBudget(
    [pinned, task, checkpoint, evidence, recent].flat(),
    budget,
  );
}
```

这里的 `allocateBudget` 不能只按 token 从后向前删除。它应理解哪些项目必须保留，哪些可以压缩，哪些可以只留引用，哪些因版本过期需要直接丢弃。

### 一份实用的预算分配

预算不必固定成行业通用比例，但必须有优先级。可以先为不可丢失的契约和当前任务预留空间，再分配工作证据、最近交互和生成余量。

| 区域 | 保存方式 | 超预算时的动作 |
| --- | --- | --- |
| 权限、任务约束、完成条件 | 原文固定 | 不参与普通摘要；缩减其他区域 |
| 当前状态与计划节点 | 结构化快照 | 删除已完成步骤的操作细节 |
| 当前决策所需证据 | 原文片段加来源 | 降低候选数量，不能剪断关键定义 |
| 工具结果与最近消息 | 结构化事件 | 去重、截断噪声、将大结果落盘 |
| 已完成阶段 | 摘要加 Artifact 引用 | 压缩为结论、证据和未决事项 |
| 模型输出空间 | 预留 | 不用输入填满整个窗口 |

输入预算必须给输出留余量。模型需要生成补丁或较长结构化结果时，如果输入已经贴近窗口上限，响应可能被截断，最完整的 Context 反而没有产生可用结果。

## 四、Context 会随着 Agent Loop 改变

Agent 的每一步都在改变下一步的信息需求。第一次调用需要理解任务和仓库；找到疑似代码后，需要读取局部实现；修改完成后，重点变成 diff、测试和验收条件。上下文如果没有随阶段转换，就会一直背着旧材料前进。

![一次 Coding Agent 任务中 Context 的逐轮变化](/images/posts/context-engineering-turns.svg)

图里没有把所有历史一股脑传到下一轮。每次工具结果先进入事件与 Artifact 存储，Context Builder 再决定下一轮带回原文、摘要还是引用。任务约束始终固定，工作证据则随当前决策变化。

### 工具输出应先进入数据层

Shell 输出、网页正文和日志经常非常大。把完整结果直接附加到消息历史，会造成三个问题：重复信息持续累积，异常字符和不可信指令进入高注意区域，后续轮次无法知道输出是否被截断。

工具契约应该同时返回可供当前轮使用的摘要和可供追溯的完整 Artifact：

```json
{
  "status": "ok",
  "summary": "182 个请求中有 17 个在 payment-client 超时",
  "evidence": [
    {"line": 84, "request_id": "r-192", "latency_ms": 301}
  ],
  "truncated": true,
  "artifact_ref": "artifact://run-2048/logs/payment-timeouts.txt",
  "content_hash": "sha256:..."
}
```

模型当前能用 `summary` 和少量证据决定下一步，需要核对分布或反例时再分页读取 Artifact。`truncated: true` 也限制了结论的强度：模型只能描述已返回样本，不能声称检查了全部日志。

文件内容还要带版本。Coding Agent 常见的 Context 错误是同时保留修改前文件、补丁和修改后文件。三份内容语义接近，模型可能基于旧版本继续编辑，产生无法应用的 patch 或覆盖用户刚做的修改。

读取文件时记录内容哈希或版本；成功编辑后，让新版本显式 `supersedes` 旧版本。下一轮默认只装配最新内容，旧版本保存在轨迹里供 diff 和审计，不再作为当前事实进入模型。Context 的时间语义因此从“最近出现的可能是新的”变成可检查的版本关系。

## 五、检索需要逐步缩小问题

复杂任务开始时，Agent 往往连正确查询词都不知道。用户说“订单偶发超时”，仓库里可能使用 `deadline exceeded`、`paymentClient` 或某个错误码。一次向量检索很难直接找到完整答案。

较稳妥的路径分为探索和取证。探索阶段用目录、符号索引、关键词与仓库地图找到候选区域；取证阶段读取精确文件、调用关系、配置和测试。前者追求覆盖，结果可以很短；后者追求完整与可引用，必须带版本和位置。

### Query 应来自当前缺口

每次检索之前，先记录“当前知道什么”和“还缺什么”。如果已经确定超时发生在 `payment-client`，下一次查询应围绕配置来源和调用方，而不是重复搜索“timeout”。

```json
{
  "known": [
    "超时集中在 POST /orders/confirm",
    "payment-client 在 300ms 附近返回 deadline exceeded"
  ],
  "unknown": [
    "300ms 由哪个配置提供",
    "重试是否可能放大请求量"
  ],
  "next_query": "payment client timeout config retry confirm order",
  "required_evidence": ["definition", "caller", "test"]
}
```

这种缺口记录也能阻止检索空转。连续两轮没有缩小 `unknown`，Harness 就应改变策略、请求用户信息或停止，而不是继续堆相似片段。

### 排名分数不能代替证据质量

语义相似度衡量文本与查询的接近程度，不包含代码版本、资源权限、事实时效和来源权威性。Context Builder 可以把这些因素作为独立特征：

```text
utility = relevance
        × source_authority
        × freshness
        × task_fit
        × completeness
        ÷ token_cost
```

这个公式只是在列出装配时容易漏掉的变量。一个短而新的配置定义，可能比一篇很相似但过时的设计文档更值得进入当前 Context。最终排序还要保留多样性，避免五个候选都在重复同一结论。

## 六、长任务为什么需要压缩

窗口快满时才临时总结全部聊天，通常已经太晚。摘要模型面对的是一堆互相覆盖的计划、试错和长日志，它不知道哪些细节会在下一阶段重新变得重要。

[OpenAI 的 Compaction 指南](https://developers.openai.com/api/docs/guides/compaction) 将压缩定义为把后续轮次需要的状态带入一个更小的 Context。[Anthropic 的 Context Engineering 文章](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 则把 compaction、结构化笔记和子 Agent 隔离列为长任务的不同策略。共同点是：历史记录仍可保存在外部，模型工作窗口只携带继续任务所需的状态。

### 压缩要按信息类型处理

权限边界、用户原始要求、已经验证的事实、失败尝试和普通对话不能用同一压缩率。适合压缩的是重复操作和过程噪声；需要原文保留的是会改变行为边界的条款；大型证据应该落盘并用稳定引用连接。

![Context 压缩时不同信息的保真策略](/images/posts/context-engineering-retention.svg)

一份阶段检查点至少应包含：

```yaml
goal: 修复订单确认偶发超时，不改变公开 API
current_hypothesis: payment-client 超时配置没有覆盖生产环境
verified_facts:
  - claim: 默认值为 300ms
    source: src/payment/config.ts:41@sha256:abc
  - claim: confirm 路径没有单独覆盖
    source: src/order/confirm.ts:88@sha256:def
changes:
  - file: src/order/confirm.ts
    patch_ref: artifact://run-2048/patches/001.diff
failed_attempts:
  - approach: 修改全局默认值
    reason: 会影响其他调用方
open_questions:
  - 生产配置是否有环境变量覆盖
next_action: 读取部署清单并运行 confirm 集成测试
constraints:
  - 不改变公开 API
  - 未验证生产配置前不得声称完成
```

这份记录保留了下一阶段做决定所需的状态，还把证据指向可重新读取的原文。它没有复制每条 Shell 命令和完整日志。

压缩还有一条更细的技术路线：按 token 或片段判断信息量，直接缩短输入。[LLMLingua](https://arxiv.org/abs/2310.05736) 与 [LongLLMLingua](https://arxiv.org/abs/2310.06839) 分别研究了通用 Prompt 压缩和长文本中的问题相关压缩。论文实验说明，经过选择的短输入在部分任务上可以保留甚至改善结果。不过 Agent 检查点承担状态恢复、权限和审计责任，不能仅凭语言模型困惑度删除字段。token 级压缩更适合处理可回读的文档与重复文本，结构化状态仍应由明确的保留策略管理。

### 摘要会制造新的事实风险

摘要是模型生成的派生信息，可能漏掉否定词、范围和不确定性。“没有证据表明重试生效”被压成“重试未生效”，含义已经改变；“只检查了 20 条样本”如果丢失，局部观察就会升级成全量结论。

因此摘要项需要标记来源与生成时间，重要 claim 最好带引用。后续动作依赖某个细节时，应回到原始 Artifact 复核。摘要适合导航和恢复，不适合单独承担高风险事实证明。

压缩时机也会影响信息质量。固定 token 阈值容易实现，却不是唯一触发条件。阶段结束往往是更好的压缩点，例如根因已经确定、补丁已经完成、测试阶段刚开始。此时信息边界清楚，系统能把“探索过程”压成“已验证结论和未决事项”。

还可以在工具产生超大输出时立即外置，而不是等待整段历史超限。把压缩当作持续的信息生命周期管理，效果通常比最后一刻做一次全文摘要稳定。

## 七、上下文污染比上下文不足更难发现

缺少文件时，模型往往会请求读取或暴露不确定性。污染的 Context 看起来信息丰富，模型却可能自信地沿错误事实继续执行。

### 常见的五类污染

| 污染 | 具体表现 | 修复位置 |
| --- | --- | --- |
| 过期 | 修改前文件仍与新版本并存 | 版本与 supersedes 关系 |
| 冲突 | 两份规则没有生效范围 | 来源、优先级与适用条件 |
| 重复 | 相同日志和工具结果反复回传 | 去重、Artifact 引用 |
| 无关 | 初期广搜结果留到执行阶段 | 按当前决策重新检索 |
| 不可信 | 网页或代码注释被当成指令 | 信任标记与动作层校验 |

Prompt Injection 是上下文污染的一种安全形式：低信任数据试图取得指令权。上一篇文章讨论了防御边界；在 Context Builder 里，最低要求是保留数据来源，不把检索正文拼进开发者指令，并限制外部内容能够引导的读取与写入范围。

### “把相关内容都放进去”为何会失效

“相关”通常只回答了主题是否接近，没有回答当前步骤是否需要。排查阶段需要历史日志，编辑阶段需要最新文件和接口约束，验收阶段需要测试结果与完成条件。相同材料在不同阶段的效用会变化。

内容越多还会增加矛盾的机会。模型要花 token 识别重复和冲突，任务证据反而只占很小比例。Context Engineering 应优先提高信号密度，窗口装载率没有必要追求最大。

## 八、端到端看一次 Context 如何演化

回到开头的订单服务任务。初始状态只有用户目标、仓库规则和工具清单。完成条件包括：定位根因、提交最小修改、测试通过、公开 API 不变。系统没有预加载整个仓库。

第一轮用于定位。Agent 看到目录摘要、与 `order timeout` 相关的符号和少量 README 片段，决定读取 `confirm.ts`、`payment-client.ts` 和对应测试。广搜结果随后落盘，不再完整进入下一轮。

第二轮用于建立假设。Context 中加入三个文件的当前版本和一段结构化日志摘要。模型发现超时集中在 300 ms，提出“全局默认值过低”。Context Builder 同时带回调用方列表，模型看到还有结算和退款共用客户端，于是放弃修改全局默认值。这条失败路径写进检查点，防止压缩后再次尝试。

第三轮读取配置来源。部署清单表明生产环境没有覆盖 `confirm` 的超时，接口测试要求保持请求结构不变。模型修改调用点，为确认路径传入独立 timeout。编辑工具记录旧哈希、新哈希和 diff，下一轮只装配修改后的文件与 diff，旧文件退出工作 Context。

第四轮进入验证。单元测试通过，集成测试却显示重试后总时长超过上游 deadline。Context Builder 移除早期代码搜索结果，加入失败测试、deadline 配置和当前 patch。模型调整超时与重试预算，再次运行验证。

最后一轮只保留用户约束、最终 diff、测试证据和未验证项。Agent 可以声称代码与测试满足本地完成条件，但不能证明生产故障已经消失，于是输出部署后的观测建议，而不是写“问题已彻底解决”。

这条轨迹里没有神奇的摘要算法。可靠性来自几件朴素的事：每轮围绕当前决定选材料，文件有版本，大输出可回读，失败尝试被保留，完成声明引用外部证据。

## 九、怎样观察模型当时看到了什么

线上 Agent 出错后，如果日志只保存用户请求和最终回答，团队几乎无法定位 Context 故障。至少要记录每次模型调用的 Context manifest：

```json
{
  "run_id": "run-2048",
  "turn": 7,
  "prompt_version": "coding-v12",
  "model": "pinned-model-snapshot",
  "budget": {"limit": 64000, "input": 41820, "reserved_output": 12000},
  "items": [
    {"id": "rule-1", "kind": "instruction", "mode": "verbatim", "tokens": 820},
    {"id": "file-9", "kind": "artifact", "mode": "excerpt", "version": "sha256:def", "tokens": 3100},
    {"id": "cp-2", "kind": "summary", "mode": "verbatim", "tokens": 960}
  ],
  "excluded": [
    {"id": "search-1", "reason": "stage_complete"},
    {"id": "file-3", "reason": "superseded"}
  ]
}
```

Manifest 不一定保存所有敏感正文，但要能回答：选了哪些材料、版本是什么、为何排除其他候选、是否发生截断或压缩。结合 Artifact 权限，排查者才能重建足够接近当时的输入。

### 指标要测效用，不只测 token

输入 token 数和缓存命中率是成本指标，不能说明 Context 是否正确。评测至少覆盖四类结果：

- 证据召回：完成决定所需的关键事实是否进入 Context；
- 冲突率：同一事实的多个有效版本是否同时出现；
- 引用有效性：模型引用的文件、规则和 Artifact 是否存在且版本匹配；
- 下游结果：任务成功率、错误动作率、重试次数、延迟与成本。

可以对同一批任务比较完整历史、最近 N 轮、阶段摘要和按需检索四种策略。评测时固定模型与工具版本，保存每轮 manifest，否则结果变化无法归因。

Context Builder 本身还可以做确定性单元测试。给定任务状态与候选项，断言权限规则一定保留，过期文件一定排除，大日志变成 Artifact 引用，当前测试失败排在旧搜索结果之前。模型评测负责验证这些选择能否改善行为，单元测试负责防止装配规则意外退化。

## 十、几种策略怎样选择

Context 管理不存在一种覆盖所有任务的方案。任务长度、信息形态和可复查要求会改变选择。

| 策略 | 适合 | 代价与风险 |
| --- | --- | --- |
| 完整历史 | 短对话、信息量小 | 简单；长度增长后噪声与冲突累积 |
| 最近 N 轮 | 最近交互决定下一步 | 会突然丢失早期约束和重要决定 |
| 滚动摘要 | 连续对话和阶段相对清晰的任务 | 摘要误差会逐轮累积 |
| 结构化检查点 | 长任务、需要恢复和审计 | 需要定义 schema 与写入时机 |
| 按需检索 | 大知识库、大仓库 | 检索失败时模型甚至不知道自己漏了什么 |
| 子 Agent 隔离 | 可拆分的探索、研究或 Review | 汇总会损失细节，协调成本更高 |

[Anthropic 的多 Agent Research 复盘](https://www.anthropic.com/engineering/multi-agent-research-system) 把子 Agent 描述成信息过滤器：子任务可以消耗大量独立 Context，主 Agent 只接收压缩后的发现或 Artifact 引用。这个模式适合相对独立的探索方向，不适合共享状态频繁变化、需要细粒度同步的编辑任务。

小型客服问答或单文件改动没有必要先建设复杂的分层记忆。完整历史仍在窗口内、来源单一、没有冲突时，简单方案更容易验证。Context Engineering 的目标是解决已经出现的信息选择问题，不是为每次模型调用增加一套基础设施。

## 十一、常见修补为什么不够

### 每次都附上整个仓库

这会带来高成本、版本冲突和低信号密度。代码库还包含生成文件、依赖、测试数据和历史文档。先提供结构地图，再按当前缺口读取文件，通常更可控。

### 只保留最近几轮

滑动窗口能控制长度，却可能剪掉用户最初的限制。必须长期生效的内容应进入固定契约或结构化任务状态，不能依赖它碰巧还在最近消息里。

### 让模型自己决定删除什么

模型可以提出摘要和保留建议，最终策略仍应由程序控制。权限条款、审计要求和 Artifact 保留期不该随着一次生成结果改变。

### 把摘要当作无损压缩

自然语言摘要会改变粒度，也可能改变含义。高风险事实要保留引用，必要时回读原文；完成条件和权限边界应原文固定或在程序中重复校验。

### 只看上下文窗口是否溢出

很多 Context 故障发生在窗口仍有大量空间时：旧文件与新文件冲突，错误日志淹没用户要求，工具说明相互重叠。容量告警发现不了这些问题。

## 十二、一份可以开始实现的检查表

| 检查面 | 需要回答的问题 |
| --- | --- |
| 当前决策 | 下一次模型调用要做出什么决定？ |
| 固定约束 | 哪些内容必须原文保留，不能被普通摘要覆盖？ |
| 来源 | 每段内容来自用户、内部工具还是外部数据？ |
| 时效 | 文件、规则和业务事实是否仍是当前版本？ |
| 证据 | 重要结论能否回到原始 Artifact 或资源位置？ |
| 预算 | 是否为输出预留空间，哪些区域可裁剪？ |
| 工具结果 | 大输出是否分页、截断并保存完整引用？ |
| 压缩 | 摘要是否保留约束、失败路径、不确定性和未决事项？ |
| 淘汰 | 已完成阶段与被替代内容何时退出工作 Context？ |
| 观测 | 能否还原某一轮选择了什么、排除了什么？ |
| 评测 | 是否同时测试召回、冲突、引用有效性和任务结果？ |

## 结语

Context Engineering 的产物是一套信息生命周期：候选材料来自哪里，哪一轮需要它，以什么形式进入，何时被更新、压缩或淘汰，出错后怎样回到原始证据。

长上下文模型提高了可用上限，也让随手堆积信息的做法能撑得更久。等到问题暴露时，轨迹往往已经充满过期文件、重复工具结果和失真的摘要。把 Context 当成每轮重新构造的运行时视图，Agent 才有机会在长任务里维持同一个目标和同一套事实。

## 参考资料

- [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [OpenAI: Context Engineering - Short-Term Memory Management with Sessions](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory)
- [OpenAI: Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI: Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)
- [LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models](https://arxiv.org/abs/2310.05736)
- [LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression](https://arxiv.org/abs/2310.06839)
