---
title: Claude Code 架构拆解：Query Loop、Compact 与 Memory
description: 以 Anthropic 官方文档为事实边界，结合特定版本的客户端还原资料，拆解 Claude Code 的主循环、上下文装配、五层压缩、自动记忆、工具权限与子 Agent。
category: Agent
subcategory: Agent 产品拆解
articleClass: flagship
seriesOrder: 20
featured: false
publishedAt: 2026-10-01
updatedAt: 2026-10-02
tags: [Claude Code, Agent Harness, Query Loop, Compact, Memory, Context Engineering, SubAgent]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

Claude Code 没有官方开源完整客户端。网上流传的“源码解析”，主要来自特定 npm 版本附带的 source map 及研究者的还原。它能帮助我们理解 Query Loop、Compact 和 Memory 可能怎样组织，但不能当成 Anthropic 承诺长期稳定的内部接口。

所以这篇文章会严格分两层：

- Anthropic 官方文档确认的产品行为，作为事实边界；
- 第三方对特定版本的实现还原，作为实现线索。

代码结构、函数名、阈值和模型选择都可能随版本变化。真正值得学习的，是它们背后的工程取舍。

![Claude Code 的运行时分层](/images/posts/claude-code-runtime-architecture.svg?v=20261001)

## 一、Claude Code 的核心是一条持续循环

Anthropic 官方文档说明，终端、IDE、桌面端、Web 和远程控制共享同一套 agentic loop。界面可以换，任务运行方式基本一致：

```text
用户任务
  ↓
装配当前上下文
  ↓
调用模型并流式读取响应
  ↓
模型请求工具？ ── 否 ──→ 本轮结束
  ↓ 是
检查权限、执行工具、收集结果
  ↓
把结果送回模型，继续下一圈
```

这就是 Claude Code 的 Query Loop。它看上去和 ReAct 很像，都是“判断、行动、观察”的循环。不同之处在于现代模型 API 已经把工具调用变成结构化协议，Harness 不必从普通文本里用正则提取 `Action:`。

模型输出可能包含文本增量、工具请求、停止原因和其他事件。循环的职责，是把这些事件解释为下一次状态转移。

## 二、先画出运行时的五层

从官方行为和第三方还原资料交叉来看，可以用五层理解 Claude Code。

| 层 | 负责什么 | 典型内容 |
| --- | --- | --- |
| 交互层 | 接收任务、显示过程、处理批准 | Terminal、IDE、Desktop、Web |
| Query 层 | 维护会话并推进模型循环 | stream、tool use、end turn、interrupt |
| Context 层 | 决定模型这一轮看见什么 | System Prompt、CLAUDE.md、Skills、Memory、MCP |
| Tool 层 | 把模型意图变成环境操作 | Read、Edit、Bash、Grep、Task、MCP |
| Governance 层 | 控制副作用与生命周期 | Permission、Sandbox、Hooks、Checkpoint、JSONL |

这五层是本文为了理解职责做的工程划分，并非 Anthropic 的官方模块命名。用这张图看系统，会比一句“Prompt 很长”更接近真实工作量。

Claude Code 的 Harness 同时管理输入和输出。输入侧控制规则、历史、工具定义和上下文预算；输出侧控制工具是否可执行、在哪里执行、失败怎样回传，以及是否允许恢复。

## 三、Query Loop：一轮对话怎样跑起来

第三方还原资料把主查询过程描述为异步生成器。这个形态与产品体验很吻合：文本、工具进度和结果可以边产生边交给 UI，而不必等整个任务结束。

抽象后的循环大致是：

```ts
async function* query(state) {
  while (!state.finished) {
    state = await prepareContext(state);
    const stream = model.stream(state.messages, state.tools);

    for await (const event of stream) {
      yield event;
      if (event.type === "tool_use") {
        const result = await runToolWithPolicy(event);
        state.messages.push(result);
      }
      if (event.type === "end_turn") {
        state.finished = true;
      }
    }
  }
}
```

这不是 Claude Code 原始源码，只是忠于行为的伪代码。真正实现还要处理取消、重试、工具并行、后台任务、Prompt Cache、Compact、Hooks 和会话写盘。

### 为什么异步流适合 Agent

普通聊天可以等一个完整答案，编程任务不行。一次任务可能运行十分钟，期间会产生许多不同类型的事件：

- 模型文本；
- 工具调用；
- 权限询问；
- 命令输出；
- 子 Agent 进度；
- 压缩与重试；
- 最终完成或失败。

异步流让 Query 层只负责推进状态，界面自行决定怎样展示。终端可以逐行打印，IDE 可以渲染 diff，桌面端可以把审批做成卡片。

### `tool_use` 与 `end_turn` 是两个关键分支

模型返回 `tool_use` 时，本轮并没有结束。Harness 需要执行工具，把 `tool_result` 加回历史，再次调用模型。只有模型给出最终响应并进入 `end_turn`，Query Loop 才能退出。

因此用户看到的一次请求，内部通常包含多次模型采样。把“用户回合”和“模型请求”混为一谈，会让指标、恢复和预算统计全部变乱。

## 四、Context Assembly：模型每一步究竟看见什么

Anthropic 官方文档列出的上下文来源不少：

```text
System Instructions
+ 当前用户请求
+ 会话历史与工具结果
+ CLAUDE.md / AGENTS.md
+ .claude/rules 中匹配的规则
+ 已加载 Skills
+ Auto Memory
+ MCP 工具与外部信息
+ 运行环境和 system-reminder
```

这些内容不是同一种数据，也不该有同一个生命周期。

**项目规则是确定性输入。**

构建命令、代码规范、禁止修改的目录和验收方式，应该写进 `CLAUDE.md`、`AGENTS.md` 或条件规则。它们由人维护，适合稳定、可审查的约束。

项目越大，越不能把所有规则一次性塞进 Prompt。Claude Code 支持在 `.claude/rules/` 中按路径匹配规则。只有任务触及对应文件时，前端或后端规范才进入上下文。

**Skills 是按需知识。**

会话开始时，模型只需要知道有哪些 Skill 及其用途。选中某个 Skill 后再加载完整说明。这个两阶段设计很重要：

```text
常驻：名称 + 简介
按需：完整方法、参考资料与脚本
```

它既节省窗口，也让专业知识保留独立版本和维护边界。

**System Reminder 是运行时信息。**

有些信息不适合写进用户消息，也不是永久系统规则，例如权限变化、记忆老化提示或任务状态。运行时可以用明确的提醒块注入，告诉模型这是系统提供的环境事实，而不是用户刚刚说的话。

## 五、工具调用：Query Loop 不直接执行一切

模型生成工具请求后，Harness 仍需完成四步：

1. 校验工具名和参数；
2. 判断是否需要权限确认；
3. 在本地、沙箱或远程环境执行；
4. 把结构化结果写回会话。

Claude Code 官方文档把 Permissions 与 Sandbox 分开。前者表达用户授权，后者限制 Bash 能访问的文件系统和网络。Hooks 又提供一组生命周期扩展点，可以在工具调用前后检查、补充或拒绝操作。

```text
模型请求 Bash
     ↓
PreToolUse Hook
     ↓
Permission Decision
     ↓
Sandboxed Execution
     ↓
PostToolUse Hook
     ↓
tool_result 回到 Query Loop
```

Checkpoint 解决另一类问题：操作已经被允许并执行，但用户想撤回 Agent 的文件改动。权限、防护和回滚分别应对事前授权、执行边界与事后恢复，不能只靠一个“自动模式”覆盖。

官方 Agent SDK 文档把权限评估顺序写得更具体：先运行 Hooks，再检查拒绝规则，然后应用当前权限模式，接着检查允许规则，仍未决时才进入交互式回调。这个顺序带来两个重要结果。第一，`allow` Hook 不能覆盖后续的明确拒绝；第二，所谓自动批准模式也不该越过组织设置的拒绝规则。权限系统不是一张平铺规则表，而是一条有优先级的决策管线。

子 Agent 的权限继承也值得单独检查。父会话进入高权限模式后，子 Agent 可能继承相同模式，但它拥有不同的 System Prompt 和更窄的任务上下文。把高权限无条件传给所有委派任务，会把“主 Agent 值得信任”错误地等同于“每个子任务都需要完整访问”。设计自己的 Harness 时，权限应作为委派契约的一部分显式收窄。

## 六、上下文为什么会爆

编程任务里，工具输出往往比用户输入更占窗口。

模型读一个大文件、搜索几十处引用、跑一轮测试，再让子 Agent 返回探索结果，几轮下来就会积累大量 `tool_use` 和 `tool_result`。其中很多内容已经完成使命，但仍然留在历史里。

常见处理办法各有问题：

- 滑动窗口会把早期关键决定一起丢掉；
- 定期摘要可能压掉具体文件和错误细节；
- 向量检索无法稳定恢复严格的时间顺序；
- 无差别截断可能破坏工具调用与结果配对。

Claude Code 用多层减压处理这个问题。官方文档确认它会先清理旧工具输出，再在需要时总结会话。第三方对特定版本的还原则展示了更细的五层管线。

![Claude Code 特定版本中的五层上下文压缩](/images/posts/claude-code-compact-pipeline.svg?v=20261001)

## 七、Compact 的五层防线

下面的层级、阈值和顺序来自第三方对特定版本的还原，只适合当作实现线索。版本升级后完全可能变化。

### 第一层：巨型工具结果先落盘

超大的文件内容或命令输出不适合原样塞进消息。还原资料显示，某些大结果会持久化到磁盘，当前上下文只保留预览和引用。

这层没有改变语义，只改变承载方式。模型知道“还有更多内容”，需要时可以继续读取，而不是误以为预览就是全部结果。

### 第二层：模型协助清除已无价值的片段

在被还原的版本中，模型可以标记早期消息或工具内容，运行时再清理对应片段。清理依据来自当前推理对信息价值的判断，不只看字符长度。

这类机制的风险是模型可能判断错，所以应该优先处理可重建内容，而不是用户决定和任务约束。

### 第三层：Micro-Compact 清理可重建输出

在完整摘要之前，系统先回收旧的、可重新获取的工具输出，例如早期文件内容和日志，同时保留较新的观察。

被还原版本中特别保护了子 Agent 或 Task 结果，因为那类结果可能是昂贵探索的唯一结论。这个取舍很值得借鉴：能重新 `grep` 的内容可以丢，经过独立研究才得到的结论不能随手裁掉。

### 第四层：Context Collapse 的实验性投影

还原文章还提到一种接近窗口上限时的读取投影机制。它不一定进入所有公开版本，也可能被 feature flag 控制。我们更应该关注设计动机：尽量在不重写整段历史的前提下，暂时排除低价值内容。

由于这一层缺少官方承诺，不能把它写进依赖稳定行为的集成方案。

### 第五层：Auto-Compact 全量摘要

当前面几层仍然不够，系统才做完整 Compact。它读取现有会话，生成结构化摘要，用更小的新历史继续工作。

在被还原的版本里，摘要会覆盖这些信息：

- 用户的原始需求；
- 关键技术概念；
- 读过或修改过的文件；
- 遇到的错误与修复；
- 已做的判断；
- 所有用户消息；
- 未完成任务；
- 当前工作位置；
- 可选的下一步。

这比“总结上面的聊天”严格得多。Compact 是一次状态迁移，需要为后续 Agent 留下可执行的接力棒。

## 八、Compact 后为什么还能继续干活

完整压缩会丢弃早期消息。要继续工作，系统还需要重建一些不能只靠摘要承载的内容。

**项目规则重新加载。**

`CLAUDE.md` 不必永久塞进摘要。它是磁盘上的权威规则，下一轮可以重新发现并加载。这样项目规则更新后，Agent 读到的是新版本，而不是摘要里的旧副本。

**当前文件按预算恢复。**

还原资料显示，Compact 后可能重新附加少量关键文件，并受单文件和总 token 预算限制。完整历史没有回来，但最可能继续编辑的文件仍在手边。

**子任务和后台任务重新挂接。**

异步任务、子 Agent 状态和工具环境不能只变成一句自然语言。运行时需要重新附加结构化状态，确保下一轮知道哪些任务仍存在。

**手动 Compact 与自动 Compact 目标不同。**

用户执行 `/compact` 时，可以给出希望保留的重点。自动 Compact 更强调无交互继续运行，不能突然向用户追问摘要偏好。

这再次说明，压缩属于 Harness，不是一个孤立 Prompt 技巧。

## 九、Memory 不是历史对话的另一个名字

短期上下文与长期记忆要分开。

- Context 保存当前任务正在发生什么；
- Compact 让当前任务在有限窗口中续航；
- Memory 保存跨会话仍有价值的信息。

Anthropic 官方文档把 Auto Memory 分为四类：

| 类型 | 适合保存什么 | 例子 |
| --- | --- | --- |
| `user` | 用户背景与能力 | 熟悉 Java，但刚开始使用 Rust |
| `feedback` | 用户确认过的偏好与纠正 | 提交前必须运行集成测试 |
| `project` | 无法从仓库直接推导的项目动态 | 某日期以后进入冻结期 |
| `reference` | 外部信息在哪里 | 某类故障去哪个看板查 |

官方文档同时强调，不应把代码模式、文件路径、Git 历史和当前任务状态随意存成长期记忆。它们可以从真实仓库重建，旧副本反而会变成“看起来权威的错误”。

![Claude Code 自动记忆的写入与召回闭环](/images/posts/claude-code-memory-loop.svg?v=20261001)

## 十、静态规则与动态记忆是两条线

### `CLAUDE.md` 管确定性规则

这类内容由人主动维护：项目怎样构建、代码风格是什么、哪些目录不能修改。它类似团队手册，应该可读、可审查、可纳入版本控制。

不同作用域可以承载组织、用户、项目和本地规则。条件规则还能根据当前文件路径按需注入，避免所有规范一起占用窗口。

### Auto Memory 管交互中学到的事实

这类内容来自使用过程，例如用户反复纠正的偏好、项目的非代码动态、外部资料指针。它具有不确定性，使用前需要考虑是否已经过期。

两者不能互相替代。把团队强制规则交给自动记忆，意味着规则可能漏写；把所有个人偏好都写进项目 `CLAUDE.md`，又会污染团队仓库。

## 十一、被还原版本中的 Memory 写入与检索

下面继续使用第三方实现线索，不把具体细节视为官方稳定接口。

**每条记忆独立成文件，索引常驻。**

还原资料显示，每条记忆可以保存为带 frontmatter 的 Markdown 文件，目录中的 `MEMORY.md` 充当索引。

```text
MEMORY.md       常驻索引，只描述“有哪些记忆”
user-role.md    完整内容，按需读取
no-mock.md      完整内容，按需读取
release-date.md 完整内容，按需读取
```

这个设计在两个极端之间取得平衡：所有正文常驻会浪费 token，完全不暴露索引又让模型不知道有什么可用。

**写入交给独立抽取过程。**

还原文章描述了一个在主 Query 完成后触发的记忆抽取过程。它扫描本轮对话，判断是否出现新的用户信息、纠正、项目事实或引用，再与现有记忆去重。

把写入与主任务分开有两个好处：主模型不必一边修代码一边思考该记什么；记忆 schema 也能由专门流程严格执行。

**小模型从索引中做选择。**

在被还原版本中，检索不依赖向量数据库。系统扫描记忆文件的头部描述，再让模型从候选列表里选择少量相关文件。

这不代表向量检索没有价值。候选只有几十到几百条、描述质量高时，LLM 选择器可解释、好调试；候选达到百万级，多阶段检索仍然必要。

**老记忆要带时间意识。**

还原资料显示，较旧记忆在注入时会附带提醒，要求模型在行动前验证。具体天数属于版本细节，原则更重要：记忆是历史快照，不是当前真相。

如果记忆里提到文件、函数或 feature flag，使用前应重新搜索。这个规则能够减少最危险的记忆错误，也就是模型坚定地相信一个已经过期的事实。

## 十二、为什么它没有把一切都交给向量数据库

向量检索擅长从大规模语料中找语义相近内容，但长期记忆不只有“相似度”问题。

```text
写入：这条信息值不值得永久保存？
类型：它是用户事实、行为反馈还是项目动态？
时效：它今天还成立吗？
冲突：新记忆和旧记忆谁更可信？
解释：为什么这条记忆被召回？
```

当候选集合不大时，结构化文件与 LLM 选择器可以把这些判断显式化。文件可读、可编辑、可删除，索引出错也容易定位。

但这并不是普适结论。大型组织知识库、海量对话或跨用户检索仍然适合倒排、向量和图检索。Claude Code 的场景是个人或项目级编程助手，候选规模和可维护性比搜索吞吐更重要。

## 十三、子 Agent 为什么能减轻主上下文

Anthropic 官方文档说明，Subagent 拥有自己的上下文窗口、System Prompt、工具和权限。它可以从新上下文开始，也可以从主会话 fork。

主 Agent 不需要接收子 Agent 的每一条 `grep` 和文件内容，只收最终结论。这样做同时获得两种收益：

1. 探索过程不挤占主窗口；
2. 不同任务可以使用不同工具和权限边界。

子 Agent 不是免费的。委派提示不清楚时，它会重复主任务已经做过的搜索；结果摘要过短时，又会丢掉证据。好的委派要写清目标、输出格式、可用工具和验收条件。

官方扩展能力总览把 Subagent 描述为“在隔离上下文中运行自己的循环并返回摘要”。这个边界很关键：子 Agent 解决的是上下文隔离和职责分工，Agent Team 才进一步引入独立会话、共享任务与点对点消息。若工作只有一条强依赖链，把它拆成多个 Agent 往往增加交接成本；若多个探索分支能独立产出证据，隔离上下文才会真正节省主窗口。

## 十四、Hooks、Permissions、Sandbox 与 Checkpoint

这四套能力经常被混成一个“安全系统”，它们实际解决四类不同问题。

| 机制 | 时间点 | 解决的问题 |
| --- | --- | --- |
| Hooks | 生命周期前后 | 插入检查、格式化、审计或上下文 |
| Permissions | 操作之前 | 用户是否允许这类动作 |
| Sandbox | 执行期间 | 进程物理上能访问什么 |
| Checkpoint | 修改之后 | 怎样撤回 Agent 文件变更 |

Hooks 可以阻止危险命令，却不是不可绕过的操作系统隔离。Sandbox 能限制文件和网络，却不知道用户是否愿意发布一条消息。Checkpoint 能恢复代码，但不一定能撤销已经发送到外部系统的副作用。

可信 Harness 需要把这几层组合起来，而不是让一个“全自动”开关承担全部责任。

Hooks 和 Skills 也不应混用。官方文档的区分很实用：Hook 在生命周期事件上确定触发，适合格式化、阻断危险命令、记录审计；Skill 由模型根据描述选择并解释执行，适合需要推理的工作流与参考知识。把“每次编辑后必须运行格式化”只写进 Skill，会留下漏触发概率；把“怎样排查一次复杂线上故障”硬编码成 Hook，又失去了模型判断空间。

## 十五、一次长任务怎样跨过 Compact 继续执行

假设用户要求把一个旧的鉴权中间件迁移到新接口，同时保持三种登录方式兼容。Claude Code 先读取入口、类型定义和测试，随后让子 Agent 调查历史兼容逻辑。主会话又运行完整测试，得到数千行日志，窗口迅速接近阈值。

在压缩前，运行时应先判断哪些信息能重建。早期文件全文可以再次读取，成功测试的大段日志只需保留命令和退出状态，失败堆栈则要留下首个根因与相关用例。子 Agent 的调查结论不能只保留“已研究”，至少要留下涉及的入口、兼容分支和证据文件。用户明确要求“保留三种登录方式”属于任务约束，优先级高于任何可重读内容。

候选摘要可以写成结构化接力状态：

```yaml
goal: migrate auth middleware without removing password, SSO, or token login
decisions:
  - keep legacy token decoder behind compatibility adapter
  - do not change public session schema
changed_files:
  - src/auth/middleware.ts
  - src/auth/compat.ts
evidence:
  - unit tests passed before integration change
  - SSO integration still failing at callback fixture
unresolved:
  - confirm whether expired legacy tokens should map to 401 or 403
next:
  - inspect callback fixture
  - rerun auth integration suite
```

完成 Compact 后，项目规则从磁盘重新加载，关键文件按预算再次读取，仍在运行的后台任务通过结构化句柄挂回会话。下一次模型请求看到的是一份较短但可执行的状态，而不是一段文学化总结。它先检查工作区和测试现状，再继续处理 SSO 用例，避免把摘要中的“当时事实”误当成当前事实。

任务结束后，只有跨会话仍有价值且无法从仓库直接推导的信息才进入 Auto Memory。例如用户确认“兼容期内 401/403 语义不能变”若是团队长期约束，更适合写进项目规则或测试；“今天集成环境证书过期”只是临时状态，不应永久记忆；“用户希望所有迁移先给兼容矩阵”则可能成为反馈类记忆。

这个例子把 Context、Compact、Memory 的边界连在一起：Context 服务当前循环，Compact迁移当前状态，Memory 选择少量长期经验。三者共享信息，却承担不同保存期限和验证责任。

## 十六、从 Claude Code 里能抄走什么

**先按生命周期管理上下文。**

项目规则、当前观察、临时日志和长期记忆不能混成一坨。它们应该有不同的来源、更新方式和淘汰策略。

**先裁剪可重建信息。**

旧文件内容和日志可以再次读取，用户决定和昂贵探索结论不容易恢复。Compact 的第一原则应是可重建性，而不是字符长度。

**Compact 要输出接力状态。**

摘要必须包含目标、文件、错误、决定、未完成事项和下一步。它要给下一轮 Agent 提供运行状态，写法和面向人的会议纪要不同。

**长期记忆先约束写入。**

记忆系统的问题常常不在召回算法，而在垃圾信息被永久写入。限定类型、要求原因和应用条件，比盲目更换 Embedding 更重要。

**索引常驻，正文按需。**

这种两阶段加载不只适合 Memory，也适合 Skills、工具文档和大型知识库。模型先知道“有什么”，再为真正需要的内容支付 token。

**记忆必须允许怀疑。**

注入时间、来源和验证建议，让模型知道这是一份历史快照。Agent 应该先对照当前代码与外部事实，再依据记忆行动。

## 十七、哪些结论不要从逆向文章里照搬

第三方还原资料很有价值，但使用时要给每条结论标注置信度。

```text
官方文档公开说明                高置信，可作为产品行为
界面与日志可以稳定复现          中高置信，可描述现象
source map 中的具体函数和常量    中置信，只代表特定版本
作者对设计动机的推断            低到中置信，需要明确是分析
```

尤其不要把某个 token 阈值、模型名称、内部函数名或 feature flag 写成长期稳定承诺。真正适合沉淀进架构文章的，是多层减压、索引与正文分离、记忆老化和独立上下文这些设计原则。

版本变化还会使“已经观察到”和“产品保证”之间出现缝隙。文档明确说明 `/compact` 会总结并释放上下文，可以作为稳定行为；环境变量暴露的自动压缩窗口，只说明当前客户端提供相关控制，不代表内部每层算法长期不变；source map 中的函数名和常量只能标注到被还原版本。读者据此实现集成时，应依赖公开命令与配置，避免把逆向细节当 API。

## 十八、最后：Claude Code 管的是信息的生命周期

Query Loop 只是骨架。Claude Code 的工程价值，在于它不断回答四个问题：

1. 这一轮模型应该看见什么；
2. 哪些内容可以从上下文移走；
3. 哪些经验值得跨会话保存；
4. 模型的动作怎样受到权限、沙箱和生命周期控制。

Agent 工程可以概括为管理模型每一步看见的信息，并在概率模型的不确定性之上构建可信系统。Claude Code 的 Compact 和 Memory 正好展示了这句话的两面：当前任务需要在有限窗口里续航，长期经验又不能变成一堆过期但权威的错误。

## 参考资料

- [Anthropic：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Anthropic：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Anthropic：Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Anthropic：Security](https://code.claude.com/docs/en/security)
- [Anthropic：Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide)
- [Anthropic：扩展能力总览](https://code.claude.com/docs/en/features-overview)
- [Anthropic Agent SDK：权限评估顺序](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Anthropic：内置命令与 Compact](https://code.claude.com/docs/en/commands)
- [小林面试笔记：Claude Code 源码拆解](https://xiaolinnote.com/claudecode/source/cc_source.html)
- [小林面试笔记：Claude Code Compact 压缩机制](https://xiaolinnote.com/claudecode/source/cc_compact.html)
- [小林面试笔记：Claude Code 记忆机制](https://xiaolinnote.com/claudecode/source/cc_memory.html)
