---
title: 分布式事务：2PC、TCC、Saga、Outbox 与事务消息怎样选
description: 从一条支付、业务确认与退款链路出发，区分原子提交、资源预留、补偿事务和可靠消息，讲清 2PC、TCC、Saga、Outbox 与事务消息的适用边界。
category: 后端
subcategory: 分布式
articleClass: flagship
seriesOrder: 110
publishedAt: 2026-08-24T20:42:00+08:00
tags: [分布式系统, 分布式事务, 2PC, TCC, Saga, Outbox, 事务消息, 状态机]
---

用户用金币购买一次续签权益。钱包已经扣款，续签服务却在响应前超时。此时不能直接返回成功，因为权益是否发放还不确定；也不能把超时当失败并退款，续签可能已经完成，退款会造成权益和金币同时留在用户手里。继续重试同样需要约束：旧请求可能晚到，多条补偿消息可能重复，后台扫描任务还可能与在线请求同时推进。

这类问题经常被统称为“分布式事务”，随后讨论就变成 2PC、TCC、Saga、Outbox 和事务消息的名词比较。它们其实处理不同边界：2PC 试图让多个事务资源共同提交；TCC 让业务显式预留和释放资源；Saga 接受中间结果已经提交，再用后续动作补偿；Outbox 与事务消息主要连接本地事务和消息发布。选型之前，先要指出哪一个不变量可能被破坏。

本文回答的问题是：一条跨钱包、业务服务、数据库和消息队列的链路，哪些步骤需要原子提交，哪些步骤允许延迟收敛，失败后又该前向恢复还是反向补偿。协议部分依据 [MySQL XA 文档](https://dev.mysql.com/doc/refman/8.4/en/xa.html)、[Saga 原始论文](https://www.cs.princeton.edu/techreports/1987/070.pdf)、[Apache Seata TCC 文档](https://seata.apache.org/docs/v1.0/user/mode/tcc/)、[Debezium Outbox 文档](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)和 [Apache RocketMQ 事务消息文档](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)。支付案例来自一套真实改造思路，名称和数据结构经过抽象，不代表某个开源框架的固定实现。

## 先把五种方案放回各自的问题里

“跨了两个服务”只能说明本地数据库事务不够用，还不能推出应该采用哪一种分布式事务。先看系统希望得到什么结果。

| 方案 | 它建立的边界 | 失败后的主要动作 | 参与方需要提供什么 |
| --- | --- | --- | --- |
| 2PC / XA | 多个事务资源共同提交或回滚 | 协调者恢复提交决议 | prepare、commit、rollback |
| TCC | 多个业务资源先预留，再确认或释放 | 重试 Confirm / Cancel | Try、Confirm、Cancel 三套业务接口 |
| Saga | 一串已经各自提交的本地事务 | 继续向前或执行补偿事务 | 可重试步骤、补偿动作、持久化进度 |
| Outbox | 本地业务事实与待发布事件一起落库 | publisher 重发事件 | 同库事务、消息转发表、消费者幂等 |
| 事务消息 | 本地事务结果与 broker 中的消息可投递性关联 | broker 回查本地事务 | 半消息、事务执行器、状态回查 |

![五种分布式事务方案分别覆盖哪一段边界](/images/posts/distributed-transaction-boundaries.svg)

图里最容易混淆的是 Saga 与消息可靠性。Saga 决定业务步骤怎样继续和补偿；Outbox 或事务消息保证某个步骤完成后，通知下一步的消息最终能够发出。一个系统可以用 Outbox 驱动 Saga，也可以像本文案例一样，让数据库状态本身成为待办事实，再由普通 MQ 和 Scanner 重复唤醒推进器。

同样，补偿不等于回滚。数据库回滚让未提交修改消失；退款是一笔新的资金操作，需要新的单号、审计记录和失败恢复。已经寄出的包裹、已经发送的短信、已经被用户看到的价格都无法靠 `ROLLBACK` 撤回。分布式事务设计要面对这些不可逆事实。

## 一、本地事务为什么跨不过 RPC

本地事务依赖一个资源管理器控制提交点。下面两条 SQL 位于同一个 MySQL 事务时，数据库可以一起提交或一起回滚：

```sql
START TRANSACTION;

UPDATE account
SET balance = balance - 100
WHERE user_id = 42 AND balance >= 100;

INSERT INTO payment_flow(trade_order_no, status)
VALUES ('p-1001', 'PAYED');

COMMIT;
```

如果扣款发生在钱包服务，权益写入发生在续签服务，当前应用只拥有两次 RPC。钱包返回成功后，扣款已经成为另一个系统的事实；本地流水回滚不会把金币加回去。续签调用超时后，调用方甚至不知道业务动作有没有发生。前文讨论过的[RPC 结果状态](/posts/rpc-call-outcome-states/)和[超时、重试与幂等](/posts/timeouts-retries-idempotency-exactly-once/)会在这里同时出现。

```text
支付服务 ── debit(tradeOrderNo) ──> 钱包
         <────── timeout ─────────

调用方观察：UNKNOWN
钱包事实：可能 SUCCESS / FAILED / PROCESSING
```

因此，第一步应当列出业务不变量，再选择框架。支付续签至少有四条：同一个支付单不能重复扣款；业务成功后永久禁止退款；扣款成功而业务最终失败时必须退款；所有非终态都要被再次发现。它们分别依赖下游幂等、状态归因、补偿动作和持久化恢复，没有一种协议名称可以代替这些条件。

### 原子性、一致性和收敛时间是三个问题

原子性问的是一组动作能否只留下“全成或全败”。业务一致性问的是系统是否始终满足不变量，例如余额不为负、权益成功后不退款。收敛时间则问系统允许中间状态存在多久。很多跨服务流程无法获得全局原子性，却可以通过状态机、幂等和补偿，在秒级或分钟级恢复到满足业务不变量的终态。

支付接口返回“处理中”并不必然是设计缺陷。若钱包结果未知，保留 `PAYING` 比伪造成功或失败安全。系统必须保证这条记录不会永久停住：MQ 可以秒级唤醒，Scanner 可以分钟级捞回，超过阈值则告警和对账。

### 本地事务仍然要用，只是边界收窄了

不用全局事务不代表放弃数据库事务。同库内的状态与关联证据应尽量原子写入，例如续签任务的 `status` 和 `resume_order_no` 必须在同一条 `UPDATE` 中修改；退款终态和退款投影位于同库时也可以放进一个本地事务。单条 CAS 更新本身同样依赖数据库原子性。

```sql
UPDATE sign_task
SET status = 'PROCESSING',
    resume_order_no = :tradeOrderNo
WHERE id = :taskId
  AND status = 'INTERCEPTED';
```

若把状态和归因单号拆成两次提交，进程可能在中间崩溃，留下“任务已经成功但不知道由哪笔支付完成”的记录。后续 attempt 既不能安全认领成功，也不敢退款。分布式流程通常由许多小而明确的本地原子边界组成。

## 二、2PC 把多个事务资源拉到同一次决议

Two-Phase Commit（2PC）有一个协调者和多个参与者。第一阶段要求参与者执行事务并进入 `PREPARED`，此时它已经把恢复所需信息写入稳定存储，并承诺可以按协调者的最终决议提交。所有参与者都投赞成票后，协调者在第二阶段发送 `COMMIT`；任一参与者拒绝则发送 `ROLLBACK`。

MySQL 的 XA 状态机把过程直接暴露为 `XA START`、`XA END`、`XA PREPARE` 和 `XA COMMIT/ROLLBACK`。官方文档也明确说明，XA 的全局事务通过 2PC 让多个 transactional resource 作为一组提交。

```text
              第一阶段：Prepare              第二阶段：Decision

协调者 ─────── PREPARE ──────> 库 A       ───── COMMIT ─────> 库 A
       └────── PREPARE ──────> 库 B       └──── COMMIT ─────> 库 B
               A/B 都投 YES                 全局事务完成
```

### Prepared 不是普通的“执行成功”

参与者进入 prepared 后不能自行决定提交或回滚。它通常仍持有锁和版本，等待协调者决议；若协调者故障，参与者需要从日志恢复 XID，再向事务管理器查询结果。MySQL 的 `XA RECOVER` 会列出 prepared 状态的事务，这也是运维必须监控的资源，而不是可以永久搁置的中间状态。

2PC 提供的是提交原子性，不自动解决业务层的所有问题。参与者必须明确支持 XA；第三方钱包 HTTP SDK、短信供应商和普通业务 RPC 通常没有 prepare 接口。即使钱包内部用了数据库事务，调用方也不能凭一个 `debit()` API 把它拉进自己的 XA 全局事务。

### 什么时候值得使用 2PC

两个受控数据库都支持 XA、事务持续时间短、参与者数量有限，而且业务确实需要同步看到全成或全败时，2PC 有明确价值。例如同一基础设施内的少量账务资源转移，协调成本可能低于应用层补偿和对账成本。

长流程、外部服务和高可用优先的在线链路通常不适合。网络分区时，无法获得决议的 prepared 参与者会保留资源；跨地域 RTT 进入提交延迟；协调器恢复、启发式提交和人工清理 prepared transaction 都增加运维负担。支付案例中的钱包和续签服务没有 XA 参与能力，2PC 从接口边界上就不成立。

## 三、TCC 用业务接口显式预留资源

Try-Confirm-Cancel（TCC）把两阶段思想上移到业务层。Try 检查条件并预留资源；全局事务成功时调用 Confirm 消费预留；失败时调用 Cancel 释放资源。Seata 文档把 TCC 描述为直接作用于 service layer 的侵入式方案，参与方需要自己实现三种操作。

以购买套餐为例：

| 阶段 | 钱包 | 权益服务 |
| --- | --- | --- |
| Try | 冻结 100 金币 | 预留一份权益名额 |
| Confirm | 冻结转扣减 | 激活权益 |
| Cancel | 解冻金币 | 释放名额 |

这与“先扣款，失败后退款”不同。TCC 的 Try 通常不完成最终副作用，而是留下可确认、可取消的资源。若钱包只提供直接扣款和退款，没有冻结接口，应用无法单方面把它变成 TCC。

### Confirm 和 Cancel 必须面对重复与乱序

协调者发送 Confirm 后响应丢失，会再次调用 Confirm；Cancel 同样可能重复，所以两者都必须幂等。更麻烦的是空回滚与悬挂：Try 请求没有到达参与者，协调者却因全局事务失败调用了 Cancel，这是空回滚；Try 在网络中迟到，Cancel 已先执行并返回成功，随后迟到的 Try 又预留资源，这是悬挂。

Seata 的 TCC 分析使用事务控制记录处理这些情况：Try 留下 `tried` 记录，Confirm/Cancel 根据 XID 与 BranchID 判定是否重复；Cancel 先到且没有 Try 记录时写入 `suspended`，迟到的 Try 看到该标记后拒绝执行。业务代码若只写三个同名方法，却没有这些状态与唯一约束，TCC 协议仍不完整。

```text
正常：Try ───────────────> Confirm
空回滚：      Cancel（此前没有 Try）
悬挂：Cancel ────────────> 迟到的 Try 必须被拒绝
重复：Confirm / Cancel 可能被协调者反复调用
```

### TCC 适合能自然预留的稀缺资源

库存、额度和名额通常有明确的冻结语义，Try 后持有时间又较短，TCC 可以把跨服务冲突提前到资源预留阶段。代价是每个参与者都要提供完整的 Try/Confirm/Cancel 及其状态表、幂等和防悬挂控制。业务流程增加一个步骤，就多一组资源协议。

支付续签链路没有采用 TCC。钱包已有的能力是按支付单号幂等扣款、查单和退款，并非冻结金币后 Confirm；续签动作也没有可撤销的“预续签”资源。为了套 TCC 新增一整套冻结接口，会把改造扩大到多个系统，收益并不匹配。

## 四、Saga 接受局部提交，再决定继续还是补偿

Saga 原始论文为长事务提出了一种拆分方式：把长事务写成一串可与其他事务交错执行的本地事务；若无法完成后续步骤，则执行补偿事务修正已经提交的部分。每个步骤各自提交，因此不会长期持有全局数据库锁。

假设一次业务包含三个本地事务：

```text
T1 创建订单 → T2 扣款 → T3 发放权益

T3 永久失败时：C2 退款 → C1 关闭订单
```

补偿事务 `C2` 不是把钱包数据库回滚到某个历史快照，而是发起一笔有独立单号的退款。退款也可能超时、重复或失败，需要像正向事务一样持久化状态、幂等重试和对账。若某个动作不可逆，例如通知已经被用户阅读，补偿只能产生新的纠正动作，无法抹掉历史。

### 前向恢复和反向补偿需要业务判断

中间步骤失败后，不应一律立即补偿。暂时性失败可以继续向前重试；明确永久失败才进入反向流程；结果未知则先查询事实。支付续签中的判断是：钱包 `PROCESSING` 时继续查单；支付已成功而续签仍在允许窗口内时重试续签；超过业务 deadline 且任务仍未成功时才退款。

这也是 Saga 实现最难的部分。框架可以保存步骤和调度任务，却不知道“超时的续签是否可能已经生效”“业务成功后能否退款”“旧 attempt 是否有权认领新 attempt 的结果”。这些规则只能来自业务模型。

### 编排式和协同式 Saga

编排式 Saga 由一个 orchestrator 持久化当前步骤并发出下一条命令，分支和补偿路径集中，便于观察整条流程；协调器本身需要高可用，逻辑也可能变得庞大。协同式 Saga 没有中心控制器，服务通过事件触发下一个参与者，初期耦合较低，参与者增加后更难回答“这笔业务现在卡在哪里”。

支付案例中的 `PayFlowCoordinator` 很接近编排器：它读取主库状态，决定调用钱包、确认业务还是退款。但这套实现没有引入通用 Saga 框架，也没有把每个服务包装成标准 Saga participant。更准确的名称是“状态机驱动的补偿型工作流”，它采用了 Saga 的本地提交与补偿思想。

### 隔离性不会随补偿自动出现

Saga 的各个本地事务之间可以被其他请求观察和修改。订单已经显示为已支付、权益还没发放时，其他流程可能根据这个中间状态做决定。解决办法包括语义锁、状态前置条件、版本 CAS、业务归因字段，以及只允许某些状态对外可见。

例如 `resume_order_no` 把任务成功与具体支付 attempt 绑定。任务显示 `PROCESSING` 还不够；只有 `resume_order_no == trade_order_no`，当前流水才有权进入 `BIZ_SUCCESS`。否则可能是另一笔 attempt 完成了续签，本单应进入退款。这个字段承担的是隔离与归因证据。

## 五、Outbox 和事务消息解决本地提交后的可靠通知

服务经常要在一个请求里修改数据库并发送 MQ：先提交数据库再发消息，进程可能在两步之间崩溃；先发消息再提交数据库，消费者可能看到一条最终回滚的业务事件。这是 dual write 问题。

### Outbox 把待发送事件写进同一个本地事务

Transactional Outbox 在业务数据库中增加一张消息表。业务更新与 Outbox 行在同一本地事务提交，独立 publisher 再轮询或通过 CDC 把事件发送到 broker。

```sql
START TRANSACTION;

UPDATE orders
SET status = 'PAID', version = version + 1
WHERE order_id = 'o-18' AND status = 'PAYING';

INSERT INTO outbox_event(event_id, aggregate_id, event_type, payload)
VALUES ('e-91', 'o-18', 'OrderPaid', '{...}');

COMMIT;
```

Debezium 的 Outbox Event Router 会捕获 Outbox 表的新增记录，把事件 ID 放入消息 header，并可用 aggregate ID 作为 partition key 保持同一聚合的顺序。publisher 在发送成功后、标记完成前崩溃仍会造成重复，因此消费者必须按 `event_id` 或业务版本幂等。Outbox 消除了“业务已提交但没有任何待发送记录”的窗口，没有承诺只投递一次。

### RocketMQ 事务消息用半消息和回查关联本地事务

RocketMQ 的流程是：producer 先发送暂不可投递的 half message；broker 保存后，producer 执行本地事务，再向 broker 返回 Commit 或 Rollback。broker 长时间拿不到明确结果时，通过 transaction checker 回查本地事务状态。Commit 后消息才对消费者可见。

![Outbox、事务消息与状态扫描的恢复路径](/images/posts/distributed-transaction-message-recovery.svg)

事务消息保证的是本地事务与消息最终可投递之间的一致性。RocketMQ 官方文档也特别说明，它不保证下游消费结果与上游事务一致，消费者仍需正确处理重试。半消息长期未知还会触发回查，producer 必须能从自己的数据库判断本地事务究竟提交还是回滚。

### 支付案例为什么只用了普通消息

这套支付链路没有要求“状态变化后必须发布唯一一类领域事件，才能继续下一步”。主库里的非终态流水本身就是未完成工作的事实：`PAYING` 表示需要查支付，`PAYED` 表示需要确认业务，`REFUNDING` 表示需要查退款。普通 MQ 负责尽快唤醒 `advance()`；消息没发出或消费耗尽时，Scanner 仍可从数据库重新发现这些状态。

```text
主库状态 = 真相和待办依据
普通 MQ   = 秒级唤醒
Scanner   = 分钟级重新发现
```

所以这里不需要半消息和事务回查，也没有单独的 Outbox 表。代价是 Scanner 必须可靠运行，扫描条件必须覆盖所有非终态，状态不能出现“需要推进但数据库看不出来”的隐式分支。若未来需要把 `PaymentSucceeded` 可靠广播给多个独立下游，Outbox 仍然合适；Scanner 只会调用本系统推进器，不能自动替代通用事件发布。

## 六、支付链路怎样把事实、尝试和触发器拆开

旧链路使用一个单日唯一的 `bizNo` 同时表示业务目标和支付请求。第一次扣款明确失败后，用户当天再次尝试仍携带旧单号，钱包按幂等规则返回旧失败结果。与此同时，支付成功和续签成功没有独立状态，MQ 一旦丢失，系统缺少一份可以回答“现在该做什么”的持久化事实。

改造先拆开两个身份：

- `bizKey` 表示同一个业务目标，例如某用户某次中断周期的续签。它在整个生命周期内保持不变。
- `tradeOrderNo` 表示一次支付 attempt。结果未知时继续使用原单号查询和重试；只有明确失败或退款结束后，用户再次发起才创建新 attempt。

退款使用固定的 `refundOrderNo = r_{tradeOrderNo}`。这样支付、退款和业务目标分别拥有稳定身份。晚到消息只能唤醒对应 attempt，无法凭一个模糊 bizNo 冒领另一笔支付的结果。

### 七个状态把三个事实层分开

![支付、业务确认与退款的状态机](/images/posts/distributed-transaction-payment-state-machine.svg)

`PAYED` 与 `BIZ_SUCCESS` 分开是这张图的轴心。`PAYED` 只说明金币已经扣除，后续仍要确认续签是否完成；业务明确失败并满足退款条件后，状态先进入 `REFUNDING`，再使用固定退款单号调用钱包。`PAY_FAIL`、`BIZ_SUCCESS` 和 `REFUNDED` 是终态。

```text
WAIT_PAY -> PAYING -> PAYED -> BIZ_SUCCESS
                |        |
                |        +-> REFUNDING -> REFUNDED
                +-> PAY_FAIL
```

钱包返回超时或 `PROCESSING` 时保留 `PAYING`。下一次推进使用同一个 `tradeOrderNo` 查单，若钱包已经扣款则恢复到 `PAYED`；若明确失败则进入 `PAY_FAIL`。支付成功但 CAS 写入 `PAYED` 失败时，也可以通过这条查单路径恢复，前提是钱包对单号严格幂等并提供权威查询。

业务确认采用“动作、事实、分流”三步。允许窗口内调用幂等续签接口；无论 RPC 返回什么，都回到主库读取任务状态与 `resume_order_no`；只有事实明确属于本单才进入 `BIZ_SUCCESS`。任务仍未完成且 deadline 未到时继续重试，deadline 已过则停止制造业务副作用，转入退款判断。

### 三个入口只负责触发，一个推进器负责决策

同步请求、MQ Consumer 与 DB Scanner 都调用同一个 `PayFlowCoordinator.advance()`。统一代码路径不等于串行执行，三个入口仍可能同时读取同一版本。推进器每次重读主库，按当前状态执行一步；状态更新通过 `id + old_status + version` 的 CAS 仲裁。

```sql
UPDATE internal_pay_flow
SET status = :newStatus,
    version = version + 1,
    update_time = :now
WHERE id = :id
  AND status = :oldStatus
  AND version = :version;
```

影响行数为 0 时，调用方重读主库。若其他入口已经推进到相同或后继状态，本次按幂等完成退出；若状态进入互斥分支，例如本次准备确认成功、数据库却已进入退款，则记录冲突并告警。CAS 失败是预期并发结果，但不能一概吞掉。

CAS 只保护本库状态，无法撤销已经发出的钱包调用。两个入口可能在 CAS 前同时调用钱包，因此资金安全依赖钱包按同一 `tradeOrderNo` 幂等；退款同理依赖固定 `refundOrderNo`。Redis 锁可以减少在线双击造成的重复 RPC，锁 TTL 和异步链路都不能覆盖整个生命周期，最终正确性仍由下游幂等、主库状态机和 CAS 共同承担。

### MQ 负责快，Scanner 负责重新发现

一次推进停在非终态时，服务发送普通延迟消息，让 Consumer 秒级再次执行。消息只携带最小定位信息，Consumer 不信任其中的旧状态，而是查询主库。当前消息推进一步后即可 ACK；若仍需处理，可以发布下一条消息或按结果延迟重投。

Scanner 周期性查询超过等待阈值的非终态流水：

```sql
SELECT id, user_id, status, version
FROM internal_pay_flow_017
WHERE status IN ('WAIT_PAY', 'PAYING', 'PAYED', 'REFUNDING')
  AND update_time < :threshold
  AND id >= :cursor
ORDER BY id
LIMIT 100;
```

它必须读主库，因为落后的从库可能把已经完成的订单再次判断为待处理，也可能看不到最新 CAS。`update_time` 提供扫描退避，避免 MQ 刚推进就被 Scanner 重复唤醒；稳定主键游标避免 offset 深分页和结果集移动漏扫。MQ 与 Scanner 同时触发没有关系，只要所有副作用有稳定幂等键，状态写入由 CAS 仲裁。

### 这套方案与标准 Saga 的关系

从业务结构看，它有一条正向链路“扣款、业务确认”，也有业务失败后的补偿“退款”，并由中心推进器保存状态，符合编排式 Saga 的主要思想。从具体实现看，它没有通用 Saga 引擎，没有为每个步骤声明标准 participant，也没有对所有已完成步骤逐一执行逆操作。钱包扣款可退款，续签一旦成功则不可退款，这是按业务不变量定制的补偿工作流。

把它简称为 Saga 没有问题，但设计说明需要继续写出状态、归因字段、重试条件和补偿出口。只写“采用 Saga 保证最终一致性”无法证明不会多扣、误退或永久悬挂。

## 七、逐个故障点检查能否恢复

分布式事务方案不能只画成功时序。下面这张表把故障发生的位置、数据库证据和恢复动作放在一起。

| 故障位置 | 主库可能状态 | 下一次怎样确认事实 | 恢复动作 |
| --- | --- | --- | --- |
| 创建流水后进程崩溃 | `WAIT_PAY` | 根据主键重建确定性单号 | Scanner 继续支付阶段 |
| 钱包扣款响应超时 | `PAYING` | 同 `tradeOrderNo` 查单 | 成功转 `PAYED`，失败转 `PAY_FAIL` |
| 扣款成功但 CAS 失败 | `PAYING` | 钱包返回已成功 | 再次 CAS 推进 |
| 续签成功但响应丢失 | `PAYED` | 主库查 task 状态与归因单号 | 属于本单则转 `BIZ_SUCCESS` |
| MQ 发送失败 | 任一非终态 | Scanner 查询超时记录 | 重新调用推进器 |
| MQ 重复或 Scanner 并发 | 相同旧版本 | 主库最新状态与 CAS 结果 | 输家重读后退出 |
| 退款响应超时 | `REFUNDING` | 同 `refundOrderNo` 查单 | 成功转 `REFUNDED`，未知继续确认 |
| 业务长期 UNKNOWN | `PAYED` | 查询、对账与人工证据 | 保持非终态，禁止盲退 |

表中的“业务长期 UNKNOWN”最容易被忽略。如果续签可能异步成功，却暂时没有可靠查询证据，自动退款会制造资损。系统应保持 `PAYED`，降低重试频率并告警，直到获得可以支持成功或补偿的事实。最终一致不意味着一定自动走到某个终态，它要求每一种无法自动判定的状态都有升级路径。

### 状态机必须有可证明的出口

“超过 deadline 后不再调用续签”与“任务仍是 INTERCEPTED 就继续重试”若同时存在，会形成死循环：业务动作已经停止，状态却无限发消息。正确分支是 deadline 内继续前向恢复，deadline 外确认任务仍未完成后进入退款。每个中间态都要回答谁会再次发现它、下一次根据什么证据决策、何时停止自动重试。

重试次数也不应只做一个硬停止开关。钱包 `PROCESSING` 可能需要持续查单，达到阈值后应降低频率并告警，而不是停止后让资金永远冻结。调用下游的速率、单笔年龄和全局积压需要同时限制，避免故障时 MQ 与 Scanner 一起放大流量。

### 灰度切换也是事务边界的一部分

新旧链路并行期间，最危险的情况是旧在途单被新链路当作“没有流水”而重新建单。同一个业务目标会被两套系统各扣一次。新链路创建 attempt 前需要检查灰度归属、旧 Redis 在途标记、旧支付流水和新表非终态；命中旧单时交回旧链路继续收敛。

回滚发布时只能关闭新单入口，不能停止已经进入新状态机的存量推进器和 Scanner。已有新流水必须继续走到终态。Topic 隔离可以避免新旧 Consumer 误消费，却不能替代同步入口的 owner 判断。这类迁移规则与事务协议同样决定最终是否多扣。

## 八、如何验证这套一致性不是纸面承诺

正常单测只能证明成功路径。至少要在每个“副作用已发生、状态尚未保存”的间隙注入崩溃，重启后观察是否从数据库证据恢复。

### 故障注入清单

- 钱包实际扣款后丢弃响应，验证同单号查单恢复到 `PAYED`。
- 续签数据库提交后让 RPC 超时，验证主库事实与归因单号阻止误退款。
- 状态 CAS 成功后阻断 MQ 发送，验证 Scanner 能在阈值后发现记录。
- 同时触发同步入口、重复消息和 Scanner，验证只有合法状态迁移，资金副作用按单号只发生一次。
- 退款成功后中断本地连接，验证固定退款单号能够恢复终态。
- 暂停 Consumer，再恢复大量积压，验证 retry budget、限流和 Scanner 不会共同打满钱包。
- 构造 deadline 边界与跨天请求，验证旧 attempt 不能认领新 attempt 的业务成功。

测试断言应落在业务不变量上：每个 `tradeOrderNo` 最多一笔扣款；每个 `refundOrderNo` 最多一笔退款；`BIZ_SUCCESS` 永远不能迁移到退款；所有超过时限的非终态都会进入告警；同一 `bizKey` 可以有多个历史 attempt，但同一时刻最多一个有效推进目标。

### 监控除了失败次数，还要显示状态年龄

建议按状态统计数量和最老年龄，记录每种入口的推进次数、CAS 冲突率、钱包查单结果、MQ 重试次数、Scanner 命中量、退款耗时和人工介入量。Scanner 命中突然升高通常说明 MQ 或 Consumer 链路退化；`PAYED` 最老年龄增长说明业务确认或退款判断卡住；大量 `REFUNDING` 则要检查钱包退款能力。

状态迁移日志至少包含 `bizKey`、`tradeOrderNo`、旧状态、新状态、version、触发来源和下游请求 ID。不要在消息体里复制一份权威状态，消息晚到后那份状态一定可能过期。排障时从主库当前状态和迁移历史重建时间线。

## 九、从约束反推选型

| 场景 | 优先考虑 | 选择依据 | 需要接受的成本 |
| --- | --- | --- | --- |
| 两个受控事务资源必须同步全成全败 | XA / 2PC | 参与方都支持 prepare，事务短 | 锁持有、协调恢复、可用性下降 |
| 库存、额度可以先冻结 | TCC | 资源有自然 Try/Confirm/Cancel 语义 | 业务侵入、空回滚、悬挂和幂等处理 |
| 跨服务长流程允许中间状态 | Saga / 状态机 | 能定义前向恢复和补偿动作 | 隔离弱、补偿复杂、需要持久化编排 |
| 本地事务后必须可靠发布领域事件 | Outbox | 业务表和事件表能同库提交 | relay、重复消息、表清理与顺序治理 |
| 已使用 RocketMQ，需关联本地事务与消息 | 事务消息 | producer 能可靠回查本地事务 | 半消息、回查压力、消费端仍需幂等 |
| 数据库状态足以重新发现未完成工作 | 普通 MQ + Scanner | 非终态完整表达待办，允许扫描延迟 | 扫描索引、调度监控、主库压力预算 |

选型时可以依次问六个问题：哪些数据必须处于同一个原子边界；每个参与方是否支持 prepare 或资源预留；已经发生的动作能否补偿；结果未知时能否按业务键查询；DB 成功但消息未发是否会永久丢失工作；允许中间态存在多久。答案通常会把候选方案缩小到一两个。

对本文支付链路而言，钱包和续签服务无法参加 XA，也没有冻结资源接口；流程允许 `PAYING`、`PAYED` 和 `REFUNDING` 暂时存在；数据库状态足以描述下一步动作；钱包和退款都支持稳定单号幂等查询。于是合适的组合是：小范围本地事务、主库状态机、下游幂等、CAS、普通 MQ、Scanner 和退款补偿。

这套组合没有制造全局原子提交。它给每个不确定结果留下持久化状态和可重复验证的证据，再由多个触发器把流程推向合法终态。选择分布式事务方案时，协议名称排在这些证据之后。

## 参考资料

- [MySQL 8.4 Reference Manual：XA Transactions](https://dev.mysql.com/doc/refman/8.4/en/xa.html)
- [MySQL 8.4：XA Transaction States](https://dev.mysql.com/doc/refman/8.4/en/xa-states.html)
- [SAGAS，Hector Garcia-Molina 与 Kenneth Salem](https://www.cs.princeton.edu/techreports/1987/070.pdf)
- [Apache Seata：TCC Mode](https://seata.apache.org/docs/v1.0/user/mode/tcc/)
- [Apache Seata：In-Depth Analysis of TCC Mode](https://seata.apache.org/blog/seata-tcc/)
- [Debezium：Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- [Apache RocketMQ：Transaction Message](https://rocketmq.apache.org/docs/featureBehavior/04transactionmessage/)
- [AWS Prescriptive Guidance：Saga patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-patterns.html)
