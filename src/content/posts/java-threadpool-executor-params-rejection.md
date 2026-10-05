---
title: 线程池：七个参数、拒绝策略与大小
description: 拆解 ThreadPoolExecutor 的七个参数，讲清任务进入线程池后的完整流程——核心线程、任务队列、非核心线程、拒绝策略，对比四种拒绝策略和不同队列的选择，最后给出线程池大小的定法。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 70
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, 线程池, ThreadPoolExecutor, 拒绝策略, corePoolSize, maximumPoolSize, 并发]
---

线程不是免费的：创建要分配栈、要系统调用，销毁要回收，频繁创建销毁开销很大。线程池的答案是把线程复用起来——预先（或按需）创建一批线程，任务来了交给空闲线程执行，用完线程不销毁、回去继续等下一个任务。它同时解决两件事：**复用线程**（省创建销毁的开销）和**控制并发度**（不让任务无限开线程打垮系统）。

线程池的核心类 `ThreadPoolExecutor` 有七个构造参数，这七个参数决定了线程池的全部行为。真正吃透线程池，就是从这七个参数开始，看懂"一个任务进来之后到底怎么走"。

本文回答一个问题：`ThreadPoolExecutor` 的七个参数各管什么，任务进入后的执行流程和拒绝策略怎么工作，线程池大小怎么定。上一篇讲了 `ThreadLocal`（线程私有变量），线程池恰好是 `ThreadLocal` 内存泄漏的重灾区——线程复用意味着线程上的 `ThreadLocal` 值也跟着复用，这个关联后面会点一句。

## 一、七个参数，各管一件事

```java
new ThreadPoolExecutor(
    corePoolSize,      // ① 核心线程数：常驻线程，即使空闲也不销毁
    maximumPoolSize,   // ② 最大线程数：核心线程 + 非核心线程的上限
    keepAliveTime,     // ③ 非核心线程空闲多久销毁
    unit,              // ④ keepAliveTime 的时间单位
    workQueue,         // ⑤ 任务队列：核心线程忙时，任务先排队
    threadFactory,     // ⑥ 线程工厂：怎么创建线程、起什么名
    handler            // ⑦ 拒绝策略：线程和队列都满时怎么办
);
```

记住这七个参数的语义，是理解线程池的第一步。其中最容易搞混的是 `corePoolSize` 和 `maximumPoolSize`：核心线程是"常驻"的，满了也不销毁；最大线程是"峰值"的，包含核心线程和非核心线程，非核心线程空闲超过 `keepAliveTime` 就回收。

## 二、任务进来怎么走：一条固定的流程

`execute(task)` 提交一个任务后，线程池按固定顺序判断：

![任务进入线程池的完整流程](/images/posts/java-threadpool-flow.svg)

1. 当前线程数 < `corePoolSize`：**新建一个核心线程**执行任务，哪怕别的核心线程闲着也不复用——这是为了尽快把核心线程建满；
2. 核心线程已满：任务**进队列排队**；
3. 队列也满：线程数 < `maximumPoolSize`，**新建非核心线程**执行；
4. 线程数已到 `maximumPoolSize` 且队列满：执行**拒绝策略**。

这个顺序里最反直觉的是第 1 步：先建满核心线程，而不是"有空闲线程就复用"。设计意图是核心线程代表"稳定负载"，先把常驻的底子打满，再靠队列缓冲突发。理解了这条流程，再看各种线程池的奇怪行为——比如"核心线程设大了，任务全被新线程抢、队列一直空"——就都能解释了。

## 三、四种拒绝策略：满了之后怎么办

线程和队列都满时，任务无处可去，由 `handler` 决定它的命运。四种内置策略：

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| `AbortPolicy`（默认） | 抛 `RejectedExecutionException` | 宁可报错，也不能丢或卡 |
| `CallerRunsPolicy` | 提交任务的线程自己执行 | 天然的背压：让调用方慢下来 |
| `DiscardPolicy` | 静默丢弃，不抛异常 | 可丢弃的任务（如日志采样） |
| `DiscardOldestPolicy` | 丢弃队头最老的任务 | 宁可丢旧的，也要接新的 |

`CallerRunsPolicy` 是最值得记的一个：它让提交任务的线程（通常是业务线程）自己跑这个任务，从而"堵住"提交方，形成一道天然的背压——上游提交太快，就被迫自己干活、慢下来。这比"抛异常"或"静默丢弃"更符合"把拥塞传回上游"的思想，和消息队列削峰里讲的背压是一回事。

## 四、队列的选择：有界还是无界

队列（`workQueue`）的选择，直接决定线程池会不会 OOM。

`LinkedBlockingQueue`（无界，`Executors.newFixedThreadPool` 默认）最危险：队列能无限塞，任务堆积时线程数不再涨（核心线程已满、队列永远塞得下），内存被队列撑爆。`ArrayBlockingQueue`（有界）更安全：队列有上限，满了才会触发新建非核心线程、最终到拒绝策略，整套"满则拒"的机制才真正生效。

`SynchronousQueue` 是特殊的一个：它不缓存任务，每个任务必须立刻被一个线程接走——提交成功即有一个线程在跑它，提交失败就直接走拒绝策略。它适合"任务量大且短暂"的场景，配合较大的 `maximumPoolSize` 使用，缺点是任务不能有排队缓冲。

一个实用原则：**生产环境用有界队列**，让线程池的"满则拒"机制真正发挥作用，而不是用无界队列把问题推迟成 OOM。这也是阿里 Java 规范里"不允许用 `Executors` 默认工厂、要显式 `new ThreadPoolExecutor`"的原因——`Executors` 的默认队列大多是无界的。

## 五、线程池大小怎么定

没有万能公式，但有两条参考和一条铁律。

CPU 密集型任务（计算为主，几乎不等待）：线程数设为 CPU 核数 + 1 即可，多了只会争抢 CPU、徒增切换。

IO 密集型任务（大量等待网络、磁盘、数据库）：线程数可以多一些，参考公式是 `N_threads = N_cpu × (1 + 等待时间 / 计算时间)`。但这个公式里的"等待/计算比"要靠实测，凭感觉填数字没用。

铁律是：**最终以压测为准**。公式只能给起点，真正的线程数要在目标负载下压测出"延迟和吞吐的拐点"再定。线程太少，CPU 闲着、任务排队；线程太多，上下文切换、内存占用反而拖慢。而且线程池大小不是孤立的——它要和数据库连接池、下游限流、CPU 核数一起看，任何一处是瓶颈，调线程池都白搭。

## 六、三个常见的坑

**用 `Executors` 默认工厂。** `newFixedThreadPool` 和 `newCachedThreadPool` 的队列分别是无界队列、或线程数无上限，前者 OOM、后者线程爆炸。显式 `new ThreadPoolExecutor` 并指定有界队列，是基本纪律。

**`submit` 吞异常。** `submit(task)` 返回 `Future`，任务里抛的异常被吞进 `Future`，不 `get()` 就永远看不到，任务"静默失败"。要么在任务里自己 `try/catch` 打日志，要么 `submit` 后 `get()` 取出异常。

**线程池 + `ThreadLocal` 不 `remove`。** 线程复用意味着线程上的 `ThreadLocal` 值也跟着复用——上一个任务 `set` 的用户信息，下一个任务可能 `get` 到。这正是上一篇讲的内存泄漏的温床，也是"上下文串了"这类诡异 bug 的来源。线程池里用 `ThreadLocal`，`remove` 是必须项。

线程池的本质是一道流量整形：它把"同时有多少任务在跑"限制在一个可控范围内，用队列吸收突发、用拒绝策略把拥塞传回上游。七个参数就是这道整形的七个旋钮——核心线程数决定常态负载，最大线程数决定峰值上限，队列决定缓冲深度，拒绝策略决定"满"之后的姿态。把七个旋钮的关系理顺，线程池就从"会用的工具"变成"能调好的工具"。

## 参考资料

- [Oracle：ThreadPoolExecutor（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/ThreadPoolExecutor.html)
- [OpenJDK：ThreadPoolExecutor 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/ThreadPoolExecutor.java)
- [Oracle：Executors（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/Executors.html)
