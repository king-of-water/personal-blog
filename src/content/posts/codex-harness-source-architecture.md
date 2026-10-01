---
title: Codex 源码拆解：从 App Server 到 Agent Loop
description: 沿 OpenAI 官方 Rust 仓库追踪一次 Codex 任务，拆开 App Server、Core、Responses API、工具路由、审批、沙箱、执行服务、Rollout 与恢复机制。
category: Agent
subcategory: Agent 开发
featured: false
publishedAt: 2026-10-01
updatedAt: 2026-10-01
tags: [Codex, Agent Harness, Rust, Agent Loop, App Server, Sandbox, Context Engineering]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

Codex 会写代码只是表面。真正值得研究的是，它怎样把概率性的模型输出接入真实仓库，并让任务持续向前推进。

OpenAI 已经公开了 Codex CLI 的 Rust 仓库。我们不需要只靠界面猜测，可以直接沿着协议、Core、工具路由、执行器和持久化模块，追踪一次任务是怎么跑起来的。

这篇文章只分析官方开源仓库里能够验证的部分。模型内部、云端调度和托管基础设施不在公开源码范围内。这里说的 Codex，主要指本地 CLI 及其可复用的 Harness。

![Codex 官方源码中的运行时分层](/images/posts/codex-source-architecture.svg?v=20261001)

## 一、先看全局：Codex 不是一个终端聊天框

从外面看，Codex 的交互很简单：输入任务，等待它读文件、改代码、跑测试。源码里真正运转的是一条分层链路：

```text
TUI / IDE / Desktop / 其他客户端
                 ↓ JSON-RPC 或进程内 typed client
             App Server
                 ↓ Thread / Turn / Item
              Codex Core
                 ↓ Responses API 事件流
                Model
                 ↓ tool call
          Tool Router 与策略检查
                 ↓
     Exec / Patch / MCP / Skills / Apps
                 ↓
       沙箱、工作区与外部环境
```

这套结构把三个经常混在一起的问题分开了：

1. 客户端如何展示任务进度；
2. Agent 如何维护会话并循环调用模型；
3. 一条命令最终在哪里、以什么权限执行。

如果把三件事全部写进一个 CLI 主函数，产品很快会失控。终端能用，IDE 却得重写一遍；本机执行能用，远程环境又得重新接；审批弹窗、任务恢复和历史回放也会互相缠绕。

Codex 的源码选择是把 Core 做成运行时，把 App Server 做成边界，把界面和执行环境放在边界之外。

## 二、仓库里哪些模块最值得看

OpenAI 的 [`openai/codex`](https://github.com/openai/codex) 是一个大型 Rust workspace。第一次进去很容易被 crate 数量淹没。若目标是理解 Harness，可以先抓住下面几组模块。

| 模块 | 主要职责 | 适合回答的问题 |
| --- | --- | --- |
| [`codex-core`](https://github.com/openai/codex/tree/main/codex-rs/core) | 会话状态、模型循环、工具调度、上下文与业务逻辑 | Codex 为什么能连续完成多步任务 |
| [`app-server`](https://github.com/openai/codex/tree/main/codex-rs/app-server) | 面向丰富客户端的双向 JSON-RPC 服务 | IDE 或桌面端怎样接入同一个 Core |
| [`app-server-client`](https://github.com/openai/codex/tree/main/codex-rs/app-server-client) | 进程内类型化客户端与通道管理 | 不走 JSON 文本时怎样复用协议 |
| [`app-server-protocol`](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol) | 请求、事件和领域对象 | Thread、Turn、Item 怎样表达状态 |
| [`exec-server`](https://github.com/openai/codex/tree/main/codex-rs/exec-server) | 远程或本地的进程与文件执行协议 | Harness 怎样与执行环境解耦 |
| sandbox 相关 crate | 操作系统级文件、进程与网络边界 | 模型出错时为什么不能越权 |
| TUI / CLI | 人机交互、事件渲染与输入 | 终端如何只做客户端，不吞掉核心逻辑 |

读源码时，我不会按目录从上到下翻。我更习惯带着一个问题走调用链：用户按下回车后，哪一层创建 Turn，哪一层向模型发请求，工具调用如何落到执行器，结果又怎样回到下一次采样。

## 三、Thread、Turn、Item：先把状态说清楚

Codex App Server 把对话暴露成三个核心对象。

```text
Thread  长生命周期任务线程
└── Turn  一次用户输入触发的工作回合
    ├── Item: user message
    ├── Item: agent message / delta
    ├── Item: command execution
    ├── Item: file change
    ├── Item: approval request
    └── Item: completion / error
```

Thread 不等于一段 Prompt。它保存的是一个可以继续、恢复和分叉的工作上下文。Turn 也不等于一次模型请求。一个 Turn 内部可能发生十几次 Responses API 调用，因为每次工具结果都会触发下一轮模型判断。

Item 把“过程”变成一等公民。客户端会收到不断追加的事件：模型正在解释、命令已经启动、补丁等待批准、测试输出持续到达、任务最终完成。最终文本只是其中一种 Item。

这不是从产品界面反推出来的抽象。`app-server-protocol` 的 [`thread_data.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs) 直接定义了 `Turn`：里面有 `id`、`items`、`status`、`error`、开始和完成时间以及持续时长。`items` 不是纯文本数组，它能保存命令执行、文件变化、MCP 调用和压缩等不同领域对象。

协议类型同时派生 Rust 序列化、JSON Schema 和 TypeScript 类型。这个细节很实用：服务端领域对象、线上的 JSON 和客户端类型来自同一份定义，协议演进时更不容易出现三套手写结构互相漂移。

旧版协议文档还使用 Session、Task、Turn 等术语。命名后来朝 Thread、Turn、Item 收敛，但核心结构没有变化：

- 长生命周期对象保存历史和配置；
- 一次用户任务串起多轮模型调用；
- 模型消息、工具调用、工具结果和状态变化按事件记录。

这种建模的价值，在任务出错时最明显。若系统只有 `messages[]`，很难判断一条命令究竟还在运行、已经失败，还是正等待用户批准。事件模型让 UI、恢复逻辑和审计都能读懂同一份事实。

## 四、App Server：把 Core 变成可嵌入服务

`codex app-server` 不是另一个 Agent。它是 Core 面向外部界面的协议适配层。

客户端通过双向 JSON-RPC 发起线程和回合操作，再持续接收通知。典型流程可以抽象为：

```json
{"method":"thread/start","params":{"cwd":"/repo"}}
{"method":"turn/start","params":{"threadId":"...","input":"修复登录超时"}}

{"method":"item/started","params":{"type":"command_execution"}}
{"method":"item/delta","params":{"stdout":"running tests..."}}
{"method":"turn/completed","params":{"status":"completed"}}
```

真实协议字段会随版本演进，这段代码只表达边界。运行时会持续发送状态变化，不会把全部过程压成一个 HTTP 响应。

App Server 还解决了多客户端一致性。终端、IDE 和桌面应用可以有完全不同的界面，却不用各自复制 Agent Loop。它们只需要理解协议对象，并把用户的批准、中断和补充输入发回 Core。

生成的 [`ServerNotificationEnvelope`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ServerNotificationEnvelope.ts) 能看到这条事件总线到底有多细：`turn/started`、`item/started`、Agent Message 和 Plan 的 delta、命令输出、文件补丁、MCP 进度、压缩完成以及进程退出都拥有独立通知。前端由此可以基于类型更新界面，不必解析一串约定俗成的日志。

对于嵌入同一进程的调用方，`app-server-client` 又提供类型化通道。这样既保留一套领域模型，也避免所有内部调用都序列化成 JSON。对外传输和进程内调用共享概念，差别只在 transport。

## 五、Core：Agent Loop 真正运行的地方

Codex Core 是这套系统的中心。它维护当前 Thread 的状态，接收用户提交，调用模型，解释流式事件，并把工具结果送回下一轮。

最小循环可以写成：

```rust
loop {
    let input = build_model_input(&thread, &turn, &tools);
    let output = model.stream(input).await?;

    match collect_next_action(output).await? {
        Action::ToolCalls(calls) => {
            let results = tool_router.execute(calls, &policy).await;
            thread.append(results);
        }
        Action::Final(message) => {
            thread.append(message);
            break;
        }
    }
}
```

源码远比这复杂，但责任边界大致如此。Core 关心的是状态推进，不负责画终端，也不应该把所有系统命令直接写死在循环里。

公开协议中还能看到两条队列式通道：客户端把输入送进 Submission Queue，Core 再通过 Event Queue 发出过程事件。这个模型很适合长任务，因为输入与输出不需要一问一答地锁死。用户可以中断、补充指令，系统也可以持续报告命令输出。

![一次 Codex Turn 在源码层怎样穿过各模块](/images/posts/codex-turn-source-flow.svg?v=20261001)

## 六、一次 Turn 的完整调用链

### 1. 创建或恢复 Thread

客户端先创建新 Thread，或从持久化记录恢复已有 Thread。运行时在这里确定工作目录、模型、审批策略、沙箱策略和其他会话级配置。

恢复不是把最后一段回答重新显示出来。Core 需要重建能继续执行的状态，包括历史 Item、模型对话、工作目录和可能存在的分支关系。

### 2. 启动 Turn，并冻结本轮输入

Turn 开始时，Core 收集用户输入和本轮配置。把配置冻结成快照很重要：模型已经根据一组工具定义开始生成以后，工具 schema 不应在半路悄悄改变。

本轮快照通常包含：

```text
用户任务
+ 当前目录与环境信息
+ 模型与推理配置
+ Approval Policy
+ Sandbox Policy
+ 可用工具集合
+ 已有历史状态
```

### 3. 组装模型上下文

Core 不会把仓库完整塞给模型。它组装的是一份分层上下文：

```text
基础系统指令
+ 开发者与产品规则
+ AGENTS.md 等项目说明
+ 运行环境描述
+ Thread 历史与工具结果
+ 当前用户输入
+ 本轮可见工具定义
+ 按需加载的 Skill / MCP 信息
```

稳定内容尽量靠前，频繁变化的内容追加在后面。这样既能理清优先级，也有利于 Prompt Cache。代码文件通常由模型通过工具按需读取，无需在 Turn 开始时全量注入。

### 4. 调用 Responses API，并消费事件流

Codex 的 Model Client 面向 Responses API。响应会以一系列流式事件到达，最终字符串只是其中一部分。Core 按事件更新当前 Item：

- 文本增量立刻传给客户端；
- 计划增量更新 Plan；
- 工具调用交给 Tool Router；
- 错误与完成信号改变 Turn 状态。

流式协议使“模型输出”和“任务状态”可以同步推进。UI 不需要等待模型说完才知道它打算执行命令。

### 5. 路由并执行工具

Tool Router 根据工具名称找到实现，解析参数，检查策略，再选择具体执行路径。源码里的 [`ToolRouter`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs) 同时持有工具注册表、模型可见的 `ToolSpec` 和当前 `ToolMode`。这个结构把“展示给模型的能力说明”与“真正可执行的 runtime”放在同一份最终计划里，避免 Prompt 声明了工具却没有实现，或实现存在但模型根本看不见。

执行成功后，结果被规范化为模型能稳定消费的 Tool Result。

一个好的 Tool Result 不该只有一串 stdout。它至少需要表达：

- 成功或失败；
- 退出码或结构化错误类型；
- 输出是否被截断；
- 是否产生副作用；
- 长输出如何继续读取；
- 进程是否仍在运行。

模型看到 `failed` 只能猜。`permission_denied`、`timeout`、`not_found`、非零退出码和沙箱拦截会导向完全不同的下一步。

### 6. 把工具结果写回，再次调用模型

工具结果追加到模型历史，Core 发起下一次 Responses API 请求。模型可能继续读文件、修改补丁、运行测试，也可能输出最终答复。

只有模型不再请求工具，且没有待处理的执行或审批时，Turn 才结束。因此用户口中的“一轮”，在源码里通常是多次模型采样与环境反馈组成的闭环。

## 七、Tool Router：模型能力与真实能力之间的闸门

模型看到的是工具 schema，系统拥有的是工具实现。两者之间不能直接连线。

```text
tool call
   ↓ 解析与 schema 校验
Tool Router
   ↓ 策略判断
Approval Gate
   ↓ 执行边界
Sandbox / Exec Server
   ↓ 结果规范化
tool result
```

这层至少承担四项责任。

### 参数必须先校验

模型输出仍然是不可信输入。即使 JSON 语法正确，路径可能越界，枚举值可能不存在，组合参数也可能互相冲突。工具实现不能假设“模型应该懂”。

### 并发不能靠猜

两个只读搜索可以并行，两个修改同一文件的补丁则可能互相覆盖。是否并发应由工具元数据和运行时策略决定，不应完全交给模型自由发挥。

### 长任务需要句柄

测试、构建和服务器进程可能运行数分钟。统一执行层会返回会话或进程标识，后续工具可以继续读取输出、写 stdin 或终止进程。模型不用在一次 Tool Call 里等待到超时。

### 结果需要控制体积

巨量日志不应该原样进入上下文。运行时可以保留尾部、摘要或外部 artifact 引用，同时告诉模型内容被截断。隐藏截断会让模型误以为它已经看到了全部事实。

## 八、Approval 与 Sandbox 是两套机制

这是读 Codex 源码时最值得记住的设计之一。

Approval Policy 回答的是“谁同意这次操作”。Sandbox Policy 回答的是“即使同意，进程最多能碰到哪里”。

| 层 | 解决的问题 | 例子 |
| --- | --- | --- |
| Prompt 规则 | 引导模型怎样行动 | 不要修改生成目录 |
| Approval | 是否需要用户授权 | push 前询问 |
| Sandbox | 操作系统实际允许什么 | 只允许写 workspace roots |

Prompt 是软约束，模型可能误解，也可能受到仓库内容中的提示注入。审批用于表达人的意图，但频繁询问会产生确认疲劳。沙箱才是最终边界，它不依赖模型有没有“记住规则”。

Codex 在 macOS、Linux 等环境中接入不同的隔离实现。对 Harness 来说，上层只需要表达文件、网络和进程策略，底层再映射到相应平台能力。

这个分层还解释了为什么 `.git` 或 `.codex` 可以在普通 workspace-write 模式下被保护：工作目录可写，不代表目录里的所有敏感区域都自动可写。

## 九、Exec Server：为什么执行环境要独立

公开仓库中的 `exec-server` 把进程和文件系统操作封装为 JSON-RPC 服务。它可以服务本地调用，也能连接远程环境。

这样做有三点收益。

第一，Core 不必知道命令跑在本机、容器还是远程开发机。它只面对统一的启动、轮询、输入和终止协议。

第二，执行生命周期可以独立管理。客户端断开不一定意味着进程必须立刻消失，进程输出也可以作为事件继续传输。

第三，安全边界更清楚。模型循环不能随意拿到宿主机进程能力，只能通过受控协议访问环境。

Exec Server 本身不等于沙箱。它是执行抽象，沙箱是权限边界。两者可以组合，但职责不要混淆。

## 十、历史、Rollout 与 Response ID

Agent 有三种容易混淆的“记忆”。

```text
模型上下文：下一次推理能看到什么
事件历史：客户端、恢复和审计能看到什么
工作区状态：真实文件与进程现在是什么样
```

模型上下文可能被压缩，事件历史仍然可以完整保存。聊天里写着“测试通过”，也不等于工作区当前仍然通过测试。

Codex 会把用户输入、模型输出、工具调用和工具结果写入 Rollout，使 Thread 可以恢复或分叉。协议文档还提到保存 `response_id`，用于继续或派生模型侧上下文。

系统不必“记住所有 token”，但必须保存足够的可恢复事实：

- 当前目标与未完成事项；
- 已执行的工具调用及结果；
- 文件修改与外部副作用；
- 审批决定；
- 模型会话的续接标识。

恢复逻辑必须接受一个现实：事件记录和工作区可能已经分叉。用户可能在任务暂停后手动修改文件。因此恢复时仍要重新观察环境，而不是盲信旧消息。

## 十一、Context 与 Compact：裁掉什么比怎么总结更重要

编程 Agent 的窗口里，对话通常只占一部分，文件、搜索结果和测试日志才是大户。上下文管理首先是信息生命周期管理。

我会把信息分成三类：

1. 可以重新读取的事实，例如旧文件内容和构建日志；
2. 不容易重建的决策，例如用户明确选择了哪个方案；
3. 必须由程序维护的状态，例如进程句柄、权限和未完成调用。

第一类可以优先裁剪，第二类适合进入压缩摘要，第三类不该依赖摘要，必须保留在结构化状态里。

因此 Compact 不是简单的“让模型总结聊天”。它是一种有损状态迁移。好的迁移至少保住：目标、约束、已改文件、关键判断、失败原因、验收证据和下一步。

## 十二、中断、恢复和 Fork 为什么能工作

中断不是删除最后一条消息。它应该终止当前正在推进的 Turn，同时保留已经发生的 Item 和工作区变化。

恢复则在已有 Thread 上开启新 Turn，让模型先观察当前环境。Fork 会复制一份可续接历史，再从新的分支继续。三者都依赖前面那套事件与状态建模。

如果系统只保存最终回答，中断后就不知道哪些补丁已经应用、哪个测试仍在运行。Codex 把执行过程事件化，才有机会在停止后继续。

## 十三、多 Agent 与 Worktree

多 Agent 并不是多开几个聊天窗口。真正困难的是上下文隔离、权限继承和文件冲突。

每个子任务需要自己的 Thread 或执行状态，只把必要结果带回父任务。会写文件的并行任务最好使用独立 Git Worktree。否则两个 Agent 同时修改一个目录，模型层面再聪明也挡不住文件竞争。

Worktree 提供的是物理隔离：

```text
主任务工作区
├── Agent A worktree：修改认证模块
└── Agent B worktree：补集成测试
```

最终仍可能发生 Git 冲突，但冲突出现在清晰的合并边界，而不是运行到一半时互相覆盖文件。

## 十四、从 Codex 源码里能抄走什么

### 1. 协议先于界面

先定义 Thread、Turn、Item 和事件，再做终端或网页。否则每加一个界面，就会复制一套模糊状态。

### 2. 状态放在程序里

进程句柄、审批结果、当前目录、文件变更和未完成调用是程序状态。不要让模型靠聊天文字“记住”。

### 3. 工具必须有契约

输入 schema、输出结构、副作用、并发性、超时和错误类型都应该显式定义。工具不是随手暴露的函数。

### 4. 权限与执行环境解耦

用户是否同意和操作系统是否允许是两件事。审批和沙箱各自负责一层，远程执行再由独立协议承载。

### 5. 流式事件是一等公民

文本、计划、命令、补丁、审批和错误都需要类型。日志字符串很容易写，后续却无法可靠恢复和重放。

### 6. 完成需要外部证据

模型说“已修复”只是一个 Agent Message。测试退出码、构建产物、diff 和用户定义的验收条件，才是 Turn 可以结束的证据。

## 十五、最后：Agent Loop 短，Harness 很长

Codex 的模型循环可以浓缩成几行伪代码，源码的大部分价值却在循环周围：协议、上下文、工具契约、执行隔离、事件、持久化和恢复。

模型负责提出下一步，Harness 负责让这一步在真实世界里可见、可控、可回退。模型能力越强，单次判断会越准确，但这套运行时不会因此消失。只要 Agent 仍然要接触文件、命令、网络和多人协作，可信性就必须由模型之外的系统提供。

## 参考资料

- [OpenAI Codex 官方开源仓库](https://github.com/openai/codex)
- [Codex Core README](https://github.com/openai/codex/blob/main/codex-rs/core/README.md)
- [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex App Server Client README](https://github.com/openai/codex/blob/main/codex-rs/app-server-client/README.md)
- [Codex Protocol v1](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md)
- [Codex Exec Server README](https://github.com/openai/codex/blob/main/codex-rs/exec-server/README.md)
- [Codex Tool Router 源码](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs)
- [App Server v2 Turn 数据结构](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)
- [App Server 通知事件类型](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ServerNotificationEnvelope.ts)
- [OpenAI Agents API：Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture)
