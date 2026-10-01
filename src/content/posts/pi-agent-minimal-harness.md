---
title: Pi Agent：一个 Agent Harness 最小可以小到什么程度
description: 从 Pi 的 Agent Loop、统一模型接口、工具契约、消息队列和扩展系统出发，理解一个可用 Agent 最少需要哪些运行时能力。
category: Agent
subcategory: Agent 前沿
featured: false
publishedAt: 2026-10-01T20:05:00+08:00
updatedAt: 2026-10-01
tags: [Pi Agent, Agent Harness, Agent Loop, Tool Calling, Context Engineering]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

我在拆 Codex 和 Claude Code 时，经常遇到一个阅读障碍：成熟产品把协议、权限、沙箱、任务恢复、界面和云端服务都堆在了一起。它们很适合研究工业级 Agent，却不适合回答一个更基础的问题：一个 Agent Harness 最少要有什么？

Pi 给了一个很干净的观察入口。它的官方仓库把模型接口、Agent Runtime、Coding Agent 和终端 UI 拆成独立包。我们可以先读两百行循环，再逐步加上真实系统需要的状态、事件和扩展，而不用先理解一个完整产品。

本文讨论的是 [Pi 官方仓库](https://github.com/earendil-works/pi)中的运行时设计，不是安装教程。Pi 的包名和仓库归属近期发生过变化，文中的结构以 `earendil-works/pi` 当前源码为准。

![Pi 从模型接口到终端应用的最小分层](/images/posts/pi-minimal-harness.svg?v=20261001)

## 一、先给 Harness 划一条边界

大模型只能接收输入并生成输出。它不会自己读取仓库，也不知道一条 shell 命令是否成功，更不会在工具执行完以后主动开始下一轮推理。

Harness 是包在模型外面的程序。它完成四件事：

1. 把当前任务、历史消息和工具说明组装成模型输入；
2. 解析模型返回的文本或工具调用；
3. 在真实环境中执行工具，把结果写回上下文；
4. 判断下一轮继续、暂停、转向还是结束。

最小循环可以压缩成下面这段伪代码：

```ts
while (true) {
  const response = await model.stream({ messages, tools });
  messages.push(response.message);

  if (response.toolCalls.length === 0) break;

  const results = await executeTools(response.toolCalls);
  messages.push(...results);
}
```

这段代码已经具备 Agent 的基本形状。真正的工程问题藏在每个名词里：`messages` 能否直接交给不同模型，工具是否允许并发，用户中途追加消息怎么办，执行失败应该抛异常还是返回一段文本，流式事件又怎样交给 UI。

Pi 的价值是把这些问题放在一个相对克制的核心里处理。

## 二、Pi 的四层结构

Pi 当前仓库包含多组包。理解 Harness 时可以先看四个：

| 包 | 责任 | 不应该负责什么 |
| --- | --- | --- |
| `pi-ai` | 统一多家模型的请求、响应、流式事件与用量 | 不决定任务什么时候结束 |
| `pi-agent-core` | Agent Loop、消息状态、工具调用与事件 | 不直接实现代码编辑产品 |
| `pi-coding-agent` | 文件、命令、会话、扩展和交互命令 | 不重新实现模型协议 |
| `pi-tui` | 终端组件、输入与增量渲染 | 不掌握 Agent 业务状态 |

这组拆分很重要。很多 Agent 项目一开始把所有逻辑写在聊天界面里：按下回车后请求模型，看到工具调用就执行命令，再把 stdout 拼回消息。功能增加以后，模型适配、状态推进和 UI 更新会互相引用，最后无法在另一种界面或服务端复用。

Pi 把 Agent Loop 放在 `pi-agent-core`，Coding Agent 只是它的一种产品化装配。要做研究助手、聊天机器人或自己的后台 Agent，可以继续使用同一个循环，换掉工具和界面。

## 三、统一模型接口解决了什么

不同模型提供商都支持文本和工具调用，但接口并不真正相同。差异至少包括：

- 工具参数和 schema 的限制；
- 流式事件的类型与顺序；
- 推理内容如何表达；
- token、缓存和费用数据；
- 工具结果应该怎样回传；
- 中断和错误如何暴露。

`pi-ai` 把这些差异归一成模型、上下文、工具和事件流。Agent Loop 因此不需要到处判断当前连接的是哪一家模型。

这种统一不是把所有供应商压成一个最小公分母。好的模型适配层应该提供稳定的公共语义，同时允许调用方传递少量模型专属选项。否则统一接口虽然好看，却会丢掉推理强度、缓存或原生工具等真正影响结果的能力。

Pi 还允许会话中切换模型。这里有一个容易忽略的问题：历史消息已经带有上一家模型的格式和内容块。切换不能只改一个模型名称，还要把 transcript 转换成新模型能够理解的上下文。模型抽象最终管理的是整段对话协议，不只是 HTTP 地址。

## 四、Agent Loop 管理的是状态推进

Pi 在低层暴露 `agentLoop()` 和 `agentLoopContinue()`，上层则提供带状态的 `Agent` 类。[官方 Agent Core 文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)明确区分了两种使用方式。

低层循环适合嵌入自己的运行时。调用方传入：

```ts
const context = {
  messages: [],
  tools: [readFile, writeFile, bash],
};

const config = {
  model,
  convertToLlm,
  toolExecution: "parallel",
  beforeToolCall,
  afterToolCall,
};
```

循环产生事件流，调用方自己决定怎样保存和呈现。`Agent` 类则继续管理消息、队列和生命周期，在关键步骤提供一致的事件屏障。

所谓状态推进，不只是向数组追加消息。一次运行可能处于下面这些状态：

```text
等待用户输入
→ 请求模型
→ 接收增量输出
→ 发现一批工具调用
→ 工具预检
→ 串行或并行执行
→ 收集结果
→ 处理 steering / follow-up
→ 再次请求模型或结束
```

如果这些状态没有明确边界，很多偶发问题会很难解释。例如用户在命令执行时追加了一句“不要改配置文件”，这条消息应该立刻打断当前批次，还是等工具完成后进入下一轮？再如两个工具并行执行，其中一个返回了终止信号，是否应该取消另一个？这些都不是 Prompt 能解决的问题。

## 五、工具契约比工具数量重要

一个工具至少需要名称、描述、参数 schema 和执行函数。Pi 的工具执行函数还能接收取消信号与增量回调，因此长任务可以持续报告进度，也可以被中止。

```ts
const readFile = {
  name: "read_file",
  label: "Read File",
  parameters: Type.Object({ path: Type.String() }),
  async execute(callId, params, signal, onUpdate) {
    // 成功时返回结构化内容，失败时抛出异常
  },
};
```

官方文档强调失败时抛出异常，不要把 `Error: file not found` 伪装成普通成功文本。Runtime 会把异常转成带 `isError: true` 的工具结果交给模型。这个选择看起来很小，却决定了模型能不能稳定区分“工具正常返回了一段报错日志”和“工具本身执行失败”。

Pi 还提供 `beforeToolCall` 与 `afterToolCall`。它们可以承担：

- 参数校验和路径限制；
- 危险操作确认；
- 调用日志与耗时统计；
- 结果裁剪或敏感信息过滤；
- 根据结果决定是否终止当前批次。

Hook 不应变成散落的业务逻辑。它更适合处理跨工具一致的策略。工具自己的领域规则仍应留在工具实现内部。

## 六、steering 和 follow-up 是两种输入

长任务运行时，用户不会一直安静等待。Pi 将中途输入区分成 steering 与 follow-up。

Steering 用来改变正在进行的任务，例如“先别改代码，查一下调用链”。它需要尽快进入循环，影响下一步动作。Follow-up 更像排队的新任务，要等当前工作没有待执行工具和 steering 后再处理。

这个区分让 Agent 从一问一答的聊天框变成可操纵的进程。若所有新消息都直接追加到同一个数组，模型可能在工具结果尚未回传时看到一条位置错误的用户消息，甚至破坏工具调用协议。Runtime 必须决定消息何时进入 transcript。

## 七、Session 保存的是可继续的过程

[Pi 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/index.md)支持继续和分叉 Session。Session 的意义不只是保存最终对话。一个可恢复会话至少要保留：

- 原始用户消息和模型消息；
- 工具调用及其结果；
- 使用过的模型和配置；
- 压缩后的历史摘要；
- 分支与父会话关系；
- 可能影响后续行为的扩展状态。

分叉尤其适合开发任务。我们可以在同一段历史上尝试两种修复方案，而不是复制粘贴上下文。它也说明 transcript 本身是一份运行记录，不能只保留渲染后的纯文本。

## 八、扩展系统为什么是 Pi 的另一半

Pi 的核心很小，但并不追求功能少。它把大量能力移到扩展、Skills、Prompt 模板、主题和安装包中。一个 Pi Package 可以同时分发这些资源，再通过 npm、Git 或本地目录安装。

这种设计与“把所有功能合进主仓库”相比，有三个直接效果：

1. Agent Loop 保持稳定，领域能力独立演进；
2. 项目可以只加载需要的资源，减少上下文和攻击面；
3. 用户能修改 Harness 的行为，而不必维护整个项目的 fork。

扩展能力越强，信任边界越重要。Pi 项目级包要在工作区获得信任后才会加载，这背后是一个明确事实：扩展不是一段给模型看的说明，它可能是在本机执行的代码。

## 九、Pi 没有替我们解决什么

Pi 证明了最小 Harness 可以很清楚，但“清楚”不等于“天然可靠”。把它放进生产系统，还需要补齐：

- 操作系统级沙箱和更细的权限模型；
- 多租户隔离与密钥管理；
- durable execution、任务重试和崩溃恢复；
- 统一 tracing、成本归因和质量评测；
- 高风险动作的审批与审计；
- 工具版本和 Session schema 的迁移。

这些能力没有必要全部进入 Agent Core。Pi 更像一块干净的运行时底板，适合学习、嵌入和改造。成熟产品会在它所展示的最小循环之外继续增加边界，但最核心的状态机并没有变。

## 十、从 Pi 得到的设计检查表

自己实现 Agent Harness 时，可以先回答下面的问题：

| 问题 | 最小可用答案 |
| --- | --- |
| 模型差异放在哪里 | 独立 provider 适配层 |
| 谁持有消息状态 | Agent Runtime，而非 UI |
| 工具失败怎样表达 | 结构化错误，不混入成功文本 |
| 用户怎样干预长任务 | 区分 steering 与 follow-up |
| 长输出怎样呈现 | 事件流和增量更新 |
| 会话怎样继续 | 保存原始 transcript 与运行配置 |
| 能力怎样扩展 | 稳定 Core 加显式扩展边界 |
| 扩展是否可信 | 项目信任、权限与执行隔离 |

Pi 最值得借鉴的不是某个 TypeScript API，而是它对边界的克制：模型接口负责模型差异，Agent Core 负责循环，产品层负责工具和会话，UI 只负责交互。先把这四层分开，后面的权限、评测和长期任务才有地方安放。

## 参考资料

- [Pi 官方仓库](https://github.com/earendil-works/pi)
- [Pi Agent Core 文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Pi Coding Agent 文档](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
- [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
