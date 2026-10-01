---
title: FastCode：先侦察代码结构，再把上下文交给模型
description: FastCode 把代码仓库探索与正文读取拆开，先在语义结构地图上定位目标，再按预算组装最小充分上下文。本文拆解它与普通 Code RAG、Repo Map 和 Coding Agent 在线搜索的区别。
category: Agent
subcategory: RAG 与知识库
articleClass: flagship
featured: false
publishedAt: 2026-10-01
updatedAt: 2026-10-01
tags: [FastCode, Code RAG, 代码知识库, Context Engineering, 代码检索]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

让模型回答一个函数做什么并不难。成本主要花在仓库级问题上：登录链路经过哪些模块，修改 `User` 模型会影响哪里，一个请求为什么绕过了缓存，某个测试失败应该改生产代码还是测试夹具。

这些问题的答案通常横跨文件、符号和抽象层。Agent 不知道目标在哪，只能先列目录、搜索关键词、打开文件，再根据新发现继续搜索。每次探索都会把一批代码送进上下文，其中很多内容最后被证明无关。仓库越大，这种“边读边找”的浪费越明显。

FastCode 在 2026 年提出了一种 scouting-first，也就是“先侦察”的代码推理方式。它先让模型在轻量的语义结构地图上探索，找到值得读取的目标，再加载完整代码并完成推理。论文把这个设计概括为：**将 repository exploration 与 content consumption 分离。**

这篇文章主要回答四个问题：FastCode 是否只是代码 RAG，它怎样建立和搜索代码地图，为什么能节省 Token，以及这种设计适合放在 Coding Agent 的哪一层。

![FastCode 先侦察再读取的仓库理解流程](/images/posts/fastcode-scouting-pipeline.svg)

## 一、仓库级代码理解贵在哪里

假设用户问：

> 修改用户角色字段，会影响哪些鉴权逻辑？

一个通用 Coding Agent 可能按照下面的顺序探索：

```text
查看目录
  ↓
搜索 User / role
  ↓
打开模型定义与几个命中文件
  ↓
搜索调用方、序列化和数据库迁移
  ↓
继续打开中间件、缓存和测试
  ↓
整理影响范围
```

这条路径有三个成本。

第一，探索过程本身消耗上下文。Agent 打开一个错误文件后，文件内容仍可能留在对话历史里。后续每轮模型调用都要重新处理已经积累的上下文。

第二，代码关系不等于文本相似。`User.role` 的调用方可能从不出现“修改角色影响鉴权”这样的自然语言。向量可以找到语义接近的片段，却不一定沿着导入、调用和继承关系把链路补全。

第三，长上下文不会自动解决检索。一次塞入更多文件会提高命中的概率，也会增加噪声。模型必须在大量无关实现中重新寻找证据，关键代码可能被埋在上下文中间。

因此，仓库推理存在两个不同动作：

1. **探索**：判断应该看哪些文件、类、函数和关系。
2. **消费**：读取完整实现，回答问题或制定修改方案。

传统 Agent 往往一边探索一边消费。FastCode 试图先用便宜的信息完成大部分探索，再为最终推理支付正文读取成本。

## 二、FastCode 是代码 RAG，但不止是向量检索

如果把 RAG 理解为“从外部知识中取回上下文再交给模型”，FastCode 属于 Code RAG。不过它没有把仓库简单处理成一堆等价文本块。

普通代码 RAG 通常采用下面的流程：

```text
代码切块 → Embedding → 向量索引 → Top K → LLM
```

它适合查找局部实现，例如“哪里生成 JWT”或者“哪个函数负责发送邮件”。问题涉及跨文件调用或变更影响时，只靠相似度容易漏掉语义不相似但结构相关的代码。

FastCode 使用三类互补信息：

| 信息 | 主要回答什么 | 典型实现 |
| --- | --- | --- |
| 词法信息 | 精确名称出现在哪里 | BM25、关键词搜索 |
| 语义信息 | 哪段代码表达了相近意图 | Embedding、向量检索 |
| 结构信息 | 哪些符号通过程序关系相连 | AST、调用图、依赖图、继承图 |

这使检索单位从“文本相似的代码块”扩展为“可沿结构导航的代码实体”。类、函数、文件和文档仍然可以被检索，但它们还带着定义、调用、依赖和继承关系。

更准确的表述是：FastCode 是一个**结构感知的代码 RAG 与上下文组装系统**。

## 三、语义结构地图是怎样建立的

FastCode 的离线阶段要把仓库整理成一张便于侦察的地图。按照论文和开源仓库说明，这张地图包含分层代码单元、混合索引和多层关系图。

### 1. 分层代码单元

代码不按固定 Token 数随意切开，而是保留文件、类、函数和文档等层级。AST 解析让索引能够识别完整符号，也能保存函数签名、类型提示和所属文件。

这种分层很重要。搜索命中一个方法时，系统既可以只返回方法摘要，也可以向上找到类和文件，或者向下读取完整实现。检索粒度能够根据问题调整。

### 2. 混合索引

关键词搜索擅长精确标识符，例如类名、错误码和配置项；向量检索擅长自然语言与代码之间的语义对应。FastCode 将 BM25 与语义向量结合，用两阶段搜索产生并整理候选。

如果只使用向量，“role”与“permission”可能很接近，但具体的 `ROLE_ADMIN` 常量不一定排在前面。如果只使用关键词，用户说“权限继承”时又可能找不到代码中的 `resolveAuthorities`。混合检索让两种信号互相补足。

### 3. 三类关系图

FastCode 建立调用、依赖和继承关系图：

- 调用图连接函数及其调用方、被调用方；
- 依赖图表达文件、模块或包之间的依赖；
- 继承图连接接口、父类和实现类。

搜索命中 `User` 模型后，Agent 可以沿关系图查看谁读取它、哪些服务依赖它，以及哪些子类继承相关行为。这个过程只传递符号和关系元数据，不需要立即把每个文件正文交给模型。

![普通代码 RAG、Repo Map、FastCode 与在线 Agent 搜索的差异](/images/posts/fastcode-strategy-comparison.svg)

## 四、scouting-first 查询流程

索引完成后，一次问题大致经历四个阶段。

### 1. 从问题中确定入口

系统先通过混合搜索寻找候选符号和文件。问题包含明确类名时，词法检索提供强信号；自然语言描述与代码命名差异较大时，语义检索负责补充候选。

### 2. 在结构图上扩展

候选不是最终上下文。FastCode 可以沿图关系向外追踪有限跳数，补齐调用方、依赖项或继承实现。开源说明中把这种能力描述为 following code connections，并限制探索深度，避免一次命中扩散到整个仓库。

### 3. 先 skim，再决定是否读取

FastCode 可以先查看类名、函数名、签名和类型提示。这些信息类似一本书的目录。模型能判断某个文件是否可能相关，却不用先支付完整正文的 Token。

例如看到下面的轻量信息：

```text
auth/middleware.py
  class AuthorizationMiddleware
  def resolve_authorities(user_id, tenant_id) -> list[str]
  def check_route_permission(route, authorities) -> bool

models/user.py
  class User
  field: role_id
  field: tenant_id
```

对于“修改角色字段影响哪里”这个问题，这些签名已经足以判断两个文件值得继续读取。某个只负责头像上传的 `user_avatar.py` 即使包含 `User`，也可以在正文加载前被排除。

### 4. 一次组装高价值上下文

侦察完成后，系统加载最终候选的完整代码，组织成供回答模型使用的上下文。论文强调 single optimized step：先完成定位，随后集中读取必要内容，避免回答模型在文件读取循环中不断积累历史。

这里的“一次”描述上下文组装思路。真实实现仍可能根据问题复杂度继续探索，只是把昂贵的正文读取推迟到候选范围已经显著收窄之后。

## 五、成本感知策略控制读多少代码

只建立结构地图还不够。如果系统沿图无限扩展，或者把所有候选都加载回来，成本仍然会失控。FastCode 使用成本感知策略决定继续侦察、加载正文还是停止。

开源说明列出的决策因素包括置信度、问题复杂度、仓库规模、资源成本和迭代次数。可以把它抽象成一个上下文选择问题：

```text
在 Token 预算 B 内选择代码集合 C

目标：最大化 C 对当前问题的证据覆盖
约束：token(C) ≤ B
```

工程实现不会真的拥有一个完美的“证据价值函数”，通常只能综合检索分数、图距离、符号类型、文件重要性和模型判断。这个抽象仍然有用，因为它把目标从“尽量多读”改成了“用最少上下文覆盖必要证据”。

一个可解释的候选记录可以长这样：

```json
{
  "symbol": "AuthorizationMiddleware.resolve_authorities",
  "lexical_score": 0.82,
  "semantic_score": 0.76,
  "graph_distance": 1,
  "estimated_tokens": 540,
  "reason": "reads User.role_id and controls route authorization"
}
```

保留这些信号有利于调试。当回答漏掉一个调用方时，我们能区分是初始搜索没召回、图遍历没到达，还是预算策略错误地裁掉了候选。

## 六、它和 Aider Repo Map、Sourcegraph 有什么区别

FastCode 与这些方案有共同点，但服务方式不同。

| 方案 | 核心表示 | 上下文如何获得 | 更适合什么 |
| --- | --- | --- | --- |
| 普通 Code RAG | 代码块向量与关键词 | 一次 Top K | 局部问答、快速原型 |
| Aider Repo Map | Tree-sitter 定义/引用与图排名 | 将重要符号压缩进固定地图 | 给编辑模型提供全局轮廓 |
| Sourcegraph Code Graph | 精确符号、定义、引用和代码导航索引 | 搜索与代码图查询 | 大规模、多仓库代码智能 |
| 通用 Coding Agent | 文件系统、grep、终端和测试 | 运行时逐步探索 | 修改、执行和验证完整任务 |
| FastCode | 混合索引与多层结构图 | 先侦察，再集中读取目标 | 仓库问答、定位和影响分析 |

Aider 的 Repo Map 倾向于把有限 Token 留给仓库中最重要的符号，使模型始终拥有一张压缩地图。FastCode 更强调针对当前问题主动搜索和导航，再构建专用上下文。

Sourcegraph 的优势是成熟的代码导航基础设施和精确符号索引。FastCode 则把“如何根据问题选择上下文”放在框架中心，并提供面向 LLM 的导航与成本管理。

通用 Coding Agent 还负责修改文件、执行测试和处理失败。FastCode 的主要能力是仓库理解与问答，更适合作为 Agent 的上下文工具，而不是替代整个编码闭环。它提供 MCP Server，也说明了这种定位：Cursor、Claude Code 或其他 Agent 可以调用 `code_qa`，把代码检索工作交给 FastCode。

## 七、一个影响分析例子

继续使用“修改 `User.role_id` 会影响哪里”的问题。

普通语义检索可能返回：

```text
models/user.py
api/user_profile.py
docs/user-guide.md
tests/test_user_create.py
```

这些结果都和 User 相关，却不一定覆盖权限链路。

FastCode 的侦察过程可以从 `User.role_id` 出发，沿读取关系与调用关系找到：

```text
User.role_id
  ├─ AuthorizationMiddleware.resolve_authorities
  │    └─ check_route_permission
  ├─ PermissionCache.make_key
  ├─ UserSerializer.to_session_claims
  └─ migration/backfill_user_role.py
```

随后只读取这些节点附近的实现，并检查测试目录中是否存在相应引用。最终回答可以列出文件，并区分直接读取、缓存键依赖、会话序列化和数据迁移等影响类型。

这个例子也暴露了结构图的边界。反射调用、运行时注册、字符串拼接的类名、框架隐式注入和跨服务消息可能无法通过普通静态关系完整恢复。结构图能降低搜索空间，不能取代运行时 Trace、测试和人工验证。

## 八、怎样接入现有 Coding Agent

FastCode 开源项目提供 Web、CLI、REST API 和 MCP Server。作为 Coding Agent 的外部工具，最简单的接入方式是暴露以下能力：

```text
code_qa(question, repos, session_id?)
list_indexed_repos()
get_session_history(session_id)
```

一次典型调用可以是：

```json
{
  "question": "梳理用户登录后权限加载与缓存刷新的完整链路，并列出关键文件",
  "repos": ["/workspace/identity-service"],
  "multi_turn": true
}
```

FastCode 负责索引仓库、寻找证据和返回带来源的回答。上层 Agent 再根据结果读取必要文件、制定修改计划、编辑代码并运行测试。

多仓库模式对微服务项目很有吸引力。系统可以先选择与问题相关的仓库，再在仓库内部执行结构导航。不过跨仓库关系往往缺少统一符号图，仓库选择的质量、版本对应关系和权限隔离都需要单独验证。

## 九、不要直接相信“节省十倍 Token”

FastCode 论文在 SWE-QA、LongCodeQA、LOC-BENCH 和 GitTaskBench 上评估仓库问答、长代码理解、定位与任务推理。README 还给出了相对 Cursor、Claude Code 的速度、成本和准确率宣传数据。

这些结果说明 scouting-first 值得研究，但不能直接推导到自己的仓库。真实收益取决于：

- 语言解析器能否正确提取符号和关系；
- 问题是否需要跨文件结构推理；
- 仓库中生成代码、旧目录和动态机制的比例；
- 对比 Agent 使用什么模型、工具与上下文预算；
- 离线索引时间和更新成本是否计入总成本。

更可靠的验证方式是从自己的开发任务中抽取测试集，并把“找到代码”和“回答正确”分开评测。

### 检索与定位

- 目标文件是否进入候选；
- 关键类和函数是否被定位；
- 影响范围中的调用方是否被覆盖；
- 无关文件占最终上下文的比例；
- 每个问题消费多少检索与正文 Token。

### 回答与任务结果

- 结论是否由实际代码支持；
- 文件和符号引用是否准确；
- 修改计划是否遗漏测试、配置和迁移；
- Agent 根据这些上下文完成任务的成功率；
- 索引过期后会产生什么错误。

特别要保留“没有足够证据”的样本。如果系统总能返回一组看起来相关的文件，定位准确率可能很好看，实际却会把不存在的链路解释得很流畅。

## 十、FastCode 的局限

### 1. 静态结构不等于运行时行为

依赖注入、反射、消息队列、配置路由和动态代理会让真实调用关系偏离静态图。Java 与 Spring、Python 插件系统、前端事件分发都可能出现这种情况。必要时要把静态结构与运行时 Trace、日志或测试覆盖结合起来。

### 2. 索引会过期

代码变化后，符号、向量和关系图必须同步更新。增量索引若漏掉重命名、移动和删除，Agent 会沿着已经不存在的边寻找证据。索引版本最好和 Git commit 绑定，回答中也应返回对应版本。

### 3. 结构相关不代表业务相关

调用图能够说明 A 调用了 B，不能说明这条调用是否仍承载线上流量，也不能解释某个条件为什么存在。业务规则、历史决策和验证方法仍需要文档、Skills 与测试补充。

### 4. 权限边界会变复杂

多仓库检索必须在召回阶段执行权限过滤。不能先建立一个包含全部代码的统一候选集，再要求模型不要引用无权访问的仓库。缓存、会话历史和生成答案也要继承相同权限。

## 十一、我对 FastCode 的理解

FastCode 最有启发性的地方，是把“模型看到什么”拆成两个成本完全不同的阶段。

第一阶段给模型目录、符号、签名、检索分数和关系边。这些信息很薄，却足以完成方向判断。第二阶段才读取实现细节，用于形成结论。系统由此避免用完整正文支付探索成本。

这个思路并不限于代码。数据库 Agent 可以先看 Schema 和血缘，再读取样本数据；日志 Agent 可以先看服务拓扑和错误聚类，再展开原始日志；文档 Agent 可以先看目录、实体和引用关系，再加载章节正文。共同原则都是：

> 先用结构缩小不确定性，再把有限上下文花在需要推理的证据上。

从 Agent 工程角度看，FastCode 是一种具体的输入管理方案。它没有改变 LLM 的概率性质，而是通过可检索的仓库地图、受控导航和预算策略，提高进入模型的上下文质量。模型仍可能误解代码，工具层至少让它少在错误文件上浪费注意力。

## 参考资料

- Zhonghang Li 等，[FastCode: Fast and Cost-Efficient Code Understanding and Reasoning](https://arxiv.org/abs/2603.01012)
- HKUDS，[FastCode 开源仓库](https://github.com/HKUDS/FastCode)
- Aider，[Repository Map 实现](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)
- Sourcegraph，[Code Graph 文档](https://sourcegraph.com/docs/cody/core-concepts/code-graph)
- Chen 等，[LocAgent: Graph-Guided LLM Agents for Code Localization](https://aclanthology.org/2025.acl-long.426/)
