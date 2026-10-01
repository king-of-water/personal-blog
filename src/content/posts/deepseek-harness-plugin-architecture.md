---
title: DSH：Everything is a Plugin，Agent Harness 如何被拆成可组合能力
description: 解析 DeepSeek Harness 的插件化架构、Cordis 运行时、能力接缝与可替换 Agent Loop，理解插件系统怎样进入 Agent 基础设施内部。
category: Agent
subcategory: Agent 前沿
featured: false
publishedAt: 2026-10-01T20:04:00+08:00
updatedAt: 2026-10-01
tags: [DeepSeek Harness, DSH, Cordis, Plugin Architecture, Agent Runtime]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

大多数 Agent 框架允许我们添加工具，少数框架还能替换模型或 Prompt。DeepSeek Harness 往前走了一步：Agent Loop、Session、模型服务、工具、Hook、UI 乃至运行时扩展本身，都放进同一套插件组合机制。

官方把这套原则写成一句话：Everything is a Plugin。

这句话很容易被理解成“插件特别多”。真正的区别在于，DSH 不把插件当作主程序外围的附件，而是用插件装配主程序。产品启动时看到的 Agent，只是某一组 Service Provider 在当前 Scope 中组合出来的结果。

本文基于 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)和[架构文档](https://deepseek-harness.github.io/deepseek-harness/)分析。项目目前处于 Developer Preview，接口仍可能发生破坏性变化，因此本文关注设计方法，不把当前包名当作长期稳定 API。

![DSH 从 Cordis Scope 到 Agent 能力的插件化装配](/images/posts/dsh-plugin-harness.svg?v=20261001)

## 一、普通插件系统为什么不够

常见插件系统有一个稳定主程序：核心负责全部流程，插件在预先留好的位置注册命令、菜单或工具。

```text
Main Program
├── Plugin: Tool A
├── Plugin: Tool B
└── Plugin: UI Panel
```

这种结构适合功能扩展，却很难改变主流程。插件可以增加一个搜索工具，却不能替换 Agent Loop；可以订阅工具调用事件，却不能接管 Session 的保存方式；可以加一块 UI，却未必能让某个子任务拥有不同的一组服务。

Agent 系统偏偏经常需要改变这些“核心”部分：

- 主 Agent 与子 Agent 使用不同工具；
- 评测环境换成可重放的模型服务；
- Web 产品和命令行产品装配不同 UI；
- 高风险任务临时挂载审计和审批能力；
- 某个实验只替换 Loop，其余组件保持不变。

如果所有变化都依赖主程序里的条件分支，系统很快会出现一棵庞大的配置树。DSH 选择让核心能力也通过服务和插件提供。

## 二、Cordis 是什么

DSH 构建在 Cordis 之上。Cordis 不是 Agent 模型，也不是工具协议。它是一套应用组合运行时，负责插件生命周期、服务发现、作用域和上下文传播。

可以先用三个概念理解：

```text
Service Definition  定义一种能力的类型和契约
Service Provider    在某个作用域内提供具体实现
Service Consumer    声明并使用这种能力
```

例如，Agent Loop 不应该直接 import 某个具体模型客户端。它消费“LLM Service”；OpenAI、DeepSeek、本地模型或回放器都可以成为 Provider。评测时挂载 Replay Provider，线上运行时挂载真实模型 Provider，Loop 本身不变。

传统依赖注入也能替换实现，Cordis 进一步处理了时间和空间两个维度。

## 三、时空可组合到底是什么意思

### 1. 时间：能力可以随生命周期挂载

插件并非只能在进程启动前写死。一个作用域可以在运行时创建、挂载插件、释放资源并销毁。能力会随着生命周期出现和消失。

这适合 Agent 的临时任务：

```text
创建评测 Scope
→ 挂载冻结的模型与工具
→ 运行任务
→ 收集轨迹和评分
→ 销毁 Scope
```

若 Provider 在初始化过程中还有依赖，运行时需要保证服务何时可用、退出时按什么顺序清理。插件化不是简单地把函数放进数组，它要维护一张活的依赖关系。

### 2. 空间：不同 Scope 拥有不同能力

Scope 可以形成父子关系。子 Scope 继承父级服务，也能覆盖其中一部分。

```text
Application Scope
├── Main Agent Scope
│   ├── Full Filesystem
│   └── Strong Model
└── Subagent Scope
    ├── Read-only Filesystem
    └── Cheap Model
```

这比全局单例更贴近 Agent 的执行模型。权限、模型和工具集合本来就应该跟随任务边界，而不是跟随进程。子 Agent 不需要复制整套应用，只需在自己的 Scope 中覆盖差异。

## 四、DSH 的包为什么这么多

[官方 Packages 地图](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)把代码按能力族组织。主要分组包括：

| 分组 | 责任 |
| --- | --- |
| `core` | Session、Prompt、Tool、Agent Service 和具体 Loop |
| `api` | 远程 BFF 装配与 RPC 网关 |
| `boot` | 应用启动与共享装配逻辑 |
| `host` | Web GUI 的宿主服务与插件清单 |
| `client` | 浏览器端 shell、wire、object service 和 UI 插件 |
| `runtime-diagnostics` | 运行时不变量检查与诊断 |
| `test-support` | Replay、测试工具和 smoke tests |
| `util` | 低层通用工具 |

包多并不自动代表架构先进。DSH 有价值的地方是依赖方向受到约束：扩展插件依赖 Service Definition，而不是依赖某个具体 Provider；可替换的 Agent Loop 通过 Agent Service 与其他组件交互；UI、Hook 与工具消费稳定能力，而不是穿透到内部实现。

如果插件名义上独立，实际却 import 主程序的内部对象，它仍然只是分散的模块。插件化的质量取决于能力接缝是否稳定。

## 五、能力接缝怎样设计

一个经常变化的能力最好拆成三类包：定义、提供者和消费者。

以模型调用为例：

```ts
// definition
interface LlmService {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

// provider
class RemoteLlmProvider implements LlmService {
  async *stream(request) { /* 调用真实模型 */ }
}

// consumer
class AgentLoop {
  constructor(private llm: LlmService) {}
}
```

设计接缝时要回答四个问题：

1. 能力的最小稳定语义是什么；
2. Provider 何时创建和销毁；
3. Consumer 在服务暂时不可用时怎么办；
4. 哪些事件必须跨插件传播。

接口太小，消费者会绕过接口读取内部状态。接口太大，任何实现变化都会扩散。DSH 把 package README、依赖图和运行时诊断当作架构的一部分，就是因为插件系统只靠 TypeScript 类型还不够。

## 六、为什么 Agent Loop 也应该可替换

很多框架把 Loop 写死为“模型输出工具调用，执行后继续”。现实中的 Loop 存在大量策略差异：

- 一次允许并行执行多少工具；
- 何时压缩上下文；
- 是否先生成计划；
- 工具失败后重试、反思还是退出；
- 子 Agent 怎样调度；
- 用户中断何时生效；
- 达到预算后如何降级。

DSH 让 `dsh-agent-loop` 成为可替换部分，意味着研究者可以替换控制策略，而不必复制 Session、UI 和工具生态。

可替换 Loop 也带来风险。Loop 是状态推进的中心，更换它可能破坏事件顺序、持久化假设和终止条件。因此稳定的 Agent Service 需要规定可观察行为：什么叫一次 Turn，工具调用怎样记录，取消后有哪些保证，结束状态有哪些类型。

插件自由度越高，对契约和不变量的要求越高。

## 七、Extensions：运行中的 Agent 修改运行时

DSH 的 packages 地图还列出 `extensions`：它允许检查当前插件和服务，并由模型生成挂载或卸载操作。

这是“Everything is a Plugin”最激进的一部分。Agent 不只调用业务工具，还能查看自己当前拥有什么能力，再为任务装配新的能力。

一种理想流程是：

```text
任务需要数据库诊断
→ Agent 查询当前 Service Inventory
→ 找到只读数据库插件
→ 请求用户授权挂载
→ 在子 Scope 中运行诊断
→ 任务结束后卸载插件
```

如果缺少治理，这也会变成供应链和权限问题。运行时自修改至少需要：

- 插件来源和版本锁定；
- 安装前的权限清单；
- 代码签名或可信发布渠道；
- Scope 级最小权限；
- 完整的挂载、调用和卸载审计；
- 失败时恢复到已知装配。

模型可以提出装配方案，但不应该自行扩大权限。

## 八、Pi、DSH 与 Codex 的位置不同

| 系统 | 适合观察什么 | 主要扩展边界 |
| --- | --- | --- |
| Pi | 最小 Agent Loop 和可嵌入 Runtime | Tools、Extensions、Skills、Packages |
| DSH | 整个 Agent 应用如何被插件装配 | Service、Provider、Scope、Loop、UI |
| Codex | 工业产品如何处理协议、审批、沙箱与恢复 | Tools、MCP、Skills、Apps 与客户端协议 |

三者不是简单的功能强弱关系。Pi 适合从小处理解循环，DSH 适合研究运行时组合，Codex 适合研究产品边界和安全执行。

如果要自己实现一个内部 Agent 平台，我不会第一天就复制 DSH 的全部插件体系。更合理的顺序是：先把模型、工具、状态和 UI 分层；当第二种 Loop、第二种宿主或子任务隔离真实出现时，再引入 Scope 和 Service Definition。过早插件化会产生大量间接层，调试成本比业务收益更早到来。

## 九、怎样判断一个插件架构是否真的成立

可以用下面这组问题检查：

| 检查项 | 失败时的症状 |
| --- | --- |
| Consumer 是否只依赖定义 | 插件升级必须同步修改所有调用方 |
| Provider 是否有明确生命周期 | 文件句柄、连接和监听器泄漏 |
| Scope 是否表达权限边界 | 子 Agent 意外继承全部能力 |
| 事件是否有稳定顺序 | UI、持久化和评测看到不同事实 |
| 装配是否可观测 | 线上无法解释某能力来自哪个插件 |
| 版本是否可重放 | 同一 Session 无法恢复原运行环境 |
| 卸载是否安全 | 仍在运行的任务突然失去依赖 |

插件系统的目标不是让任何东西都能替换，而是让变化发生在可描述、可检查、可恢复的边界内。DSH 展示了一种很完整的方向：Harness 不再是一个固定程序加若干工具，而是一组能力在具体 Scope 和生命周期中的装配结果。

## 参考资料

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness 官方文档](https://deepseek-harness.github.io/deepseek-harness/)
- [DSH Packages 地图](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)
- [Cordis：A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)
