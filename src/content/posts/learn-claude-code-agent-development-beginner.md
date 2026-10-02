---
title: 从一个循环开始：用 Learn Claude Code 入门 Agent 开发
description: 面向第一次开发 Agent 的工程师，从 Learn Claude Code 的 s01 到 s03 读懂 Agent Loop、工具协议、ReAct、权限边界与完成条件，再给出一条可动手的进阶路线。
category: Agent
subcategory: Agent 工程化
articleClass: focused
featured: false
publishedAt: 2026-10-02
updatedAt: 2026-10-02
tags: [Agent, Learn Claude Code, Agent Loop, Tool Use, ReAct, Harness]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

第一次接触 Agent 开发，很容易从框架名词开始：ReAct、Memory、MCP、Multi-Agent、Context Engineering。每个词都能找到一套库，装完以后也能跑出 Demo，但模型为什么会连续行动、工具结果怎样回到下一轮、循环为什么会停，仍然藏在框架里面。

[Learn Claude Code](https://github.com/shareAI-lab/learn-claude-code)适合反过来学。它用 17 个递进章节重新搭建一个 Claude Code 风格的 Coding Agent。`s01` 只有 Agent Loop 和 Bash，`s02` 加工具注册与分发，`s03` 把权限判断插到执行之前。后面的规划、子 Agent、Skills、上下文压缩和 Memory 都继续挂在同一个循环上。

本文基于仓库提交 [`ce8f9f1`](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3)。它是教学项目，不是 Claude Code 官方源码，也不能代表 Anthropic 产品内部的全部实现。我们用它回答一个更适合入门的问题：一个模型怎样从“能回答”变成“能观察环境、采取动作并根据结果继续工作”的程序？

## 一、先确认你在开发哪一层

一个最小 Agent 产品可以写成：

```text
Agent 产品 = Model + Harness
```

Model 根据当前输入生成文本或工具请求。Harness 保存消息、声明工具、执行动作、回传结果，并控制权限和生命周期。大多数应用工程师所说的“开发 Agent”，实际工作集中在 Harness。

这和训练模型是两件事。微调、偏好优化会更新模型参数；给模型增加 `read_file`、数据库查询或浏览器工具，则是在改变模型能够观察和操作的环境。当前会话的历史、工具结果和项目规则也由 Harness 组织，它们不会因为一次调用自动写进模型参数。

Anthropic 在[《Building effective agents》](https://www.anthropic.com/engineering/building-effective-agents)中还区分了 Workflow 与 Agent：Workflow 的代码路径由程序预先决定，Agent 则由模型动态决定过程和工具使用。两者可以组合。发布审批适合固定 Workflow，排查一个陌生代码库则需要模型根据刚读到的文件决定下一步。

如果模型只回答一次文本，程序没有把它的动作落到环境里，也没有把新观察送回来，那仍然是一次普通的模型调用。Agent Loop 补上的就是这段往返。

## 二、最小 Agent Loop 只有六个动作

先忽略 Memory、规划和多 Agent，一个能够使用客户端工具的循环只做六件事：

1. 把任务和历史消息发给模型；
2. 同时告诉模型有哪些工具及其参数；
3. 从响应中读取 `tool_use`；
4. 执行工具；
5. 用同一个 `tool_use_id` 回传 `tool_result`；
6. 没有工具请求时退出。

![Learn Claude Code 最小 Agent Loop 中模型、Harness 与环境的职责](/images/posts/learn-claude-code-agent-loop.svg)

图里的环路发生在 Harness 内。模型不会自己运行 Shell，也不会在下一次 API 请求中自动记得工具输出。程序必须保留消息，并把模型刚才的响应和真实执行结果按协议追加进去。

Learn Claude Code 的 [`s01_agent_loop/code.py`](https://github.com/shareAI-lab/learn-claude-code/blob/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s01_agent_loop/code.py)有 151 行，其中核心形状可以缩成下面这段：

```python
def agent_loop(messages):
    while True:
        response = client.messages.create(
            model=MODEL,
            system=SYSTEM,
            messages=messages,
            tools=TOOLS,
            max_tokens=8000,
        )
        messages.append({
            "role": "assistant",
            "content": response.content,
        })

        tool_calls = [
            block for block in response.content
            if block.type == "tool_use"
        ]
        if not tool_calls:
            return

        results = []
        for block in tool_calls:
            output = run_bash(block.input["command"])
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output,
            })

        messages.append({"role": "user", "content": results})
```

代码短，是因为 Messages API 已经处理了模型推理与结构化工具请求。Harness 仍然承担了四类状态：`messages` 保存运行轨迹，`TOOLS` 定义动作空间，`run_bash` 把请求变成副作用，循环条件决定这一轮是否继续。

### `messages` 保存完整运行状态

第一轮输入可能只有用户任务：

```python
messages = [
    {"role": "user", "content": "找出测试失败的原因并修复"}
]
```

模型请求执行测试后，轨迹会变成：

```text
user:      找出测试失败的原因并修复
assistant: tool_use(bash, "pytest -q", id="toolu_01")
user:      tool_result(id="toolu_01", "1 failed, 8 passed ...")
```

下一次模型调用会重新接收这三段内容。模型能根据报错继续行动，是因为 Harness 把观察结果放回了 Context。删掉 `tool_result`，模型就只能猜测试发生了什么；删掉前面的 `tool_use`，结果又失去了对应动作。

[Anthropic 的工具使用文档](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)要求客户端工具结果紧跟对应的工具请求，并用 `tool_use_id` 关联。并行返回多个工具请求时，也要为每个请求提供结果。这个 ID 是协议关联键，不是业务操作的幂等键，不能用它防止重复付款、重复发消息或重复部署。

### Tool Schema 定义模型能采取哪些动作

`s01` 只向模型暴露一个 Bash 工具：

```python
TOOLS = [{
    "name": "bash",
    "description": "Run a shell command.",
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string"}
        },
        "required": ["command"],
    },
}]
```

名称、描述和 Schema 一起构成模型看到的动作说明。模型先生成一段满足协议的结构化请求，Harness 再把其中的 `name` 映射到本地实现。

工具描述太宽，模型不知道什么时候该用；参数语义模糊，模型会把路径、ID 和自然语言混在一起；返回值只写 `failed`，下一轮又没有足够信息修正。工具 API 既服务普通程序，也服务一个根据自然语言描述选择动作的调用者。Anthropic 在[工具设计经验](https://www.anthropic.com/engineering/writing-tools-for-agents)中建议从少量、边界清楚、可组合的高影响工具开始，再用评测轨迹迭代。

### “没有工具调用”只是循环退出条件

`s01` 在响应里找不到 `tool_use` 就返回。这是一条很适合教学的规则，却不能自动证明任务完成。

模型可能因为以下原因停止调用工具：

- 它真的完成了任务；
- 它认为自己完成了，但没有运行测试；
- 输入条件不足，需要用户补充信息；
- API 输出被 `max_tokens` 截断；
- 模型拒绝继续；
- 它误判下一步不需要工具。

Messages API 的 `stop_reason`能够区分 `end_turn`、`tool_use`、`max_tokens`、`refusal` 等情况。[官方停止原因说明](https://docs.anthropic.com/en/api/handling-stop-reasons)要求调用方针对不同原因处理。教学循环只检查内容块，是为了把主干暴露出来；实际系统还应检查停止原因、步数、总耗时和预算，并保留 `completed`、`needs_input`、`failed`、`budget_exhausted` 等不同状态。

## 三、这条循环和 ReAct 是什么关系

[ReAct 论文](https://arxiv.org/abs/2210.03629)研究的是把推理轨迹与任务动作交错，让模型通过外部环境取得新信息，再更新后续判断。经典表达常写成：

```text
Thought → Action → Observation → Thought → ...
```

Learn Claude Code 没有在普通文本里解析 `Action: bash`。现代模型 API 直接输出结构化 `tool_use`，Harness 执行后返回 `tool_result`。从系统行为看，仍然存在行动与观察的往返：

```text
模型根据当前 Context 选择动作
  → Harness 执行动作
  → 环境产生可观察结果
  → Harness 把结果加入下一轮 Context
  → 模型重新选择动作
```

这里不需要程序读取或保存模型的私有思维链。可观察、可审计的对象是工具请求、工具参数、工具结果、外部状态变化和最终回答。模型可以在内部完成推理，Harness 只消费协议允许它看到的输出。

ReAct 解释了循环为什么有效：动作让模型接触训练参数之外的当前事实，观察结果又能纠正上一轮判断。但它没有替系统解决权限、幂等、超时、上下文上限和验收。那些都属于 Harness 的责任。

## 四、先在临时目录运行 `s01`

仓库当前推荐从根目录的 `s01` 到 `s17` 学习，不要把旧版 `agents/` 下的 12 章编号混进来。准备步骤以项目的[当前 README](https://github.com/shareAI-lab/learn-claude-code/blob/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/README-zh.md)为准：

```bash
git clone https://github.com/shareAI-lab/learn-claude-code.git
cd learn-claude-code

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 在 .env 中填写 ANTHROPIC_API_KEY 和 MODEL_ID
```

`s01` 会执行模型生成的 Shell 命令。第一次运行时，不要把工作目录放在真实项目、家目录或装有凭据的目录中。可以单独准备一个练习目录：

```bash
mkdir -p /tmp/agent-loop-lab
cd /tmp/agent-loop-lab
python /path/to/learn-claude-code/s01_agent_loop/code.py
```

然后给它一个只读任务：

```text
List the files in this directory, inspect any Python files,
and explain what the project currently does. Do not modify files.
```

运行时先观察四件事：

1. 模型返回文本还是 `tool_use`；
2. 每次工具请求的参数是什么；
3. Shell 输出怎样成为下一条 `tool_result`；
4. 模型在哪一轮停止调用工具。

先别急着做网页、数据库或多 Agent。只要能把一条完整轨迹解释清楚，就已经理解了 Agent 的最小运行机制。

### 151 行里，循环之外还有什么

`s01` 文件共有 151 行，但循环主体只占其中一小段。其余代码处理环境变量、终端输入、Windows 与 Unix 差异、超时、输出截断和异常。这些代码没有偏离主题，反而说明 Harness 必须接住模型之外的现实条件。

例如 `run_bash` 设置 120 秒超时，并把输出截到 50,000 个字符。超时防止单条命令永远占住循环，截断避免一个巨型日志立刻吞掉 Context。代价也很清楚：定位问题所需的报错可能位于被截掉的后半段。更完整的实现会把大结果落盘，返回摘要和文件位置，让模型按需读取。

文件里的危险命令字符串检查只能减少练习时的明显误操作。它不是 Shell 安全解析器，也没有操作系统级隔离。只要 Agent 拿到了通用 Shell，字符串变体、脚本文件、子进程和间接调用都可能绕开简单列表。这个边界要在学习 `s03` 时继续处理。

## 五、`s02` 把工具做成可扩展的动作空间

只给 Bash 的好处是代码少，问题是模型必须把“读文件”“修改精确片段”“查找路径”翻译成 Shell 语法。不同操作系统的命令不同，转义和路径也容易出错。模型还可能为了一次简单读取，生成拥有更大权限的命令。

[`s02_tool_use/code.py`](https://github.com/shareAI-lab/learn-claude-code/blob/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s02_tool_use/code.py)保留原来的循环，新增四个文件工具和一张分发表：

```python
TOOL_HANDLERS = {
    "bash": run_bash,
    "read_file": run_read,
    "write_file": run_write,
    "edit_file": run_edit,
    "glob": run_glob,
}

for block in tool_calls:
    handler = TOOL_HANDLERS.get(block.name)
    output = (
        handler(**block.input)
        if handler
        else f"Unknown: {block.name}"
    )
```

增加新工具时，开发者做两件事：把工具说明加入 `TOOLS`，再把本地函数注册进 `TOOL_HANDLERS`。Agent Loop 不需要知道 `read_file` 怎样读文件，也不用为每个工具新增分支。

这形成了三个不同层次：

| 层 | 面向谁 | 负责什么 |
| --- | --- | --- |
| Tool Schema | 模型 | 说明动作名称、用途和参数 |
| Dispatcher | Harness | 把工具名路由到实现 |
| Handler | 外部环境 | 执行真实操作并返回结果 |

分层以后，工具实现可以单独测试，权限也能按工具类型处理。只读工具默认放行，精确编辑要求路径位于工作区，删除或外部写入则需要审批。

### `safe_path` 展示了边界应该放在哪里

`s02` 的文件工具先把用户参数解析到工作目录，再检查最终路径是否仍在工作区：

```python
def safe_path(p: str) -> Path:
    path = (WORKDIR / p).resolve()
    if not path.is_relative_to(WORKDIR):
        raise ValueError(f"Path escapes workspace: {p}")
    return path
```

检查 `resolve()` 后的路径很重要。只检查字符串是否以工作目录开头，挡不住 `../../secret` 和一部分符号链接路径。权限规则应约束最终资源，而不是相信模型提供的原始字符串。

不过 `safe_path` 只保护四个专用文件工具，Bash 仍然可以访问更广的路径。这里能得到一条实用经验：专用工具的权限更容易描述和验证，通用 Shell 则需要进程级沙箱、文件系统限制和网络策略。给模型一个“万能工具”会降低工具数量，也会放大权限面。

### 多个工具请求不等于可以安全并行

模型可能在一次响应中生成多个 `tool_use`。`s02` 按内容块顺序逐个执行，行为简单且可预测。生产系统可以并行执行互不依赖的只读调用，例如同时读取几个文件；写文件、运行迁移或依赖前一步输出的动作仍要串行。

是否并行不能只看“模型一次返回了几个调用”。Harness 需要知道工具是否只读、是否访问同一资源、有没有顺序依赖，以及失败后是否能重试。否则一次响应里的两个编辑可能互相覆盖。

## 六、用一条修复轨迹看懂数据怎样流动

假设练习仓库里有一个 `duration.py`，`parse_duration("1h30m")` 错误地返回 30，测试要求它返回 90。下面是一条示意轨迹，格式与 `s02` 的工具协议一致，但具体动作仍由所选模型和 Context 决定。

初始目标和验收条件是：修复组合时长解析，并让现有测试通过，不修改测试文件。

```text
user
  修复 parse_duration 对 "1h30m" 的处理。
  不要修改测试，完成前运行测试。

assistant → tool_use
  glob({"pattern": "**/*.py"})

tool_result
  duration.py
  test_duration.py

assistant → tool_use
  read_file({"path": "duration.py"})
  read_file({"path": "test_duration.py"})

tool_result
  返回两个文件的内容

assistant → tool_use
  edit_file({
    "path": "duration.py",
    "old_text": "...",
    "new_text": "..."
  })

tool_result
  Edited duration.py

assistant → tool_use
  bash({"command": "python -m unittest -q"})

tool_result
  Ran 4 tests in 0.01s\nOK

assistant
  说明修改位置和测试结果
```

这条轨迹里有三种证据。源文件说明当前实现，测试文件给出约束，测试进程的退出与输出支持“修复完成”。模型生成的最终总结不是独立证据，它只是引用前面已经发生的环境事实。

如果 `edit_file` 返回 `text not found`，下一轮应重新读取文件或缩小匹配范围；继续提交同一个编辑只会重复失败。如果测试命令超时，Harness 应返回超时状态，而不是空输出。错误结果要保留动作、原因和可修正信息，模型才有条件换一条路径。

## 七、`s03` 在副作用之前插入权限闸门

工具 Schema 告诉模型“能请求什么”，不代表所有请求都应该执行。`s03` 在 Dispatcher 前增加权限管线：

![Learn Claude Code s03 的三段权限判断与工具执行边界](/images/posts/learn-claude-code-permission-boundary.svg)

[`s03_permission/code.py`](https://github.com/shareAI-lab/learn-claude-code/blob/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s03_permission/code.py)把决策拆成三段：

- 硬拒绝列表处理任何时候都不允许的操作；
- 规则匹配识别工作区外访问和潜在破坏性命令；
- 命中规则后暂停，由用户批准或拒绝。

循环只多了一个检查：

```python
if not check_permission(block):
    results.append({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": "Permission denied.",
    })
    continue
```

拒绝结果仍然回到模型。这样模型知道动作没有发生，可以选择只读方案、修改目标路径或请求用户解释。若 Harness 直接丢掉被拒绝的调用，消息协议会缺失对应的 `tool_result`，模型也无法区分“还在执行”和“明确拒绝”。

### 教学权限规则不能直接当安全产品

仓库文档明确说明，简单字符串拒绝表只是为了展示闸门位置。真实 Shell 命令可以通过变量、脚本、解释器、编码和子进程表达同一副作用。`rm -rf /` 没出现，不等于命令安全。

一套更可信的边界通常分成几层：

| 层 | 例子 | 能解决什么 |
| --- | --- | --- |
| 工具层 | 只提供 `read_file`、`search`、`apply_patch` | 缩小动作空间 |
| 参数层 | 规范化路径、Schema 校验、资源白名单 | 拒绝越界输入 |
| 策略层 | `allow / ask / deny`、风险分级 | 表达用户授权 |
| 运行层 | 容器、工作树、文件系统和网络沙箱 | 限制实际影响范围 |
| 审计层 | 保存请求、批准者、结果与变更 | 支持追踪和恢复 |

Prompt 可以提醒模型不要删除文件，但不能替代这些执行检查。模型负责提出动作，Harness 决定动作是否具备授权和运行条件。

## 八、从 `s04` 到 `s17`，增加的是哪类责任

前三章已经形成最小骨架：循环负责推进，工具连接环境，权限控制副作用。后续章节没有替换这条骨架，而是把长任务暴露出的责任逐步挂上去。

![Learn Claude Code 从最小循环到目标闭环的学习路线](/images/posts/learn-claude-code-learning-path.svg)

可以把 17 章压缩成五段学习路线：

| 阶段 | 章节 | 新增责任 | 先观察什么 |
| --- | --- | --- | --- |
| 能安全行动 | s01-s04 | Loop、工具、权限、Hooks | 一次动作怎样请求、执行和回传 |
| 能处理长任务 | s05-s09 | Todo、子 Agent、Skills、压缩、Memory | 状态放在哪里，哪些信息进入 Context |
| 能跨时间运行 | s10-s12 | 任务依赖、后台命令、Cron | 进程和会话结束后什么仍然存在 |
| 能协作与扩展 | s13-s15 | Agent Teams、MCP、集成 Harness | 隔离、通信、认领和工具命名空间 |
| 能编排并收口 | s16-s17 | Workflow Journal、Goal Loop | 谁判断完成，失败后从哪里恢复 |

### Hooks：给扩展逻辑稳定插口

权限、日志和自动格式化如果都直接写进 `agent_loop`，循环会很快变成大量条件分支。`s04` 引入工具执行前后的 Hook，让审计、阻止或结果加工成为可注册扩展。主循环仍然只负责状态推进。

Hook 的价值在于调用时机和契约固定，不在于名字。一个 `PreToolUse` Hook 必须能看到工具名与参数，并且有明确的允许、拒绝或改写语义；`PostToolUse` 要区分成功、失败和结果未知。否则它只是另一个散落的回调列表。

### Todo、子 Agent 与 Skills：管理任务和 Context

`s05` 把计划做成工具状态，模型可以创建、更新和完成 Todo。计划不应只存在于一段自然语言里，否则上下文压缩后很难继续维护。`s06` 给子任务一份新的 `messages[]`，主 Agent 只接收最后结果，从而隔离探索噪声。

`s07` 的 Skills 采用渐进加载。常驻 Context 只放技能名称和简介，选中后再读取完整说明与资源。它解决的是“有哪些知识可用”和“本轮真正需要哪些知识”的分离，不是把更多 Markdown 一次性塞进系统提示。

### Compact 与 Memory：一个管当前会话，一个管跨会话知识

`s08` 处理 Context 预算：先控制巨型工具结果，再裁剪可重建内容，最后才用摘要替换较早历史。压缩会损失细节，因此关键目标、文件状态和未完成事项不应只依赖一段自由摘要。

`s09` 的 Memory 面向跨会话复用，拆成选择、提取和整理。聊天历史的每句话都保存下来不等于有效记忆。可复用事实需要来源、范围和更新机制，过期结论也要能被合并或删除。

### Task、Teams、Workflow 与 Goal：让“结束”成为系统决策

`s10` 以后，任务状态开始持久化，后台进程和定时触发拥有独立生命周期；`s13` 增加队友通信、原子认领和任务绑定工作目录；`s14` 把 MCP 工具接进同一工具池；`s15` 展示多种机制如何回到一个 Harness。

`s16` 适合路径相对固定的 Workflow，把编排写进代码并用 Journal 恢复。`s17` 则在 Agent 准备结束时增加独立目标判断。两章正好说明 Workflow 与 Agent 可以协作：开放探索交给模型，固定流程与完成闸门交给程序。

## 九、入门项目：先做一个只读 Repo Scout

第一次自己写 Agent，不建议复制 `s15` 的完整 Harness。做一个只读代码库侦察器更容易看清机制，也降低误操作风险。

它只需要三个工具：

```text
glob(pattern)              查找文件
read_file(path, start, n)  分段读取文本
search(query, path)        搜索符号或关键字
```

任务可以定义为：读取陌生 Python 项目，找出入口、核心模块、测试命令和一个潜在风险，最后给出每条结论对应的文件位置。这个任务没有写操作，但需要模型多轮选择信息，已经足够体现 Agent 与一次性问答的差别。

### 第一版只实现四条不变量

1. 每个 `tool_use` 都产生对应的 `tool_result`；
2. 所有路径解析后必须位于工作区；
3. 循环有最大步数、总耗时和输出长度限制；
4. 最终结论必须引用本轮实际读取过的文件。

前三条可以由代码确定检查。第四条可以先做简单验证：记录成功读取的路径，最终回答里出现的证据路径必须属于这个集合。它不保证分析正确，但能拦住一部分凭空引用。

### 第二版再增加一个受控编辑工具

只读版本稳定后，再增加 `edit_file(path, old_text, new_text)`。执行前检查：

- 路径是否在工作区；
- `old_text` 是否恰好出现一次；
- 文件是否在允许类型中；
- 这次任务是否获得写权限；
- 修改后 diff 是否超过范围限制。

编辑成功不等于任务完成。再提供一个有限的测试工具，或允许特定命令前缀，例如 `python -m unittest`。让 Agent 用测试结果支持完成声明。

### 用固定任务集判断改动有没有变好

准备十个很小的练习仓库，每个仓库有明确答案：入口文件在哪里、哪个测试失败、允许修改哪些文件。每次调整工具描述、模型或 Prompt 后重复运行，记录：

| 指标 | 要回答的问题 |
| --- | --- |
| 任务成功率 | 最终状态是否满足验收条件 |
| 无效工具率 | 有多少调用没有带来新信息 |
| 越界请求数 | 模型提出了多少未授权动作 |
| 平均轮数 | 完成同类任务需要几次模型调用 |
| Context 消耗 | 工具定义和结果占用了多少 Token |
| 假完成率 | 模型声称完成但外部检查失败多少次 |

Agent 开发很难只靠“这次看起来挺聪明”判断。固定任务和完整轨迹能把变化落到具体故障上：是工具没选对、结果不可用、Context 被污染，还是完成条件太松。

## 十、初学者最常遇到的六类故障

### 模型始终不调用工具

先检查任务是否明确要求行动，以及工具名称、描述和参数是否足够具体。用户说“你觉得这个文件怎么改”时，模型给建议可能完全符合请求；要它执行，应明确“读取文件并完成修改”。不要一开始就靠强硬 Prompt 强制所有请求调用工具，普通问答并不需要副作用。

### 模型传出的参数不合法

Schema 应该尽量把约束前移：必填字段、枚举、数字范围和清晰描述都要写明。Handler 仍需校验，因为模型输出和外部输入都不可信。错误结果要指出字段、收到的值和允许范围，方便下一轮修正。

### 工具结果迅速撑满 Context

给读取与搜索工具增加分页、行数和结果数限制。大输出落盘后返回摘要、总量和位置。静默截断最危险，因为模型会把不完整结果当成完整事实。必须在返回值里明确说明还有多少内容未展示。

### Agent 重复同一个失败动作

记录规范化后的工具名和参数。如果连续调用完全相同，且上一次失败结果没有变化，Harness 可以返回“重复调用未产生新证据”，达到阈值后停止。更重要的是让第一次错误包含可行动信息，避免模型只能盲试。

### Agent 说完成了，但没有证据

把完成条件写成环境可检查的状态。例如测试退出码为 0、目标文件存在、API 返回指定字段。模型自评可以补充解释，不能取代这些检查。`s17` 的 Goal Loop 是这类机制的后续教材。

### 权限提示太多，用户开始无脑批准

权限粒度过粗时，读操作和高风险写操作都会弹窗。按工具和资源范围分类，安全的常见操作直接允许，明确危险的操作直接拒绝，只把少量上下文相关决策交给用户。审批界面要展示将执行的具体动作和影响范围。

## 十一、Learn Claude Code 和 Hello-Agents 怎么选

两个项目都能作为入门材料，教学角度不同。

[Hello-Agents](https://github.com/datawhalechina/hello-agents)是一套更广的系统教程，覆盖 Agent 基础、经典范式、框架、多 Agent 和应用案例。适合先建立概念地图，再按章节学习不同范式。

Learn Claude Code 更像一组连续的源码实验。每章只增加一项 Harness 机制，并保留独立可运行的 `code.py`。如果你的目标是亲手看见 `messages`、`tool_use`、Dispatcher、权限和压缩怎样进入循环，它更适合作为第一条实作主线。

一种省力的组合方式是：先读本文并动手完成 `s01-s04`，建立运行时直觉；再用 Hello-Agents 补 ReAct、Planning、Reflection 和多 Agent 的概念背景；最后回到 Learn Claude Code 的 `s05-s17`，观察这些概念怎样落实为状态和协议。

## 十二、读完以后应该能回答什么

入门 Agent 开发不要求先掌握所有框架。你至少应该能沿着一条真实轨迹回答这些问题：

- 当前任务和历史存放在哪里；
- 模型从哪里知道有哪些工具；
- 工具请求怎样映射到真实函数；
- 执行结果怎样与请求配对并进入下一轮；
- 哪一层决定允许、询问或拒绝；
- 为什么没有继续调用工具不等于已经完成；
- 哪些状态只属于当前 Context，哪些需要跨会话持久化；
- 如何用外部证据判断一次运行是否成功。

能回答这些问题后，再学习 Memory、MCP 和 Multi-Agent，新增机制就有了落点。它们是在解决上下文、扩展和协作问题，没有改变最里面那条循环：模型选择动作，Harness 执行动作，环境返回观察，下一轮基于新事实继续。

## 参考资料

- [shareAI-lab/learn-claude-code，本文取证提交](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3)
- [s01 Agent Loop 源码](https://github.com/shareAI-lab/learn-claude-code/blob/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s01_agent_loop/code.py)
- [s02 Tool Use 源码](https://github.com/shareAI-lab/learn-claude-code/blob/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s02_tool_use/code.py)
- [s03 Permission 源码](https://github.com/shareAI-lab/learn-claude-code/blob/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s03_permission/code.py)
- [Anthropic：Tool use implementation](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic：Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [Datawhale：Hello-Agents](https://github.com/datawhalechina/hello-agents)
