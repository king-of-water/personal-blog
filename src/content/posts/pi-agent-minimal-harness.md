---
title: Pi Agent：一个 Agent Harness 最小可以小到什么程度
description: 沿 Pi 的公开源码拆解一个可用 Agent Harness 的必要组成部分：统一模型接口、Agent Loop、消息模型、工具契约、steering 队列、会话树与扩展边界，并回答哪些责任必须留在运行时之外。
category: Agent
subcategory: Agent 前沿
articleClass: flagship
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

研究 Agent 时，我常遇到一个阅读障碍。工业级产品把协议、审批、沙箱、任务恢复、界面和云端服务堆在一起，很难从中读出"一个 Agent 到底靠什么跑起来"。Pi 提供了一个相反的入口：它把 Harness 拆到足够小，小到我们可以顺着一个循环，看清哪些部分是模型做不了的，哪些责任无论如何都必须留在程序里。

这篇文章想回答一个具体问题：一个可用的 Agent Harness 最小需要什么，又有哪些东西永远不该塞进核心循环。它不介绍 Pi 怎么安装、怎么配置模型，而是把 Pi 当成一份运行时教材来读。证据来自 [Pi 官方仓库](https://github.com/earendil-works/pi)的公开源码、README 和[官方文档](https://pi.dev/docs/latest)，范围限定在本地 CLI 及其可复用的运行时，不包括模型内部和任何托管服务。Pi 的包名与仓库归属近期发生过变化，文中的结构以 `earendil-works/pi` 当前代码为准。

![Pi 从模型接口到终端应用的最小分层](/images/posts/pi-minimal-harness.svg?v=20261001)

## 先看结论

Pi 把 Agent 拆成四层，每层只承担一类变化。模型接口负责供应商差异，Agent Core 负责循环和状态，Coding Agent 负责把运行时装配成产品，终端 UI 只负责交互。

| 层 | 责任 | 缺少它时会怎样 |
| --- | --- | --- |
| 模型接口 | 归一多家 LLM 的请求、流式事件与用量 | Loop 里到处写 `if (provider === 'openai')` |
| Agent Core | 维护消息状态，驱动"调用模型、执行工具、再调用模型"的循环 | 你手动在终端和对话框之间复制结果 |
| Coding Agent | 提供文件、命令、会话和扩展 | 运行时有了，却写不了代码、恢复不了进度 |
| 终端 UI | 增量渲染流式输出、读取输入 | 界面逻辑和业务状态互相缠绕 |

Pi 的贡献不是功能最多，而是把 Harness 必须解决的几件事分层放好，让循环可以被单独读懂、单独替换、单独嵌入别的程序。理解了这四层的边界，也就理解了为什么它被称作"最小 Harness"，以及哪些能力它刻意不提供。

后面正文会依次展开：先定义 Harness 到底解决什么问题，再读仓库地图，然后沿模型接口、Agent Loop、消息模型、工具契约、steering 与 follow-up、会话树、扩展系统一路拆下去，最后用一个真实任务把整条链路串起来，并说清楚 Pi 没有替我们解决的部分。

## 一、先给 Harness 划一条边界

大模型一次调用只做一件事：根据当前输入生成下一段内容。内容可以是回答，也可以是对工具的调用请求。它不会主动打开文件，不知道一条 shell 命令是否成功，也不会在工具执行完之后自己开始下一轮推理。

Harness 是包在模型外面的程序。它至少要做四件事：

1. 把任务、历史消息和工具说明组装成模型输入；
2. 解析模型返回的文本或工具调用；
3. 在真实环境中执行工具，把结果写回上下文；
4. 判断下一轮该继续、暂停、转向，还是结束。

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

这段代码已经具备 Agent 的基本形状，但每个名词背后都藏着真正的工程问题。`messages` 能不能直接交给另一家模型？工具是并发执行还是串行执行？用户在流式输出进行到一半时补了一条消息，它应该插在哪里？执行失败该抛异常，还是返回一段文本让模型猜？流式事件又怎样交给界面，而不是等模型说完才一次性渲染？

Pi 的价值不在这些问题的答案有多么独特，而在于它把答案集中在一个克制的核心里，让这些问题各自落在明确的层上。

聊天模型给出一段错误建议，用户可以不采用。Agent 拿到工具以后，建议会变成真实动作：文件被覆盖、分支被推送、通知被发送、数据库被修改。一次文本生成失败通常可以重新请求，一次外部动作超时却可能已经在远端生效。

因此工具调用至少要区分三种状态：明确成功、明确失败、结果未知。结果未知常见于客户端超时或进程崩溃。此时继续重试可能重复扣款、重复部署或重复发消息。可靠系统需要幂等键、执行回执或状态查询，先核实外部世界发生了什么，再决定下一步。这条责任从一开始就属于 Harness，不属于模型。

### 模型做不了的，正是 Harness 的职责

连续对话看起来像模型记得上一轮，实际是运行时把历史重新放进了输入。模型本身不保存跨会话状态，不维护全局一致性，不判断工具调用的副作用是否已经发生，也不验证自己声称的"已完成"是否属实。

把这些问题拆开，就得到 Harness 必须承担的责任清单：

- 持久化：会话关闭后，状态还留在哪里；
- 执行：模型提出的动作，由谁、在什么权限下真正执行；
- 反馈：工具结果以什么形式回到模型，失败如何表达；
- 边界：哪些动作不该执行，谁来决定；
- 验收：任务完成与否由什么证据判断。

模型可以生成更好的候选动作，却不能替运行环境处理授权、持久化和外部验收。这一条区分贯穿全文：凡是能由程序确定的事实，尽量交给程序；只有需要语义理解的部分才留给模型。

### Harness 与 Workflow、Context 不是一回事

三个词经常被混用。Workflow 预先规定步骤，适合审批、发布等确定流程；Harness 主要规定边界、反馈和协作协议，让模型在边界内选择具体路径；Context Engineering 关心的是有限窗口里到底放哪些材料、什么时候检索、工具结果怎样组织。

一个 Agent 可能同时需要三者。关键流程走固定 Workflow，调查和修复阶段让 Harness 允许动态决策，每一轮再靠 Context Engineering 决定模型看到什么。把三者混成"给 Agent 写配置"会丢掉责任边界：有些事是流程该定的，有些是上下文该定的，有些是执行边界该定的。

### 为什么选 Pi 当观察对象

读 Codex 或 Claude Code 的源码时，Harness 的核心循环被协议、沙箱、审批和远程服务层层包裹，初学者很容易迷失。Pi 的优势是它把循环放在一个相对独立的位置：`pi-agent-core` 只处理循环和状态，Coding Agent 只是它的一种产品化装配，模型适配则被推到更下面的 `pi-ai`。

这意味着我们可以先读一个干净的循环，再逐步补上真实系统需要的状态、事件和扩展。Pi 也足够流行，公开文档和第三方分析都比较多，适合做交叉验证。它不能回答"工业级 Agent 平台长什么样"，但能回答"一个 Agent 运行时最基础的骨架是什么"。

## 二、仓库地图：哪些包属于运行时

Pi 是一个大型 monorepo。第一次打开容易迷失在包的数量里。如果目标是理解 Harness，可以先抓住四个主包，其余包围绕它们提供扩展能力。

| 包 | 责任 | 不应该负责什么 |
| --- | --- | --- |
| `@earendil-works/pi-ai` | 统一多家模型的请求、响应、流式事件与用量 | 不决定任务何时结束 |
| `@earendil-works/pi-agent-core` | Agent Loop、消息状态、工具调用与事件 | 不实现代码编辑产品 |
| `@earendil-works/pi-coding-agent` | 文件、命令、会话、扩展和交互命令 | 不重新实现模型协议 |
| `@earendil-works/pi-tui` | 终端组件、输入与增量渲染 | 不掌握 Agent 业务状态 |

除这四个，仓库里还有几组支撑包。`@earendil-works/chord` 是一个独立的应用组合运行时，负责服务、复制状态、RPC 和插件；`@earendil-works/pi-telemetry` 提供厂商无关的遥测契约和类型化 schema；`@earendil-works/pi-mcp` 连接 MCP 服务器；`@earendil-works/pi-codemode` 执行模型生成的 JavaScript 并让脚本调用工具。这些包说明 Pi 的核心并不大，但它把扩展能力放得很开。

### 依赖方向比包数量更重要

很多 Agent 项目一开始把所有逻辑写在聊天界面里：按下回车后请求模型，看到工具调用就执行命令，再把 stdout 拼回消息。功能增加以后，模型适配、状态推进和 UI 更新互相引用，最后无法在另一种界面或服务端复用。

Pi 的选择是让 Agent Loop 住在 `pi-agent-core`，Coding Agent 只负责把它装配成产品。要做研究助手、聊天机器人或自己的后台 Agent，可以复用同一个循环，只换掉工具和界面。这种依赖方向的价值，在你想把一个终端 Agent 搬进网页或服务端时才真正显现：核心循环不用重写，改变的是边界。

Harness 这个词流行得晚，背后的工程问题却很早。早期的 AutoGPT、BabyAGI 已经能让模型循环调用工具，但停止条件、状态恢复和结果验证都很薄。演示时看起来聪明，任务一长就陷入重复操作、任务漂移或假完成。

随着模型能力提升，问题的重心也在变化：最初大家关心模型能不能回答，后来关心如何给它正确的上下文，现在更常见的是它能不能长期、稳定并且可控地完成任务。模型能生成更好的候选动作，却不能替运行环境处理授权、持久化和外部验收。Pi 出现在这个阶段，把 Harness 的最小骨架抽了出来，让后来者不必再从 AutoGPT 的混乱里重新发明循环。

第一次读这个 monorepo，不建议按目录从上到下翻。更有效的是带着一个调用链走：从 `pi-coding-agent` 的入口开始，看它怎样创建 `Agent`，再回到 `pi-agent-core` 看循环，最后落到 `pi-ai` 看模型事件。反向也可以：先读 `pi-ai` 的事件流，再读 `pi-agent-core` 怎样消费事件，最后看产品层怎样把工具和会话装配起来。

无论哪个方向，每次只追一个问题就够了。问"一条工具结果怎样回到模型"，就沿着 tool result 事件走；问"会话怎样恢复"，就沿着 SessionManager 走。带着问题读，比把每个包的 README 都读完更有效。

## 三、统一模型接口：把供应商差异压到一层

不同模型提供商都支持文本和工具调用，但接口并不真正相同。差异至少包括这几项：

- 工具参数和 schema 的约束；
- 流式事件的类型与顺序；
- 推理内容如何表达；
- token、缓存和费用的统计；
- 工具结果应该怎样回传；
- 中断和错误如何暴露。

`pi-ai` 把这些差异归一成模型、上下文、工具和事件流。Agent Loop 因此不需要在每一处判断当前连接的是哪一家模型。它提供了一个 `Models` 集合，注册各家 provider 后，通过统一的 `stream`、`streamSimple`、`complete`、`completeSimple` 方法调用。

```ts
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();
const context: Context = { messages: [], tools: [] };

for await (const event of models.streamSimple(model, context)) {
  // 统一事件流，不必关心底层是 OpenAI 还是 Anthropic
}
```

`streamSimple` 与 `completeSimple` 接收 provider 无关的选项，例如 `reasoning`；`stream` 与 `complete` 则允许传递 API 专属选项。这种"公共语义加少量专属选项"的设计很实用。完全把所有供应商压成一个最小公分母，会丢掉推理强度、缓存或原生工具等真正影响结果的能力。

除了文本和工具调用，新一代模型还会流式返回推理过程。`pi-ai` 把 thinking 内容通过专门的事件交付，例如推理起始和增量事件。上层可以据此显示推理，也可以决定是否把推理保留进 transcript。

这件事看起来只是多一类事件，实际牵动上下文管理。有些模型默认把推理留在上下文里，有些需要显式保留。统一接口必须把"推理是否进入 transcript"作为明确语义，否则切换模型时，行为差异会悄悄改变模型看到的内容。

调用时，`Models` 集合通过所属 provider 解析认证信息，并把结果合并进请求。`stream` 系列还支持一个 `transformHeaders` 选项，它在 provider 认证之后、模型请求头之前运行一次，适合追加租户标识、路由头或统一限流头。

用量统计也在这一层发生。流式调用期间会产生 token、缓存命中、费用等信息，模型接口把它们归一成统一结构。这层设计的意义在于，Loop 和上层产品看到的是同一套用量语义，而不是不同供应商各自的计费字段。

Pi 允许会话中途切换模型，但这里有一个容易忽略的问题：历史消息已经带有上一家模型的消息格式和内容块。切换不能只改一个模型名称，还要把 transcript 转换成新模型能够理解的上下文。

模型抽象最终管理的是一整段对话协议，而不只是 HTTP 地址。`pi-ai` 把 `Message`、`Content`、`Tool`、`Usage` 这些类型统一起来，Loop 处理的是归一后的 transcript，切换模型时再由适配层做转换。这也是为什么统一接口要定义得足够完整，否则切换模型时就会丢掉上一家的推理内容或工具结果。

### 切换模型时，转换发生在 transcript 层

切换模型不是改一个 `model` 字段那么简单。上一家模型返回的消息可能带着它特有的内容块：Anthropic 的 tool use 块和 OpenAI 的 tool calls 结构不同，推理内容的位置也不同。`pi-ai` 先把不同供应商的响应归一成统一的 `Message` 和 `Content`，需要时再转换回目标供应商的格式。

这个过程可以粗写为：

```ts
function convertToProvider(messages: Message[], target: string): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    return remapAssistantContent(message, target);
  });
}
```

`convertToLlm` 在 Agent Loop 里做的是相反方向的事：把运行时丰富的 `AgentMessage` 精简成模型能理解的 `Message`。两者合起来说明，模型抽象管理的是一段对话协议，而不是一段文本。谁能让一个会话在 OpenAI、Anthropic 和本地模型之间来回迁移，谁才算真正统一了模型接口。

## 四、Agent Loop：状态推进的最小状态机

Pi 在低层暴露 `agentLoop()` 和 `agentLoopContinue()`，上层提供带状态的 `Agent` 类。[官方 Agent Core 文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)区分了这两种用法。

低层循环适合嵌入自己的运行时。调用方传入一个 `AgentContext` 和一份 `AgentLoopConfig`：

```ts
const context: AgentContext = {
  messages: [{ role: 'system', content: 'You are helpful.', timestamp: Date.now() }],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel('openai', 'gpt-4o'),
  convertToLlm: (messages) => messages.filter(
    (m) => ['user', 'assistant', 'toolResult'].includes(m.role),
  ),
  toolExecution: 'parallel',
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

`agentLoopContinue` 则从既有上下文继续，不再追加新消息。它适合重试场景：上下文已经以用户消息或工具结果结尾，模型可以直接继续响应。

`Agent` 类在上层做更多事情：它管理消息、队列和生命周期，通过 `createContextSnapshot()` 与 `createLoopConfig()` 组装循环，再在关键步骤提供一致的事件屏障。低层循环的事件流是"观察性"的，它保证事件顺序，但不会等待你的异步事件处理完成后再继续生产阶段。若需要让消息处理在工具预检前形成屏障，就用 `Agent` 类而不是裸的 `agentLoop()`。

### 一次 Turn 穿过哪些状态

所谓状态推进，不只是向数组追加消息。一次运行会穿过下面这些阶段：

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

如果这些状态没有明确边界，很多偶发问题会很难解释。用户在命令执行时追加一句"不要改配置文件"，这条消息应该立刻打断当前批次，还是等工具完成后进入下一轮？两个工具并行执行，其中一个返回了终止信号，另一个是否该取消？这些都不是 Prompt 能回答的问题，它们需要运行时在状态机里明确处理。

![Pi Agent Loop 的八段状态与事件流](/images/posts/pi-agent-loop.svg?v=20261001)

### 事件流是 Loop 的对外接口

循环内部通过事件把进度暴露给外部。公开事件包括 `tool_execution_end`、`agent_end`，以及推理阶段产生的 thinking 事件。事件流让 UI、持久化和评测读到同一份运行事实，而不是各自解析日志字符串。

对嵌入者来说，事件流是 Loop 最重要的契约之一。你可以在 `tool_execution_end` 时记录一次工具调用的结果，在 `agent_end` 时收尾一次任务，在 thinking 事件时更新推理显示。Loop 本身不负责渲染，它只负责把状态变化说清楚。

### 模型调用失败、超时与中止

循环里最容易漏掉的是模型调用本身的失败。`pi-ai` 的 stream 函数有一个明确契约：它不能因为请求、模型或运行时错误而抛出异常或返回 rejected promise，而是把这些情况编码进事件流，由 Loop 统一处理。

这个契约很重要。如果底层适配器随便抛异常，Loop 就得到处写 try/catch，而且每种 provider 的异常类型不同。把失败编码进事件流后，Loop 只面对一种失败语义：某个事件表示请求失败或超时，运行时据此决定重试、中止，还是把错误交给用户。

`AbortSignal` 贯穿整个循环，模型流式调用和工具执行都能被取消。取消发生时要区分几种状态：模型还没有产生任何输出，取消就是放弃本次调用；模型已经产生工具调用，取消可能意味着跳过剩余工具；工具已经产生副作用，取消就只能停止继续等待，副作用本身已经无法撤回。

### 最小循环的常见翻车轨迹

只写十几行循环，能跑，但会稳定地踩中几类问题：

| 翻车轨迹 | 更可能缺少的机制 |
| --- | --- |
| 同一条命令重复执行，结果没有变化 | 停滞检测与新证据判断 |
| 工具返回权限不足，模型却当成"没有数据" | 结构化错误契约 |
| 长任务做到一半推翻早期决定 | 状态落盘与决策理由保留 |
| 模型说测试通过，实际没有运行 | 验收回路与命令证据 |
| 两个工具并行改写同一文件 | 数据依赖与执行模式控制 |
| 用户中断后，旧批次的结果又回到上下文 | steering 与结果回收 |
| 会话关闭后一切从头再来 | Session 持久化 |

每一条都对应运行时的一层责任。骨架能跑只是开始，真正的 Harness 质量体现在这些翻车点是否被显式处理。

循环的每一步都在消耗上下文。历史消息、工具结果、推理内容加起来，很快接近窗口上限。Loop 不能只靠"等模型报错才发现窗口满了"，而应主动管理预算。

实际做法包括：把长工具输出落盘而不是全部进 transcript；在合适的时机压缩早期历史；限制单次工具结果的长度。这些决定属于运行时策略，因为它们改变的是模型下一轮看到什么，而不是模型本身。

不跟踪预算的 Harness，要么在窗口超限时报错，要么在重要早期上下文被挤出时悄悄退化。把预算做成显式的运行时概念，正是区分"演示循环"和"能跑一天任务的循环"的地方。

## 五、消息模型：transcript 才是真相

Agent 状态的核心是一条 transcript，而不是一个简单的字符串数组。`pi-agent-core` 定义了 `AgentMessage` 类型，并通过 declaration merging 允许调用方扩展自定义消息类型。

```ts
declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    notification: { role: 'notification'; text: string; timestamp: number };
  }
}
```

声明合并之后，`AgentMessage` 就能接受 `role: 'notification'` 这类自定义消息。要注意的是，自定义消息必须在 `convertToLlm` 里决定如何进入模型输入。上面那个 notification 消息对模型没有意义，于是被过滤掉：

```ts
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap((m) => {
    if (m.role === 'notification') return [];
    return [m];
  }),
});
```

这个机制的意义在于，运行时的消息空间可以比模型的消息空间更丰富。你可以在 transcript 里保存通知、状态标记、进度节点，再在转换时决定哪些进入模型上下文。模型看到的是精简后的输入，运行时保有的是完整过程。

### system prompt 和工具声明由 transcript 承载

官方源码中的契约很明确：Loop 传入的是已经归一化的 transcript，系统提示词和工具声明由 transcript 里的 system message 承载，而不是由 `context.systemPrompt` 或 `context.tools` 单独承载。

这条约束看似只是实现细节，实际影响很大。它意味着"模型当前看到什么"只有一个真相来源，就是 transcript。任何对 system prompt 或工具的修改，都通过改写 transcript 里的 system message 完成。这样 Loop 在压缩、恢复或切换模型时，不需要在多个字段之间同步状态。

## 六、工具契约：错误与终止是运行时语义

一个工具至少需要名称、描述、参数 schema 和执行函数。Pi 的工具执行函数还能接收取消信号和增量回调，因此长任务可以持续报告进度，也可以被中止。

```ts
import { Type } from '@earendil-works/pi-ai';

const readFileTool: AgentTool = {
  name: 'read_file',
  label: 'Read File',
  parameters: Type.Object({ path: Type.String() }),
  async execute(callId, params, signal, onUpdate) {
    if (!fs.existsSync(params.path)) {
      throw new Error(`File not found: ${params.path}`);
    }
    return { content: [{ type: 'text', text: '...' }] };
  },
};
```

`parameters` 使用 TypeBox 定义，`pi-ai` 会导出 `Type`、`Static`、`TSchema` 供复用。`label` 用于 UI 展示，`name` 用于模型和工具路由。

### 失败要抛出，不要伪装成成功文本

官方文档强调，工具失败时抛出异常，不要返回 `Error: file not found` 这样的成功文本。运行时会把抛出的异常捕获，作为带 `isError: true` 的工具结果交给模型。

这个选择看起来很小，却决定了模型能不能稳定区分两件事：工具正常返回了一段包含报错日志的内容，还是工具本身执行失败。前者说明工具工作正常，日志内容可能是诊断线索；后者说明动作没有完成，模型需要修正参数或换一条路径。如果两者都被包装成文本，模型就只能靠猜。

### terminate 是运行时的停止提示

工具执行函数可以返回 `terminate: true`，被阻塞的 `beforeToolCall` 或 `afterToolCall` 也可以。它提示 Agent 在当前工具批次结束后停止。这个提示只在该批次内所有已定稿的工具结果都是终止状态时生效，而且是运行时语义，发射到 transcript 里的 `toolResult` 消息仍是标准工具结果。

`terminate` 解决了一个真实问题：有时一次工具调用已经说明任务不需要继续，比如检测到没有更多待办项，或用户已经明确取消。此时与其让模型再走一轮、再由模型判断是否停下，不如让运行时直接知道该收尾。

### beforeToolCall 与 afterToolCall

两个 Hook 承担跨工具一致的策略：

- `beforeToolCall`：参数校验、路径限制、危险操作确认；
- `afterToolCall`：语法检查、审计日志、结果裁剪、敏感信息过滤；
- 两者都可以根据结果决定是否终止当前批次。

Hook 不应该变成散落的业务逻辑。它更适合处理跨工具一致的问题。工具自己的领域规则仍应留在工具实现内部。把参数校验全塞进 Hook，会让每个工具的实现残缺；把审计逻辑塞进每个工具，又会重复。边界在于：属于单一工具的事留在工具里，属于所有工具的事放进 Hook。

`AgentLoopConfig` 里的 `toolExecution` 可以设为 `parallel`，单个工具也可以通过自身的执行模式覆盖它。默认并行执行能显著降低多工具任务的延迟，但并行工具共享同一份上下文和文件系统，数据依赖和副作用会互相影响。

一个很常见的错误是让两个工具并行修改同一个文件。结果取决于调度顺序，难以复现。可靠的做法是让有数据依赖或写冲突的工具串行，只把只读且相互独立的工具并行。这个决定属于运行时策略，不应该写死在工具内部。

工具执行成功时，返回的是结构化内容，而不是一段拼接好的字符串。结果可以包含多种 content 块，例如文本块。长输出应当被分页或截断，并明确告诉模型还有更多内容没有读。

实际产品里，`bash` 会把完整输出写进临时文件，只把一部分放进 transcript；`read` 支持 offset 和 limit，超长时返回下一段位置。这样做的原因是，模型上下文是有限预算，把几十 KB 的日志一次性塞进去，既浪费预算，也会淹没关键信息。截断必须显式，模型才能区分"输出确实只有这些"和"还有更多，我该继续读"。

`terminate: true`、`beforeToolCall` 的阻塞、`afterToolCall` 的阻塞，三者都能向运行时表达"该停了"，但作用范围不同。`terminate` 是工具结果携带的提示，只在批次内所有定稿结果都终止时生效；`beforeToolCall` 的阻塞发生在执行前，可以阻止一个工具根本不执行；`afterToolCall` 的阻塞发生在执行后，副作用已经发生，只能阻止后续动作。

这三层合起来，运行时才能回答"到底停在哪一步"。只靠一个布尔值，无法区分"还没开始所以安全停止"和"已经执行所以只能善后"。

工具可以按副作用粗略分成三类：只读、可重放写、不可重放写。只读工具失败可以安全重试；可重放写例如覆盖写同一内容，重试风险低；不可重放写例如发送消息、扣款，超时后必须核对状态而不是直接重放。

运行时至少要知道每个工具属于哪一类，才能在超时和取消发生时给出正确的默认行为。这个分类不应只写在工具描述里让模型猜，而应成为工具契约的一部分。

## 七、steering 与 follow-up：把长任务变成可操纵的进程

长任务运行时，用户不会一直安静等待。Pi 把中途输入区分成 steering 与 follow-up 两种，并维护两个独立的待处理队列。

Steering 用来改变正在进行的任务，例如"先别改代码，查一下调用链"。它需要尽快进入循环，影响下一步动作。Follow-up 更像排队的新任务，要等当前工作没有待执行工具和 steering 之后再处理。

公开文档中，`queue_update` 事件会在两个队列变化时发出完整的 pending 内容。运行时也提供 `steer()` 和 `followUp()` 两个方法，调用方根据用户意图选择把消息放进哪个队列。

### 为什么必须分开两种输入

如果所有新消息都直接追加到同一个数组，模型可能在工具结果尚未回传时看到一条位置错误的用户消息，甚至破坏工具调用协议。运行时必须决定消息何时进入 transcript。

这个区分的现实来源，在社区讨论里也看得到。有用户观察到，Agent 工作时输入的消息名为 queued，实际却起 steering 的作用。官方的命名于是朝 steer 与 follow-up 收敛。背后的判断很朴素：有些消息要打断当前批次，有些消息要等当前批次结束。

### 中断发生后，运行时还要做什么

Steering 不只是把文字插进队列。一个合理的中断路径包括：取消当前仍在运行的只读工具，跳过批次里剩余的工具，把用户意图作为下一轮的最高优先级输入，并保留已经完成的工作。文档里"skip remaining tools if user interrupted"正是这个含义。

输入处理器（input handlers）会对排队的消息运行，这意味着 steering 和 follow-up 并不是简单字符串，它们同样经过输入阶段的处理和校验。这个细节让中断路径和正常输入走同一套逻辑，减少了"普通消息被校验、中断消息绕过后门"的不一致。

`queue_update` 事件发出的是两个数组：`steering` 和 `followUp`，各包含待处理的消息。一次并发交互可以想象成这样：

```text
用户输入任务 → 模型开始流式输出
用户按回车："先别改文件"
  → steer()，进入 steering 队列
  → 运行时跳过剩余工具
  → 用户消息成为下一轮最高优先级输入
用户按 shift+enter："顺便把 README 里的拼写改一下"
  → followUp()，进入 follow-up 队列
  → 等当前工作结束后再处理
```

两个队列的存在，让"打断"和"排队"成为两种明确的运行时操作，而不是靠插入位置或时间戳猜。

## 八、Session：会话是一棵可恢复的树

Pi 默认持久化会话。会话不是一行最终回答，而是一份可继续、可恢复、可分叉的运行记录。

![Pi 的会话树、分叉与压缩](/images/posts/pi-session-tree.svg?v=20261001)

存储形式是 append-only 的 JSONL，一个会话一个文件，默认放在 `~/.pi/agent/sessions/` 下。目录按工作路径编码，文件名形如 `<时间戳>_<uuid>.jsonl`。文件第一行是 session header，包含会话 id、版本和时间；后续每一行是带 `id` 和 `parentId` 的条目。这些 id 把会话组织成一棵树。

```text
~/.pi/agent/sessions/
└── <encoded-cwd>/
    └── <ts>_<uuid>.jsonl
```

一个可恢复会话至少要保留这些内容：

- 原始用户消息和模型消息；
- 工具调用及其结果；
- 使用过的模型和配置；
- 压缩后的历史摘要；
- 分支与父会话关系；
- 可能影响后续行为的扩展状态。

### 一份 JSONL 长什么样

文件第一行是 header，后续每行是一个条目。条目至少带 `type`、`id`、`parentId`，根据类型再携带不同字段。粗看是这样的：

```json
{"type":"session","version":3,"id":"...","timestamp":"..."}
{"type":"user","id":"m1","parentId":null,"content":"修复失败的测试"}
{"type":"assistant","id":"m2","parentId":"m1","content":[{"type":"text","text":"..."}]}
{"type":"tool_call","id":"m3","parentId":"m2","tool":"read_file","args":{}}
{"type":"tool_result","id":"m4","parentId":"m3","content":"..."}
```

字段细节会随版本演进，这里只表达结构。重点是 `id` 和 `parentId` 把条目连成树，`fork` 从某个节点复制出一个新的叶子，`parentId` 指向共享的祖先。没有这棵树，恢复和分叉都无从谈起。

### SessionManager 与分叉

`SessionManager` 拥有持久化或内存中的条目树，并跟踪当前活动的叶子。`AgentSessionRuntime` 在其上提供 `newSession()`、`switchSession()`、`fork()` 和 `importFromJsonl()` 等方法。

分叉尤其适合开发任务。我们可以在同一段历史上尝试两种修复方案，而不是复制粘贴上下文。`fork()` 创建一个共享祖先的新叶子，两个分支独立推进，互不覆盖。它说明 transcript 本身是一份运行记录，不能只保留渲染后的纯文本；没有 `id` 和 `parentId`，分叉就无从谈起。

长会话会撑爆上下文窗口，于是需要 compaction。压缩不是把历史删除，而是把早期内容浓缩成摘要，作为新的 system 或 assistant 消息继续留在树里。压缩之后的会话仍然可以追溯：原始条目仍在文件中，摘要只是让当前上下文更短。

压缩发生在 transcript 层，这一点要留意。它保留的是可继续的状态，不是丢给 UI 的最终文本。恢复一个压缩过的会话时，运行时拿到摘要加最近消息，而不是一段无法继续的旧对话。

## 九、Coding Agent：把运行时装配成产品

`pi-agent-core` 只提供循环，真正的产品能力在 `pi-coding-agent`。它提供四个核心工具：`read`、`write`、`edit`、`bash`，并通过扩展系统提供 `grep`、`find`、`ls` 等更多能力。

官方 SDK 暴露了一批工具工厂，方便按需装配：

```ts
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
```

`createCodingTools` 组合出完整的编码工具集，`createReadOnlyTools` 组合出只读工具集，下面还有 `createReadTool`、`createBashTool`、`createEditTool`、`createWriteTool`、`createGrepTool`、`createFindTool`、`createLsTool`、`createPowerShellTool` 等更细的工厂。

### 四个核心工具为什么够

`read`、`write`、`edit`、`bash` 覆盖了代码编辑的绝大部分动作：读文件、写文件、精确修改、执行命令。更复杂的能力用扩展补充，而不是塞进核心。

这个设计体现了一个原则：核心工具应该是正交的最小集。`edit` 需要精确旧文本和新文本，是为了让修改可预测、可回滚；`bash` 是最通用的逃生口，也因此需要最谨慎的权限约束。工具越多，模型在选择上的误差越大；一个正交且边界清楚的小工具集，往往比几十个重叠工具更可靠。

### 只读模式是一次真实的权限边界

SDK 示例里，只读会话只挂载 `read`、`bash`、`grep`，写会话才挂载 `edit` 和 `write`。这不是把权限写进 Prompt 提醒模型小心，而是在装配工具时就不给模型写能力。

这条边界值得单独说清楚。一个没有 `write` 工具的 Agent，无论模型多想改文件，运行时都没有对应的执行函数。权限约束落在工具集合上，而不是落在模型自觉上。Pi 的扩展系统和工具工厂让这种"装配即授权"的模型变得很自然。

### ResourceLoader 覆盖 system prompt

`createAgentSession` 接受一个 `resourceLoader`，调用方可以用它覆盖系统提示词。这意味着同一个运行时可以装配出不同角色的 Agent：一个负责代码评审，一个负责排障，一个负责写测试。核心循环不变，变化的是装配时注入的资源。

这个模式和工具工厂一样，都体现了 Pi 的装配思想：运行时提供骨架，产品通过"注入资源、选择工具、配置会话管理器"来决定自己是什么。

会话文件按工作路径编码，意味着回到同一个目录，就能列出并继续这里的历史会话。这个细节很小，却直接影响体验：开发者最常做的"今天继续昨天的任务"因此变得自然。

工作目录同时也是工具的默认作用域。读取、编辑和命令都在这个目录内展开，权限边界也随之有一个默认的锚点。把会话和工作目录绑在一起，恢复的不只是对话文本，还包括任务当时所处的环境上下文。

## 十、扩展系统：Core 小的另一半原因

Pi 的核心很小，但并不追求功能少。它把大量能力移到扩展、Skills、Prompt 模板、主题和安装包中。一个 Pi Package 可以同时分发这些资源，再通过 npm、Git 或本地目录安装。

```text
pi install npm:@example/pi-tools@1.0.0
pi install git:github.com/example/pi-tools@v1
pi install ./local-package
```

`pi list` 显示已配置的包，`pi remove` 移除，`pi update --extensions` 协调安装。这种设计与"把所有功能合进主仓库"相比，有三个直接效果：

1. Agent Loop 保持稳定，领域能力独立演进；
2. 项目可以只加载需要的资源，减少上下文和攻击面；
3. 用户能修改 Harness 的行为，而不必维护整个项目的 fork。

### 信任边界必须显式存在

个人安装写入 `~/.pi/agent/settings.json`，项目级声明写入 `.pi/settings.json`。项目级包只有在工作区获得信任之后才会被读取。

这背后是一个明确事实：扩展不是一段给模型看的说明，它可能是会在本机执行的代码。`pi-mcp` 连接外部 MCP 服务器，`pi-codemode` 执行模型生成的 JavaScript 并让脚本调用工具。能力越强，信任边界越重要。Pi 把"项目是否受信任"作为一个显式门槛，而不是默认加载任何东西。

扩展系统让一个很小的 Core 承载大量能力，代价是攻击面分散到第三方包。一个恶意扩展可以做任何代码能做的事：读取环境变量、上传文件、修改配置。

因此，扩展的发现、安装、信任和审计需要和扩展能力同样受重视。Pi 用项目信任作为第一道门槛，用包来源和版本作为后续约束。这个取舍没有一劳永逸的答案，但它提醒我们：Harness 的可扩展性和安全性是同一个设计问题的两面。

## 十一、遥测与可观测性

Harness 在运行，但它做得好不好、钱花在哪里、失败集中在哪一步，需要遥测来回答。Pi 提供了 `@earendil-works/pi-telemetry`，一组厂商无关的遥测契约、参考适配器、一致性测试和类型化 schema。

遥测要回答的问题大致是：

- 一次任务调用了多少次模型、多少 token、多少费用；
- 工具调用的成功率和耗时分布；
- 流式输出在哪个阶段最慢；
- 中断和取消发生的频率；
- 每种工具各占多少上下文预算。

这些数据不能只靠事后翻日志。结构化 schema 让不同运行环境产生可比较的记录，一致性测试保证参考适配器不会悄悄漏掉字段。对一个要长期维护的 Harness，遥测不是附加功能，而是判断"这次改动有没有用"的证据来源。没有遥测，评测里的任何分数都无法和线上真实行为对上。

## 十二、端到端：一个真实任务穿过 Pi

把前面的机制串起来，看一个具体任务：用户让 Pi 修复一个失败的单元测试。初始状态是一个 Git 仓库，测试文件 `src/math.test.ts` 失败，报错是 `expected 5, received 6`。

### 第一步：启动会话，建立可恢复状态

用户在工作目录运行 Pi，`SessionManager` 创建一个新会话。session header 写入 id 和时间，后续条目通过 `id` 和 `parentId` 挂到树上。此时运行时拥有工作目录、可用工具集和模型配置。

### 第二步：组装 context 并请求模型

`Agent` 类创建上下文快照，调用 `createLoopConfig` 生成循环配置，然后请求模型。system message 承载系统提示和工具声明，用户消息携带任务。模型流式返回计划，thinking 事件一路更新推理显示。

### 第三步：模型发起工具调用

模型决定先读测试文件和被测实现。它发起两个工具调用，运行时按 `toolExecution` 策略执行。两个都是只读操作，可以并行。`beforeToolCall` 校验路径在工作区内，两个 `read_file` 各自返回文件内容，`afterToolCall` 记录耗时。

### 第四步：工具结果回到 transcript

读到的内容以结构化文本回到 transcript，成为下一轮模型输入。模型现在知道实现里 `add(2, 3)` 返回了 6，于是判断是加法函数把加法写成了乘法。

### 第五步：写入并验证

模型发起 `edit` 工具调用，替换错误的实现。`edit` 需要精确的旧文本和新文本，返回 diff。随后模型发起 `bash` 运行测试。`bash` 返回测试通过、退出码 0。

### 第六步：steering 打断

就在模型准备总结时，用户输入"等一下，先确认没有改到别的文件"。这条消息走 `steer()`，进入 steering 队列。运行时跳过剩余工具，把用户意图作为下一轮最高优先级输入。模型随后发起 `git diff --stat`，确认改动范围，再回答用户。

### 第七步：结束并落盘

任务完成，`agent_end` 事件发出，会话条目全部 append 到 JSONL 文件。下次用户回到这个目录，`switchSession` 可以继续，`fork` 可以在同一历史点上试另一种修法。

这个例子里，没有哪个环节是"模型自己聪明"就能替代的。状态、权限、失败语义、中断和持久化，都由 Harness 在模型的两次生成之间完成。

### 中途失败的分支

把同一个任务改一下：模型发起 `bash` 运行测试，但测试进程因为超时被杀，运行时收到的不是退出码 0，而是超时。此时模型不该把"超时"当成"失败"，也不该当成"通过"，而应得到"结果未知"。

运行时可以再查询一次进程状态，或者让模型发起一次只读的 `git status` 和更短范围的测试。这里的重点是，超时没有被静默吞掉，也没有被误报成成功。这个分支暴露的正是工具错误语义的价值：模型能否继续，取决于运行时把什么信息放回 transcript。

## 十三、Pi 没有替我们解决什么

Pi 证明了最小 Harness 可以很清楚，但"清楚"不等于"天然可靠"。把它放进生产系统，还需要补齐一批能力：

- 操作系统级沙箱和更细的权限模型；
- 多租户隔离与密钥管理；
- durable execution、任务重试和崩溃恢复；
- 统一 tracing、成本归因和质量评测；
- 高风险动作的审批与审计；
- 工具版本和 Session schema 的迁移。

这些能力没有必要全部进入 Agent Core。Pi 更像一块干净的运行时底板，适合学习、嵌入和改造。成熟产品会在它所展示的最小循环之外继续增加边界，但最核心的状态机并没有变。

### 与 Codex、DSH 的位置差异

| 系统 | 适合观察什么 | 主要扩展边界 |
| --- | --- | --- |
| Pi | 最小 Agent Loop 和可嵌入 Runtime | Tools、Extensions、Skills、Packages |
| DSH | 整个 Agent 应用如何被插件装配 | Service、Provider、Scope、Loop、UI |
| Codex | 工业产品如何处理协议、审批、沙箱与恢复 | Tools、MCP、Skills、Apps 与客户端协议 |

三者不是简单的功能强弱关系。Pi 适合从小处理解循环，DSH 适合研究运行时组合，Codex 适合研究产品边界和安全执行。

Pi 是执行 Harness，验证它主要靠可重复的行为，而不是 benchmark 分数。一条实用的验证路径是：

- 固定一组任务和初始环境；
- 记录每次运行的轨迹、工具调用和退出状态；
- 修改循环后，比较失败类型而不是只看成功与否；
- 为已知失败构造最小复现，确认新逻辑确实改变了该路径；
- 检查副作用是否落在预期范围，而不是只查最终文本。

执行 Harness 的正确性，体现在"该停的时候停、该问的时候问、失败能说清楚"，这些往往不是一次总分能反映的。

## 十四、什么时候不该选 Pi

Pi 的克制也意味着它不适合所有场景。下面这些情况值得三思。

第一，你需要一个开箱即用的完整平台。Pi 是 toolkit 和 runtime，不是一个带云端、审计、团队协作和权限审批的一体化产品。选它意味着接受"自己装配边界"的成本。

第二，你的任务高度依赖远程沙箱和崩溃恢复。Pi 本地工具直接操作文件和 shell，它在 OS 级隔离、任务续跑和远端执行上，需要额外的集成（社区有把工具跑进沙箱的方案，但那是集成，不是内置）。

第三，你要做的是评测而不是执行。Pi 是执行 Harness。批量跑任务、保存轨迹、计算分数，需要另外搭建评测 Harness。两者目标不同，一个交付结果，一个测量能力。

把这几个判断压成一张表：

| 你的处境 | 更合适的判断 |
| --- | --- |
| 想直接部署一个带审计、团队和云端的平台 | Pi 只提供 toolkit，边界要自己搭 |
| 核心诉求是远程沙箱与崩溃续跑 | 需要额外集成，不是内置能力 |
| 目标是批量评测与分数 | 用评测 Harness，而不是执行 Harness |
| 想读懂 Agent 运行时的最小骨架 | 选 Pi 正合适 |
| 想嵌入自己的产品、复用同一循环 | 选 Pi 正合适 |

### 最小 Harness 不等于生产 Harness

把 Pi 的最小循环当成"这就是生产 Agent 的全部"会出错。生产系统还欠着幂等、审计、灰度、监控和回滚。Pi 的贡献是让这些边界有清晰的挂载点，而不是替你实现它们。

反过来，也不该因为 Pi 简单就低估它。它把最容易被产品复杂度掩盖的那部分抽了出来，而这部分正是理解一切 Agent 的起点。

## 十五、从 Pi 得到的设计检查表

自己实现 Agent Harness 时，可以先回答下面这些问题：

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

### 一个最小可运行骨架

如果只想验证"调用模型、执行工具、再调用模型"这条循环，下面是一个可以运行的最小形状，事件名对应 Pi 的公开语义：

```ts
async function runAgent(context, config, streamFn) {
  for (let step = 0; step < config.maxSteps; step++) {
    let emittedToolCall = false;
    for await (const event of streamFn(config.model, context)) {
      if (event.type === 'assistant_text') {
        context.messages.push(event.message);
      }
      if (event.type === 'tool_call') {
        emittedToolCall = true;
      }
      if (event.type === 'tool_execution_end') {
        context.messages.push(event.result);
      }
    }
    if (!emittedToolCall) break;
  }
}
```

这段代码省略了预检、steering、终止和持久化，只表达最核心的推进逻辑。真正的运行时会把每一步替换成对应的事件和状态转换。骨架的意义在于，它把"循环"和"模型"分开了：模型是 `streamFn`，循环是 `runAgent`，两者可以独立测试、独立替换。

如果要从头实现一个 Harness，不必一次补全所有层。可以按下面的顺序推进：

1. 先跑通最小循环，让模型能调用一个只读工具并看到结果；
2. 补结构化错误，把"失败"和"无结果"分开；
3. 加预算和退出状态，避免无限循环；
4. 落盘 transcript，让会话可以继续；
5. 加 steering 与 follow-up，让长任务可以被操纵；
6. 最后再考虑扩展、遥测和权限。

这个顺序的原则是：先让循环可信，再让它可恢复，最后让它可扩展。很多项目反过来，第一天就设计了复杂的插件和权限体系，结果连基本循环里的失败语义都没处理清楚。

## 参考资料

- [Pi 官方仓库](https://github.com/earendil-works/pi)
- [Pi Agent Core 文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Pi Coding Agent 文档](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)
- [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi SDK 文档](https://pi.dev/docs/latest/sdk)
