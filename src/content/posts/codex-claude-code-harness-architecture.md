---
title: Codex 与 Claude Code 的底层架构：模型之外，Harness 里到底有什么
description: 从源码与官方文档出发，拆解两款 Coding Agent 的会话模型、Agent Loop、上下文装配、工具执行、权限沙箱、压缩、记忆与多 Agent 机制。
category: Agent
subcategory: Agent 开发
featured: false
publishedAt: 2026-10-01
updatedAt: 2026-10-01
tags: [Codex, Claude Code, Agent Harness, Agent Loop, Context Engineering, Sandbox, SubAgent]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

Codex 和 Claude Code 给人的第一印象很像：都能搜索代码、修改文件、执行命令，也都能在失败后继续尝试。它们与普通聊天模型的差别，来自模型外面那套持续运转的程序，不只是多了几个工具。

这套程序负责决定模型这一轮能看见什么，怎样把工具调用变成真实操作，哪些操作必须停下来等待批准，工具结果怎样写回历史，以及上下文快满时该丢掉什么。它通常被称为 Agent Harness。

我更愿意把它理解成 Agent 的运行时。模型负责在概率空间里给出下一步，Harness 把下一步放进一个有状态、有权限、有反馈的工程系统。

![Codex 与 Claude Code 的 Harness 分层架构](/images/posts/codex-claude-harness-layers.svg?v=20261001)

## 一、先说源码：两者并不是同一种“开源”

这个问题需要先讲清楚，否则后面的每一处实现细节都会混在一起。

### Codex 的核心运行时是官方开源的

OpenAI 的 [`openai/codex`](https://github.com/openai/codex) 仓库采用 Apache-2.0 许可证。Codex CLI、Rust 核心、App Server、协议类型、执行服务和沙箱相关代码都可以直接阅读。仓库里的 `codex-core` 明确承担 Codex 的业务逻辑，多种界面通过协议复用同一个核心。

不过，“Codex 开源”不等于所有 Codex 产品都完全开源。我们能直接分析的是本地 CLI 与公开仓库中的运行时。云端模型、托管服务和部分产品基础设施仍然是黑盒。

### Claude Code 没有官方开源仓库

Claude Code 是公开发布的软件，但 Anthropic 没有把完整客户端源码作为一个官方开源项目发布。网上所谓“Claude Code 源码”，主要来自某个 npm 版本随包暴露的 source map，以及研究者据此还原的客户端实现。

这类材料有两个限制：

1. 它只代表被还原的那个版本，内部结构可能很快变化；
2. 变量名、模块边界和未公开行为不能视为 Anthropic 的稳定接口。

因此，本文对 Codex 可以谈“源码如何实现”，对 Claude Code 则分两层：官方文档确认它现在具有什么行为，第三方源码还原只用来解释这些行为可能怎样组织。后者我会明确标注为“实现线索”。

## 二、两套系统共享同一个最小循环

无论具体模块叫什么，一个 Coding Agent 的主循环都可以缩成下面几行：

```ts
while (!finished) {
  const context = assembleContext(session, environment, tools);
  const response = await model.stream(context);

  if (response.requestsTools) {
    const results = await executeWithPolicy(response.toolCalls);
    session.append(results);
    continue;
  }

  finished = true;
}
```

这段伪代码故意省略了大部分难点。真实系统至少还要处理：

- 流式输出中的文本、计划、工具调用和错误事件；
- 工具参数校验、并行条件、审批和沙箱边界；
- 长时间运行的命令、超时、中断与恢复；
- 上下文预算、工具输出截断与压缩；
- 会话持久化、分支、回放和多 Agent 协作；
- 文件在 Agent 读取后又被人修改的竞态。

模型只决定“下一步倾向于做什么”。Harness 要把这个意图变成一次可观察、可约束、可恢复的状态转移。

![一次 Coding Agent 调用如何穿过 Harness](/images/posts/coding-agent-turn-lifecycle.svg?v=20261001)

## 三、Codex：把 Agent 做成一个可嵌入的运行时

从公开仓库看，Codex 最鲜明的架构特征是协议优先。终端界面、IDE、桌面应用或其他客户端不必各自实现一套 Agent Loop，它们通过 App Server 与 Codex Core 交互。

可以把本地 Codex 拆成五层。

### 1. 客户端层

客户端负责呈现和交互，例如：

- 展示模型文本和计划进度；
- 渲染文件修改、命令输出和 diff；
- 处理用户批准、拒绝、补充输入和中断；
- 恢复已有线程，或从历史状态分叉出新线程。

客户端不应自己猜测 Agent 当前处于什么状态。它从事件流中获取事实，再把用户操作作为请求发回运行时。

### 2. App Server 与协议层

`codex app-server` 是丰富界面连接 Codex 的接口。它使用双向 JSON-RPC，把一次交互表示为三个主要对象：

```text
Thread
└── Turn
    ├── Item: user message
    ├── Item: agent message delta
    ├── Item: command execution
    ├── Item: file change
    └── Item: approval request
```

Thread 是持续存在的对话，Turn 是一次用户驱动的工作回合，Item 是回合内可被 UI 展示和持久化的原子事件。

这套结构解决了一个很实际的问题：Agent 的输出并不是一段最终文本。执行十分钟的任务时，客户端需要知道它正在读文件、等待审批、运行测试，还是已经失败。如果只返回一个字符串，UI 只能显示一个旋转图标。

App Server 还让传输层与核心逻辑分开。今天可以通过本地 stdio 连接，远程场景也可以把同一套协议放到其他传输上。协议版本和生成的类型成为客户端与运行时之间的边界。

### 3. Codex Core：会话、任务与 Agent Loop

公开的协议说明里，Codex Core 在本地后台线程或独立进程中运行。客户端通过 Submission Queue 发送输入，Core 再通过 Event Queue 持续发出事件。

旧协议文档使用 Session 和 Task 等术语，新版 App Server 主要暴露 Thread、Turn、Item。名称在演进，核心关系没有变：

- 长生命周期对象保存配置与对话状态；
- 一次工作回合持有当前输入、模型配置、目录、权限和沙箱策略；
- 每次模型返回工具调用后，Core 执行工具并把结果送入下一次模型请求；
- 模型不再请求工具并生成最终消息，回合才完成。

这也是为什么 Codex 可以被随时打断。中断会终止当前任务，同时保留已经产生的历史事件；它处理的是运行状态，不是删除最后一段文本。

### 4. 工具路由与执行层

模型看到的是工具定义，系统真正拥有的是工具实现。两者之间需要一层路由：

```text
模型生成 tool call
      ↓
解析名称与参数
      ↓
参数校验与策略判断
      ↓
需要批准？等待用户
      ↓
在沙箱或执行服务中运行
      ↓
把结构化结果写回会话
```

Codex 把“能否执行”和“在哪里执行”拆开。Approval Policy 决定何时询问用户，Sandbox Policy 决定进程获得哪些文件和网络权限。Prompt 中写着“不要修改某个目录”属于行为提示；操作系统拒绝写入那个目录才是执行边界。

本地执行时，macOS 可以使用 Seatbelt，Linux 可以使用 Landlock 或相关隔离机制。公开仓库中的 `exec-server` 进一步把进程和文件系统操作封装为独立协议。Harness 可以在本机执行，也可以连接远程环境，而不必把远程执行逻辑塞进模型循环。

长时间命令也由执行层管理。启动测试后，模型不需要阻塞等待全部输出。系统保存会话标识，后续可以继续读取输出、写入 stdin 或终止进程。

### 5. Rollout、历史与恢复

Agent 做过什么不能只存在内存里。Codex 会记录输入、模型输出、工具调用和结果，使线程可以恢复、回放或分叉。

这里有一个容易忽略的区别：

- 对话历史服务于模型下一轮推理；
- 事件历史服务于 UI、恢复和审计；
- 工作区文件保存任务产生的真实状态。

三者有关联，却不能互相替代。模型上下文被压缩后，事件历史仍然可以完整保存；聊天里说“测试通过”也不能替代工作区里的真实测试结果。

## 四、Codex 一轮请求怎样跑完

把各层串起来，一次 Turn 大致经历下面的过程。

### 第一步：冻结本轮配置

运行时读取用户输入、当前目录、模型、工具集、审批策略和沙箱策略。冻结快照很重要，因为一次模型调用进行到一半时，如果可用工具或权限突然变化，随后返回的工具调用可能已经不再符合当前环境。

### 第二步：装配上下文

上下文通常包含：

```text
基础指令
+ 用户任务
+ AGENTS.md / 项目规则
+ 当前环境信息
+ 历史消息与工具结果
+ 本轮可见的工具定义
+ 按需加载的 Skills 或记忆
```

这并不是把仓库所有内容塞给模型。规则按目录层级发现，文件按任务需要读取，长工具结果会截断或落盘。稳定内容尽量保持在 Prompt 前缀，变化内容追加在后面，这样更容易利用 Prompt Cache。

### 第三步：消费 Responses API 的流

模型响应被拆成事件。文本增量可以立即显示，计划更新进入计划视图，工具调用交给路由器。运行时不必等整段响应结束才知道发生了什么。

### 第四步：执行工具并规范化结果

工具层校验参数，检查审批与沙箱，再执行命令或补丁。结果要转换成模型能稳定消费的结构，包括成功状态、输出、错误类别、是否截断，以及继续读取结果的方法。

错误如果只有 `failed`，模型只能猜。`permission_denied`、`timeout`、`not_found` 和非零退出码会指向完全不同的下一步。

### 第五步：继续或结束

工具结果写入历史，Core 再发起下一次模型请求。模型可能继续读文件、修改代码和运行测试。只有当它返回最终消息且没有待处理工具时，Turn 才结束。

所以一次 Turn 可以包含几十次模型请求。用户看到的是一轮任务，运行时看到的是多次“采样、执行、观察”的循环。

## 五、Claude Code：终端优先的 Agent 编排器

Anthropic 官方文档确认，Claude Code 在终端、IDE、桌面端、Web 和远程控制等界面上复用同一套 agentic loop。代码可以在本机、Anthropic 托管 VM 或自建环境中执行。

从可观察行为和第三方实现线索看，它同样可以分成几层：

1. CLI 与多种交互界面；
2. 会话与 Query 循环；
3. System Prompt、项目指令、记忆和 Skills 的上下文装配；
4. Read、Edit、Bash、Grep、MCP 等工具调度；
5. 权限、沙箱、Hooks、Checkpoint 和持久化。

Claude Code 的风格更接近一个终端中的编排器。它把很多能力直接暴露为模型可调用的工具，连 Plan Mode 的进入和退出也可以表现为能力切换。主循环不必知道每个业务工具怎样工作，只要识别模型返回的是继续调用工具还是结束本轮。

### Query 循环：流式生成器很适合 Agent

第三方还原的客户端实现显示，Claude Code 的主查询循环采用异步流的形态。这个结构和产品行为能够对上：模型文本、工具调用、进度和中间状态都能边产生边交给 UI。

可以把它抽象成：

```ts
async function* runQuery(state) {
  while (true) {
    state = compactIfNeeded(state);

    const response = yield* streamModel(state);
    if (response.stopReason === "end_turn") return response;

    const toolResults = await executeToolCalls(response.toolCalls);
    state.messages.push(...toolResults);
  }
}
```

这里没有必要要求模型把 Thought 写成普通文本，再由客户端用正则提取 Action。现代模型 API 已经提供结构化工具调用和明确的停止原因。推理可以留在模型内部，Harness 只处理协议事件。

不过，把它称为“完全不同于 ReAct”也容易造成误解。从系统行为看，它仍然在反复执行“模型判断、工具行动、环境观察”。差别主要在协议表达：Thought 不必作为公开文本进入应用层，Action 与 Observation 变成了原生工具调用和结果。

## 六、Claude Code 的上下文是怎样拼起来的

Anthropic 官方文档列出的上下文来源包括：

- 当前会话历史；
- 文件内容与命令输出；
- System Instructions；
- `CLAUDE.md` 或 `AGENTS.md`；
- Auto Memory；
- 已加载的 Skills；
- MCP 工具定义与外部结果；
- 系统在运行期间追加的提醒。

这说明 Agent 开发里所谓“管理输入 LLM 的那一坨内容”，实际上是一套有优先级、有生命周期的装配系统。

### 稳定规则放在项目指令里

每个新会话都有新的上下文窗口。早期聊天细节可能在压缩时丢失，因此跨任务仍然有效的规则应写进 `CLAUDE.md` 或 `AGENTS.md`。这类文件适合保存构建命令、代码规范和项目边界。

Claude Code 还支持按路径触发规则。某条规则可以只在 Agent 读取匹配文件时进入上下文，避免所有前端、后端和数据库规则从会话开始就同时占用窗口。

### Skills 按需加载

模型在会话开始时只看到 Skill 的简短描述，需要使用时才加载完整内容。这是一种两级索引：先告诉模型“有哪些能力”，再为被选中的能力付出完整上下文成本。

### Auto Memory 只记不能轻易重建的信息

官方文档将 Auto Memory 分为用户、反馈、项目和外部引用四类，并明确跳过可以从代码、Git 历史或项目指令中推导的信息。

这个取舍很合理。代码结构如果已经改变，一条旧记忆会变成带权威感的错误；用户偏好和“某个看板在哪里”却无法从当前仓库恢复，值得跨会话保存。

## 七、上下文满了以后，两者都不能只做摘要

编程任务的上下文增长很快。一段测试日志可能比用户的全部对话还长，连续读取多个文件后，真正有用的决策会被工具输出包围。

两套系统都会使用几类手段：

1. 限制单次工具返回的大小，保留预览和继续读取入口；
2. 清理或截短较老的工具输出；
3. 保留工具调用与结果的配对关系，避免生成不合法历史；
4. 必要时压缩早期对话；
5. 压缩后重新注入不能丢的项目规则和工作状态。

Anthropic 官方文档明确说明，Claude Code 会先清理旧工具输出，再在需要时总结会话。用户也可以通过 `/compact` 指定摘要重点。Skills 和子 Agent 则从源头减少主上下文的负担：一个按需加载知识，另一个把探索过程放进独立窗口，只把结果摘要带回主会话。

Codex 的公开实现同样把截断和 compaction 当成运行时职责。这里最重要的认识是：

> 压缩是一种有损状态迁移，不能把它当成无副作用的字符串摘要。

好的压缩至少要保住当前目标、已修改文件、关键决策、失败原因、未完成事项和验收标准。否则模型虽然“记得大概聊了什么”，却接不上当前工作。

## 八、权限与沙箱为什么必须分开

两套工具都把模型输出视为不可信意图。它可以提出操作，但不能仅凭一句 Tool Call 获得无限权限。

### 审批回答“谁同意”

审批层处理的是授权：

- 这条命令是否需要询问用户；
- 用户的批准只对本次生效，还是可以形成规则；
- 当前是只读、接受编辑、自动判断，还是完全手动；
- 外部系统、网络与破坏性操作是否需要更高等级确认。

### 沙箱回答“即使同意，最多能做到什么”

沙箱通过操作系统能力限制文件、进程和网络。Prompt 中的安全规则可能被模型误解，也可能被注入内容覆盖；沙箱不依赖模型是否“记得听话”。

Codex 的公开核心在不同操作系统上接入原生隔离机制，并把 writable roots 等边界写进执行策略。Claude Code 官方文档也区分权限模式与 Bash 沙箱，支持文件系统和网络隔离。

两层必须同时存在。只有审批会让用户陷入确认疲劳，只有沙箱又无法表达“这次可以 push，但以后仍要问”。

## 九、Hooks 与事件协议走了两条不同路线

Codex 更强调统一事件协议。执行状态、文本增量、审批请求和工具结果都作为结构化事件流向客户端。这让多个 UI 可以复用同一个 Core，也便于持久化和恢复。

Claude Code 提供了更显式的 Hooks 扩展点。用户可以在会话开始、工具调用前后、配置变化等生命周期位置运行自定义逻辑，用来检查命令、执行格式化、补充上下文或阻止操作。

二者并不冲突，只是扩展重点不同：

| 维度 | Codex | Claude Code |
| --- | --- | --- |
| 外部界面 | App Server 与结构化事件 | 多表面共享同一 Agent Loop |
| 生命周期扩展 | Core 事件、工具与协议能力 | Hooks 是主要用户扩展点之一 |
| 工具接入 | 内置工具、Skills、MCP、Apps | 内置工具、Skills、MCP、Plugins |
| 运行环境 | 本地沙箱、远程 Exec Server、托管环境 | 本地、托管 VM、自建环境、Remote Control |

如果要自己做 Agent，事件协议更像系统骨架，Hooks 更像可插拔关节。成熟产品通常两者都需要。

## 十、子 Agent 并不是多开几个模型窗口

主 Agent 把任务委派出去后，至少要解决三个问题。

### 上下文隔离

Claude Code 官方文档说明，子 Agent 有自己的上下文窗口、系统提示词、工具和权限。它默认从新上下文开始，也可以从主会话 fork。子 Agent 的中间工具调用不会全部挤进主上下文，完成后只返回摘要。

Codex 的多线程也遵循类似原则：每个并行任务维护自己的状态和事件流。并行运行既节省时间，也隔离上下文，搜索日志和试错过程不会全部污染主任务。

### 权限继承

子 Agent 不能因为被委派就自动获得更高权限。父任务只读时，子任务不应绕过边界去修改文件。工具集和审批策略要作为显式配置传入，而不是靠 Prompt 口头约定。

### 工作区隔离

两个 Agent 共享同一目录并同时修改文件，很容易互相覆盖。Git Worktree 给每个任务独立工作区，是比“大家小心一点”更可靠的办法。最终合并仍然可能冲突，但冲突会出现在清晰的版本控制边界，而不是随机发生在运行中的文件里。

## 十一、Codex 与 Claude Code 的架构差异

把产品功能放在一边，只看 Harness，我认为差异主要在以下几处。

| 维度 | Codex | Claude Code |
| --- | --- | --- |
| 可验证源码 | 官方公开 Rust 仓库与协议 | 无官方开源仓库，只有官方文档与特定版本的第三方还原 |
| 架构重心 | 可嵌入 Core、App Server、类型化协议 | 终端优先的 Query 编排与生命周期扩展 |
| 会话抽象 | Thread、Turn、Item，事件模型清晰 | Session、消息、工具使用与本地 JSONL 历史 |
| 执行分离 | 独立 Exec Server 协议，适合本地与远程环境 | 本地工具、托管 VM、自建环境与远程控制 |
| 上下文扩展 | AGENTS.md、Skills、MCP、历史与压缩 | CLAUDE.md/AGENTS.md、Skills、Auto Memory、MCP 与系统提醒 |
| 安全主线 | Approval Policy 与 Sandbox Policy 分离 | Permission Modes、Sandbox、Checkpoint 与 Hooks |
| 多 Agent | 线程、委派与工作区隔离 | 独立上下文的 Subagents、fork、权限和持久记忆 |

Codex 的代码结构更适合作为“Agent runtime”研究：协议、Core 和执行器的边界清楚。Claude Code 的公开产品能力更像一套“Agent operating environment”：项目规则、记忆、Hooks、Skills 和子 Agent 都围绕终端工作流组织。

两者没有谁在所有层面更先进。它们解决的是同一组工程问题，只是对外暴露的扩展面和内部模块边界不同。

## 十二、如果自己实现 Coding Agent，先抄哪些设计

读完两套架构后，我会优先实现下面八件事。

### 1. 把状态留在程序里

当前目录、权限、未完成工具调用、进程句柄和修改文件列表都属于程序状态。不要让模型靠聊天记录记住这些事实。

### 2. 每次模型请求使用一致的快照

模型调用开始后，本轮工具定义和策略应保持一致。配置变化放到下一轮生效，避免模型根据旧工具表生成新环境无法执行的调用。

### 3. 工具必须有契约

参数 schema、结果结构、超时、错误类型、是否并发、是否有副作用，都应该在工具层定义。模型面对的不是任意函数，而是一组有边界的能力。

### 4. 权限规则交给客户端执行

项目指令可以提醒模型，硬边界必须由客户端、沙箱和组织策略执行。任何仅存在 Prompt 里的禁令都只能算软约束。

### 5. 先裁剪可重建信息，再压缩决策

测试日志和旧文件内容通常可以重新获取，用户目标与架构决定却很难恢复。上下文清理顺序应该反映这个差别。

### 6. 流式事件要成为一等公民

不要把 UI 建立在日志字符串之上。计划、命令、补丁、审批、错误和完成状态需要独立事件类型，之后才能可靠地做恢复、重放和远程控制。

### 7. 子 Agent 要隔离上下文与工作区

只隔离上下文还不够。会写文件的并行任务最好使用独立 Worktree，并在父任务中合并结果。

### 8. 完成必须有外部证据

模型说“已经修复”只是一个文本事件。Harness 应继续检查测试退出码、构建产物、diff 和用户定义的验收条件，再决定任务是否完成。

## 十三、我对 Agent Harness 的新理解

之前我把 Agent 开发概括为“管理 LLM 每一步看见的信息，在概率模型的不确定性之上构建可信系统”。拆完 Codex 和 Claude Code 后，这句话可以再具体一点。

管理模型输入只是上半场。Harness 还要管理模型输出怎样进入真实世界：

```text
输入侧：规则、历史、文件、记忆、工具定义、上下文预算
输出侧：参数校验、权限、沙箱、执行、事件、恢复、验收
```

如果输入侧失控，模型会看错信息；如果输出侧失控，模型的一次错误判断会直接变成破坏性操作。可信系统来自两边同时收紧，并在每次工具反馈后重新计算下一步。

模型能力继续增长后，Agent Loop 可能会变得更短，工具调用也会更准确。但会话、权限、隔离、压缩、审计和恢复不会因此消失。这些代码看起来没有模型炫酷，却决定了 Coding Agent 能不能在真实仓库里持续工作。

## 参考资料

- [OpenAI Codex 官方开源仓库](https://github.com/openai/codex)
- [Codex Core README](https://github.com/openai/codex/blob/main/codex-rs/core/README.md)
- [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex Protocol v1](https://github.com/openai/codex/blob/main/codex-rs/docs/protocol_v1.md)
- [Codex Exec Server README](https://github.com/openai/codex/blob/main/codex-rs/exec-server/README.md)
- [OpenAI Agents API：Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture)
- [Anthropic：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Anthropic：Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Anthropic：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Anthropic：Security](https://code.claude.com/docs/en/security)
- [Anthropic：Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide)
- [小林面试笔记：Codex Harness 源码解析](https://xiaolinnote.com/codex/source/codex_harness.html)
- [小林面试笔记：Claude Code 源码拆解](https://xiaolinnote.com/claudecode/source/cc_source.html)
