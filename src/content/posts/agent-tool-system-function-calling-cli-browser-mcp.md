---
title: Agent 工具系统：Function Calling、CLI、浏览器、代码执行与 MCP
description: 从一次工具调用的完整路径出发，解释 Function Calling、CLI、浏览器、代码执行和 MCP 各自解决什么问题，以及怎样设计权限、结果契约与执行隔离。
category: Agent
subcategory: Agent 开发
articleClass: flagship
featured: false
publishedAt: 2026-10-02
updatedAt: 2026-10-02
tags: [Agent, Tool Use, Function Calling, CLI, Browser, Code Execution, MCP]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

给模型接一个 `bash`，看起来已经拥有了整个操作系统；再接一个浏览器，它似乎什么网站都能操作；MCP server 装多以后，数据库、GitHub、Docs 和各种内部服务也都出现在工具列表里。工具数量增加很快，系统可靠性却不会随之自动增长。

原因很具体。模型返回的 Function Call 只是一份动作提议，外部程序仍要决定它能不能执行。CLI、浏览器和代码执行面对不同状态与副作用，不能共用一套粗糙的超时重试逻辑。MCP 统一了能力发现和消息交换，却不会替 Host 校验业务权限、隔离进程或判断一次写操作是否可以重放。

本文要回答的问题是：**怎样把 Function Calling、CLI、浏览器、代码执行与 MCP 放进同一套 Agent 工具架构，同时保留清楚的执行边界、反馈语义和审计证据？**

事实边界主要来自 OpenAI 与 Anthropic 的工具调用文档、MCP `2025-11-25` 规范、Python `subprocess` 文档、Playwright 的隔离说明，以及 Docker 和 gVisor 的官方资料。各厂商 API 字段会继续变化，文中把稳定的工程责任抽出来讨论；涉及具体协议版本的内容会标明来源。

## 先看结论

Function Calling 负责把模型输出变成结构化的动作请求。它不会执行函数，也不证明参数符合业务规则。Schema 约束解决的是形状问题，用户权限、资源范围、并发版本和副作用仍要由 Harness 检查。

CLI、浏览器和代码执行是三种执行面。CLI 调用已有程序，浏览器操作带会话状态的网页，代码执行允许模型临时创造程序。自由度越高，所需隔离越强。把三者都包装成 `execute(command: string)`，会抹掉本来能够检查的意图。

MCP 位于工具接入层。它规定 Host、Client 和 Server 怎样协商能力，怎样列出、调用和返回工具，也支持 Resources、Prompts 等其他原语。接入 MCP 后，工具依旧应进入统一的注册表、策略引擎和结果规范，不能绕过本地工具已有的权限与审计。

![Agent 工具调用从模型提议到环境结果的七层路径](/images/posts/agent-tool-system-layers.svg)

这张图是全文的坐标。模型只负责提出候选动作。工具目录帮助它选择能力，Dispatcher 完成参数与策略检查，Adapter 把统一请求翻译成 CLI、浏览器、沙箱或 MCP 调用，执行环境产生结果和副作用，Normalizer 再把有限、可判断的观察送回 Context。

## 一、先分清协议、工具和执行环境

“模型会调用工具”经常把三个层次压成一句话。

第一层是模型协议。开发者向模型提供工具名称、描述和参数 Schema，模型可以返回结构化调用。OpenAI 文档称其为 Function Calling；Anthropic 的消息协议使用 `tool_use` 内容块。二者字段不同，核心过程相同：模型选择工具并生成参数，应用程序取得请求后自行执行，再把结果送回下一轮。

第二层是工具契约。`search_code`、`run_tests`、`open_page`、`create_issue` 都属于这里。契约说明能力的语义、参数、结果、权限和副作用。模型看见的是契约，不应该依赖底层究竟由 Python 函数、Shell 程序、浏览器驱动还是远端 MCP server 实现。

第三层是执行环境。工具最终可能运行在当前进程、子进程、浏览器 Context、容器、微型虚拟机或远端服务里。超时、文件权限、网络出口、凭据和资源限制都发生在这一层。

这三个层次可以分别替换。模型供应商变化时，内部 `ToolRequest` 不必跟着重写；`search_code` 可以从 `rg` 换成索引服务；同一个代码执行工具也能从普通容器迁到更强的沙箱。边界清楚以后，协议兼容和安全策略才不会缠在每个工具实现里。

### Function Calling 不等于远程调用

一次 Function Call 更接近类型化的意图表达：

```json
{
  "call_id": "call_42",
  "name": "run_tests",
  "arguments": {
    "target": "tests/checkout/mobile.spec.ts",
    "timeout_seconds": 120
  }
}
```

模型没有持有函数指针，也不会因为生成这段 JSON 就运行测试。Harness 至少还要确认工具存在、参数能解析、路径在允许范围、调用者具备权限、当前任务预算足够，然后才交给实现层。

[OpenAI 的 Function Calling 说明](https://help.openai.com/en/articles/8555517-function-calling-in-the-openai-api)指出，在支持的模型和配置上，`strict: true` 能让参数符合受支持的 JSON Schema 子集。[Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs)也区分了两种用途：连接外部工具时使用 Function Calling，约束普通回答结构时使用结构化输出。Schema 一致不代表业务合法，`timeout_seconds: 120` 可以通过类型检查，`target: /etc/shadow` 也可能是合法字符串。

### MCP 位于工具接入层

[MCP 规范](https://modelcontextprotocol.io/specification/2025-11-25)定义了 LLM 应用与外部数据源、工具之间的开放协议，消息基于 JSON-RPC 2.0。Host 是发起连接的 LLM 应用，Client 是 Host 内部连接某个 Server 的协议组件，Server 提供能力。

MCP 解决的是接入碎片化：同一个 GitHub MCP Server 可以被多个兼容 Host 使用，Host 也能用统一方式发现不同 Server 的工具。模型怎样规划、Host 是否要求审批、Server 运行在哪个权限下，仍由具体实现决定。

## 二、一条可靠的工具调用经过哪些层

最小 Demo 常把模型返回直接映射到一个函数表：

```python
result = TOOL_IMPL[call.name](**call.arguments)
```

生产路径通常要多几步。下面的 Dispatcher 保留了关键控制点：

```python
def dispatch(call, actor, task, registry):
    tool = registry.resolve(call.name)
    args = tool.input_schema.validate(call.arguments)

    decision = policy.evaluate(
        actor=actor,
        task=task,
        tool=tool,
        args=args,
    )
    if decision.requires_approval:
        return pause_for_approval(call, decision.reason)
    if not decision.allowed:
        return denied_result(call, decision.reason)

    execution = executor.run(
        adapter=tool.adapter,
        args=args,
        limits=decision.limits,
        idempotency_key=call.idempotency_key,
    )
    return normalize_result(call, execution, tool.output_policy)
```

`registry.resolve` 负责名称与版本，Schema 校验负责结构，Policy 负责主体和资源边界，Executor 负责隔离与生命周期，Normalizer 控制进入 Context 的结果。日志和 Trace 应贯穿整条路径，但不能把密钥、Cookie 与完整环境变量写进模型消息。

### 工具注册表还要保存执行元数据

一条实用的工具记录至少包含：

```yaml
name: repo.run_tests
version: 3
description: 在当前工作区运行指定测试目标；不安装依赖，不访问生产服务
input_schema: RunTestsInput
output_schema: RunTestsResult
adapter: cli
risk:
  side_effect: workspace_write
  network: denied
  approval: on_scope_expansion
limits:
  timeout_seconds: 180
  stdout_bytes: 65536
  memory_mb: 2048
observability:
  retain_full_output: true
  redact: [authorization, cookie, '*_TOKEN']
```

厂商 API 通常只要求名称、描述和输入 Schema，内部注册表还要保存版本、风险、执行位置、超时、输出预算和脱敏规则。把这些字段写进 Prompt 并不能形成可靠控制；Dispatcher 必须在模型请求之后再次执行程序化检查。

### 调用状态要覆盖“结果未知”

工具调用至少有五种结果：成功、明确失败、被拒绝、需要用户批准、结果未知。最后一种常出现在外部写操作已发出，但连接在收到回执前断开。

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

`unknown` 不能折叠成失败。查询超时可以在预算内重试，创建工单、发消息、部署或付款超时则要先用业务幂等键或查询接口核对状态。模型协议里的 `call_id` 关联请求和结果，下一轮重新发起同一业务动作时通常会出现新 ID，因而不能代替业务幂等键。

## 三、工具描述决定模型怎样路由

工具名称、描述、Schema 和示例一起构成模型的动作空间。描述只写“搜索内容”，代码搜索、互联网搜索、文档搜索和日志搜索会争抢同一任务。边界清楚的描述应说明三个问题：什么时候使用，搜索哪个范围，什么时候换另一个工具。

```json
{
  "name": "search_code",
  "description": "在当前仓库的文本文件中搜索符号、字符串或正则。用于定位实现和引用；不要用于互联网资料、Git 历史或二进制文件。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pattern": {"type": "string"},
      "paths": {
        "type": "array",
        "items": {"type": "string"},
        "maxItems": 20
      },
      "maxMatches": {"type": "integer", "minimum": 1, "maximum": 200}
    },
    "required": ["pattern"],
    "additionalProperties": false
  }
}
```

粒度也会改变行为。一个 `bash(command)` 很灵活，却把命令语义藏进字符串；`run_tests(target)`、`git_diff(paths)` 和 `search_code(pattern)` 更容易做权限判断和结果压缩。另一端的 `fix_repository()` 又过于粗糙，Agent 看不到中间证据，失败时也不知道该修哪一步。

一个好工具通常对应清楚的用户意图，允许组合，返回的信息足以修正下一步。底层实现可以很强，但对模型暴露的接口不必复制底层全部选项。

### 工具数量会占用 Context 和选择能力

几十个完整 Schema 常驻每次调用，会增加输入长度，也让相似名称更难区分。渐进披露可以先暴露能力目录，模型或检索器命中候选后，再加载详细说明与 Schema。Anthropic 在[高级工具使用介绍](https://www.anthropic.com/engineering/advanced-tool-use)中公开了 Tool Search 的思路：先搜索工具，只把匹配定义装入 Context。

这项优化需要单独评测发现率。目录描述太短时，正确工具可能从未进入候选；检索结果太宽时，Schema 负担又回来了。除了 Token，还要记录候选召回率、误选率、工具搜索额外轮次和最终任务成功率。

## 四、CLI：把成熟程序接进 Agent

CLI 是 Coding Agent 最常见的工具面。`git`、`rg`、测试框架、编译器和包管理器已经拥有稳定语义，Agent 无需为每项能力重新实现 API。命令行还是可观测接口：退出码、标准输出、标准错误和文件变化都能成为证据。

灵活性也带来风险。Shell 字符串允许管道、重定向、命令替换、通配符和环境变量展开。策略只检查第一个词，会漏掉 `safe-command | dangerous-command`、`$(...)` 和写向敏感路径的重定向。

### 优先使用 argv，明确 cwd 与 env

如果工具目标固定，可以跳过 Shell 解析，直接执行参数数组：

```python
completed = subprocess.run(
    ["/usr/bin/git", "diff", "--", *validated_paths],
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

Python 官方 [`subprocess` 文档](https://docs.python.org/3/library/subprocess.html)建议通常把参数作为序列传入；默认不调用系统 Shell。显式启用 `shell=True` 后，应用程序要自行处理空白和元字符，避免 Shell Injection。完整可执行路径、固定工作目录和环境变量白名单还能减少 `PATH`、当前目录与继承凭据造成的歧义。

开放 Shell 确实有价值，例如用户明确要求复现一条复杂管道，或 Agent 正在探索陌生构建系统。此时检查器必须面对最终执行语义，解析失败就请求批准或拒绝。静态命令检查仍替代不了低权限用户、文件系统范围和网络策略。

### 输出需要分层保存

测试命令可能输出几十万行。把全部 stdout 塞回 Context，错误位置反而更难找到。工具可以返回退出码、耗时、首尾摘要、关键匹配、截断说明和完整 Artifact 引用：

```json
{
  "status": "error",
  "exit_code": 1,
  "duration_ms": 18421,
  "summary": "47 passed, 1 failed: checkout button is covered on 390px viewport",
  "stdout_truncated": true,
  "artifact_ref": "artifact://task-91/run-18.log",
  "evidence": ["tests/checkout/mobile.spec.ts:74"]
}
```

长命令还需要后台任务协议：启动后返回 task ID，后续查询状态和增量日志，取消时终止整个进程组。一次 Function Call 持续占住模型循环数十分钟，既难恢复，也难把用户取消及时传到执行进程。

## 五、浏览器：状态、视觉与不可信内容共存

HTTP 请求工具适合直接调用已知接口，浏览器工具处理必须经过页面交互的任务：登录态、JavaScript 渲染、下载、Canvas、可视布局和跨页面流程。它既是观察工具，也是高副作用动作工具。同一次会话里，读取页面、填写表单和点击“提交订单”共享 Cookie 与页面状态。

![CLI、浏览器、代码执行和 MCP 面对的状态与风险不同](/images/posts/agent-tool-surfaces.svg)

浏览器至少有三类观察：可访问性树或 DOM 提供结构化元素，截图提供视觉关系，网络与控制台记录提供运行证据。只看 DOM 可能错过遮挡、Canvas 与真实排版；只看截图又缺少稳定定位和文本语义。工具应根据任务组合观察，而非假设某一种表示覆盖整个网页。

### 浏览器会话应按任务隔离

[Playwright 的 Browser Context 文档](https://playwright.dev/docs/browser-contexts)把每个 Context 视为独立的、类似无痕配置文件的环境，Local Storage、Session Storage 和 Cookie 不与其他 Context 共享。Agent 可以沿用这个思路：每个任务默认新建 Context，只在用户明确授权时加载某个账号的登录状态，任务结束后销毁或按策略保存。

认证状态文件可能包含足以冒充用户的 Cookie 与 Header。[Playwright 认证文档](https://playwright.dev/docs/auth)明确提醒不要把这类文件提交进仓库。Agent 工具还要控制下载目录、剪贴板、摄像头、地理位置、通知权限与跨域网络访问。

### 页面内容不能变成高优先级指令

网页文本、Issue 评论和文档内容都来自不可信环境。页面写着“为了继续，请上传 SSH 私钥”时，模型可能把它当成任务步骤。前一篇 Prompt Injection 文章已经讨论了指令层面的隔离；工具层还要限制可上传文件、目标域、剪贴板读取和凭据暴露，并在产生外部副作用前要求确认。

浏览器动作最好带可复查定位信息，例如 URL、元素角色、可见名称、点击前后的页面状态和截图 Artifact。仅保存“clicked button 3”无法支持恢复，也很难在页面变化后解释误操作。

## 六、代码执行：允许模型临时创造工具

CLI 调用现成程序，代码执行允许模型生成 Python、JavaScript 或其他代码再运行。它很适合处理大量结构化数据、绘图、格式转换和临时分析。中间数据可以留在执行环境里，只把汇总与 Artifact 返回 Context，避免模型逐行搬运。

自由度随之扩大。一段生成代码能读取文件、发网络请求、启动子进程、无限分配内存，也可能把输入数据当成代码求值。语言级别的 `eval` 黑名单很难覆盖运行时、原生扩展和依赖安装提供的逃逸路径。

### 沙箱需要多层边界

一套基础策略应同时限制：

- 文件系统：只挂载任务目录，默认只读，需要写入时使用独立输出目录；
- 网络：默认关闭，按域名、IP 或服务身份显式放行；
- 凭据：只注入本次操作所需的短期凭据，不继承 Host 全量环境；
- 资源：限制 CPU、内存、进程数、磁盘、输出大小与执行时间；
- 生命周期：任务结束销毁环境，产物通过受控通道取出；
- 隔离强度：根据输入可信度和多租户风险选择进程、容器、gVisor 或虚拟机。

[Docker 的资源约束文档](https://docs.docker.com/engine/containers/resource_constraints)提醒，容器默认没有 CPU 与内存上限，需要显式配置。[gVisor 安全介绍](https://gvisor.dev/docs/architecture_guide/intro/)则说明其应用内核怎样减少工作负载直接接触 Host System API 的范围，同时也列出了兼容性和性能成本。沙箱是降低影响面的手段，网络策略、凭据最小化和上层输入验证仍然要单独存在。

### 代码结果也要可复现

Agent 说“脚本算出 37.2%”不构成证据。工具结果应保存脚本、输入 Artifact 的哈希、运行时版本、依赖锁定信息、stdout/stderr 和输出文件。随机算法还应记录种子。复现包不必全部进入 Context，但要能被评测器或人工 Review 重新运行。

依赖安装应与代码执行分开授权。`pip install` 或 `npm install` 会引入网络、供应链脚本与新的可执行代码；将它藏在同一次 `run_code` 里，会让审批界面无法展示这批附加动作。

## 七、MCP：统一接入，不替代工具治理

MCP 的价值可以用两个请求说明。Client 通过 `tools/list` 发现能力，通过 `tools/call` 调用某个工具。根据当前 [`2025-11-25` Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)，工具定义包含名称、描述、`inputSchema`，还可以提供 `outputSchema`、Annotations 和执行相关属性。工具结果可以返回文本、图片、音频、Resource Link、嵌入式 Resource 与结构化内容。

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "github.issue.add_comment",
    "arguments": {
      "repository": "shop/checkout",
      "issue_number": 4821,
      "body": "修复已验证，证据见 CI run 9182。"
    }
  }
}
```

Host 不应把 Server 返回的定义直接塞给模型并无条件执行。规范明确提醒，来自不可信 Server 的 Tool Annotations 也必须按不可信数据处理。一个工具自称 `readOnlyHint: true`，不代表实现真的没有副作用。

### Host、Client 与 Server 各负责什么

![MCP 接入 Agent 工具系统时的组件和信任边界](/images/posts/agent-tool-mcp-boundaries.svg)

Host 管理用户会话、模型、审批界面与全局策略。每个 Client 处理与某个 Server 的协议连接、能力协商和消息关联。Server 把外部服务或本地能力暴露成 MCP 原语。远端服务自己的授权仍在 Server 或下游资源服务器完成，Host 还要决定当前 Agent 是否可以看见和调用这项能力。

MCP 标准传输包括本地 `stdio` 和 Streamable HTTP。[Transport 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)要求 `stdio` Server 的 stdout 只输出合法 MCP 消息，日志走 stderr；Streamable HTTP 使用一个支持 POST 与 GET 的端点，并可用 SSE 发送多条消息。规范还要求 HTTP Server 校验 `Origin`，本地运行时建议只绑定 loopback，并为连接实现认证，以防 DNS Rebinding 等攻击。

### MCP Server 本身就是代码与权限主体

本地 MCP Server 常由 Client 启动为子进程，它与普通插件一样能访问当前用户拥有的文件和网络。官方 [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)要求一键安装前展示完整启动命令并获得明确同意，建议用沙箱限制文件、网络和系统资源；本地场景优先使用 `stdio`，可以缩小未授权进程访问面。

远端 Server 则要处理 OAuth、Token Audience、Session 与下游 API 授权。规范明确把 Token Passthrough 视为反模式：Server 接受并转发一个并非为自己签发的 Token，会破坏受众校验、审计和信任边界。接入协议统一之后，身份链路反而更需要写清楚谁代表谁、凭据发给谁、最终操作归属于哪个用户。

### Resources、Prompts 和 Tools 不要混为一谈

MCP 除 Tools 外还有 Resources 与 Prompts。Resource 更适合由应用或用户选择的上下文对象，如文件、Schema 和文档；Prompt 是可发现的提示模板；Tool 是模型可以请求执行的动作。三者的 UI 与信任语义不同。

把一份大文档伪装成 `get_document` 工具并非协议错误，但 Host 会失去 Resource 的 URI、订阅或按需读取语义。反过来，把“删除记录”包装成 Prompt 也不会产生安全边界。选原语时应看它代表数据、模板还是动作。

## 八、权限应该绑定动作和资源

“允许使用 GitHub”粒度太粗。读取公开 Issue、读取私有仓库、创建分支、合并 PR 和修改组织权限的风险完全不同。Policy 输入至少包括用户身份、任务、工具、参数、资源范围、预期副作用、凭据来源和运行环境。

| 风险级别 | 例子 | 默认处理 |
| --- | --- | --- |
| 只读且范围明确 | 读取当前仓库文件、查询公开文档 | 自动执行并记录 |
| 工作区可恢复写入 | 修改分支内文件、生成临时 Artifact | 在限定目录执行，返回 diff |
| 外部可见写入 | 发评论、创建工单、推送分支 | 预览对象与内容，按策略确认 |
| 难恢复或高影响 | 删除资源、部署生产、付款、改权限 | 强确认、最小权限、幂等与复核 |
| 任意代码或扩权 | 安装未知 Server、开放 Host Shell | 强隔离，默认拒绝或人工批准 |

审批要展示语义，而非原始 JSON。用户需要知道“将向 `shop/checkout#4821` 发表这段评论”，并能看到正文与账号；只显示 `tools/call` 很难判断后果。批量批准应限制在同一资源范围、同一风险等级和明确时段，不能把一次读权限扩成整场会话的写权限。

### 模型看到工具不等于拥有权限

能力发现与授权是两条链路。一个工具可以进入目录，便于模型判断任务是否可做，调用发生时仍要按参数检查。也可以先根据用户和工作区裁剪目录，减少模型误选。无论采用哪种方式，最终执行前的 Policy Check 都不能省略。

结果也可能越权。数据库工具按行级权限查询后，返回 Artifact 的下载接口必须继续验证同一身份；否则模型消息受控，Artifact URL 却能被其他任务读取。权限要贯穿请求、执行、结果存储和后续引用。

## 九、端到端走一遍真实任务

任务是修复移动端结账按钮无法点击的问题，并在 GitHub Issue `#4821` 留下验证结果。约束包括：只修改 checkout 前端与测试；不得访问生产；外部评论发送前需要确认。

Agent 首先用 GitHub MCP Server 读取 Issue。MCP Client 把远端 `tools/list` 映射进内部注册表，Policy 允许读取指定仓库。工具结果返回问题描述和附件链接，Normalizer 保留关键字段，把完整响应存成 Artifact。

随后浏览器工具在新的 Browser Context 中打开本地预览，切换到 390px 视口。可访问性树显示按钮存在，截图却显示 Cookie Banner 覆盖按钮。Agent 保存截图、URL、视口和元素定位信息，证据指向视觉层问题。

Agent 使用 `search_code` 定位 Banner 与 checkout 布局，再调用受约束的文件编辑工具修改 CSS。CLI 工具运行指定 Playwright 用例。第一次测试失败，因为修改让桌面端 Banner 与页脚重叠；失败结果包含用例、截图 Artifact 和 Trace，Agent 据此收窄媒体查询。第二次移动端与桌面端测试都通过。

代码执行工具没有参与这次任务，因为现有测试与 CLI 已经足够。能不开放任意代码时，系统无需为了“Agent 更强”增加一个更宽的执行面。

最后 Agent 生成 Issue 评论预览，其中包含修改摘要、两组测试结果和 Artifact 链接。`github.issue.add_comment` 属于外部可见写入，Policy 返回 `needs_approval`。用户确认后，Harness 携带业务幂等键调用 MCP 工具。网络在回执前断开，状态进入 `unknown`；系统先查询 Issue 评论，发现内容已经存在，于是记录成功，不重复发送。

这条轨迹里，Function Calling 表达每一步动作，MCP 接入 GitHub，浏览器提供视觉观察，CLI 调用现有测试。Registry、Policy、Sandbox、Artifact 与幂等检查把它们组合成一套可负责的工具系统。

## 十、失败应送回正确的处理层

工具调用失败后直接让模型“再试一次”，经常会放大故障。不同错误应由不同层处理：

| 故障 | 负责层 | 处理方式 |
| --- | --- | --- |
| JSON 不符合 Schema | 协议/校验器 | 返回字段错误，允许模型修正参数 |
| 路径超出工作区 | Policy | 拒绝并说明可用范围，不要求模型绕过 |
| 模型 API 限流 | Runtime | 有上限的退避，通常不需要模型参与 |
| CLI 退出码非零 | Tool/Agent | 返回 stderr 摘要与 Artifact，决定修复或停止 |
| 浏览器元素过期 | Browser Adapter | 重新观察页面，再决定是否重放动作 |
| 写操作回执丢失 | Executor | 标记 unknown，查询外部状态或幂等记录 |
| MCP Server 不可信 | Registry/Policy | 禁用、隔离或要求管理员批准 |
| 沙箱资源耗尽 | Sandbox | 终止执行，记录资源证据，限制重试 |

参数错误通常可以修正后重试；权限拒绝不应通过换一种说法反复尝试；状态未知要先核验外部世界。错误契约如果只返回 `failed`，模型无法区分这些情况，最终只能随机换参数或重复动作。

## 十一、怎样观察和评测工具系统

每次调用应形成一条从模型请求到外部证据的 Trace。建议记录：模型看到的工具版本、候选列表、调用名称和参数摘要、Policy 决策、审批、执行环境、耗时、退出状态、结果大小、截断位置、Artifact、重试与最终副作用。敏感值保留哈希或引用，不进入普通日志。

评测也要拆层。工具选择评测观察正确能力能否进入候选、模型是否选对工具；参数评测检查 Schema 与业务约束；执行评测覆盖超时、取消、并发写、状态未知和沙箱逃逸面；任务级评测才看最终成功率、成本与用户接管次数。

### 用回放区分模型问题和工具问题

保存去敏后的 Tool Request 与 Result 后，可以做两类回放。固定工具结果，只换模型或 Prompt，观察工具选择和恢复行为；固定请求，直接重放 Adapter 与 Executor，检查工具实现是否稳定。两种问题混在端到端成功率里时，很难知道该改描述、Schema、Policy 还是底层程序。

写工具还要测试幂等与故障注入：请求送达后主动断开连接，确认系统不会重复副作用；在文件写入中途终止进程，确认原文件仍完整；让 Browser Context 过期，确认系统重新认证或请求用户，而非声称页面没有数据。

### 指标不能只看调用成功率

一个总是返回 200 的工具可能把错误藏进文本。更有解释力的指标包括：正确工具选择率、参数一次通过率、Policy 拒绝率、人工批准率、结果未知率、重复副作用数、输出截断率、Artifact 再读取率、每个成功任务的工具调用数，以及错误结果被下一轮正确修复的比例。

工具目录变更要跑回归集。新增一个名称相近的工具，可能让旧任务开始误选；更新描述也可能提高一种任务、损害另一种任务。Registry 应保存版本，Trace 才能解释同一模型为什么在两个日期表现不同。

## 十二、从最小实现逐步扩展

第一阶段只需要少量本地工具：读取、精确编辑、代码搜索和受约束测试。先把 Tool Request、Result、步数预算、退出状态和 Artifact 做完整。此时避免开放任意 Shell，更容易看清每个契约是否有用。

第二阶段加入 Policy 与审批，把只读、工作区写、外部写和高影响动作分级。所有写操作返回实际 diff 或外部资源 ID，超时引入 `unknown` 状态和幂等核验。

第三阶段按需求增加执行面。网页任务加入隔离 Browser Context；大量数据处理加入代码沙箱；需要复用外部集成时再接 MCP。每增加一种 Adapter，都复用同一个 Registry、Policy、Result 与 Trace，不再创建旁路。

第四阶段解决规模问题：工具搜索、按需加载、Server 治理、版本兼容和分布式凭据。复杂度应由真实轨迹推动。五个工具就能完成的系统，不需要先建一个企业级 MCP Registry。

## 十三、设计检查表

| 检查面 | 需要回答的问题 |
| --- | --- |
| 协议 | 模型生成的是请求还是已经发生的动作？ |
| 目录 | 工具名称、描述和边界是否足以区分相似能力？ |
| Schema | 只验证结构，还是也有业务和资源范围校验？ |
| 权限 | 谁在什么任务里，能对哪个对象执行什么动作？ |
| 副作用 | 只读、可恢复写入、外部写入和难恢复动作是否分级？ |
| CLI | 是否使用 argv、固定 cwd、环境白名单与输出上限？ |
| 浏览器 | 会话、Cookie、下载和页面不可信内容怎样隔离？ |
| 代码执行 | 文件、网络、凭据、资源和生命周期是否受限？ |
| MCP | Server 来源、传输、授权和工具定义是否经过治理？ |
| 结果 | 成功、失败、拒绝、待批准和结果未知是否分开？ |
| 恢复 | 写操作超时后怎样核验，取消是否传到真实进程？ |
| 证据 | 完整输出放在哪里，Context 中保留什么摘要？ |
| 评测 | 能否区分工具发现、参数、执行与任务级故障？ |

## 结语

Agent 工具系统把概率性的动作提议变成受控、可观察的环境交互。Function Calling 提供模型边界上的结构，CLI、浏览器和代码执行连接不同执行面，MCP 让外部能力可以用统一协议接入。

执行之前仍有一段不能省略的工程路径：解析意图、校验参数、检查主体和资源、获得必要批准、在合适的隔离环境运行，再把有限且有证据的结果送回模型。工具越强，这段路径越值得写清楚。

## 参考资料

- [OpenAI: Function Calling in the OpenAI API](https://help.openai.com/en/articles/8555517-function-calling-in-the-openai-api)
- [OpenAI: Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Anthropic: Tool use with Claude](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [Anthropic: Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [Model Context Protocol Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Transports Specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)
- [Python: subprocess management](https://docs.python.org/3/library/subprocess.html)
- [Playwright: Browser Context isolation](https://playwright.dev/docs/browser-contexts)
- [Docker: Resource constraints](https://docs.docker.com/engine/containers/resource_constraints)
- [gVisor: Introduction to security](https://gvisor.dev/docs/architecture_guide/intro/)
