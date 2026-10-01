---
title: Repo Map：把整个代码仓库压缩成一张给 LLM 看的地图
description: Repo Map 用符号定义、引用关系和图排序，在固定 Token 预算内生成仓库地图。本文结合 Aider 的实现，拆解 Tree-sitter、PageRank、上下文相关排序、增量缓存，以及它和 RAG、FastCode、LLM Wiki 的关系。
category: Agent
subcategory: RAG 与知识库
articleClass: focused
featured: false
publishedAt: 2026-10-01
updatedAt: 2026-10-01
tags: [Repo Map, Aider, Code RAG, Context Engineering, 代码知识库]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

让 Coding Agent 修改一个陌生仓库时，我们很容易陷入两个极端。

一种做法是只给它当前文件。模型能看清局部实现，却不知道仓库里已有的接口、工具类和抽象，最后又造出一套重复代码。另一种做法是把大量文件塞进上下文。模型确实看见了更多内容，注意力和 Token 也被无关实现占满。

Repo Map 走的是中间路线：保留少量完整文件，同时提供一份仓库地图。地图不复制所有代码，只列出重要文件、类、方法、函数签名以及它们之间的引用关系。模型先借地图形成全局印象，确定需要深入阅读的文件，再把有限上下文用在实现细节上。

Aider 是 Repo Map 最有代表性的实践之一。它会在每次代码修改请求中附带一份与当前对话相关的仓库地图，并根据 Token 预算裁剪内容。[Aider 的官方文档](https://aider.chat/docs/repomap.html)给出的默认建议预算是 1K Token。这个数字不大，却足以放下一批跨文件符号，帮助模型发现当前文件之外可以复用的模块。

![Repo Map 从代码仓库生成预算内上下文的流程](/images/posts/repo-map-pipeline.svg)

## 一、Repo Map 到底是什么

先看一份简化后的 Java 仓库地图：

```text
src/main/java/com/example/order/OrderController.java:
│class OrderController {
│    OrderResponse create(CreateOrderRequest request)
│    void cancel(Long orderId)

src/main/java/com/example/order/OrderService.java:
│interface OrderService {
│    Order createOrder(CreateOrderCommand command)
│    void cancelOrder(Long orderId)

src/main/java/com/example/order/OrderServiceImpl.java:
│class OrderServiceImpl implements OrderService {
│    Order createOrder(CreateOrderCommand command)
│    void cancelOrder(Long orderId)

src/main/java/com/example/inventory/InventoryClient.java:
│interface InventoryClient {
│    void reserve(ReserveRequest request)
│    void release(ReleaseRequest request)
```

它比目录树多了一层语义。模型不只知道仓库里有四个文件，还知道文件暴露了哪些符号，接口和实现大概是什么形状。它又比完整源码轻得多，没有方法体、日志、异常处理和样板代码。

Repo Map 可以回答三类基础问题：

1. 仓库里有哪些可以使用的模块和接口；
2. 当前任务可能涉及哪些文件；
3. 想继续理解某个行为，下一步应该打开哪里。

这张地图并不尝试直接解释业务。`cancelOrder()` 为什么先改状态再释放库存，仍然需要读取完整实现、测试和设计文档。Repo Map 提供的是导航坐标。

## 二、有大上下文窗口，为什么还需要地图

上下文窗口变大以后，把整个仓库交给模型看起来变得可行。问题是窗口容量只说明“能装多少”，没有保证模型能同等重视每一段内容。

大量无关代码会带来几种具体影响：

- 每次请求都要为相同代码支付输入 Token；
- 关键定义可能被埋在长上下文中间；
- 相似类、旧实现和测试夹具会干扰判断；
- 对话继续增长后，系统需要压缩或丢弃旧内容；
- 仓库稍有变化，预先拼好的大上下文就会过期。

Aider 的使用建议明确提醒用户不要把所有文件加入对话。它会自动分析仓库并补充 Repo Map，让完整上下文保留给真正可能修改的文件。官方 FAQ 也提到，过多无关文件可能降低代码结果质量并增加成本。

一个实用的上下文通常分成三层：

```text
完整代码层：当前要编辑或验证的少量文件
仓库地图层：其他文件的重要符号和签名
按需检索层：地图不足时，再搜索并读取新文件
```

完整代码负责细节，仓库地图保持全局感，工具调用负责继续探索。这比单纯追求“把更多代码塞进去”更稳定。

## 三、Aider 怎样提取仓库里的符号

Aider 的实现入口在 [`aider/repomap.py`](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)。生成地图的第一步，是从源文件中提取定义和引用。

### 1. Tree-sitter 负责理解语法结构

Aider 使用 Tree-sitter 解析不同语言的代码。Tree-sitter 会生成语法树，查询文件再从语法树中捕获类名、函数名、方法名等节点。它的查询语言适合匹配具体语法结构，不必为每种语言手写一套完整解析器。

以 Java 为例，概念上可以把查询理解成：

```scheme
(class_declaration
  name: (identifier) @name.definition.class)

(method_declaration
  name: (identifier) @name.definition.method)

(method_invocation
  name: (identifier) @name.reference.call)
```

真实查询会考虑更多语法情况，这里只展示定义和引用的区别。Aider 将捕获结果整理成类似下面的 Tag：

```python
Tag(
    rel_fname="src/order/OrderService.java",
    line=42,
    name="cancelOrder",
    kind="def",
)
```

每条记录至少要回答四个问题：符号叫什么、位于哪个文件、处于哪一行、这是定义还是引用。

Tree-sitter 的优势是速度快、语言覆盖广，也适合增量解析。它的边界同样明显：静态语法不一定能还原反射、依赖注入、运行时注册和字符串形式的调用。Repo Map 看见的是源码中能够被解析的结构，不是运行时世界的完整复制。

### 2. 定义和引用把文件连接起来

假设 `OrderServiceImpl.java` 定义了 `cancelOrder`，`OrderController.java` 和 `OrderJob.java` 引用了它。系统就得到两条跨文件关系：

```text
OrderController.java ──引用 cancelOrder──▶ OrderServiceImpl.java
OrderJob.java        ──引用 cancelOrder──▶ OrderServiceImpl.java
```

文件由此成为图上的节点，符号引用成为边。一个被很多文件引用的定义，往往是公共接口、领域模型或基础设施入口，值得优先进入地图。

这里要保留一份怀疑：引用次数高不一定说明业务重要。`StringUtils` 可能遍布仓库，却和当前“取消订单”任务关系不大。因此 Repo Map 还需要利用当前对话调整排序。

## 四、PageRank 怎样挑出重要代码

文件和引用关系组成图以后，Aider 使用图排序寻找重要节点。思路来自 PageRank：一个节点被多个重要节点引用，它的得分也会提高。[NetworkX 的 PageRank 文档](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.link_analysis.pagerank_alg.pagerank.html)将其描述为根据入链结构计算节点排名。

放到代码仓库里，可以这样理解：

```text
很多业务模块都引用 Money
            ↓
Money 的全局重要性较高

当前对话正在修改 OrderController
            ↓
与 OrderController 相连的 OrderService 获得额外权重
```

PageRank 提供仓库级中心性，个性化向量则把当前任务注入排序。Aider 的实现会关注已经加入对话的文件、用户提及的文件名和标识符，让地图随着对话变化。

因此，同一个仓库面对不同任务，地图内容也会不同：

```text
任务 A：修复订单取消
OrderController → OrderService → InventoryClient → OrderEventPublisher

任务 B：调整优惠券过期时间
CouponController → CouponService → CouponPolicy → CouponExpireJob
```

如果地图永远只展示仓库中引用最多的符号，它会退化成一份静态 API 目录。实用的 Repo Map 会同时考虑全局重要性和任务相关性。

![静态目录、全局 Repo Map 与任务相关 Repo Map 的差异](/images/posts/repo-map-ranking.svg)

## 五、如何把地图压进 Token 预算

完成排序以后仍不能直接输出全部符号。大型仓库的类和函数签名本身就可能超过上下文窗口。

Aider 会按照排名从高到低选取 Tag，把这些 Tag 渲染成带文件名和必要上下文的代码树，然后估算 Token 数量。它通过搜索合适的截断位置，让输出尽量接近 `--map-tokens` 指定的预算。

可以把算法简化成下面的伪代码：

```python
def build_repo_map(files, chat_files, mentioned_symbols, token_budget):
    tags = extract_definitions_and_references(files)
    graph = build_file_reference_graph(tags)

    scores = personalized_pagerank(
        graph,
        focus_files=chat_files,
        focus_symbols=mentioned_symbols,
    )

    ranked_tags = rank_definitions(tags, scores)

    low, high = 0, len(ranked_tags)
    best = ""

    while low <= high:
        middle = (low + high) // 2
        candidate = render_code_tree(ranked_tags[:middle])

        if count_tokens(candidate) <= token_budget:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1

    return best
```

预算机制比固定选择 Top 100 更合理。不同语言的签名长度差异很大，一个带大量泛型参数的 Java 方法可能占据数行，一个 Python 函数只需要一行。最终约束应该落在模型实际接收的 Token，而不是符号数量。

预算也不该完全固定。刚进入仓库、还没有选择文件时，Agent 更依赖全局地图；已经锁定两三个目标文件以后，地图可以收缩，把空间让给完整代码、测试结果和对话历史。Aider 会根据会话状态动态调整地图大小，并支持 `auto`、`always`、`files` 和 `manual` 等刷新策略。

## 六、Repo Map 与普通目录树差在哪里

目录树只保存物理结构：

```text
src/
├── controller/
├── service/
├── repository/
└── model/
```

它适合发现模块，却不能说明每个文件提供什么能力。Repo Map 增加了符号和关键代码行：

```text
service/OrderService.java:
│interface OrderService
│    Order createOrder(CreateOrderCommand command)
│    void cancelOrder(Long orderId)
```

调用图则更进一步，试图描述符号之间的调用：

```text
OrderController.cancel
  → OrderService.cancelOrder
  → InventoryClient.release
  → OrderEventPublisher.publish
```

三者适合不同阶段：

| 结构 | 信息量 | 主要用途 | 主要缺口 |
| --- | --- | --- | --- |
| 目录树 | 低 | 认识模块和文件布局 | 不知道文件内部能力 |
| Repo Map | 中 | 给模型提供跨仓符号全景 | 不包含完整实现和精确运行时链路 |
| 调用图 / Code Graph | 高 | 路径追踪与影响分析 | 建图更贵，动态行为仍可能缺失 |

Repo Map 的价值来自适度。它没有承担所有代码理解任务，而是用很少的上下文回答“仓库里还有什么值得看”。

## 七、Repo Map、RAG、FastCode 和 LLM Wiki 的关系

这几个概念最容易混在一起，因为它们都在向模型提供仓库知识。

### Repo Map：常驻的仓库索引页

Repo Map 通常随请求一起进入上下文。它短、稳定、可快速刷新，作用类似书前面的目录和索引。

### RAG：根据问题即时寻找证据

RAG 会把问题转换为关键词或向量查询，从索引中召回相关代码块和文档。它更适合回答具体问题，但一次检索可能漏掉没有文本相似度的结构关系。

### FastCode：先在结构地图上侦察，再读取正文

FastCode 把仓库探索做成一个显式阶段。Agent 可以多步搜索语义结构地图、沿调用和依赖关系移动，收敛后再加载完整代码。Repo Map 更像一次性提供的压缩全景，FastCode 更像一套可以交互探索的侦察工具。

### LLM Wiki：把仓库知识沉淀为可阅读页面

LLM Wiki 面向持续阅读和知识复用。它会把代码事实组织成模块说明、业务流程和架构页面。Repo Map 可以辅助 Wiki 发现核心符号，Wiki 也可以反过来补充地图无法表达的业务解释。

它们可以组合成一套代码知识系统：

```text
Repo Map       提供轻量全局结构
RAG            针对问题召回局部证据
FastCode       在复杂任务中继续结构化探索
LLM Wiki       沉淀稳定、可阅读的解释
Skills         规定找到知识后如何修改和验证
```

Repo Map 不需要替代其中任何一层。它填补的是“完整文件太重，目录树又太薄”之间的空位。

## 八、一次真实任务中怎样使用 Repo Map

假设任务是：

> 取消订单时增加优惠券返还，并保证重复消费不会重复返还。

Agent 当前只有 `OrderCancelConsumer.java` 的完整内容。Repo Map 还提供：

```text
CouponService.java:
│interface CouponService
│    void returnCoupon(ReturnCouponCommand command)

CouponServiceImpl.java:
│class CouponServiceImpl implements CouponService
│    void returnCoupon(ReturnCouponCommand command)

CouponRecordRepository.java:
│interface CouponRecordRepository
│    Optional<CouponRecord> findByOrderId(Long orderId)

IdempotencyService.java:
│class IdempotencyService
│    boolean tryAcquire(String businessKey)
```

模型因此知道仓库里已有返还接口、订单维度查询和幂等服务。它可以提出读取 `CouponServiceImpl` 与相关测试，而不是直接在消费者里新写一套数据库更新。

接下来仍要验证：

1. `returnCoupon` 是否已经幂等；
2. 事务边界包含哪些操作；
3. 消息重复和数据库回滚怎样处理；
4. 是否有缓存需要同步失效；
5. 现有测试使用什么夹具和断言。

地图帮助 Agent 选对入口，不替它完成这些判断。

## 九、增量更新为什么决定可用性

如果每次对话都重新解析整个仓库，Repo Map 很快会变成启动瓶颈。Aider 会按文件修改时间缓存 Tag。文件没有变化时直接复用定义和引用；文件变化后只重新解析对应部分。

一个工程化实现至少需要三层缓存：

```text
解析缓存：文件内容 → 定义与引用 Tag
图缓存：Tag 集合 → 文件关系和基础排名
地图缓存：对话焦点 + Token 预算 → 最终文本
```

三层缓存的失效条件不同。文件内容变化会影响解析与关系图；用户在对话中提到新符号，可能只需重新计算个性化排序；Token 预算变化则只影响最后的选择和渲染。

大型 Monorepo 还要处理范围。Aider 提供 `--subtree-only` 和忽略文件配置，允许用户只分析当前子树。实际系统也应该过滤生成代码、构建产物、第三方依赖和归档目录。地图里的噪声越多，排序算法越难补救。

## 十、Repo Map 的几个局限

### 1. 静态引用会漏掉动态行为

Spring 依赖注入、反射、注解扫描、消息订阅、SPI 和配置路由都可能隐藏真实关系。地图里没有一条边，不代表运行时没有调用。复杂问题仍要结合 Trace、日志、测试和框架元数据。

### 2. 中心性容易偏爱基础工具

被大量文件引用的工具类排名很高，却不一定对当前任务有用。个性化排序、路径过滤、文件角色和问题语义需要共同参与，不能只看 PageRank。

### 3. 签名不足以解释业务约束

方法名可以告诉模型存在 `returnCoupon()`，无法解释它能否重复调用、事务失败后是否重试。业务知识仍来自实现、测试、ADR、故障复盘和 Skills。

### 4. 地图也会给模型制造错觉

模型可能把地图中的省略内容当成完整实现，甚至尝试直接编辑地图片段。Aider 因此会针对模型能力决定是否默认启用 Repo Map。提示中需要明确说明：地图只用于导航，修改前必须读取真实文件。

### 5. 多仓库和权限需要额外设计

微服务调用经常跨仓库。分别生成 Repo Map 很容易，建立版本一致的跨仓关系更难。权限过滤也必须在地图生成前完成，不能先把无权访问的符号放入上下文，再要求模型忽略。

## 十一、自己实现一个最小版本

第一版不需要图数据库或向量数据库。选一个语言和一个中等规模仓库，完成下面四步就能验证价值。

### 第一步：提取定义和引用

使用 Tree-sitter 或语言服务器得到：

```text
file, symbol, kind, line, signature
```

先覆盖类、接口、函数和方法。字段、局部变量和匿名函数会迅速放大图规模，可以稍后增加。

### 第二步：建立文件关系

当文件 A 引用了文件 B 定义的符号，就增加一条 A 到 B 的边。可以用引用次数作为初始权重，并降低测试、生成代码和样板文件的权重。

### 第三步：注入任务焦点

从用户问题和已打开文件中提取文件名、类名和方法名，为对应节点增加个性化权重。第一版不必使用复杂语义模型，精确名称和简单分词已经能产生明显差异。

### 第四步：按预算渲染

输出文件路径、符号签名和少量父级上下文。持续加入高分符号，达到 Token 预算时停止。随后让模型回答两个问题：它能否正确选择下一批文件，能否复用仓库已有接口。

第一版的代码骨架可以控制在几百行以内。后续工作主要集中在语言适配、排序特征和评测集。

## 十二、怎样判断地图有没有用

Repo Map 的评测不能只看文本是否整齐。至少要记录下面几项：

| 指标 | 要回答的问题 |
| --- | --- |
| 目标文件召回率 | 最终需要修改的文件是否出现在地图或后续选择中 |
| 关键符号覆盖率 | 完成任务所需的接口、类型和方法是否被保留 |
| 无关符号比例 | Token 有多少花在与任务无关的地图内容上 |
| 下一步选择准确率 | 模型根据地图选择继续读取的文件是否正确 |
| 复用率 | 模型是否发现并复用仓库已有抽象 |
| 任务成功率 | 加入地图后，测试通过和人工验收是否改善 |
| 更新延迟 | 代码变化后多久能反映到地图中 |

评测集最好来自真实提交。对每个历史任务保留用户需求、最终修改文件、关键符号和测试结果，然后比较三组输入：只有目录树、加入 Repo Map、直接提供大批完整文件。

这里还要单独统计成本。Repo Map 节省的是每轮重复输入和盲目探索，生成地图本身也需要解析与排序。仓库小、任务明确、相关文件已经由用户选好时，它带来的收益可能很小。

## 十三、什么时候值得使用

Repo Map 适合下面这些情况：

- 仓库大于模型能够舒适阅读的范围；
- 任务经常跨文件，但一次只需要修改少量文件；
- 仓库已有稳定的模块和公共抽象；
- Coding Agent 需要主动选择下一步读取内容；
- 团队在意输入 Token、响应时间和上下文噪声。

它不太适合单文件脚本、临时 Demo，以及已经明确指定全部相关文件的简单修改。动态语言和大量运行时注册也会降低静态地图的覆盖率，此时应当把 Repo Map 当成入口，并补充搜索、运行时数据和测试。

## 十四、我对 Repo Map 的理解

Repo Map 是一种面向模型的代码压缩。它没有压缩每一行源码，而是保留仓库中最能帮助模型继续行动的坐标：文件、符号、签名、定义位置和引用关系。

这也解释了它为什么适合放进代码知识库系列。RAG 解决按问题召回，FastCode 解决结构化侦察，LLM Wiki 解决长期解释，Skills 解决执行方法。Repo Map 在每轮对话中提供一份轻量全景，让 Agent 不必在完全失去方向和一次读取全仓之间二选一。

树形输出只是一种表现形式。Repo Map 更值得研究的是它对信息预算的处理：哪些信息常驻、哪些按需检索、哪些只有在验证时才读取。

## 参考资料

- Aider，[Repository map](https://aider.chat/docs/repomap.html)
- Aider，[Repo Map 源码实现](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)
- Aider，[FAQ：仓库规模、地图与上下文建议](https://aider.chat/docs/faq.html)
- Aider，[Repo Map 支持语言](https://aider.chat/docs/languages.html)
- Tree-sitter，[Pattern Matching with Queries](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/index.html)
- NetworkX，[PageRank](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.link_analysis.pagerank_alg.pagerank.html)
