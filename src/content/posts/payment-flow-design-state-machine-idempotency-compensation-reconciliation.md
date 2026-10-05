---
title: 支付链路设计：状态机、幂等、补偿与对账
description: 以一次付费续签为例，从业务目标、支付尝试与退款单号的拆分开始，设计支付状态机、幂等调用、CAS 推进、MQ 与 Scanner 补偿、退款闭环、对账和灰度迁移。
category: 后端
subcategory: 系统设计与高并发
articleClass: flagship
seriesOrder: 110
publishedAt: 2026-10-02T20:59:00+08:00
tags: [支付系统, 状态机, 幂等, 补偿, 对账, 消息队列, Scanner, CAS, 系统设计]
---

用户用账户余额购买一次续签权益。支付服务调用钱包后超时，页面只看到“请求失败”；几秒后钱包完成扣款，续签服务也可能已经写入权益。此时重新创建支付单可能多扣，立即退款可能把已经发放的权益免费送给用户，只等待人工又会让大量流水长期停在处理中。

支付链路的难点通常不在一次成功调用，而在副作用已经发生、确认却没有回来。进程可能死在任意两次写入之间，MQ 会重复或耗尽重试，回调会乱序，Scanner 可能与在线请求同时推进。系统必须保存足够的事实，让任何入口都能回答：这笔钱是否扣了，业务是否完成，若需退款又退到了哪一步。

本文回答的问题是：一笔支付怎样在超时、重复、乱序和部分失败下，最终收敛到可解释的终态，并且不多扣、不误退、不漏退。前文[分布式事务：2PC、TCC、Saga、Outbox 与事务消息怎样选](/posts/distributed-transactions-2pc-tcc-saga-outbox/)讨论方案边界；本文假设外部钱包无法参与 XA，但支持稳定单号幂等和查单，继续向下完成数据模型、接口语义、推进器、补偿任务、对账与迁移设计。

案例来自一套真实支付改造的抽象。业务名、表结构和代码都经过简化，不代表某个支付渠道的固定接口。本文也不展开 PCI、清结算、风控和会计总账；它关注业务系统与支付能力之间的一致性链路。

## 一、先承认链路里有三份独立事实

“支付成功”这句话经常同时指三件事：渠道已经扣款，业务权益已经发放，用户最终不再需要退款。它们的提交点不同，不能压进一个布尔字段。

| 事实 | 权威来源 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 支付事实 | 钱包或支付渠道订单 | 扣款成功、失败或处理中 | 业务权益是否发放 |
| 业务事实 | 业务主库 | 续签、出票、发货等目标是否完成 | 钱是否实际到账 |
| 退款事实 | 钱包退款单 | 退款受理、成功、失败或未知 | 原业务是否应该退款 |

一条安全链路至少维护下面几条不变量：

```text
同一个 trade_order_no 最多产生一次有效扣款
同一个 refund_order_no 最多产生一次有效退款
BIZ_SUCCESS 一旦成立，自动流程永久禁止退款
支付成功且业务最终失败的流水必须进入退款闭环
任何非终态都能被数据库查询重新发现
```

若“下一步该做什么”只存在于线程内存、Redis 临时标记或某条 MQ 消息中，触发器丢失后就没有恢复入口。主库流水既要描述已经确认的事实，也要显式暴露尚未完成的工作。

![支付链路中的身份、事实与触发器](/images/posts/payment-flow-evidence-model.svg)

图中三层不能互相代替。业务单号负责把重复请求认成同一件事，状态机负责决定下一步，MQ 和 Scanner 只负责唤醒。触发次数可以很多，资金身份和合法状态迁移必须稳定。

### 业务目标与支付尝试是两个身份

假设用户要修复一次中断的连续签到：

```text
biz_key        = R:{userId}:{roundId}:{breakDate}:{breakDays}
attempt_no     = 1, 2, 3 ...
trade_order_no = h2r_{userIdBase36}_{flowIdBase36}
refund_order_no = r_{tradeOrderNo}
```

`biz_key` 表示长期不变的业务目标。同一个目标可以经历多次支付尝试，例如第一次被钱包明确拒绝后，用户换一种支付方式再次发起。`trade_order_no` 表示其中一次 attempt，也是钱包执行幂等的键。结果未知时必须继续沿用旧单号查单；只有得到明确失败，才允许创建下一次 attempt。

退款单号从支付单号确定性派生，同一 attempt 的所有退款重试都使用它。随机生成新退款号会把一次重试变成一笔新退款。

这与 Stripe 的公开接口语义一致：其[幂等请求文档](https://docs.stripe.com/api/idempotent_requests)要求客户端为可安全重试的写请求提供稳定 idempotency key，并在同键参数不一致时拒绝复用。具体钱包未必采用同一实现，但支付链路要依赖等价能力：同一个业务单号重复调用不会制造第二笔资金副作用，而且能查询权威结果。

## 二、流水表保存恢复证据，而不是只保存结果

下面是一份简化表结构。字段名可以调整，职责不能含混：

```sql
CREATE TABLE internal_pay_flow (
  id                  BIGINT       NOT NULL AUTO_INCREMENT,
  user_id             BIGINT       NOT NULL,
  scene               VARCHAR(32)  NOT NULL,
  biz_key             VARCHAR(160) NOT NULL,
  attempt_no          INT          NOT NULL,
  trade_order_no      VARCHAR(96)  NULL,
  refund_order_no     VARCHAR(96)  NULL,
  status              VARCHAR(24)  NOT NULL,
  version             BIGINT       NOT NULL DEFAULT 0,
  amount              BIGINT       NOT NULL,
  currency            VARCHAR(16)  NOT NULL,
  biz_deadline_time   DATETIME(3)  NOT NULL,
  next_retry_time     DATETIME(3)  NOT NULL,
  retry_count         INT          NOT NULL DEFAULT 0,
  last_error_code     VARCHAR(64)  NULL,
  channel_request_id  VARCHAR(128) NULL,
  created_at          DATETIME(3)  NOT NULL,
  update_time         DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_trade_order_no (trade_order_no),
  UNIQUE KEY uk_refund_order_no (refund_order_no),
  UNIQUE KEY uk_biz_attempt (user_id, scene, biz_key, attempt_no),
  KEY idx_scan (status, next_retry_time, id)
);
```

金额使用最小货币单位的整数，币种或账户资产类型跟随流水冻结，不能在重试时重新读取活动价格。`biz_deadline_time` 是业务动作的截止时间，例如续签只能发生在某个日期之前；`next_retry_time` 是调度时间，两者不能共用。deadline 到达后应停止制造新的业务副作用，调度器仍可能继续查单、退款和对账。

错误码也不应只有一段异常文本。至少要区分明确业务失败、暂时不可用、结果未知、参数冲突和人工冻结。调度器据此决定是否原单重试、何时降频、是否允许新 attempt，以及要不要升级人工处理。

### 先建行，再生成外部单号

如果支付单号包含数据库自增 `flow_id`，建单可以分成两步：先插入 `WAIT_PAY` 行取得 ID，再由 `user_id + flow_id` 确定性生成 `trade_order_no` 和 `refund_order_no`，最后回写同一行。

```sql
INSERT INTO internal_pay_flow(
  user_id, scene, biz_key, attempt_no, status,
  amount, currency, biz_deadline_time, next_retry_time,
  created_at, update_time
) VALUES (
  :userId, :scene, :bizKey, :attemptNo, 'WAIT_PAY',
  :amount, :currency, :deadline, NOW(3), NOW(3), NOW(3)
);

-- 由返回的 id 确定性计算两个单号
UPDATE internal_pay_flow
SET trade_order_no = :tradeOrderNo,
    refund_order_no = :refundOrderNo
WHERE id = :flowId
  AND trade_order_no IS NULL;
```

进程若死在两条 SQL 之间，Scanner 仍能从 `id` 重算出完全相同的单号。若先随机生成单号再写库，崩溃后的请求必须另外保存随机值，否则恢复逻辑可能创造第二个身份。

`uk_biz_attempt` 只阻止同一个 attempt 被并发插入两次，不能阻止两个线程分别创建 attempt 2 和 attempt 3。建单逻辑还要在短锁内读取当前最大 attempt 与非终态流水；数据库唯一键负责兜住相同序号竞争，非终态检查负责决定现在是否允许出现下一次尝试。

两个写操作也可以放在一个事务里，或直接使用独立发号器提前得到 ID。设计的检查点不是“必须自增”，而是崩溃之后能否从持久证据恢复同一身份。分布式 ID、数据库主键和业务单号的职责区别见[分布式唯一 ID](/posts/distributed-id-uuid-snowflake-leaf/)与[分库分表](/posts/database-sharding-key-routing-resharding/)。

## 三、接口成功、支付成功和业务成功要分开返回

同步接口只能等待有限时间，支付和业务流程却可能持续几十秒甚至更久。`POST /payments` 返回 200，只能说明接口在当前 deadline 内得到什么证据，不能把本地“RPC 已发送”包装成支付成功。

一个可操作的返回模型是：

| API 状态 | 本地证据 | 客户端动作 |
| --- | --- | --- |
| `BIZ_SUCCESS` | 支付和业务都已确认 | 展示成功 |
| `PAY_FAIL` | 渠道明确拒绝或支付单明确失败 | 允许修改条件后重新发起 |
| `PROCESSING` | 已有非终态流水，最终结果未知 | 按同一 flow 查询 |
| `REFUNDED` | 支付曾成功，但补偿退款已确认 | 展示失败并说明资金已退 |
| `MANUAL_REVIEW` | 自动系统缺少足够证据 | 停止自动重试，展示处理中或联系客服 |

这里列的是对客户端的状态投影，不要求与数据库枚举一一对应。`PROCESSING` 可以覆盖 `WAIT_PAY`、`PAYING`、`PAYED` 和 `REFUNDING`；`MANUAL_REVIEW` 也可以由冻结标记、错误分类和工单状态组合得出，不必把下面的七态扩成一张难以维护的大图。

接口超时后，客户端继续携带同一个请求幂等键查询或重试，服务端返回原流水。前端不能每次点击都换一个 key，也不能看到 HTTP 200 就展示“购买成功”。支付页可以每 2 到 3 秒查询 `/payment-flows/{flowId}`，在服务端给出的 deadline 或终态处停止。

Stripe 的 [PaymentIntent](https://docs.stripe.com/api/payment_intents) 同样把一次支付意图建模为多状态资源，可能处于 `processing`、`requires_action`、`canceled` 或 `succeeded`。内部系统无须照搬这些状态名，但要承认支付动作可能跨越一次 HTTP 请求。API 应返回可查询资源，避免让一个响应承担完整生命周期。

客户端取消等待也不等于退款。用户关闭页面时，钱包可能已经扣款；“取消支付”只能对尚未执行的动作生效。已经成功的资金操作需要进入独立退款状态机，并受业务事实约束。

## 四、七个状态把支付、业务和退款隔开

本文案例使用七个核心状态：

```text
WAIT_PAY      已建流水，尚未开始确认支付
PAYING        已进入支付阶段，可能正在调用或查单
PAY_FAIL      支付明确失败，当前 attempt 终止
PAYED         支付成功，业务结果尚未确认
BIZ_SUCCESS   支付对应的业务已经完成
REFUNDING     已决定退款，结果尚未确认
REFUNDED      退款成功
```

![支付、业务确认与退款状态机](/images/posts/payment-flow-state-machine.svg)

合法主路径是：

```text
WAIT_PAY -> PAYING -> PAYED -> BIZ_SUCCESS
                |        |
                |        +-> REFUNDING -> REFUNDED
                +-> PAY_FAIL
```

`PAYED` 是整张图最重要的中间态。它只证明钱已扣，不能提前表示业务成功；同时也不能因为业务 RPC 超时就自动进入退款。推进器必须查询业务事实，判断当前 attempt 是否完成了目标、是否被另一 attempt 抢先完成，以及 deadline 之后能否安全补偿。

`PAY_FAIL`、`BIZ_SUCCESS` 和 `REFUNDED` 是终态。终态不再被普通触发器推进。尤其 `BIZ_SUCCESS` 永久禁止自动退款：权益已经发出后再把钱退回，会形成直接资损。若业务允许用户主动售后，应另建售后退款流程与审核规则，不能复用故障补偿路径。

状态图没有画出的迁移同样是契约。例如 `PAYING -> WAIT_PAY`、`REFUNDING -> BIZ_SUCCESS`、`BIZ_SUCCESS -> REFUNDING` 都应被拒绝。数据库更新必须携带前置状态和版本，不能直接 `SET status = :whatever`。

### 状态名不能代替渠道事实

本地处于 `PAYING` 只说明系统还没有取得明确结果。钱包可能从未收到请求，也可能已经扣款。`REFUNDING` 也不等于钱已到账，它只说明补偿决策成立且退款单已经有稳定身份。

因此每个中间态都要写出三件事：下一次由谁发现，查询哪个权威事实，根据什么条件离开。若某个状态只能靠一条可能丢失的消息唤醒，或者只有“重试超过三次后停止”却没有人工出口，它就不是可恢复状态。

## 五、推进器一次只依据当前事实走一步

同步接口、MQ Consumer 和 Scanner 都调用同一个 `advance(flowId, trigger)`。统一入口避免三套代码各自解释状态；它不负责把所有执行串行化，也不持有覆盖全流程的分布式锁。

```java
AdvanceResult advance(long flowId, Trigger trigger) {
    PayFlow flow = repository.findFromPrimary(flowId);

    if (flow.isTerminal()) {
        return AdvanceResult.completed(flow.status());
    }

    return switch (flow.status()) {
        case WAIT_PAY   -> preparePayment(flow, trigger);
        case PAYING     -> confirmPayment(flow, trigger);
        case PAYED      -> confirmBusiness(flow, trigger);
        case REFUNDING  -> confirmRefund(flow, trigger);
        default         -> AdvanceResult.manual("illegal state");
    };
}
```

每次进入都从主库重读，不使用 MQ 中携带的旧状态做决策。消息可能延迟十分钟，此时数据库已经从 `PAYING` 进入 `BIZ_SUCCESS`；按消息快照执行会把一条历史命令变成非法退款。

推进器可以在一次调用中连续走几步，让同步请求更快拿到结果；每一步仍要重新读取或使用 CAS 返回的新版本，并受总 deadline 限制。更容易验证的实现是一次只完成一个外部动作和一个状态决议，后续由本次循环或新的触发器继续。这样每个崩溃窗口都有明确恢复点。

### 读、副作用与状态写分别靠什么保证

推进器里的操作可以分成三类：

| 操作 | 例子 | 并发保护 |
| --- | --- | --- |
| 读取事实 | 查主库流水、查钱包订单、查业务任务 | 允许重复，要求读到权威源 |
| 外部副作用 | 扣款、续签、退款 | 稳定业务单号与下游幂等 |
| 本库状态写 | `PAYING -> PAYED` | 前置状态、version 与 CAS |

CAS SQL 可以保持很小：

```sql
UPDATE internal_pay_flow
SET status = :newStatus,
    version = version + 1,
    retry_count = :retryCount,
    next_retry_time = :nextRetryTime,
    last_error_code = :errorCode,
    update_time = NOW(3)
WHERE id = :id
  AND status = :oldStatus
  AND version = :oldVersion;
```

影响行数为 0 表示状态已被其他入口改变。处理器要重读：若已经进入相同或更后的合法状态，本次幂等结束；若走进互斥分支，例如本次准备确认成功，数据库却已进入退款，则停止自动推进并告警。CAS 冲突是并发中的正常结果，吞掉所有冲突或一律抛异常重试都不正确。

CAS 发生在外部调用之后时，两个入口仍可能同时调用钱包。它只能仲裁本库状态，资金层安全必须由 `trade_order_no` 幂等保证。反过来，只靠钱包幂等也不够：本库仍需防止支付成功与退款决策被两个线程写成互相矛盾的状态。

## 六、支付阶段：结果未知时查单，不换单

从 `WAIT_PAY` 开始，推进器先 CAS 到 `PAYING`，再使用已经持久化的 `trade_order_no` 调用钱包。预先落 `PAYING` 的意义是进程崩溃后 Scanner 知道应该确认支付，而不是误以为从未发起。

```text
钱包返回 SUCCESS      -> CAS PAYING -> PAYED
钱包返回 FAILED       -> CAS PAYING -> PAY_FAIL
钱包返回 PROCESSING   -> 保持 PAYING，安排查单
超时、断连、异常       -> 保持 PAYING，安排查单
```

超时不属于 `FAILED`。调用方只知道没有按时收到响应，无法推出服务端没有执行。下一次进入 `PAYING` 时，应先按原 `trade_order_no` 查询；渠道明确表示不存在且协议允许安全重试时，才可以使用相同单号再次发起扣款。

“重试三次后换单”是危险规则。三次请求都可能在服务端成功、响应都在网络中丢失；换新单号会绕过渠道幂等。attempt 的边界来自明确业务结果，不来自调用次数。

支付成功后，本地 CAS 也可能失败，例如数据库瞬时不可用或另一个入口抢先更新。流水仍在 `PAYING`，但下次查单会看到渠道 `SUCCESS`，再将本地状态恢复到 `PAYED`。这要求渠道订单可查询，且查询结果的语义足以作为资金证据。

### 回调是唤醒，不是绕过状态机的写权限

有些渠道通过 Webhook 通知支付结果。回调处理器应先验证签名，持久化或快速入队，再用 `trade_order_no` 唤醒同一个推进器。它不能直接把订单任意覆盖成成功。

Stripe 的 [Webhook 文档](https://docs.stripe.com/webhooks)明确说明，事件可能重复投递，也不保证生成顺序；官方建议记录 event ID 去重，并在需要时重新查询资源。即使具体渠道另有保证，内部代码按重复和乱序安全设计更稳妥：回调事件提供线索，主库前置状态和渠道查询决定合法迁移。

回调返回 2xx 只表示本方已经可靠接收。若处理逻辑很重，应先落队列或接收表，再异步推进，避免渠道因超时不断重投。事件去重表防同一 event 重复消费，业务状态机还要处理“不同 event 表达同一资金结果”的语义重复。

## 七、业务确认要经过动作、事实与归因

流水进入 `PAYED` 后，钱已扣，业务尚未确认。最危险的实现是：调用续签接口返回异常，于是立刻退款。RPC 可能在业务数据库提交后丢失响应，此时退款会同时留下权益和资金。

一次业务确认分三步：

1. 在 `biz_deadline_time` 之前，使用 `trade_order_no` 调用幂等业务接口。
2. 无论调用返回什么，都读取业务主库中的最新任务事实。
3. 根据任务状态、归因单号与 deadline 决定成功、继续确认还是退款。

业务任务的关键更新应原子写入状态与归因：

```sql
UPDATE sign_task
SET status = 'PROCESSING',
    resume_order_no = :tradeOrderNo,
    version = version + 1
WHERE id = :taskId
  AND status = 'INTERCEPTED'
  AND version = :oldVersion;
```

只看到任务 `PROCESSING` 还不够。同一业务目标可能有历史 attempt，旧消息也可能晚到；`resume_order_no` 证明是哪笔支付完成了续签。分流规则如下：

| 业务主库事实 | 当前 attempt 的处理 |
| --- | --- |
| 已完成，`resume_order_no` 等于本单 | CAS 进入 `BIZ_SUCCESS` |
| 已完成，但归因属于另一单 | 本单不能冒领成功，进入退款判断 |
| 尚未完成，deadline 未到 | 保持 `PAYED`，退避后重试 |
| 尚未完成，deadline 已过 | 停止调用业务接口，进入退款 |
| 状态与归因互相矛盾 | 冻结自动流程并告警 |

deadline 分支必须闭合。“过期后不再调用业务接口”和“任务未完成就继续重试”若同时存在，会形成没有任何动作能够改变事实的死循环。过期后仍未完成时，退款是明确出口；若业务事实本身长期无法确认，则保持 `PAYED` 并升级人工，禁止盲退。

业务成功一旦归因给当前支付，本地进入 `BIZ_SUCCESS`。这一步之后，普通 MQ、Scanner、旧回调和用户重复点击都只能读取终态，不能再产生资金动作。

## 八、退款是另一笔支付流程，不是数据库回滚

退款决定成立后，先 CAS 将流水从 `PAYED` 推进到 `REFUNDING`，再用固定 `refund_order_no` 调钱包。退款也会超时、重复、处理中和失败，因此需要与支付对称的查单路径。

```text
退款 SUCCESS       -> CAS REFUNDING -> REFUNDED
退款 FAILED        -> 保持 REFUNDING，记录明确原因并按规则重试或人工
退款 PROCESSING    -> 保持 REFUNDING，延后查单
退款超时或断连      -> 保持 REFUNDING，原退款单号查单
```

进入 `REFUNDING` 前必须再次读取业务主库。若业务已经由当前 attempt 完成，退款决策失效；若业务由另一 attempt 完成，当前单通常仍应退款，因为它没有获得对应权益。这里的规则来自业务归因，不能只看一张支付流水表。

退款金额、原支付单、原因码和操作来源都应固化。部分退款、多次售后退款或手续费处理会形成更复杂的退款聚合，届时建议独立退款表，让每次退款拥有自己的金额与状态。本文的一次性补偿场景可以把固定退款单号保存在原流水，但仍不能用 `refunded=true` 代替退款生命周期。

自动重试要有速率预算。渠道整体故障时，成千上万条 `REFUNDING` 每分钟重试会阻碍恢复。按单退避、全局并发上限、熔断和人工批次恢复应同时存在。达到自动重试阈值后不是丢弃，而是降低频率并进入告警或人工队列。

## 九、三个入口只负责唤醒，一个推进器负责收口

同步入口希望尽快给用户结果，MQ 负责秒级继续，Scanner 负责在消息链路失效时重新发现。它们的可靠性和延迟不同，却调用同一个 `advance()`。

![同步入口、MQ 与 Scanner 怎样收敛到同一推进器](/images/posts/payment-flow-three-entry-coordinator.svg)

一条典型路径是：

1. 同步请求建流水并推进到当前 deadline，未到终态则返回 `PROCESSING`。
2. 推进器在需要等待时发送延迟消息，Consumer 到期后重新读主库。
3. 消息发送失败、消费重试耗尽或服务发版暂停时，Scanner 从非终态集合捞回。
4. 渠道回调若存在，也转换为一次唤醒，不另写一套状态逻辑。

主库状态必须足以重建下一步。`PAYING` 意味着查支付，`PAYED` 意味着确认业务或判断退款，`REFUNDING` 意味着查退款。若某个必要动作只能从 MQ payload 的隐藏字段推断，Scanner 无法恢复它。

### Redis 锁、处理中标记和 CAS 管不同问题

同步入口可以按 `user_id + biz_key` 加短 Redis 锁，降低双击和前端重放带来的重复查库与 RPC。锁在同步调用结束时释放，不等待整条支付链路终态；否则 TTL 很难覆盖异步时长，锁服务故障还会让业务停摆。

锁释放后，后续请求通过主库非终态流水或短期 retry flag 返回“支付中”，避免再次建单。MQ 与 Scanner 不依赖这把锁，它们可能跨越多分钟，最终并发正确性由下游幂等与 CAS 保证。

可以把三者理解为：锁降低此刻的重复成本，处理中记录维持锁释放后的用户语义，CAS 仲裁任意时刻的状态写入。把 Redis 锁称为“保证不多扣”的最终防线，会掩盖锁过期、主从切换和异步并发这些事实。

### 为什么普通 MQ 加 Scanner 有时比事务消息合适

如果数据库成功后必须向多个独立下游可靠发布 `PaymentSucceeded` 事件，Outbox 或事务消息很合适。本文的 MQ 只是唤醒本系统推进器，数据库非终态本身已经表达待办；消息没发出后，Scanner 能重新发现同一行。

[RocketMQ 事务消息文档](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)说明，它关联本地事务与消息可投递性，但不保证下游消费结果与上游事务一致，消费者仍需处理重试。为一个已有主库扫描恢复路径的低吞吐链路增加半消息与事务回查，未必划算。

这个判断有明确边界：Scanner 只能恢复“数据库状态可见的本系统工作”，不能代替面向多个订阅者的领域事件总线。若下游必须看到每一条已提交事件，仍应使用 Outbox、CDC 或事务消息。

## 十、Scanner 要扫描动态待办集合

Scanner 每轮查询超过等待阈值的非终态流水。它不是定时把所有订单重做一遍，而是为丢失唤醒、长时间处理中和异常恢复提供最后入口。

```sql
SELECT id, user_id, status, version
FROM internal_pay_flow_017
WHERE status IN ('WAIT_PAY', 'PAYING', 'PAYED', 'REFUNDING')
  AND next_retry_time <= NOW(3)
  AND id >= :cursor
ORDER BY id
LIMIT 100;
```

每一轮从 `id=0` 开始，游标只在当前轮内分页。待办集合会随时间变化：上轮尚未到 `next_retry_time` 的旧记录，这一轮可能刚好到期；若把最大 ID 保存成永久进度，下次从它后面继续，这条旧记录会永远漏掉。

使用主键游标而非 offset，还能避免边扫边推进时结果集收缩造成跳页。Scanner 读取主库，落后的只读副本可能看不到最新终态，也可能把已经完成的记录再次当成待办。重复触发虽然由幂等兜底，持续的从库延迟仍会制造无意义流量并掩盖真实积压。

扫描索引以 `status + next_retry_time + id` 为起点，具体顺序要结合状态基数和查询计划验证。大量历史终态不应进入扫描范围；非终态长期增长则需要按状态年龄告警，而不是不断扩大 batch 把问题藏起来。

分库分表场景下，调度器轮询所有逻辑表。1000 张表、5 分钟一轮，空扫频率约为每秒 3.3 次查询；真正的下游压力由命中记录数决定。Scanner 命中量突然升高，往往比 MQ broker 自身指标更早暴露发送失败、Consumer 停滞或某个状态分支无法收敛。

## 十一、用一次响应丢失走完整条链路

用户为续签任务 `task-73` 创建业务目标 `biz-R-73`。数据库插入 attempt 1，得到 `flow_id=901`，确定性生成支付单 `h2r_u16_p1` 和退款单 `r_h2r_u16_p1`。

同步入口把状态从 `WAIT_PAY` 推到 `PAYING`，调用钱包。钱包完成扣款，但响应在网络中丢失。接口在一秒 deadline 到达后返回 `PROCESSING` 和 `flow_id=901`，没有把超时改成 `PAY_FAIL`，也没有创建 attempt 2。

一条延迟消息与 Scanner 几乎同时唤醒推进器。两者都读到 `PAYING(version=1)`，分别使用同一 `trade_order_no` 查钱包，均得到 `SUCCESS`。第一个线程 CAS 到 `PAYED(version=2)`；第二个线程更新 0 行，重读后发现已经进入后继状态，正常退出。钱包只存在一笔扣款。

下一次 MQ 消费进入 `PAYED`。推进器调用续签接口，业务库已经把任务更新为 `PROCESSING` 并写入 `resume_order_no=h2r_u16_p1`，但 RPC 响应再次丢失。推进器没有依据异常退款，而是读取业务主库，确认状态与归因都属于本单，于是 CAS 到 `BIZ_SUCCESS`。

旧 Scanner 任务稍后才执行。它携带的快照仍是 `PAYED`，进入 `advance()` 后重新查询主库，看到终态便退出。前端轮询同一 flow，得到业务成功。

这条路径里没有全局事务，也没有要求 MQ 只投递一次。安全性来自稳定支付身份、权威查单、业务归因、本库 CAS 和终态不可逆。消息与扫描器只影响多久能得到结果。

再看失败分支：若续签在 deadline 前一直没有完成，deadline 到达后推进器停止调用业务接口，重读任务确认仍未完成，再 CAS 到 `REFUNDING`。退款调用响应丢失时继续使用固定退款单号查单，直到 `REFUNDED` 或人工接管。若读取任务时发现已由当前支付完成，则禁止退款；发现由另一 attempt 完成时，本单进入补偿。

## 十二、对账不是比两个总数

在线状态机处理已知流程，对账处理历史差异。支付系统至少需要连接三份明细：本地支付流水、钱包支付/退款订单和业务权益事实。按日汇总金额相等不能证明每一笔正确，一条多扣和一条漏扣会在总数上互相抵消。

对账键通常包含 `trade_order_no`、`refund_order_no`、用户、金额、币种、渠道状态、业务目标与时间窗口。每条差异要能归到具体类型：

| 差异 | 可能原因 | 修复前必须确认 |
| --- | --- | --- |
| 钱包成功，本地仍 `PAYING` | 回应丢失、CAS 失败、Consumer 停滞 | 单号、金额与用户一致 |
| 本地 `PAYED`，业务已成功但未归因 | 业务更新缺字段、旧链路写入 | 成功属于哪次 attempt |
| 本地 `BIZ_SUCCESS`，钱包无成功单 | 错误推进、渠道数据延迟 | 渠道查询范围和环境 |
| 本地 `REFUNDED`，钱包退款处理中 | 过早确认终态 | 退款单权威状态 |
| 钱包退款成功，本地仍 `REFUNDING` | 退款响应丢失 | 原支付、退款金额和退款单 |
| 两个 attempt 都扣款，业务只完成一次 | 换单过早、迁移双写 | 哪一单获得权益，另一单退款 |

修复动作仍要幂等。补状态使用原 version 和合法前置状态；补退款沿用已有 `refund_order_no`；无法自动判断归因时生成差异工单，不能通过“取渠道较新值覆盖本地”来消除报警。

对账可以分三个时效层：在线查单解决秒级 UNKNOWN，Scanner 解决分钟级未收敛，离线账单或渠道文件解决日级遗漏。三者使用相同身份映射，却有不同证据强度。渠道最终账单与业务主库冲突时，应保留两边原始记录和修复历史，不能直接修改过去的审计事实。

## 十三、灰度迁移要区分新单入口与存量收敛

老链路可能使用 Redis 标记和旧 MQ，新链路使用 MySQL 流水。灰度开关只决定新请求走哪套逻辑，无法让切换瞬间已经在途的旧单消失。最危险的错误是：用户命中新链路，新表查不到订单，于是重新扣款；实际旧链路已有一笔正在处理。

新建 attempt 前应依次检查：

```text
1. 用户是否命中新链路灰度
2. 旧 Redis 在途标记是否存在
3. 旧支付系统是否有非终态流水
4. 新表是否已有非终态 attempt
5. 全部为空时才允许创建新单
```

命中旧在途单时，应交回旧链路继续收敛，而不是简单拒绝用户。支付、查询、取消等所有入口必须共享同一个路由决策，否则会出现支付走新链路、查询仍读旧状态的分裂体验。

新旧 MQ 使用独立 Topic 可以降低 Consumer 误消费，但无法解决同步入口误建单。Topic 上的版本字段只在消息已经产生后生效，重复扣款往往发生得更早。

回滚发布时，只关闭新单入口，不停止新表中的 Coordinator、Consumer 和 Scanner。已经进入新状态机的流水仍需走到终态。旧链路下线前至少确认：放量已稳定到 100%，观察时间超过旧标记最大 TTL，旧标记与旧队列积压归零，并且旧 Consumer 不再收到新业务。

## 十四、监控要看状态年龄和资金差异

只看接口成功率会漏掉最重要的问题：请求可能快速返回 `PROCESSING`，订单却几个小时没有收敛。监控至少包含：

- 各状态数量、进入速率、最老记录年龄和 P95 停留时间；
- 支付、业务确认、退款的调用量、明确失败率、UNKNOWN 比例与查单次数；
- MQ 发送失败、消费延迟、重试次数和死信量；
- Scanner 每轮耗时、扫描表数、命中数、推进成功数与重复命中率；
- CAS 冲突率及冲突后的目标状态分布；
- 按 `trade_order_no` 对账的差异数量、金额和最老未解决时间；
- 自动退款、人工退款和被 `BIZ_SUCCESS` 阻止的退款尝试。

状态转移日志至少记录 flow ID、`biz_key`、attempt、支付与退款单号、旧状态、新状态、version、触发来源、下游 request ID、结果分类和耗时。敏感账户信息与凭证不能进入普通日志；排障需要的是可关联标识，不是完整支付载荷。

告警应落在业务风险上。`PAYING` 最老年龄增加说明支付确认停滞；`PAYED` 堆积说明业务确认或退款判断没有出口；`REFUNDING` 增长指向退款能力；Scanner 命中突然放大则可能是 MQ 链路退化。单个 Consumer 报错并不总等于资金风险，状态不再收敛才是。

## 十五、怎样验证不会多扣、误退和悬挂

成功路径测试远远不够。最有价值的故障点都位于“副作用已经提交、本地状态尚未保存”的窄窗口：

1. 钱包扣款后丢弃响应，重试只能查到同一笔扣款。
2. 钱包成功、本地 CAS 前杀进程，Scanner 能从 `PAYING` 恢复。
3. 业务主库提交后让 RPC 超时，归因字段阻止自动误退。
4. 退款成功后断开连接，同退款单号查单恢复到 `REFUNDED`。
5. 同时触发同步入口、重复 MQ、回调与 Scanner，状态只能沿合法边迁移。
6. 延迟 attempt 1 的消息，先让 attempt 2 完成业务，旧单不能冒领成功。
7. 阻断 MQ 发送或耗尽消费重试，Scanner 仍能发现非终态。
8. 暂停钱包后恢复，重试预算与退避不能形成第二次洪峰。
9. 构造 deadline 前后并发，过期业务动作不得继续执行，已成功业务不得退款。
10. 灰度切换时保留旧在途单，新链路不能创建重复 attempt。

性质测试可以随机排列支付响应、回调、业务完成、退款、消息重投和扫描时机，每一步检查：

```text
charge_count(trade_order_no) <= 1
refund_count(refund_order_no) <= 1
status == BIZ_SUCCESS  => refund_count == 0
status == REFUNDED     => charge_success && business_not_owned_by_this_attempt
terminal(status)       => ordinary_trigger_cannot_change_status
```

终态不可变需要测试代码与数据库约束共同证明。只在 Java 枚举中声明终态，旁路脚本仍可能写坏数据；只靠数据库状态值，又无法表达业务归因。高风险迁移可以增加审计表或事件日志，让每次状态变化都有前置版本与触发证据。

### 上线前检查清单

- 业务目标、支付 attempt 和退款是否各有稳定身份？
- 同幂等键不同金额或业务参数是否会被拒绝？
- 超时是否进入 UNKNOWN/PROCESSING，而非被当作明确失败？
- 新 attempt 是否只在旧 attempt 明确结束后创建？
- `PAYED` 与 `BIZ_SUCCESS` 是否为两个独立状态？
- 业务成功是否带有归因当前支付单的持久字段？
- `BIZ_SUCCESS` 是否在所有自动路径上永久禁退？
- 支付和退款是否都支持原单号查单？
- MQ payload 过期时，Consumer 是否重读主库？
- 消息完全丢失时，Scanner 能否仅根据数据库状态恢复？
- Scanner 游标是否只在单轮内使用，是否读取主库？
- Redis 锁失效后，幂等与 CAS 是否仍能保证正确性？
- 对账能否列出逐笔差异，而非只比较总金额？
- 灰度回滚是否只关新单入口，并继续收敛已有流水？
- 每个非终态是否都有发现者、决策证据、退避策略和最终出口？

## 结语

支付链路无法靠一次 RPC 返回获得完整事实。系统需要把业务目标、支付尝试和退款分开编号，把扣款成功、业务成功与退款成功分开建模。结果未知时沿用原单查证，明确失败才创建新 attempt；业务确认依据主库状态与归因字段，退款则作为独立、可查询、可重试的资金流程处理。

主库流水保存事实和待办，MQ 缩短收敛时间，Scanner 重新发现遗漏工作，多个入口最终进入同一个推进器。外部副作用靠稳定单号幂等，本库迁移靠前置状态与 CAS，对账负责找出自动流程仍未解释的历史。这套设计接受短暂中间态，换来一条能在故障后继续查证并到达合法终态的支付协议。

## 参考资料

- [Stripe API：Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe API：Payment Intents](https://docs.stripe.com/api/payment_intents)
- [Stripe Docs：Receive events in your webhook endpoint](https://docs.stripe.com/webhooks)
- [Apache RocketMQ：Transaction Message](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)
