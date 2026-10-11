---
title: Agent 工具系统：Function Calling 之后，CLI、MCP、浏览器与代码怎样协作
description: 从一次日志查询出发，分清 Function Calling、CLI、MCP、浏览器、代码执行和沙箱所处的层次，解释同一个 RPC 为什么会有多种 Agent 接入方式。
category: Agent
subcategory: Agent 开发
articleClass: flagship
seriesOrder: 60
featured: false
publishedAt: 2026-08-01T15:46:00+08:00
updatedAt: 2026-10-12T00:10:00+08:00
tags: [Agent, Tool Use, Function Calling, CLI, Browser, Code Execution, MCP]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

公司里已经有一个日志查询 RPC。研发人员可以在终端里执行 `log-cli query --trace-id abc123`，Agent 平台也可以通过 MCP 调用 `query_log`。两条链路最后进入同一个 RPC，查询相同的数据，使用相同的权限系统。

那么 CLI 和 MCP 到底有什么区别？它们与 Function Calling 又是什么关系？浏览器和代码执行为什么也经常出现在 Agent 的工具列表里？

这些概念容易混在一起，是因为它们回答的并不是同一个问题：

- Function Calling 说明模型怎样提出一个动作；
- CLI、MCP、直接函数和 RPC 说明 Agent Runtime 怎样接入能力；
- 浏览器与代码执行说明 Agent 具体获得了什么能力；
- 沙箱、权限、审批和审计说明能力要在什么边界内运行。

本文沿着一次真实的工具调用把这些层次拆开。读完以后，至少应该能判断：一个已有 RPC 是否还需要包装成 MCP，Coding Agent 为什么可以直接复用 CLI，以及浏览器、代码执行和沙箱应当放在工具架构的哪个位置。

事实边界来自 OpenAI Function Calling 文档、MCP `2026-07-28` 规范、Python `subprocess`、Playwright Browser Context、Docker 与 gVisor 的官方资料。厂商字段仍会变化，文中重点讨论稳定的执行关系。

## 一、一张图先把层次放对

![Function Calling、能力接入、执行能力和安全边界的四层关系](/images/posts/agent-tool-system-layers.svg?v=20261011)

模型这一轮只能做两件事：生成普通回答，或者生成一个工具调用请求。Agent Runtime 收到请求后，才开始查找工具、校验参数、判断权限并选择执行路径。

同一个 `query_log` 可以直接调用 Java RPC Client，也可以转换成 CLI 命令，还可以交给 MCP Client。浏览器和代码执行则是另外两种具体能力，它们同样可以被 Runtime 直接实现，也可以藏在 CLI 或 MCP Server 后面。最下方的沙箱和策略作用于实际执行，并不因为接入方式换成 MCP 就自动存在。

这张图给出全文最重要的边界：

```text
Function Calling：模型如何表达“我要做什么”
CLI / MCP / RPC：Runtime 如何抵达这个能力
Browser / Code Execution：Runtime 最终让环境做什么
Sandbox / Policy：这次动作可以接触哪些资源
```

后面所有概念都可以放回这四层，不需要把五六个术语记成一排。

## 二、Function Calling 只产生调用请求

Function Calling，也叫 Tool Calling，是模型与 Agent 程序之间的结构化动作协议。应用程序先把工具名称、描述和参数 Schema 提供给模型。模型认为需要外部信息或动作时，返回工具名与参数。

例如 Agent 要查询一次调用链，模型可能返回：

```json
{
  "call_id": "call_42",
  "name": "query_log",
  "arguments": {
    "service": "order-service",
    "trace_id": "abc123",
    "limit": 100
  }
}
```

此时日志还没有被查询。模型只提交了一张调用申请单。Agent Runtime 还要完成下面这些动作：

1. 在工具注册表里找到 `query_log`；
2. 校验 `service`、`trace_id` 和 `limit`；
3. 判断当前用户是否可以查询这个服务；
4. 选择 CLI、MCP 或直接 RPC Adapter；
5. 执行调用并取得结果；
6. 把结果与 `call_id` 对应起来，再交给模型。

[OpenAI Function Calling 文档](https://developers.openai.com/api/docs/guides/function-calling)把这个过程拆成五步：向模型提供工具、接收 Tool Call、在应用侧执行、回传 Tool Output、继续生成回答。第三步明确发生在应用侧，因此 Schema 合法不等于操作已经执行，也不等于它具备业务权限。

### Function Calling 不关心工具怎样实现

模型看到的是 `query_log(service, trace_id, limit)`。它通常不需要知道实现代码是下面哪一种：

```text
Java ToolCallback → RPC Client
Shell Tool        → log-cli → RPC Client
MCP Tool          → MCP Server → RPC Client
Browser Tool      → 日志平台网页
```

这给工具系统留下了一个很有用的替换点。工具契约保持不变时，团队可以先用 CLI 接入，之后迁移到 MCP，也可以在测试环境使用假实现。模型侧仍然调用 `query_log`。

Function Calling 也不是所有 Agent 的唯一实现。早期 Agent 会让模型输出固定文本，再由程序解析 `Action:` 和 `Action Input:`。现代模型通常提供原生 Tool Call，因为结构更稳定，也更容易关联参数和结果。无论协议字段叫什么，核心过程都是模型提出动作、外部 Runtime 执行动作、结果回到下一轮。

## 三、Agent Runtime 才是工具调用的执行者

Agent Runtime 可以理解为模型外面的运行程序。Spring AI、Codex、Claude Code 或自建 Harness 都在承担这项工作，只是暴露的控制点不同。

一个最小 Runtime 至少要保存工具契约和实现映射：

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  adapter: "direct" | "cli" | "mcp" | "browser" | "code";
  risk: "read" | "workspace_write" | "external_write" | "dangerous";
};
```

模型只需要前三项。后面的 Adapter、风险等级、超时、凭据、输出上限和审批规则属于 Runtime 内部信息，不能靠 Prompt 代替。

最小执行过程可以写成：

```python
def dispatch(call, actor, task, registry):
    tool = registry.resolve(call.name)
    args = tool.input_schema.validate(call.arguments)

    decision = policy.evaluate(actor, task, tool, args)
    if decision.requires_approval:
        return pause_for_approval(call, decision.reason)
    if not decision.allowed:
        return denied_result(call, decision.reason)

    raw = adapters[tool.adapter].execute(
        args=args,
        limits=decision.limits,
        idempotency_key=call.idempotency_key,
    )
    return normalize_result(call, raw)
```

这段代码里，Function Calling 到 `call` 为止；CLI、MCP、浏览器和代码执行从 `adapter.execute` 开始。Policy 位于两者之间，负责把模型建议变成一次可控操作。

### 直接函数和 RPC 是最短路径

如果排障 Agent 本身就是一个 Java 服务，而日志 RPC 已经有稳定 SDK，最直接的实现是：

```java
@Tool(description = "根据服务名和 Trace ID 查询日志")
public LogResult queryLog(String service, String traceId) {
    return logRpcClient.query(service, traceId);
}
```

调用链只有：

```text
Function Call → Spring AI Tool → RPC Client → 日志服务
```

这条路没有 CLI 进程，也不需要 MCP。它适合单个应用内部使用，参数、超时和错误都能直接使用当前语言的类型系统表达。

当同一项能力还要提供给人、脚本、Coding Agent 或其他 Agent Host 时，才需要考虑 CLI 或 MCP。它们增加了一层适配，也扩大了复用范围。

## 四、CLI 和 MCP 是同一个能力的两种入口

CLI 与 MCP 最容易被误解成两种不同能力。公司内部更常见的情况是：业务能力早已存在于 RPC 或 HTTP 服务，CLI 和 MCP 只是两层薄封装。

![同一个日志 RPC 通过 CLI 与 MCP 提供给 Agent](/images/posts/agent-tool-surfaces.svg?v=20261011)

左边的 CLI 把命令行参数转换为 RPC 请求，再把结果打印到 stdout。右边的 MCP Server 接收 `tools/call`，把 JSON 参数转换为相同的 RPC 请求，再返回 Tool Result。两条链路的数据源、查询规则和业务权限可以完全一致。

### CLI 怎样提供给 Agent

CLI 是命令行接口。它并不等于“只能在本机做事”，内部完全可以调用远程 RPC：

```bash
log-cli query \
  --service order-service \
  --trace-id abc123 \
  --limit 100 \
  --output json
```

对于拥有 Shell 的 Coding Agent，接入 CLI 很直接。Skill 或仓库说明告诉模型命令格式，模型通过 Shell Tool 发起 Function Call，Runtime 启动进程并读取结果：

```text
模型 → Function Call: shell(command)
     → Agent Runtime
     → log-cli
     → 日志 RPC
```

CLI 的优势在于人也能使用。Agent 出错时，研发人员可以复制同一条命令在终端复现。命令还能进入 Shell 脚本、CI 和运维 Runbook，不要求调用方支持某个 Agent 协议。

它的契约由 `argv`、stdout、stderr 和退出码组成。若 CLI 只输出面向人的彩色表格，Agent 需要从文本中提取字段；提供 `--output json` 后，结果会稳定很多。CLI 的 `--help` 和使用文档承担工具发现作用，但 Runtime 不会天然获得一份统一的 JSON Schema。

执行固定命令时，最好直接传参数数组，而不是拼接完整 Shell 字符串：

```python
completed = subprocess.run(
    [
        "/usr/local/bin/log-cli",
        "query",
        "--service", service,
        "--trace-id", trace_id,
        "--output", "json",
    ],
    cwd=workspace,
    env=allowlisted_env,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    timeout=30,
    text=True,
    check=False,
)
```

Python [`subprocess` 文档](https://docs.python.org/3/library/subprocess.html)建议通常把参数作为序列传入。开放 `shell=True` 后，管道、重定向、命令替换和环境变量展开都会进入执行语义，权限检查必须覆盖完整命令，而不能只看第一个单词。

### MCP 怎样提供同一个 RPC

MCP 是 LLM 应用连接外部数据和工具的开放协议。Host 是 Agent 应用，Client 是 Host 内部的连接组件，Server 提供 Tools、Resources 或 Prompts。[MCP `2026-07-28` 规范](https://modelcontextprotocol.io/specification/2026-07-28)使用 JSON-RPC 2.0，并把核心请求定义为无会话、自包含的请求。

日志 MCP Server 可以暴露：

```json
{
  "name": "query_log",
  "description": "根据服务名和 Trace ID 查询日志",
  "inputSchema": {
    "type": "object",
    "properties": {
      "service": { "type": "string" },
      "trace_id": { "type": "string" },
      "limit": { "type": "integer", "minimum": 1, "maximum": 1000 }
    },
    "required": ["service", "trace_id", "limit"],
    "additionalProperties": false
  }
}
```

Host 通过 `tools/list` 获取定义，把选中的工具提供给模型。模型产生 Function Call 后，Host 再通过 MCP Client 发出：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "query_log",
    "arguments": {
      "service": "order-service",
      "trace_id": "abc123",
      "limit": 100
    }
  }
}
```

[MCP Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)规定了 `tools/list`、`tools/call`、输入 Schema 和可选的输出 Schema。MCP 给多个兼容 Host 提供了统一接入面，底层实现仍然可以是一行 RPC Client 调用。

### 两者的差别集中在接口契约

| 维度 | CLI | MCP |
| --- | --- | --- |
| 调用入口 | 可执行文件与参数 | MCP Client 与 `tools/call` |
| 工具发现 | 文档、`--help`、Skill | `tools/list` 与 Schema |
| 输入 | argv 或 Shell 字符串 | JSON 参数 |
| 输出 | stdout、stderr、退出码 | Tool Result、结构化内容、协议错误 |
| 人工使用 | 可以直接在终端运行 | 通常需要 MCP Client |
| Agent 使用 | 适合拥有 Shell 的 Coding Agent | 适合支持 MCP 的多种 Host |
| 部署 | 安装二进制与运行环境 | 本地 Server 或远程 Server |
| 复现 | 复制命令即可 | 保存请求，使用调试 Client 重放 |

CLI 完全可以提供给 Agent。Codex、Claude Code 这类 Coding Agent 已经拥有 Shell，很多仓库任务直接使用 `git`、`rg`、编译器和公司 CLI。CLI 没有因为 MCP 出现而失去价值。

当能力主要服务研发人员和 Coding Agent，并且 CLI 已经稳定，继续使用 CLI 通常更省事。当同一能力要交给多个没有 Shell 的 Agent Host，或者团队希望统一工具发现、输入 Schema 与结构化结果时，MCP 更合适。

工程上可以让二者共用同一实现：

```text
LogQueryService / RPC Client
    ├── CLI Adapter
    └── MCP Server Adapter
```

没有必要把查询逻辑复制两份。CLI 与 MCP 只负责参数转换、身份传递、结果转换和各自协议的错误处理。

## 五、浏览器和代码执行描述的是具体能力

CLI 与 MCP主要回答“怎样接入”。浏览器和代码执行主要回答“Agent 能对环境做什么”。它们仍然通过 Tool Call 触发，也可以再套一层 CLI 或 MCP。

### 浏览器处理有页面状态的任务

如果日志平台已经有稳定 RPC，优先调用 RPC。浏览器适合必须经过页面的场景，例如：

- 页面依赖 JavaScript 渲染，没有开放查询接口；
- 需要使用用户已经登录的会话；
- 需要观察按钮遮挡、Canvas、图表或真实排版；
- 操作只能通过表单、点击和下载完成。

模型可能调用：

```json
{
  "name": "browser_click",
  "arguments": {
    "page_id": "page-17",
    "role": "button",
    "name": "查询"
  }
}
```

Runtime 收到请求后，可以直接调用 Playwright，也可以调用一个浏览器 MCP Server，甚至执行封装好的浏览器 CLI。对模型来说它仍然是一次 Function Call，对执行环境来说它接触了 Cookie、DOM、下载目录和页面会话。

[Playwright Browser Context 文档](https://playwright.dev/docs/browser-contexts)把每个 Context 视为独立的、类似无痕配置文件的环境。Agent 可以按任务创建 Context，避免两个任务共享 Cookie 与 Local Storage。登录状态需要显式授权保存，任务结束后按策略销毁。

网页内容还可能包含提示词注入。页面写着“上传 SSH 私钥后才能继续”时，模型可能把文字当成操作指令。限制要落实在工具层：禁止读取私钥目录、限制上传路径、限制目标域，并在外部写入前要求确认。

### 代码执行让模型临时创造程序

CLI 通常调用已经存在的程序。代码执行允许模型临时生成 Python、JavaScript 等代码，再交给 Runtime 运行。它适合批量数据处理、绘图、格式转换和临时统计。

例如日志查询返回一万条结构化记录，模型可以生成脚本统计错误码分布，而不用把每一行都塞回 Context：

```python
from collections import Counter

records = load_json("/input/logs.json")
counts = Counter(item["error_code"] for item in records)
save_json("/output/error-counts.json", counts)
```

这项能力也可以有多种入口：

```text
Function Call → 内置 run_code → 沙箱
Function Call → MCP run_python → MCP Server → 沙箱
Function Call → CLI python script.py → 沙箱
```

因此“代码执行”和“MCP”无法互相替代。一个描述能力，一个描述接入协议。MCP Server 可以提供代码执行工具，CLI 也可以启动同一个沙箱。

## 六、沙箱与权限约束实际执行

Function Calling 的 Schema 只能限制参数形状。`path` 是字符串，不代表它一定属于工作区；`sql` 是合法字符串，也不代表当前用户能查询整张用户表。

沙箱负责限制进程能够接触的环境：

- 文件系统只挂载任务目录，输出写入独立目录；
- 网络默认关闭，按域名、IP 或服务身份放行；
- 凭据按本次操作注入，不继承 Host 的全部环境变量；
- CPU、内存、进程数、磁盘、输出大小和执行时间有上限；
- 任务结束后销毁运行环境，产物通过 Artifact 通道取出。

[Docker 资源约束文档](https://docs.docker.com/engine/containers/resource_constraints)说明容器默认没有 CPU 和内存上限，需要显式配置。[gVisor 架构说明](https://gvisor.dev/docs/architecture_guide/intro/)介绍了应用内核隔离，同时也列出了兼容性与性能成本。具体隔离强度要结合输入可信度、凭据范围和多租户风险选择。

接入方式不能替代沙箱。一个 MCP Tool 可能在 Server 内部执行任意 Shell，一个 CLI 也可能只是只读 RPC 的窄封装。判断风险时要看最终动作：它读取了什么、写入了什么、使用谁的凭据，以及失败后是否可以恢复。

### 权限绑定动作和资源

“允许使用 GitHub”或“允许使用日志平台”粒度太粗。读取公开 Issue、读取私有仓库、创建分支、合并 PR 的风险不同；查询本人负责的服务与查询全公司日志的范围也不同。

Policy 至少需要这些输入：

```text
谁：当前用户与 Agent 身份
做什么：工具名称与动作类型
对谁做：仓库、服务、文件路径或数据范围
在哪做：工作区、测试环境或生产环境
带来什么影响：只读、可恢复写入、外部写入或难恢复操作
```

工具出现在模型的候选列表里，只表示模型可以提出调用。执行前仍要重新校验参数和资源范围。高影响动作还要向用户展示可理解的预览，例如“将向 `shop/checkout#4821` 发布以下评论”，而不是只展示一段 `tools/call` JSON。

## 七、一次排障任务怎样走完整条链路

现在用一条任务把各层连接起来。

初始状态如下：用户给出订单号 `O-20261011-42`，要求定位支付失败原因。Agent 只允许读取生产日志和配置，不能修改生产状态；查询范围限定为订单、支付两个服务，最长追踪十分钟。

工具注册表里有三项能力：

```yaml
query_trace:
  adapter: cli
  implementation: log-cli
  risk: read

read_service_config:
  adapter: mcp
  server: config-center
  risk: read

analyze_logs:
  adapter: code
  runtime: python-sandbox
  risk: isolated_compute
```

### 第一步：模型提出日志查询

模型得到订单详情后生成：

```json
{
  "name": "query_trace",
  "arguments": {
    "service": "order-service",
    "order_id": "O-20261011-42"
  }
}
```

Runtime 校验服务范围，随后 CLI Adapter 转换为：

```bash
log-cli query \
  --service order-service \
  --order-id O-20261011-42 \
  --output json
```

CLI 调用日志 RPC，返回 Trace ID 与下游支付错误。Runtime 保留完整日志 Artifact，只把错误摘要、时间和 Trace ID 送回模型。

如果团队后来把 `query_trace` 改成 MCP，模型侧请求无需变化。注册表把 Adapter 从 `cli` 改为 `mcp`，Runtime 使用 MCP Client 调用 `query_trace`，MCP Server 仍进入同一个日志 RPC。

### 第二步：通过 MCP 读取配置

模型发现支付服务返回“渠道已关闭”，于是调用 `read_service_config`。MCP Client 已经通过 `tools/list` 获得 Schema，此时发送 `tools/call`。Config MCP Server 校验用户身份后读取配置中心，返回渠道状态与最后更新时间。

这一步说明 Function Calling 与 MCP 的分工：模型生成 `read_service_config` 调用，Host 决定把它路由到哪个 MCP Server，Server 再调用配置中心。模型不会直接建立 MCP 连接。

### 第三步：必要时才使用代码执行

如果一次查询只返回三条关键日志，模型直接阅读即可。只有返回量较大，需要按照错误码和机器分组时，Runtime 才把去敏后的日志 Artifact 挂载到代码沙箱，让模型生成统计脚本。

脚本无权访问生产网络，只能读取 `/input`，写入 `/output`。最终结果记录脚本、输入哈希、运行时版本和输出 Artifact。这样“渠道错误占 87%”才能回溯到具体输入与计算过程。

### 浏览器只在接口无法覆盖时介入

假设某个旧监控平台没有 RPC，也没有 CLI 或 MCP，Agent 才打开浏览器，输入 Trace ID 并读取图表。Browser Context 使用用户明确授权的登录状态，下载和外部写入默认关闭。

工具越多并不代表每个任务都要全部调用。这条排障链路优先使用稳定的结构化接口，浏览器负责补齐接口缺口，代码执行负责处理大量中间数据。

## 八、工具结果必须让下一轮能够判断

把所有工具统一成 `success: true/false` 会丢失关键信息。至少需要区分成功、明确失败、权限拒绝、等待批准和结果未知：

```ts
type ToolResult = {
  callId: string;
  status: "ok" | "error" | "denied" | "needs_approval" | "unknown";
  summary: string;
  data?: unknown;
  error?: {
    type: string;
    retryable: boolean;
    retryHint?: string;
  };
  sideEffect: "none" | "possible" | "confirmed";
  artifactRef?: string;
  evidence?: string[];
};
```

`unknown` 常出现在外部写操作已经发送，但 Runtime 在收到回执前断开连接。此时不能直接重试创建工单、发消息或部署操作。系统应当携带业务幂等键查询外部状态，再决定是否补发。Function Call 的 `call_id` 只负责关联模型请求与结果，下一轮重试可能得到新的 ID，不能替代业务幂等键。

不同失败要送回不同处理层：

| 故障 | 负责层 | 处理方式 |
| --- | --- | --- |
| 参数不符合 Schema | Runtime 校验器 | 返回字段错误，让模型修正 |
| 路径或服务超出范围 | Policy | 拒绝并说明允许范围 |
| CLI 退出码非零 | CLI Adapter | 返回 stderr 摘要与完整日志引用 |
| MCP Server 超时 | MCP Client / Runtime | 有上限重试，写操作先核验状态 |
| 浏览器元素失效 | Browser Adapter | 重新观察页面后再定位 |
| 代码超过资源配额 | Sandbox | 终止进程，限制再次执行 |
| 外部写入回执丢失 | Executor | 标记 `unknown`，使用幂等键核验 |

权限拒绝不应交给模型换一种工具绕过。CLI 查询被拒绝后改用浏览器查询同一数据，仍然属于同一资源权限。Policy 需要约束目标资源，而不是只限制某个 Adapter。

## 九、工具描述、结果和 Trace 怎样设计

工具名称、描述与 Schema 共同决定模型是否会选对能力。名称只写 `search` 时，代码搜索、日志搜索、文档搜索和互联网搜索容易互相争抢。

一个清楚的定义应说明使用时机、数据范围和替代工具：

```json
{
  "name": "search_code",
  "description": "在当前仓库的文本文件中搜索符号、字符串或正则。用于定位实现和引用；不要用于互联网资料、Git 历史或二进制文件。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string" },
      "paths": {
        "type": "array",
        "items": { "type": "string" },
        "maxItems": 20
      }
    },
    "required": ["pattern"],
    "additionalProperties": false
  }
}
```

工具数量增加以后，Runtime 可以先暴露简短目录，再按需加载详细 Schema。CLI 可以通过 Skill 建立目录，MCP 可以从 `tools/list` 获取目录，直接函数则来自应用内部注册表。来源不同，最后都要进入同一套可见性和权限规则。

每次工具调用还要形成 Trace，至少记录：

- 模型看见了哪些工具与版本；
- 模型选择了什么工具，参数摘要是什么；
- Policy 为什么允许、拒绝或请求批准；
- Runtime 选择了哪个 Adapter；
- 实际执行耗时、退出状态、重试和资源消耗；
- 返回内容在哪里被截断，完整 Artifact 在哪里；
- 是否产生外部副作用，结果是否已经确认。

敏感 Token、Cookie 和完整环境变量不应进入模型 Context 或普通日志。Trace 可以保存去敏后的参数与引用，原始证据由受权限保护的 Artifact 系统保存。

### 观察指标要能区分模型问题和工具问题

一次任务失败，原因可能是模型选错工具、参数错误、权限拒绝、CLI 输出无法解析、MCP Server 超时或者沙箱终止。只记录“Agent失败”无法确定应该修改 Prompt、Schema、Adapter 还是底层 RPC。

可以分别观察：

- 正确工具是否进入候选列表；
- 模型是否选择了正确工具；
- 参数是否一次通过校验；
- Adapter 调用是否成功；
- Tool Result 是否被下一轮正确理解；
- 是否出现重复副作用、结果未知或用户接管。

保存去敏后的 Tool Request 和 Tool Result 后，还可以固定工具结果，只替换模型或 Prompt，观察选择和恢复能力；也可以固定请求，重放 Adapter，检查 CLI、MCP 或浏览器实现是否稳定。

## 十、从最小工具系统开始

一个新的业务 Agent 不需要同时建设 CLI、MCP、浏览器和代码沙箱。可以按现有资产逐步扩展。

第一步先定义稳定的业务工具契约，例如 `query_trace`、`read_config` 和 `run_test`。模型看到的是业务动作，不是底层 RPC 的全部参数。

第二步选择最短接入方式。当前 Java 应用已经有 RPC SDK 时，直接调用；团队已经维护成熟 CLI 时，Coding Agent 先复用 CLI；多个 Agent Host 需要共享能力时，再建设 MCP Server。

第三步补齐执行边界。只读工具校验资源范围，工作区写入返回 diff，外部写入要求预览和确认。所有长输出进入 Artifact，模型只接收足够判断下一步的摘要。

第四步按真实任务增加浏览器和代码执行。没有 API 的页面再用浏览器，大量临时计算再开放代码沙箱。每增加一种能力，都复用同一个 Registry、Policy、Tool Result 和 Trace。

最后再处理规模问题，例如工具搜索、按需加载、Server 治理、版本兼容和分布式凭据。五个工具能够完成的系统，暂时不需要先建设一个复杂的企业 MCP 平台。

## 十一、设计检查表

| 问题 | 需要确认的内容 |
| --- | --- |
| 模型怎样提出动作 | 使用哪种 Tool Call 协议，参数怎样约束 |
| Runtime 怎样路由 | 工具契约与 CLI、MCP、RPC 实现怎样映射 |
| 是否需要 CLI | 人和 Coding Agent 是否要在终端直接复现 |
| 是否需要 MCP | 是否有多个 Host 需要统一发现和调用能力 |
| 浏览器为何存在 | 是否确实没有更稳定的 API、RPC 或 CLI |
| 代码为何执行 | 是否存在临时计算，而非已有工具就能完成 |
| 执行在哪里发生 | 文件、网络、凭据和资源限制是什么 |
| 谁可以做什么 | 身份、动作、资源、环境和副作用是否共同校验 |
| 失败怎样恢复 | 超时、取消、结果未知和幂等如何处理 |
| 证据怎样保留 | 摘要、完整输出、Artifact 和 Trace分别存在哪里 |

## 结语

Function Calling 位于模型与 Agent Runtime 之间，负责表达工具调用。Runtime 收到请求后，可以直接调用函数或 RPC，也可以选择 CLI、MCP、浏览器和代码执行等路径。CLI 与 MCP 经常只是同一个 RPC 的两种入口：CLI 面向终端、人和拥有 Shell 的 Coding Agent，MCP 面向需要统一发现与结构化调用的 Agent Host。

浏览器和代码执行描述的是实际能力，它们可以被直接实现，也可以藏在 CLI 或 MCP 后面。沙箱、权限、审批和审计继续约束最终动作，不会随着接入协议自动获得。

设计工具系统时，先确定模型看到的业务契约，再选择最短的接入路径，最后根据真实副作用配置权限和隔离。这样更换 CLI、MCP 或底层 RPC 时，模型侧契约和上层任务流程都不需要跟着重写。

## 参考资料

- [OpenAI: Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Model Context Protocol Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP Transports Specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [Python: subprocess management](https://docs.python.org/3/library/subprocess.html)
- [Playwright: Browser Context isolation](https://playwright.dev/docs/browser-contexts)
- [Docker: Resource constraints](https://docs.docker.com/engine/containers/resource_constraints)
- [gVisor: Introduction to security](https://gvisor.dev/docs/architecture_guide/intro/)
