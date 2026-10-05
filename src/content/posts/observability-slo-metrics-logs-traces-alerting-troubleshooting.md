---
title: 可观测性与 SLO：指标、日志、Trace、告警和故障定位
description: 从用户旅程与 SLO 出发，设计 Metrics、Logs、Traces 的关联字段、采样和存储，再用多窗口燃烧率告警与一次支付故障定位，把遥测数据变成可执行的可靠性证据。
category: 后端
subcategory: 系统设计与高并发
articleClass: flagship
seriesOrder: 120
publishedAt: 2026-10-05T20:28:00+08:00
tags: [可观测性, SLO, SLI, Metrics, Logs, Traces, OpenTelemetry, Prometheus, 告警, 故障定位]
---

凌晨两点，值班工程师收到一条“CPU 超过 80%”的告警。监控大盘上有两百多张图，应用日志每分钟几十万行，链路平台保存了数百万条 Trace。数据很多，值班工程师仍然回答不了三个问题：哪些用户正在受影响，影响是否值得立刻叫醒更多人，下一步应该查哪里。

可观测性系统要交付一条可验证的证据链。图表先说明用户承诺有没有被破坏，再把问题缩小到请求类型、版本、地域、依赖或资源，最后提供足够细节复现一次失败。Metrics、Logs 和 Traces 是不同粒度的证据载体；SLO、告警策略、字段约定和故障响应流程决定这些数据能否合在一起工作。

本文回答的问题是：怎样从一条用户可感知的服务承诺出发，设计指标、日志、Trace 和告警，使工程师既能及时发现故障，也能沿同一组标识找到原因，并用故障后的数据验证修复有效？文章使用“付费续签”链路贯穿设计。支付状态机本身见[支付链路设计](/posts/payment-flow-design-state-machine-idempotency-compensation-reconciliation/)，本文只关注怎样观察它。

## 一、监控、遥测与可观测性分别解决什么

遥测（Telemetry）是系统主动产生的数据，包括指标样本、日志记录、Trace Span、Profile 和变更事件。监控（Monitoring）对其中一部分数据持续执行已知查询，例如“过去五分钟错误率是否超过阈值”。可观测性（Observability）要求系统留下足够证据，让工程师面对事先没有写成规则的问题时，仍能从外部数据推断内部发生了什么。

[OpenTelemetry 的可观测性说明](https://opentelemetry.io/docs/concepts/observability-primer/)把 Metrics、Logs 和 Traces 都视为遥测信号。三者的能力不同：

| 信号 | 擅长回答 | 不擅长回答 | 常见成本来源 |
| --- | --- | --- | --- |
| Metrics | 多少、何时开始、影响面多大 | 某一个请求经历了什么 | 标签组合产生的时间序列数量 |
| Logs | 某个组件在某一时刻记录了什么事实 | 跨服务时序和总体比例 | 写入量、全文索引、保留周期 |
| Traces | 一次请求跨服务花了多少时间、经过哪些分支 | 未采样流量的完整统计 | Span 数量、属性体积、采样策略 |
| Profiles | CPU 时间、分配和锁等待落在哪段代码 | 用户请求语义 | 持续采样与符号解析成本 |
| Change events | 何时发布、改配置、切流或执行运维动作 | 变化是否真的导致故障 | 变更来源不统一、记录缺失 |

只部署一个日志平台或接入一个 Trace SDK，不会自动获得可观测性。若所有服务对 `success` 的定义不同、消息链路不传播上下文、指标标签把 URL 实例值直接写入、告警也没有用户影响和处置动作，平台只能更快地保存一批无法关联的数据。

### 白盒信号与黑盒结果要同时存在

白盒信号来自系统内部，例如线程池队列、数据库连接等待、缓存命中率和 MQ 消费延迟。它们能解释原因，也能发现尚未形成用户影响的容量风险。黑盒信号从用户边界观察，例如从公网探测登录、创建订单并查询最终状态。它直接说明服务是否履约，却很难单独解释原因。

Google SRE 的[分布式系统监控章节](https://sre.google/sre-book/monitoring-distributed-systems/)把两者的关系概括为症状与原因：Pager 更适合由正在发生的用户症状触发，白盒指标则帮助定位原因和预警即将耗尽的资源。数据库 CPU 高是原因线索；支付确认率下降才是服务症状。若数据库 CPU 高但请求仍满足承诺，可以进入看板或工单，不一定要在凌晨叫醒人。

## 二、先写用户旅程，再定义 SLI

服务等级指标（SLI）是对服务行为的测量，服务等级目标（SLO）规定一个时间窗口内希望达到的水平，服务等级协议（SLA）则是对外合同及未达标后的责任。工程团队日常设计和告警通常围绕 SLI 与 SLO，不应把内部目标随意写成有赔偿含义的 SLA。

最常见的请求型 SLI 可以写成：

```text
SLI = good_events / valid_events

availability SLI:
  good = 返回正确结果，且结果语义满足接口契约

latency SLI:
  good = 有效请求在目标时间内完成
```

分母决定指标代表谁。压测流量、健康探针和调用方参数错误是否进入分母，需要按产品承诺明确记录，不能在故障发生后为了让数字好看临时排除。分子也不能只看 HTTP 状态码。接口返回 200 和空列表，真实数据却因权限 Bug 全部丢失，仍然属于错误事件。

付费续签至少有三条用户旅程：

| 用户旅程 | good event | 时间边界 | 主要证据 |
| --- | --- | --- | --- |
| 创建支付 | 返回明确失败，或返回可查询的 `flow_id` | 800 ms | 网关与服务端请求指标 |
| 获得最终结果 | 流水进入 `BIZ_SUCCESS` 或 `REFUNDED` | 2 min | 状态机终态事件 |
| 查询状态 | 返回与主库一致的当前状态 | 300 ms | 查询接口和抽样校验 |

第一条旅程健康，第二条仍可能大面积失败。同步接口快速返回 `PROCESSING`，HTTP 可用率会保持 100%，但用户两分钟后仍看不到权益，也没有收到退款。异步系统需要单独定义“在期限内收敛”的 SLI：

```text
convergence_sli =
  flows_reaching_valid_terminal_state_within_120s
  / eligible_created_flows
```

这里的终态必须带业务语义。`PAY_FAIL`、`BIZ_SUCCESS` 和 `REFUNDED` 都可以是合法终态，但长期停在 `PAYING` 不算成功；状态被错误推进到 `BIZ_SUCCESS` 也不能只凭枚举值计入 good event，抽样对账仍需验证支付与业务事实。

### 测量点越靠近用户，越接近真实体验

应用进程记录的延迟通常不包含网关排队、网络传输和客户端解析。若目标是用户点击到页面反馈，应优先在负载均衡器、边缘或客户端测量；若目标是服务自身处理时间，服务端指标更合适。两种指标可以同时存在，但名称和 SLO 文档要说明测量边界。

Google SRE 的 [SLO 实施指南](https://sre.google/workbook/implementing-slos/)建议通过已知事故、用户工单和 SLI 下降之间的关系持续校准指标。已知用户故障发生时 SLI 没有变化，说明测量点太靠里、覆盖不足或 good event 定义错误。SLI 持续变差却没有用户影响，也要检查分母、流量类别和目标是否合理。

## 三、SLO 把“稳定”变成可以消费的预算

假设“最终结果在两分钟内可得”的 30 天滚动 SLO 是 99.9%，错误预算就是 0.1%。窗口内有 10,000,000 笔合格流水，允许 10,000 笔没有按期收敛。预算承认 100% 可靠性成本极高，并给发布速度与稳定性投入提供共同尺度，它并不鼓励制造错误。

```text
error_budget_ratio = 1 - SLO
error_budget_events = valid_events × error_budget_ratio
burn_rate = observed_bad_event_ratio / error_budget_ratio
```

在 99.9% SLO 下，观察到 1% 的坏事件率，燃烧率是 10。若这种速度保持不变，30 天预算大约三天就会耗尽。燃烧率把不同 SLO 的服务放到相同尺度：同样是 1% 错误，对 99% SLO 只是 1 倍燃烧，对 99.99% SLO 则是 100 倍。

![从用户旅程到故障证据的可观测性闭环](/images/posts/observability-evidence-loop.svg)

SLO 通过闭环产生作用。服务先定义用户承诺，运行数据计算预算消耗，告警通知责任人，事故修复和复盘再修改代码、容量或测量方式。若预算耗尽后没有任何发布、优先级或架构决策变化，SLO 就退化成报表末尾的 KPI。

一份能执行的 SLO 文档至少写清：

- 服务边界和用户旅程；
- SLI 的分子、分母、数据源和计算查询；
- 目标值、滚动或自然窗口，以及为什么选这个窗口；
- 低流量、维护期、测试流量和数据缺失怎样处理；
- 预算不足时由谁采取什么动作；
- 评审人、最近验证日期和下一次复核时间。

目标值不能凭“行业都用三个 9”决定。它应来自用户容忍度、依赖能力、当前基线和成本。内部依赖只有 99.5% 可用，调用方又没有缓存、排队或降级，却对外承诺 99.99%，这份 SLO 没有可实现的设计基础。目标过松也会掩盖真实抱怨，需要用历史事故和用户反馈反复校准。

## 四、Metrics 用固定成本观察总体形状

指标把大量事件聚合成时间序列，适合持续计算速率、比例、分位数和资源水位。用户入口可以先覆盖 Google SRE 所说的四个黄金信号：延迟、流量、错误和饱和度。服务内部还可使用 RED 观察 Rate、Errors、Duration，使用 USE 检查每种有限资源的 Utilization、Saturation、Errors。它们都是检查框架，不能替代业务 SLI。

付费续签链路可以从下面这组指标起步：

```text
http_server_requests_total{service, route, method, status_class, region, version}
http_server_request_duration_seconds_bucket{service, route, method, region, version, le}

pay_flow_created_total{scene, region, version}
pay_flow_terminal_total{scene, terminal_status, region, version}
pay_flow_transition_total{from, to, trigger, result, region, version}
pay_flow_nonterminal_age_seconds{state, region}

wallet_requests_total{operation, result, provider, region}
wallet_request_duration_seconds_bucket{operation, provider, region, le}
mq_wakeup_total{topic, action, result, region}
scanner_flow_total{state, action, result, region}
```

指标名描述被测对象和单位，标签用于有限维度的分组。`route=/payments/{id}` 是有限集合，`path=/payments/938472` 会为每个订单创建新序列。`user_id`、`flow_id`、完整 URL、异常堆栈和 SQL 文本都不应成为 Metric 标签，它们属于日志或 Trace。

### Counter、Gauge 与 Histogram 不可互换

Counter 只增加，适合请求数、错误数和状态迁移次数。进程重启后 Counter 可以从零开始，查询用 `rate()` 或 `increase()` 处理重置。Gauge 可增可减，适合当前队列深度、连接数和最老任务年龄。若用 Gauge 记录“累计错误数”，重启和多实例聚合会让语义混乱。

延迟应使用 Histogram 保存分布。平均值会隐藏长尾，单实例预计算的 p95 也不能直接跨实例取平均。[Prometheus 的 Histogram 说明](https://prometheus.io/docs/practices/histograms/)明确指出，预计算 Quantile 的平均值没有统计意义；Histogram Bucket 可以先按实例聚合，再通过 `histogram_quantile()` 估算总体分位数。

```text
# 整个服务过去 5 分钟的 p95，而不是各实例 p95 的平均值
histogram_quantile(
  0.95,
  sum by (le) (
    rate(http_server_request_duration_seconds_bucket{
      service="payment", route="/payments"
    }[5m])
  )
)
```

Bucket 边界应围绕 SLO 和真实分布设置。如果延迟目标是 300 ms，却只有 `100 ms、1 s、10 s` 三个边界，系统只能知道请求落在 100 ms 到 1 s 之间，无法准确计算 300 ms 内的 good event。OpenTelemetry 当前的 [HTTP Metrics 语义约定](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)也把服务端请求时长定义为 Histogram，并给出建议边界；项目仍要按自身目标与分布验证，不必机械照抄。

### 高基数首先是数据模型问题

时间序列数量大致等于标签值组合的笛卡尔积。20 个服务、30 条 Route、6 个状态码类别、5 个地域、20 个版本，理论上已经达到 360,000 组；再加入百万级用户 ID，监控后端和查询都会失控。

控制基数的做法包括：在采集侧把实例路径归一为 Route 模板；状态码按类别聚合，只在需要时保留少量具体码；版本标签保留当前和最近几个版本；用户、订单和 Trace 标识进入可检索日志；用 Exemplar 将少量 Histogram 样本连接到具体 Trace。基数预算应进入代码评审和上线检查，不能等监控平台账单或 OOM 后再清理。

## 五、Logs 保存离散事实和决策上下文

日志最有价值的部分是不可从指标还原的离散事实：输入属于哪个业务场景，状态为什么从 A 迁移到 B，下游返回的是明确失败还是结果未知，代码使用了哪一版配置。自由文本适合人读，稳定字段才便于机器过滤和关联。

一次状态迁移日志可以长这样：

```json
{
  "timestamp": "2026-10-04T01:32:18.412+08:00",
  "severity": "INFO",
  "service.name": "payment-coordinator",
  "service.version": "2026.10.04-rc3",
  "deployment.environment": "prod",
  "cloud.region": "cn-north-1",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "flow_id": "901",
  "trade_order_no_hash": "9d37...",
  "event": "pay_flow_transition",
  "from": "PAYING",
  "to": "PAYED",
  "trigger": "MQ",
  "result": "CAS_SUCCESS",
  "duration_ms": 17
}
```

字段需要有跨服务约定。时间使用带时区的统一格式；严重级别保持有限枚举；`service.name`、版本、环境、地域和可用区描述资源；`event` 描述稳定事件类型；Trace 与业务 ID 用于关联。异常日志还要包含 `error.type`、稳定错误码和堆栈，但不要把完整异常文本当聚合维度。

[OpenTelemetry Logs 规范](https://opentelemetry.io/docs/specs/otel/logs/)支持在 LogRecord 中携带 TraceId 和 SpanId，使日志能跳转到对应 Span。关联只有在上下文正确传播时才成立。异步线程池、消息消费和定时任务若丢失 Context，日志里的 Trace ID 会在最需要的时候断开。

### 级别代表处置语义，不代表作者情绪

一条可自动恢复的单次下游超时通常不需要 `ERROR`；系统最终耗尽重试、违反业务期限或需要人工介入时才升级。若每次重试都打印完整堆栈，一次渠道故障会制造日志风暴，并让真正的终态错误淹没在重复记录里。

可以把同类瞬时错误计入 Counter，日志按首条、状态变化和周期摘要输出；终态失败保留完整上下文。`WARN` 和 `ERROR` 的定义要与告警分离，日志级别本身不能直接决定是否 Page。第三方库突然增加 ERROR 日志，也不应绕过用户影响判断叫醒值班人员。

### 日志不能泄露比故障更多的问题

支付凭证、访问 Token、Cookie、完整手机号、身份证和银行卡信息不能进入普通日志。业务 ID 也要按权限和用途决定是否哈希或脱敏。清理应尽量发生在 SDK 或 Collector 侧，使所有服务遵守同一规则；只依赖每位开发者手工删字段，很容易在异常对象序列化时漏出敏感数据。

日志保留策略按用途分层。近几小时的热数据支持故障搜索，近几周数据支持趋势与复盘，更长周期的审计记录可以进入成本更低、权限更严格的存储。把所有 DEBUG 日志永久全文索引，既昂贵，也扩大安全暴露面。

## 六、Traces 把一次请求拆成路径与等待

Trace 由一组 Span 组成。Span 表示一个工作单元，记录开始时间、持续时间、父子关系、状态、属性和事件。一个 HTTP 请求经过网关、支付服务、钱包客户端与数据库时，每一步都可以形成 Span；瀑布图展示端到端时间花在本地计算、连接等待、下游 RPC 还是队列中。

W3C 的 [Trace Context 规范](https://www.w3.org/TR/trace-context/)定义了 `traceparent` 与 `tracestate` HTTP 头，使不同库和厂商能传播同一 Trace 身份。`traceparent` 中包含 Trace ID、当前父 Span ID 和 Trace Flags。服务收到不可信外部请求时要验证格式，并遵守隐私与滥用边界，不能把任意外部 Baggage 直接变成内部高权限标签。

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  └──────────── trace-id ────────────┘ └ span-id ─────┘ │
             version                                            flags
```

Span 名称要低基数且稳定，例如 `POST /payments`、`wallet.charge`、`SELECT pay_flow`。订单号和用户 ID 放属性，不放 Span 名称。属性命名尽量采用 OpenTelemetry Semantic Conventions，避免 Java 服务写 `http.code`，Go 服务写 `status`，网关又写 `response_status`，最终无法统一查询。

### 异步链路不能强行伪装成一棵同步调用树

同步 RPC 有自然的父子关系，MQ 生产与消费可能间隔几分钟，一个消息也可能被重复消费或批量处理。消费者可以从消息头提取 Trace Context 创建后继 Span；当一个消费动作由多个消息共同触发，或重试已经属于新的处理过程，Span Link 往往比单一 Parent 更准确。

支付流程跨越同步请求、延迟消息、渠道回调和 Scanner，生命周期可能长达数小时。把所有动作挂在一个永不结束的 Trace 上，查询和采样都很困难。更实用的设计是让每次触发形成有限 Trace，同时在 Span 与日志中携带 `flow_id`、`trade_order_no_hash` 和触发来源。Trace 回答一次执行经过哪里，业务关联键串起跨时间的完整生命周期。

### 采样要保护稀有失败，也要保护采集链路

全量 Trace 在高 QPS 系统中通常不可承受。Head Sampling 在请求开始时按概率决定，成本低，却无法预知本次请求是否最终失败；Tail Sampling 等待完整或大部分 Trace 后，根据错误、总延迟、版本或属性决定是否保留。OpenTelemetry 的[采样说明](https://opentelemetry.io/docs/concepts/sampling/)同时指出，Tail Sampler 需要缓存大量 Span，是有状态且必须被监控的组件。

常见组合是：低比例保留正常流量，完整保留错误与极慢请求，提高新版本和低流量关键接口的采样率，并给每个租户或属性规则设置上限。采样策略本身也要有指标，例如接收 Span 数、丢弃原因、决策延迟、缓冲区水位和导出失败。观测系统过载时静默丢掉所有错误 Trace，会让业务事故和诊断能力同时恶化。

## 七、三类信号靠共同维度组成证据链

Metrics、Logs 和 Traces 不需要落在同一个数据库，但必须共享可以跳转的维度。建议把维度分成三层：

| 层级 | 示例 | 放在哪里 |
| --- | --- | --- |
| 资源维度 | service、version、environment、region、zone、instance | 三类信号都带 |
| 请求维度 | route、operation、result、error.type | 指标用有限集合，日志与 Trace 可更细 |
| 实例身份 | trace_id、flow_id、order_id、message_id | 日志与 Trace，避免进入 Metric 标签 |

![Metrics、Traces 与 Logs 怎样从总体缩小到单次故障](/images/posts/observability-signal-correlation.svg)

故障调查通常从左向右缩小范围。SLO 告警先给出受影响旅程和时间窗口；Metrics 按地域、版本和 Route 切分，找到异常群体；Histogram Exemplar 或同窗口 Trace 搜索给出具体慢请求；Trace 中的 `flow_id` 再跳到状态迁移日志和数据库审计记录。若每次跳转都要手工换算时区、猜服务名或复制模糊错误文本，信号还没有真正关联。

资源字段应由部署平台注入，避免各业务自行填写。版本要能对应构建产物与提交，环境和地域使用固定枚举，实例身份在容器重启后变化。业务库中的状态迁移、网关请求和消息消费都使用同一错误分类，例如 `TIMEOUT`、`REMOTE_REJECTED`、`UNKNOWN_RESULT`、`CAS_CONFLICT`；否则一个故障会在三个系统里显示成三个无关问题。

### 变更事件是经常缺失的第四条线索

很多事故发生在发布、配置变更、证书轮换、流量切换或定时任务执行后。把这些事件以统一时间轴叠加到 SLO 与 Metrics 上，能快速回答异常是否只影响新版本、某个 Cell 或变更后的实例。

相关性不是因果关系。错误率在发布后上升，只能支持“版本是候选原因”；还要比较未发布实例、回滚或流量隔离后的结果。变更记录应包含操作者、对象、前后版本、审批或自动化来源以及回滚动作，使调查能够验证假设，而不是凭时间接近直接归因。

## 八、告警先判断用户影响，再帮助定位原因

一个 Page 级告警应同时满足四个条件：用户正在或即将受到明显影响；问题需要尽快处理；接收者有可执行动作；自动化无法安全完成全部处置。磁盘将在三十天后填满可以建工单，单实例短暂重启可以由编排系统自愈，支付最终成功率快速下降则需要立即响应。

静态阈值容易两头失效。错误率固定超过 1% 才报警，会漏掉对 99.99% SLO 已经严重的故障；固定超过 0.1% 报警，又会让低流量服务因一次失败频繁触发。基于 SLO 的燃烧率告警直接衡量预算消耗速度。

[Google SRE Workbook 的 SLO 告警章节](https://sre.google/workbook/alerting-on-slos/)给出一组可作为起点的多窗口、多燃烧率配置。对 30 天窗口的 99.9% SLO，可以同时检查：

| 级别 | 长窗口 | 短窗口 | 燃烧率 | 大约消耗预算 |
| --- | ---: | ---: | ---: | ---: |
| Page | 1 h | 5 min | 14.4× | 2% |
| Page | 6 h | 30 min | 6× | 5% |
| Ticket | 3 d | 6 h | 1× | 10% |

长窗口保证事件已经消耗足够预算，短窗口确认故障仍在持续。两者同时超阈值才 Page，可以避免一个已经恢复的短脉冲继续报警一小时。数值来自上述窗口和预算比例，不是所有服务的默认答案；低流量接口、批处理任务和强周期业务要单独设计。

![多窗口燃烧率告警怎样区分快速故障与慢性消耗](/images/posts/observability-burn-rate-windows.svg)

一条告警通知需要直接给出处置上下文：受影响的用户旅程、当前 SLI 与燃烧率、开始时间、主要地域和版本、关联看板、最近变更、Runbook、静默与升级规则。通知标题若只是 `HighErrorRate`，值班人员还要从零猜服务、范围和紧急程度。

### 原因告警更适合补充，而非成片呼叫

数据库连接池饱和、MQ 积压、证书即将过期和磁盘接近满载都有价值。其中有些是明确且迫近的风险，可以 Page；更多原因指标适合挂在症状告警的诊断看板里。若入口错误率、钱包错误率、数据库 CPU 和 MQ 积压分别通知四个团队，同一事故会制造告警风暴和重复指挥。

告警路由要有唯一主责。依赖团队可以收到关联通知，但事件指挥、用户沟通和缓解动作必须由明确的人协调。告警恢复也要通知，并保留事件期间阈值、静默、升级和动作时间线，供复盘判断告警是否太晚、太吵或无法执行。

## 九、看板按问题组织，不按基础设施产品组织

首页看板应在一分钟内回答：用户承诺是否满足，哪个旅程、地域或版本正在消耗预算，影响从何时开始。第二层看板展示四个黄金信号和主要依赖，第三层才展开 JVM、容器、数据库和 Broker 细节。

一个支付服务首页可以包含：

1. 创建支付、两分钟收敛、状态查询三条 SLI 与剩余预算；
2. 各状态流入速率、终态比例、非终态年龄分布；
3. 钱包调用的速率、错误分类和延迟；
4. MQ 唤醒发送、消费、延迟与 Scanner 兜底命中；
5. 按地域、版本和支付场景切分的影响面；
6. 最近发布、配置和流量变更时间线。

CPU、堆内存和 Pod 数量仍然需要，但放在诊断层。把每种中间件各放一整页，会迫使调查者在几十个 Tab 之间寻找同一时间窗口。统一变量、时区、单位和版本筛选，远比再加一张图有用。

看板也需要维护。没有告警引用、没有人查看、无法支持任何决策的图应删除；查询耗时过长或依赖高基数维度的面板要改写。事故复盘时记录“为了回答什么问题临时写了哪条查询”，重复出现的查询再进入正式看板。

## 十、用一次支付收敛故障走完整条证据链

假设一次发布把 MQ 延迟唤醒参数的单位从毫秒改为秒，调用方仍传入 `5000`。新建支付流水在钱包响应未知后，本应五秒再查单，消息却被安排在约八十三分钟之后。数据库中的 `next_retry_time` 仍按五秒计算，因此 Scanner 每五分钟可以捞回部分流水。系统没有完全中断，但大量用户迟迟看不到最终结果。

### 01:28，症状告警发现异步承诺被破坏

同步创建接口仍在 300 ms 内返回 `PROCESSING`，HTTP 5xx 没有变化，CPU 也只有 35%。如果系统只监控入口请求，事故不会触发告警。

“两分钟内进入合法终态”的 SLI 在 1 小时和 5 分钟窗口同时超过 14.4 倍燃烧率，Page 指向支付团队。通知显示影响从 01:21 开始，集中在 `2026.10.04-rc3`，两个地域都存在，因此单机和单可用区故障优先级下降。

### 01:31，Metrics 把范围缩到唤醒链路

看板显示 `pay_flow_created_total` 正常，钱包 `SUCCESS` 与 `UNKNOWN` 比例没有明显变化，`PAYING` 状态的最老年龄和 p95 快速上升。`mq_wakeup_total{action="scheduled"}` 正常，`action="consumed"` 从新版本上线后明显下降；Scanner 命中量每五分钟出现一次尖峰。

这些数据支持“支付请求仍在发生，延迟唤醒没有按期消费，Scanner 正在兜底”。它还不能区分 Broker 调度异常、生产参数错误或 Consumer 停止，需要进入单次请求。

### 01:34，Trace 与日志给出具体错误参数

工程师从异常版本的 `PAYING` Histogram Exemplar 打开一条 Trace。同步 Span 显示钱包请求在 420 ms 后超时，流程正常写入 `PAYING`；消息生产 Span 的 `messaging.delay` 属性却是 `5000 s`。使用 `flow_id` 查询结构化日志，可以看到数据库中的 `next_retry_time` 是五秒后，消息发送事件记录的 `delay_value=5000`、`delay_unit=SECONDS` 与它矛盾。

最近变更时间线显示 01:20 发布了 MQ SDK 适配层。对照上一版本 Trace，旧属性为 `5000 ms`。此时证据已经把故障缩小到单位转换，不需要继续翻数据库 CPU、GC 或钱包服务日志。

### 01:39，缓解动作与验证围绕同一 SLI

团队回滚新版本，暂停继续制造错误调度；随后按速率限制批量修正受影响流水的 `next_retry_time`，让 Scanner 和 MQ 消费者逐步恢复，避免一次性释放全部积压压垮钱包。修复脚本使用流水版本和前置状态做 CAS，已经进入终态的订单不会被重新推进。

短窗口燃烧率先恢复，`PAYING` 年龄分布随后下降，Scanner 命中回到基线。团队继续观察两分钟收敛 SLI，而不是以“Pod 已回滚”宣布结束。事故影响按未在两分钟内收敛的流水数计算，复盘动作包括参数类型改为 `Duration`、消息延迟契约测试、发布对比面板和积压释放 Runbook。

![一次异步支付故障怎样从告警收敛到代码参数](/images/posts/observability-incident-walkthrough.svg)

这条路径没有从海量日志全文搜索开始。告警给出用户症状，Metrics 确定影响面和异常组件，Trace 暴露一次具体调用，日志补齐持久状态和决策，变更事件提供可验证的候选原因，最终仍由原 SLI 判断恢复。

## 十一、遥测采集链路也会故障

典型采集路径包含 SDK、Agent 或 Sidecar、OpenTelemetry Collector、消息缓冲、后端存储、查询和告警执行器。每一层都可能丢数据、积压、限流或时间漂移。业务没有指标，不代表业务健康；也可能是采集链路已经中断。

Collector 应暴露接收、处理、丢弃、重试和导出指标。关键告警的数据源尽量减少依赖，Page 路径与业务系统避免共享同一个故障域。若数据库故障同时让 Metrics 查询和告警存储不可用，最需要告警时系统会沉默。黑盒探测和多地域告警可以提供独立证据。

时间同步同样影响调查。实例时钟偏移会让 Span 出现负耗时，让日志顺序颠倒。分布式 Trace 可以修正一部分显示，但业务审计和跨系统对账仍依赖可靠时间。监控 NTP 偏移、在事件中保留接收时间，并避免通过毫秒时间戳猜测严格因果顺序。

### 遥测丢失本身必须有明确语义

SLI 查询没有数据时，不能默认等于 100%。低流量、采集停止和查询失败会得到相似的空结果，需要借助流量基线、采集心跳与数据新鲜度区分。告警规则可显式检查 `absent()`、最后样本时间和目标发现数量。

故障期间临时调高日志或采样率也可能压垮链路。Runbook 应规定允许调到什么范围、保持多久、由谁恢复，并为 Collector 和存储预留突发容量。诊断手段不能成为第二次事故。

## 十二、成本、隐私与保留期是架构约束

遥测量随请求量、Span 数、日志字节和指标序列数增长。没有预算的系统常经历两个极端：平时全量采集导致成本失控，事故时紧急粗暴降采样又丢掉关键证据。

可以为信号分别设预算：

```text
metrics  = active_series × samples_per_series × retention
logs     = events_per_second × average_event_bytes × retention
traces   = requests_per_second × spans_per_trace × sampled_ratio × span_bytes
```

公式用于识别增长因子，不用于替代真实压测。新增一个标签前估算唯一值数量，新增一个 Span 前确认它是否表达独立工作单元，新增日志字段前说明查询用途。成本看板按服务、环境、信号和保留层拆分，让团队看到哪项埋点在增长。

隐私规则应覆盖采集、传输、存储、查询和删除。开发环境的真实数据不能默认进入权限更宽的测试平台；Baggage 会跨服务传播，不能放用户隐私或凭证；Trace 和日志的访问要审计；删除请求需要考虑热存储、归档与备份。脱敏之后仍可能通过多个准标识重新识别用户，因此最安全的字段是根本不采集。

## 十三、埋点也要经过设计、测试与评审

埋点是生产代码的一部分。错误的 Counter 名称、重复注册、标签爆炸、Context 丢失和日志序列化异常都会影响系统。团队可以为遥测建立最小契约：

```yaml
service: payment-coordinator
journey: payment_converged_within_120s
sli:
  good: terminal in [BIZ_SUCCESS, REFUNDED, PAY_FAIL] within 120s
  valid: production flows excluding approved load tests
dimensions:
  metrics: [scene, region, version, terminal_status]
  logs_traces: [flow_id, trade_order_no_hash, trace_id]
owner: payment-oncall
runbook: /runbooks/payment-convergence
```

单元测试验证 Metric 只在预期分支增加、日志包含必需字段且不含敏感字段、Context 能跨线程池和消息传播。集成测试启动 Collector，检查生成的 Span 父子或 Link 关系、资源属性和状态。预发布环境通过故障注入验证 SLI、告警和 Runbook：让钱包超时、暂停 Consumer、制造数据库连接等待，观察告警是否在预期窗口触发，以及通知能否引导到正确证据。

上线前还要检查 Dashboard 与告警查询是否在生产数据规模下可执行。一个需要扫描数十亿日志才能判断是否 Page 的规则，可靠性和成本都不合格。高频 SLO 计算可使用 Recording Rules 或预聚合，详细查询留给事故调查。

## 十四、故障响应把遥测转换为行动

告警只是故障处理的开始。收到 Page 后，先确认用户影响和故障范围，再选择缓解动作；根因分析可以在服务恢复后继续。立即回滚、切流、降级、限流或暂停高风险写入，取决于哪种动作能降低正在燃烧的预算，同时不引入更大数据风险。

事件时间线至少记录：最早用户影响、告警触发、值班确认、关键证据、缓解决定、动作执行、SLI 恢复和事件结束。聊天记录可以辅助，不应成为唯一记录。多人协作时明确 Incident Commander、操作执行和用户沟通角色，避免两个人同时回滚或修改同一配置。

复盘不以“某人传错单位”结束。需要继续问：为什么接口允许整数跨越单位边界，为什么契约测试没有发现，为什么灰度指标没有比较延迟消息消费，为什么 Scanner 五分钟兜底仍无法满足两分钟 SLO。行动项要有负责人、期限和可验证结果，例如“类型改为 `Duration` 并加入编译期约束”比“以后注意单位”更可执行。

### 用历史事故校验可观测性

每次事故都能反向测试系统：用户最早何时受影响，SLI 何时变化，告警延迟多久，第一张看板是否缩小范围，Trace 是否保留了失败样本，日志能否按同一 ID 找到状态，最近变更是否完整。如果其中一步依赖某位老工程师记住隐藏路径，就把这条知识写入字段约定、看板或 Runbook。

衡量可观测性的指标可以包括 MTTD、确认时间、缓解时间、无动作告警比例、重复告警数量、Runbook 命中率、遥测丢弃率和每项信号成本。但这些数字也可能被优化错。为了降低 MTTD 而增加大量低质量 Page，会缩短检测时间并恶化值班质量；最终仍要看用户影响、预算消耗和团队能否持续运转。

## 十五、从零落地时怎样分阶段

第一阶段先选一个关键用户旅程，定义 SLI、SLO 和负责人；接入入口请求的 Rate、Errors、Duration，加上一个最接近用户的黑盒探测；建立能执行的 Page 与最小 Runbook。此时不追求全链路全量 Trace。

第二阶段补齐主要依赖和异步状态。统一服务、环境、地域、版本与错误类型字段，结构化关键状态日志，传播 W3C Trace Context，让 Metric 能跳到 Trace，Trace 能按业务 ID 找日志。用一次已知故障验证证据链。

第三阶段治理规模和成本。设置标签基数预算、Trace 采样、日志分层保留和 Collector 容量；把变更事件接入统一时间线；用多窗口燃烧率替换大量静态阈值，并清理没有动作的告警和无人使用的面板。

第四阶段让可靠性数据进入决策。预算消耗影响发布节奏和技术债优先级，故障演练验证告警与 Runbook，复盘行动项通过同一 SLI 验收。SLO 不再只是可视化数据，而是开发、产品和运维共同接受的服务边界。

### 上线检查清单

- SLI 是否对应一个明确用户旅程，而非单个机器状态？
- good event 是否同时考虑结果正确和时间边界？
- 分子、分母、排除项、窗口和数据缺失语义是否写清？
- Page 是否基于用户症状或确定且迫近的风险？
- 通知是否包含负责人、影响、看板、变更和 Runbook？
- 指标是否避免用户、订单、实例 URL 等高基数标签？
- Histogram Bucket 是否围绕延迟 SLO 和真实分布设置？
- 日志是否结构化、可关联且经过敏感字段检查？
- Trace Context 是否跨 HTTP、线程池和 MQ 正确传播？
- 异步生命周期是否使用业务关联键，而非无限延长单个 Trace？
- 采样是否保留错误、慢请求、新版本和低流量关键路径？
- Collector、存储、查询和告警链路是否有自身健康指标？
- 一次已知故障能否从 SLO 告警走到具体版本、Trace 和日志？
- 修复后是否由原 SLI 与状态分布证明用户影响已经结束？

## 结语

可观测性从服务承诺开始。SLI 把用户旅程变成可计算事件，SLO 给错误留下有边界的预算，燃烧率告警判断何时需要人介入。Metrics 展示总体形状，Traces 拆开一次请求，Logs 保存离散事实，Profiles 与变更事件补上代码和时间线；共同的资源字段、Trace Context 与业务关联键让它们形成证据链。

一套成熟系统允许工程师从“哪些用户正在受影响”逐步收敛到“哪次变更、哪条路径和哪个参数造成了影响”，并在缓解后使用同一个 SLI 证明恢复。数据收集量、图表数量和平台功能会增加成本；缩短这条验证路径，才是建设可观测性要取得的结果。

## 参考资料

- [Google SRE Book：Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [Google SRE Workbook：Implementing SLOs](https://sre.google/workbook/implementing-slos/)
- [Google SRE Workbook：Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [OpenTelemetry：Observability Primer](https://opentelemetry.io/docs/concepts/observability-primer/)
- [OpenTelemetry：Logging Specification](https://opentelemetry.io/docs/specs/otel/logs/)
- [OpenTelemetry：Sampling](https://opentelemetry.io/docs/concepts/sampling/)
- [OpenTelemetry Semantic Conventions：HTTP Metrics](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)
- [W3C：Trace Context](https://www.w3.org/TR/trace-context/)
- [Prometheus：Histograms and Summaries](https://prometheus.io/docs/practices/histograms/)
