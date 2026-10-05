---
title: RocketMQ 推拉模式：本质只有一个「拉」
description: 拆开 Push Consumer 与 Pull Consumer 的 API 形态和底层传输两层，说明 RocketMQ 底层只有「拉」一种模式，Push 是「拉 + 长轮询」的封装，并给出日常该用哪种、为什么。
category: 后端
subcategory: 消息队列
articleClass: field-note
seriesOrder: 10
featured: true
publishedAt: 2026-08-12T20:26:00+08:00
updatedAt: 2026-08-12T20:26:00+08:00
tags: [RocketMQ, 消息队列, Push, Pull, 长轮询, 消费模型, DefaultMQPushConsumer, 背压]
---

RocketMQ 的文档里既有 Push Consumer，也有 Pull Consumer，两个都能把消息从 Broker 取回来。于是自然有一个问题：消息队列的消费模型不是分"推"和"拉"两种吗，RocketMQ 到底支持哪一种？

答案可以提前说清：**RocketMQ 底层只有一种，就是「拉」**。所谓 Push Consumer，名字里的 Push 是 API 层面的封装，底层仍是「拉」，只是加了一层长轮询，让"拉"看起来像"推"。搞清这一层，才能理解为什么日常开发几乎都用 Push、却又能放心它不会把慢消费者打爆。

## 一、先拆两层：API 形态和传输机制

"推"和"拉"这两个词，混着两件不同的事，这是大多数误解的来源。

第一层是 **API 形态**，也就是你写代码时看到的接口长什么样。Push Consumer 是 `DefaultMQPushConsumer`：你注册一个回调，消息来了框架自动调用你的 `consumeMessage`，你只管写消费逻辑。Pull Consumer 是 `DefaultLitePullConsumer`：你自己主动去 `poll`，拉回来一批自己处理，位点也自己管。

```java
// Push：注册回调，消息来了框架调用，位点自动提交
consumer.registerMessageListener((msgs, ctx) -> {
    handle(msgs);
    return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
});

// Pull：自己拉、自己处理、自己提交位点
List<MessageExt> msgs = litePullConsumer.poll();
handle(msgs);
```

第二层是 **传输机制**，也就是消息到底怎么从 Broker 到消费者进程。这一层 RocketMQ 只有一种：消费者主动向 Broker 发拉取请求，Broker 返回消息。

官方文档的 Push Consumer 页有一句关键的话：用户"不需要关注 rebalance 和 **pulling** 的逻辑，只需要写自己的消费逻辑"。这句话其实已经承认了 push 背后有一套 pulling 逻辑存在，只是框架帮你藏起来了。所以"Push vs Pull"在 RocketMQ 里不是两种传输方式的对比，而是"框架帮你拉"和"你自己拉"的对比。

## 二、Push 的底层：拉 + 长轮询

既然底层是拉，那 Push 怎么做到"消息一来就好像被推给消费者"？

消费者进程内部有一个 `PullMessageService` 线程，它持续向 Broker 发拉取请求。如果 Broker 上正好有消息，就返回，消费者收到后触发回调——这一步看起来确实像"推"。关键在于"正好没有消息"的时候：如果消费者拉一次、Broker 回个空、消费者立刻再拉，就成了空转轮询，白烧 CPU 和网络。

RocketMQ 用长轮询解决空转。Broker 端默认开启长轮询（源码里 `longPollingEnable` 默认是 `true`），消息不足时不立刻返回空，而是把这次拉取请求挂起一小段时间（`PullRequestHoldService` 持有它），等新消息落盘后再唤醒这个挂起的请求、把消息返回；如果一直没消息，才超时返回空，消费者再发起下一次拉取。短轮询是"一秒一问、大多空手"，长轮询是"问了就等着、有货再回"。

![长轮询让「拉」既不空转又接近推的实时性](/images/posts/rocketmq-push-pull-long-polling.svg)

这张图里三条线对应三种可能：短轮询是消费者不停空手而归；纯 push 是 Broker 主动推（RocketMQ 不走这条）；长轮询是消费者拉一次、Broker 挂着等、有新消息再回。RocketMQ 的 `DefaultMQPushConsumer` 走的是第三条。长轮询用"挂起请求"这一个动作，同时买到两样东西：不空转（省资源），延迟低（消息一到就回，接近 push 的实时性）。

源码里还有一个更直白的证据：`defaultMessageRequestMode` 的默认值是 `PULL`。也就是说，整个 RocketMQ 默认的消息请求模式，写出来就是 PULL。

## 三、为什么底层只留「拉」

只留"拉"一种传输方式，根子在一个词：**背压**。

拉模式下，消费速度由消费者自己决定。消费者按自己的处理能力去拉——处理得快就拉得快，处理得慢就拉得慢，甚至暂时不拉。于是"消费慢"天然会反向传导成"拉得慢"，Broker 和消费者之间形成了一道天然的背压，慢消费者不会被打爆。

纯 push 就没有这道背压。Broker 如果不管消费者能不能消化、一个劲地推，慢消费者要么被打挂，要么消息在它那边积压失控；要避免这个，Broker 端就得自己维护一套复杂的流控——按消费者的消费进度决定推多快。RocketMQ 选择不做这套流控，而是把"拉多快"的控制权交还给消费者自己，代价只是把"拉"的循环封装进框架。

「拉」还顺带解决了另一个问题：位点（offset）的主动权。拉模式下，什么时候拉、拉哪个队列、拉到哪、失败之后从哪里重来，都是消费者可以自己决定的。这对需要精确控制消费进度、或者要做批量拉取、限速、暂停恢复的场景，是必不可少的自由度。纯 push 模式下，这些都要靠 Broker 侧的协议去协商，复杂得多。

## 四、平时用哪种，为什么

日常开发里，绝大多数场景用 **Push Consumer（`DefaultMQPushConsumer`）**，原因不是它"更高级"，而是它把该省的都省了：

- 你不用写"拉循环 + 存位点 + 失败重拉"这套样板代码，只写一个回调；
- 位点自动提交，失败自动重试，超过最大次数进死信队列，负载均衡（Rebalance）也是框架自动做；
- 底层是长轮询的拉，所以它保留了背压——消费慢不会被打爆，这一点很多人误以为 push 会失去。

Pull Consumer（现在的 `DefaultLitePullConsumer`，老的 `DefaultMQPullConsumer` 已不推荐）只在一种情况下用：**你需要把手伸进消费循环里**。具体说，是这几类：

- 要精确控制位点：按业务条件决定什么时候 ack、失败要回退到某个具体位置，而不是框架默认的"成功即提交"；
- 要批量、限速：一次拉一批、按自己的节奏消费，或主动暂停、恢复、seek 到指定 offset；
- 消费语义不标准：数据同步、数据抽取、流计算这类"消费"本质上是"搬运"或"处理一批"，不是"处理一条回调一次"。

一句话：**能用 Push 就用 Push，只有当你需要自己掌控"拉"的节奏和位点时，才换成 Pull**。想清楚这一层，就不会被"推拉模式"这个说法绕进去——RocketMQ 里从来没有"推"这种传输方式，只有"框架帮你拉"和"你自己拉"两种 API。

## 参考资料

- [RocketMQ 官方文档：Push Consumer](https://rocketmq.apache.org/docs/4.x/consumer/02push/)
- [RocketMQ 官方文档：Pull Consumer](https://rocketmq.apache.org/docs/4.x/consumer/03pull/)
- [RocketMQ 源码：BrokerConfig（longPollingEnable / defaultMessageRequestMode）](https://github.com/apache/rocketmq/blob/develop/common/src/main/java/org/apache/rocketmq/common/BrokerConfig.java)
- [RocketMQ 源码：PullMessageService](https://github.com/apache/rocketmq/blob/develop/client/src/main/java/org/apache/rocketmq/client/impl/consumer/PullMessageService.java)
- [RocketMQ 源码：PullRequestHoldService](https://github.com/apache/rocketmq/blob/develop/broker/src/main/java/org/apache/rocketmq/broker/longpolling/PullRequestHoldService.java)
