---
title: RocketMQ 推拉模式：Push 背后的长轮询与消费控制
description: 以 RocketMQ 4.x Remoting 消费者为主，拆开回调 API、主动拉取与长轮询，说明流控和位点提交的边界，并区分 5.x PushConsumer、SimpleConsumer 的接口与确认模型。
category: 后端
subcategory: 消息队列
articleClass: field-note
seriesOrder: 10
featured: true
publishedAt: 2026-09-30T20:33:00+08:00
updatedAt: 2026-10-06T15:46:00+08:00
tags: [RocketMQ, 消息队列, Push, Pull, 长轮询, 消费模型, DefaultMQPushConsumer, 背压]
---

RocketMQ 的文档里既有 Push Consumer，也有 Pull Consumer，两个都能把消息从 Broker 取回来。于是自然有一个问题：消息队列的消费模型不是分"推"和"拉"两种吗，RocketMQ 到底支持哪一种？

先限定范围：本文的 `DefaultMQPushConsumer` 与 `DefaultLitePullConsumer` 指 4.x Remoting API，不以 Broker 的大版本号直接判断客户端模型。这里 Push 的消息获取由客户端主动拉取、长轮询与回调调度组成，不是 Broker 无请求地持续推送。5.x gRPC SDK 另有 PushConsumer、SimpleConsumer 等接口，不能把旧类名、消费位点和逐消息 ACK 混为一谈。

## 一、先拆两层：API 形态和传输机制

"推"和"拉"这两个词，混着两件不同的事，这是大多数误解的来源。

第一层是 API 形态，也就是代码里的入口。`DefaultMQPushConsumer` 注册监听器，由 SDK 调用消费逻辑并根据返回值管理进度。`DefaultLitePullConsumer` 让应用主动 `poll()` 获取消息；它也提供自动提交配置，并非调用 `poll()` 就天然变成手动提交。需要业务完成后提交时，要关闭自动提交并设计失败、并发与重平衡处理。

```java
// 4.x Push：handle 必须完成约定业务边界后才返回成功
consumer.registerMessageListener((msgs, ctx) -> {
    handle(msgs);
    return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
});

// 4.x LitePull：示意手动管理进度；配置须在 start 之前设置
litePullConsumer.setAutoCommit(false);
// ... start、循环、异常处理等省略
List<MessageExt> msgs = litePullConsumer.poll();
handle(msgs);
litePullConsumer.commitSync();
```

第二层是获取协议。上述 Remoting 消费者向 Broker 发拉取请求，Broker 返回匹配消息。LitePull 的 `poll()` 主要从客户端本地缓存获取消息，后台线程执行实际拉取；它也不等于每次 `poll()` 都同步访问 Broker。

官方文档的 Push Consumer 页有一句关键的话：用户"不需要关注 rebalance 和 **pulling** 的逻辑，只需要写自己的消费逻辑"。这句话其实已经承认了 push 背后有一套 pulling 逻辑存在，只是框架帮你藏起来了。所以"Push vs Pull"在 RocketMQ 里不是两种传输方式的对比，而是"框架帮你拉"和"你自己拉"的对比。

## 二、Push 的底层：拉 + 长轮询

既然底层是拉，那 Push 怎么做到"消息一来就好像被推给消费者"？

消费者进程内部有一个 `PullMessageService` 线程，它持续向 Broker 发拉取请求。如果 Broker 上正好有消息，就返回，消费者收到后触发回调——这一步看起来确实像"推"。关键在于"正好没有消息"的时候：如果消费者拉一次、Broker 回个空、消费者立刻再拉，就成了空转轮询，白烧 CPU 和网络。

RocketMQ 用长轮询减少空查询。满足请求挂起条件时，Broker 不立即返回空结果，而由 `PullRequestHoldService` 保存请求，等待匹配消息可读或等待期限结束，再重新检查并响应。这个机制不会为每个等待请求阻塞一条业务线程，也不是必须等到物理磁盘 fsync 才唤醒；消息可读与刷盘耐久是不同边界。消息过滤、扫描与调度还会影响实际延迟，长轮询不保证零等待。

![长轮询让「拉」既不空转又接近推的实时性](/images/posts/rocketmq-push-pull-long-polling.svg)

这张图对比短轮询、无请求的主动推送，以及挂起拉取请求的长轮询。本文讨论的 `DefaultMQPushConsumer` 走第三条。它减少空响应，避免为了及时获知消息而高频询问，但网络、过滤、调度与业务队列依然可能造成延迟。

不能拿某个默认配置值证明“整个 RocketMQ 只有一种协议”。服务端和客户端还存在 POP、逐消息确认等路径，5.x 官方消费者文档也区分消息级与队列级负载均衡。理解具体行为，应同时确认 SDK、协议与消费类型。

## 三、主动拉取便于控制节奏，但背压不是自动成立

主动拉取使消费者能够决定请求节奏，这是实现背压的一个入口。

SDK 会根据本地缓存数量、大小、位点跨度等阈值延缓拉取。实际系统仍要限制消费线程、单批工作量、外部连接池和业务侧队列。拉取速度高于完成速度时，消息照样能在客户端缓存或自建线程池积压。长轮询解决空查询，不直接解决慢 SQL、无限异步分发和内存失控。

主动推送也可以有背压，例如利用信用额度、预取上限和未确认消息数量限制发送。不能把“拉”与“安全”画等号，也不能说推送协议必定无法控制流量。选择的区别在于流控信号、状态和调度由谁维护。

4.x LitePull 还允许应用更直接地管理消费进度。但位点不是一条消息的独立完成标记：如果并发处理时后面的消息先完成，不能直接跨过前面未完成的消息提交。提交应覆盖连续完成的范围，并协调队列重新分配；否则所谓“自己控制”反而会漏处理。

## 四、平时用哪种，为什么

在 4.x 回调式业务消费中，Push 通常能省去自行管理拉取与调度的工作，但要遵守监听器的完成语义：

- 你不用写"拉循环 + 存位点 + 失败重拉"这套样板代码，只写一个回调；
- 在适用的集群消费与重试模式下，SDK 管理进度、失败重试与 Rebalance；广播等模式不能直接照搬这套保证。
- 有缓存与调度流控，但仍需限制下游并发。把消息提交给内存线程池后立即返回成功，会让 MQ 误以为业务已经完成。

Pull Consumer（现在的 `DefaultLitePullConsumer`，老的 `DefaultMQPullConsumer` 已不推荐）只在一种情况下用：**你需要把手伸进消费循环里**。具体说，是这几类：

- 要精确控制位点：按业务条件决定什么时候 ack、失败要回退到某个具体位置，而不是框架默认的"成功即提交"；
- 要批量、限速：一次拉一批、按自己的节奏消费，或主动暂停、恢复、seek 到指定 offset；
- 消费语义不标准：数据同步、数据抽取、流计算这类"消费"本质上是"搬运"或"处理一批"，不是"处理一条回调一次"。

如果使用 5.x gRPC SDK，按 [官方消费者类型](https://rocketmq.apache.org/docs/featureBehavior/06consumertype/)选择：PushConsumer 在监听器完成后返回结果；SimpleConsumer 通过 `receive`、`ack` 与不可见时间管理处理，适合更自主的业务调度；PullConsumer 主要用于流处理集成。不可见时间是有限处理租约，超时、确认失败仍可能重复投递，并不取消幂等要求。

日常选择先看当前客户端类型，再看是否需要自主调度、怎样确认业务完成、怎样控制并发。理解 Push 背后的长轮询有助于定位延迟，但确认、背压和版本边界必须一起看。

## 参考资料

- [RocketMQ 官方文档：Push Consumer](https://rocketmq.apache.org/docs/4.x/consumer/02push/)
- [RocketMQ 官方文档：Pull Consumer](https://rocketmq.apache.org/docs/4.x/consumer/03pull/)
- [RocketMQ 4.9.8：BrokerConfig](https://github.com/apache/rocketmq/blob/rocketmq-all-4.9.8/common/src/main/java/org/apache/rocketmq/common/BrokerConfig.java)
- [RocketMQ 4.9.8：PullMessageService](https://github.com/apache/rocketmq/blob/rocketmq-all-4.9.8/client/src/main/java/org/apache/rocketmq/client/impl/consumer/PullMessageService.java)
- [RocketMQ 4.9.8：PullRequestHoldService](https://github.com/apache/rocketmq/blob/rocketmq-all-4.9.8/broker/src/main/java/org/apache/rocketmq/broker/longpolling/PullRequestHoldService.java)
