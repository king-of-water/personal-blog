---
title: RocketMQ 事务消息：半消息与回查怎样保证一致性
description: 拆解 RocketMQ 事务消息的「半消息 + 二次确认 + 状态回查」机制，说明它如何解决本地事务与消息发送的双写窗口，覆盖 COMMIT/ROLLBACK/UNKNOW 三态、回查的兜底与失败模式，以及与本地消息表（Outbox）的取舍。
category: 后端
subcategory: 消息队列
articleClass: focused
seriesOrder: 30
featured: true
publishedAt: 2026-10-01T21:20:00+08:00
updatedAt: 2026-10-01T21:20:00+08:00
tags: [RocketMQ, 事务消息, 半消息, 回查, 本地事务, Outbox, 一致性, 消息队列]
---

「用户下单」要同时做两件事：把订单写进数据库，再发一条消息通知下游（扣库存、发券、发短信）。这两件事无法成为一个原子操作——数据库提交了、消息还没发出去；或者消息发出去了、数据库却回滚了。这个"双写窗口"，是消息队列落地业务时最经典的一致性难题。

RocketMQ 的事务消息就是为这个窗口设计的。它的解法可以一句话概括：**先发一条消费者暂时看不见的"半消息"，执行本地事务后再决定这条消息是投递还是丢弃；如果"决定"这一步因为崩溃或断网而丢失，Broker 会主动回来问"你的本地事务到底成没成"**。

本文回答一个问题：这套"半消息 + 回查"机制具体怎么工作，它在什么情况下能保证一致、什么情况下保证不了。站内《分布式事务：2PC、TCC、Saga 与 Outbox》是从解法全景的角度把事务消息列为其中一种，本文只深入 RocketMQ 事务消息这一种机制；本文也不重述《超时、重试、幂等》里的幂等原则，但结论会落到它上面。主要依据是 RocketMQ 官方事务消息文档与 Broker 配置，托管版行为以各自文档为准。

## 一、先看清要解决的窗口在哪

把"下单"拆成两步，双写窗口就现形了：

```text
1. 数据库：INSERT 订单（本地事务提交）
2. 消息：发一条"订单已创建"给下游
```

如果先做 1 再做 2，1 成功、2 失败（进程崩溃、网络闪断），订单落库了，下游却永远不知道这笔订单——库存没扣、用户没收到通知。如果先做 2 再做 1，消息发了、订单回滚了，下游按消息去查订单却查不到——数据对不上。

问题的本质是：**数据库和消息队列是两个独立系统，跨它们的操作没有原生原子性**。要堵住这个窗口，得让"业务数据"和"待发消息"在某一个时刻达成一致，再由另一方据此推进。

事务消息的思路是反过来排顺序：**先让消息"挂起"，再提交本地事务，最后根据本地事务结果决定消息去留**。消息先到 Broker 上占个位、但不投递，本地事务成了就放行、败了就丢弃——这样消息的可见性和本地事务的提交绑在了同一次决定上。

## 二、半消息 + 二次确认：两阶段机制

事务消息分两阶段。第一阶段发一条**半消息（half message）**：它被 Broker 持久化、返回 ack，但被标记为"暂不可投递"，消费者看不到它。半消息发成功后，生产者执行本地事务；第二阶段，根据本地事务结果向 Broker 发第二次确认——提交（Commit）或回滚（Rollback）。

```java
TransactionMQProducer producer = new TransactionMQProducer("order-group");
producer.setTransactionListener(new TransactionListener() {
    @Override
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        // 半消息已持久化，现在执行本地事务，并返回结果
        boolean ok = createOrder(msg);
        return ok ? LocalTransactionState.COMMIT_MESSAGE : LocalTransactionState.ROLLBACK_MESSAGE;
    }

    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        // Broker 回查时，根据消息里的订单号查本地事务的真实状态
        return orderExists(msg) ? LocalTransactionState.COMMIT_MESSAGE : LocalTransactionState.ROLLBACK_MESSAGE;
    }
});
producer.sendMessageInTransaction(msg, null);
```

`executeLocalTransaction` 在半消息成功发出后立刻执行本地事务，`checkLocalTransaction` 留给 Broker 回查时用。第二个方法的语义很关键：它不是"重新执行一遍业务逻辑"，而是"查一下上次那个本地事务到底成没成"。

半消息在 Broker 上不是存在原 Topic 里，而是先落到一个内部系统 Topic（`RMQ_SYS_TRANS_HALF_TOPIC`），被标记为不可投递。Commit 时，Broker 把消息从半消息 Topic 搬到真正的业务 Topic，消费者这才可见；Rollback 时直接丢弃。这个"搬"的动作，是半消息和普通消息在存储上的本质区别——它解释了为什么消费者永远看不到"半截"的消息：业务 Topic 里只有已经确认要投递的消息。

![半消息、二次确认与状态回查的完整时序](/images/posts/rocketmq-transactional-message-flow.svg)

这张时序图里有两条正常路径和一条兜底路径。正常路径：半消息发出 → 本地事务执行 → Commit（放行）或 Rollback（丢弃）。兜底路径：如果第二次确认因为进程崩溃、网络闪断而丢失，Broker 不会一直傻等，而是过一段时间主动回查生产者，根据 `checkLocalTransaction` 返回的状态把半消息放行或丢弃。

## 三、三个状态，和一个必须写对的回查

事务状态有三种：`COMMIT_MESSAGE`（提交，消费者可消费）、`ROLLBACK_MESSAGE`（回滚，消息丢弃）、`UNKNOW`（暂时无法确定）。`UNKNOW` 不是错误，它是"我还不知道本地事务结果"的诚实回答——常见于本地事务还在执行、或结果还没落库的情况。返回 `UNKNOW` 后，Broker 会等一段时间再回查。

回查不是无限进行的。Broker 侧有参数约束：事务消息默认超过 `transactionTimeOut`（6 秒）还没收到第二次确认，就进入待回查队列；`TransactionCheckService` 按 `transactionCheckInterval`（默认 30 秒）周期性回查；一条半消息最多回查 `transactionCheckMax`（默认 15 次）。回查次数耗尽仍无法确定状态，半消息会被丢弃或进入死信。

回查机制有一个容易被忽略的硬约束：**事务消息的 ProducerGroupName 不能随便设**。如果原生产者进程崩溃，Broker 会找同一 Producer Group 里的其他生产者实例，请它们代为执行 `checkLocalTransaction`。这意味着 `checkLocalTransaction` 必须能跨实例查到本地事务的真实状态——它不能只查"本进程内存里存没存过这个事务"，而要去数据库里按消息里的业务键（订单号）查订单到底在不在。很多事务消息写错，错就错在这里：把事务状态存进程内存，回查一旦落到别的实例，就查不到了。

回查还是异步的，跑在生产者侧的独立线程里。官方示例专门为事务消息的 check 设置了一个线程池——`checkLocalTransaction` 被 Broker 的检查请求触发、并发执行。这带来两个推论：一是回查逻辑可能和业务请求并发跑，它读到的必须是"已经落库、能跨线程一致读到"的状态；二是回查请求会排队，线程池太小会在流量高峰积压回查，导致半消息迟迟得不到最终状态。所以事务消息的回查，本质是一套"生产者端要自己维护好的查询服务"，不是 Broker 替你包办。

## 四、失败模式与它到底保证什么

事务消息保证的是**"下游最终只看到已提交的本地事务"**，它是最终一致，不是强一致。要理解它的边界，得看清几类失败各自的结果。

用一个具体场景走一遍：用户下单，本地事务是"插入订单 + 扣减库存"（同一个数据库事务），消息要通知下游发券。正常路径——半消息发出、本地事务提交、Commit 发到 Broker、Broker 把消息搬到订单 Topic、下游发券。三种崩溃路径，回查都能把结果收敛到"订单和消息一致"：半消息刚发出、本地事务还没执行就崩溃，回查按订单号查不到订单，返回 Rollback，消息丢弃、下游不发券；本地事务提交了、Commit 没发出去就崩溃，回查查到订单存在，返回 Commit，消息最终投递、下游晚几秒发券；本地事务执行到一半数据库回滚，回查查不到完整订单，Rollback。崩溃点不同，结局都正确——这正是半消息 + 回查的价值。

**半消息发出后、本地事务执行前崩溃**：本地事务没执行，`checkLocalTransaction` 查订单查不到，返回 Rollback，半消息被丢弃。下游收不到消息，正确。

**本地事务提交后、第二次确认发出前崩溃**：订单已落库，但 Commit 没到 Broker。回查时查到订单存在，返回 Commit，半消息放行。下游**晚一点**收到消息，但不会漏，正确。

**回查本身也失败**：Broker 回查、生产者恰好也联系不上，或回查超时。半消息继续挂着，直到回查次数耗尽后被丢弃或进死信。这时"订单在、消息丢了"的不一致又回来了——只是概率被压低，不是被消灭。所以事务消息不能替代对账：关键链路仍要有兜底扫描或对账，把这类漏网之鱼捞回来。

**消费者重复消费**：Commit 之后、消费者消费完成之前崩溃，消息会被再次投递。事务消息解决的是"消息和本地事务是否一致"，不解决"消费是否恰好一次"。消费端仍然要幂等——这回到《超时、重试、幂等》那篇的原则：事务消息负责把"不该发的消息"拦在门外，幂等负责把"重复发的消息"消化掉，两者各管一段。

一句话：事务消息把"本地事务和消息发送"的窗口从"可能不一致"压到"少数难以触发的场景不一致，且能靠回查和对账兜底"，但它不是分布式事务，也不提供恰好一次消费。

事务消息也不是银弹，三种场景它帮不上忙。一是"本地事务"本身跨了多个系统、没有一个单一业务键能反查出最终状态——回查不知道该查谁，这套机制就落不了地。二是本地事务执行时间很长（比如要同步等外部接口），半消息长时间挂着、回查反复触发，消费者迟迟收不到消息。三是要求多个下游"要么都成功要么都失败"的强一致——事务消息只保证"消息和本地事务一致"，不保证"多个下游之间一致"，后者要靠 Saga 或对账。认清这些边界，才不会把事务消息当成万能的事务替代品，也不会在它覆盖不了的地方硬用它。

## 五、事务消息还是本地消息表：怎么选

解决同一个双写窗口，还有一条不依赖 MQ 特性的路：**本地消息表 / Transactional Outbox**。把"业务记录 + 待发消息"放进同一个本地数据库事务，后台任务轮询消息表、把没发出去的消息补发出去。站内分布式事务那篇已经讲过 Outbox 的机制。

两者的取舍很清晰：

| 维度 | RocketMQ 事务消息 | 本地消息表 / Outbox |
| --- | --- | --- |
| 依赖 | 绑死 RocketMQ 的事务消息能力 | 任何 MQ 都能用，甚至不用 MQ |
| 一致性 | 半消息 + 回查，由 Broker 兜底 | 靠数据库事务 + 后台补发 |
| 实现成本 | 实现 TransactionListener，写好回查 | 建消息表、写轮询发送任务、对账 |
| 跨实例回查 | 同 Producer Group 会被代查，回查必须查库 | 无此约束，逻辑更直白 |
| 适用 | 团队已用 RocketMQ，且愿意写对回查 | 要解耦 MQ、或已有 Outbox 基础设施 |

我的判断是：**团队已经在用 RocketMQ、且业务里双写窗口确实高频出现，用事务消息更省事**——它把消息表、轮询发送、补发这些自己造，换成了实现两个回调方法。但如果团队要解耦 MQ 选型、或已经有一套 Outbox 基础设施在跑，本地消息表更稳，因为它不把一致性绑在某个中间件的特性上。最忌讳的是两者都不做：先写数据库、再裸发一条消息，然后指望"大概率不会出事"。

无论选哪条，终点都一样：消费者幂等、关键链路对账，这两件事省不掉。事务消息和本地消息表都是把"不该发的消息"拦住的闸门，闸门之外的那段路，还得靠幂等和对账来兜。

还有一种中间态值得一提：如果系统已经跑着本地消息表 / Outbox，没必要全量换成事务消息——两者可以共存、按链路区分。和本地事务强绑定、又恰好落在 RocketMQ 上的关键路径，用事务消息省事；跨 MQ、或已经有成熟 Outbox 基础设施的路径，继续用 Outbox。选型是逐链路判断，不是全站一刀切。

## 参考资料

- [RocketMQ 官方文档：Transactional Message Sending](https://rocketmq.apache.org/docs/4.x/producer/06message5/)
- [RocketMQ 源码：TransactionListener](https://github.com/apache/rocketmq/blob/develop/client/src/main/java/org/apache/rocketmq/client/producer/TransactionListener.java)
- [RocketMQ 源码：BrokerConfig（transactionCheckInterval / transactionCheckMax）](https://github.com/apache/rocketmq/blob/develop/common/src/main/java/org/apache/rocketmq/common/BrokerConfig.java)
