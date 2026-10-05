---
title: 线程池：参数、状态机与线程复用
description: 深入 ThreadPoolExecutor 源码：七个参数、ctl 高 3 位状态与低 29 位线程数、五种状态及转换、execute 的完整流程、Worker/runWorker/getTask 的线程复用循环、allowCoreThreadTimeOut 回收核心线程、四种拒绝策略与队列选择。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 70
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, 线程池, ThreadPoolExecutor, ctl, 状态机, Worker, getTask, 拒绝策略, 线程复用]
---

线程池最核心的价值是"线程复用"——一个线程执行完一个任务后不死，而是回去继续取下一个任务。这个"复用"到底是怎么实现的？答案在三个源码组件里：`ctl`（一个 int 同时存状态和线程数）、`Worker`（把线程和任务包装在一起）、`getTask`（一个让线程"要么取到任务、要么超时退出"的循环）。

大多数讲线程池的文章停在"七个参数 + 四种拒绝策略 + 任务先核心后队列再非核心"这三件事。这三件事对，但不完整——线程池的**状态机**（什么时候能收新任务、什么时候处理队列、什么时候销毁）、**线程复用的循环**（`runWorker` → `getTask` 那一圈）、**核心线程的回收**（`allowCoreThreadTimeOut`），这些才是线程池"活"起来的部分。

本文把 `ThreadPoolExecutor` 的源码机制摊开讲。目标是：读完你能画出状态机的五态转换，复述出 `execute` 的每一步和 `getTask` 的每一层判断。主要依据是 JDK 8 源码。

## 一、七个参数，各管一件事

```java
new ThreadPoolExecutor(
    corePoolSize,      // ① 核心线程数：常驻，空闲也不销毁（除非 allowCoreThreadTimeOut）
    maximumPoolSize,   // ② 最大线程数：核心 + 非核心的上限
    keepAliveTime,     // ③ 非核心线程空闲多久销毁
    unit,              // ④ keepAliveTime 的时间单位
    workQueue,         // ⑤ 任务队列：核心线程忙时，任务先排队
    threadFactory,     // ⑥ 线程工厂：怎么创建线程、起什么名
    handler            // ⑦ 拒绝策略：线程和队列都满时怎么办
);
```

最容易混的是 `corePoolSize` 和 `maximumPoolSize`：核心线程是常驻的，空闲也不回收；最大线程是"峰值"上限，包含核心线程，其中超出核心的那部分（非核心线程）空闲超过 `keepAliveTime` 就回收。`keepAliveTime` 默认只作用于非核心线程，除非开了 `allowCoreThreadTimeOut`（第六节）。

## 二、ctl：一个 int 存状态和线程数

`ThreadPoolExecutor` 用一个 `AtomicInteger ctl` 同时存两样东西——**高 3 位是运行状态，低 29 位是工作线程数**。用一个 int 而不是两个字段，是为了能**一次 CAS 同时改状态和线程数**，避免两者分离带来的竞态。

```java
private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
private static final int COUNT_BITS = Integer.SIZE - 3;      // 29
private static final int CAPACITY   = (1 << COUNT_BITS) - 1; // 2^29 - 1 ≈ 5 亿

// 五种状态，占用高 3 位
private static final int RUNNING    = -1 << COUNT_BITS;   // 111...
private static final int SHUTDOWN   =  0 << COUNT_BITS;   // 000...
private static final int STOP       =  1 << COUNT_BITS;   // 001...
private static final int TIDYING    =  2 << COUNT_BITS;   // 010...
private static final int TERMINATED =  3 << COUNT_BITS;   // 011...

private static int runStateOf(int c)    { return c & ~CAPACITY; }   // 取高 3 位
private static int workerCountOf(int c) { return c & CAPACITY; }    // 取低 29 位
```

## 三、五种状态及转换

线程池有五态，各自的"能做什么"不同：

| 状态 | 接受新任务 | 处理队列任务 | 触发方式 |
| --- | --- | --- | --- |
| RUNNING | 是 | 是 | 初始状态 |
| SHUTDOWN | 否 | 是（把队列里的干完） | `shutdown()` |
| STOP | 否 | 否（中断正在执行的任务） | `shutdownNow()` |
| TIDYING | 否 | 否（所有任务终止，workerCount=0） | 过渡态 |
| TERMINATED | 否 | 否 | `terminated()` 钩子执行完 |

转换路径是单向的：

```text
RUNNING ──shutdown()──▶ SHUTDOWN ──队列空且线程空──▶ TIDYING ──▶ TERMINATED
RUNNING ──shutdownNow()──▶ STOP ──线程空──▶ TIDYING ──▶ TERMINATED
SHUTDOWN ──shutdownNow()──▶ STOP
```

`shutdown()` 和 `shutdownNow()` 的差别，就是这张图最核心的一行：`shutdown()` 停止收新任务、但把队列里已排队的干完再停；`shutdownNow()` 停止收新任务、**不**处理队列（返回未执行的任务列表）、并中断正在跑的任务。所以"优雅停机"用 `shutdown()`（配合 `awaitTermination` 等它干完），"立即停机"用 `shutdownNow()`。

![线程池五种状态及转换](/images/posts/java-threadpool-state.svg)

## 四、execute 的完整流程

`execute` 是提交任务的入口，它的源码是理解线程池行为的地基：

```java
public void execute(Runnable command) {
    if (command == null) throw new NullPointerException();
    int c = ctl.get();
    // ① 线程数 < 核心 → 新建核心线程执行
    if (workerCountOf(c) < corePoolSize) {
        if (addWorker(command, true)) return;
        c = ctl.get();   // 竞态失败，重读
    }
    // ② 核心线程已满 → 尝试入队
    if (isRunning(c) && workQueue.offer(command)) {
        int recheck = ctl.get();
        if (!isRunning(recheck) && remove(command))   // 双重检查：入队后状态变了
            reject(command);
        else if (workerCountOf(recheck) == 0)          // 队里有任务但没线程
            addWorker(null, false);                    // 补一个线程
    }
    // ③ 队列也满 → 建非核心线程，失败则拒绝
    else if (!addWorker(command, false))
        reject(command);
}
```

三个细节值得盯。第一，第 ② 步入队成功后有个**双重检查**：入队的瞬间线程池可能被 `shutdown` 了，所以要重读状态，若已停止就从队列里移除这个任务并拒绝。第二，`addWorker(null, false)` 传的是 `null` 任务——它的作用是"队列里还有活、但没有线程去干，补一个线程"，这个线程会去 `getTask` 里从队列取任务。第三，第 ③ 步的 `addWorker(command, false)` 是"建非核心线程"，第二个参数 `false` 表示"不是核心"，受 `maximumPoolSize` 约束。

![任务进入线程池的完整流程](/images/posts/java-threadpool-flow.svg)

## 五、线程复用：Worker、runWorker、getTask

线程复用的核心是 `Worker`——它把"一个线程"和"一个任务"包在一起：

```java
private final class Worker extends AbstractQueuedSynchronizer implements Runnable {
    final Thread thread;
    Runnable firstTask;
    Worker(Runnable firstTask) {
        this.firstTask = firstTask;
        this.thread = getThreadFactory().newThread(this);   // 关键：线程跑的是 Worker 自己
    }
    public void run() { runWorker(this); }
}
```

注意 `newThread(this)`——Worker 传入的是 `this`（Worker 自身，因为它实现了 `Runnable`），所以这个线程启动后跑的是 `Worker.run()`，而 `run()` 里是 `runWorker` 那个**循环**。复用就发生在这个循环里：

```java
final void runWorker(Worker w) {
    Thread wt = Thread.currentThread();
    Runnable task = w.firstTask;          // 先执行创建时带来的任务
    w.firstTask = null;
    while (task != null || (task = getTask()) != null) {
        w.lock();
        try {
            beforeExecute(wt, task);
            task.run();                   // 执行任务
            afterExecute(task, null);
        } finally {
            task = null;
            w.unlock();
        }
    }
    processWorkerExit(w, completedAbruptly);   // 拿不到任务，退出
}
```

`while (task != null || (task = getTask()) != null)` 这一行就是复用的本质：先跑完 `firstTask`，然后不断 `getTask()` 从队列取下一个任务，取到就继续跑，取不到（`getTask` 返回 null）就退出、线程销毁。一个线程就这样"一个任务接一个任务"地循环，直到没有任务可做。

`getTask` 是这个循环的另一半，它决定"线程什么时候该等、什么时候该退"：

```java
private Runnable getTask() {
    boolean timedOut = false;
    for (;;) {
        int c = ctl.get();
        int rs = runStateOf(c);
        // SHUTDOWN 且队列空，或 STOP → 线程退出
        if (rs >= SHUTDOWN && (rs >= STOP || workQueue.isEmpty())) {
            decrementWorkerCount();
            return null;
        }
        int wc = workerCountOf(c);
        // 是否允许超时：开了 allowCoreThreadTimeOut，或线程数 > 核心
        boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;
        if ((wc > maximumPoolSize || (timed && timedOut))
            && (wc > 1 || workQueue.isEmpty())) {
            if (compareAndDecrementWorkerCount(c)) return null;   // 超时，退出
            continue;
        }
        try {
            // 非核心线程 poll(keepAliveTime) 超时；核心线程 take() 无限阻塞
            Runnable r = timed ?
                workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) :
                workQueue.take();
            if (r != null) return r;
            timedOut = true;   // poll 超时，下一轮可能退出
        } catch (InterruptedException retry) {
            timedOut = false;
        }
    }
}
```

`getTask` 里的 `timed` 判断是理解线程回收的钥匙：**非核心线程**（`wc > corePoolSize`）用 `poll(keepAliveTime)`——超时取不到任务就返回 null、退出、被回收；**核心线程**（`wc <= corePoolSize` 且没开 `allowCoreThreadTimeOut`）用 `take()`——无限阻塞等待，不超时、不退出。这就是"核心线程常驻、非核心线程超时回收"的源码实现。

![Worker 的线程复用循环](/images/posts/java-threadpool-worker.svg)

## 六、回收核心线程：allowCoreThreadTimeOut

默认 `keepAliveTime` 只作用于非核心线程，核心线程空闲也不回收。`allowCoreThreadTimeOut(true)` 把它也应用到核心线程——开了之后，核心线程空闲超过 `keepAliveTime` 也会被回收，线程池可能缩到 0 个线程（有任务再来时重新建）。

```java
public void allowCoreThreadTimeOut(boolean value) {
    if (value && keepAliveTime <= 0)
        throw new IllegalArgumentException("Core threads must have nonzero keep alive times");
    if (value != allowCoreThreadTimeOut) {
        allowCoreThreadTimeOut = value;
        if (value) interruptIdleWorkers();   // 中断空闲线程，让它们走 getTask 退出
    }
}
```

在 `getTask` 里，它把 `timed` 变成 `true`，于是核心线程也走 `poll(keepAliveTime)` 分支、超时退出。这个开关的用途是：线程池平时空着、偶尔来任务，且想省掉空闲线程的内存和系统资源。代价是任务高峰来时线程要重新创建、有冷启动延迟。

## 七、四种拒绝策略

线程和队列都满时，由 `handler` 决定任务的命运：

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| `AbortPolicy`（默认） | 抛 `RejectedExecutionException` | 宁可报错，不能丢或卡 |
| `CallerRunsPolicy` | 提交任务的线程自己执行 | 天然背压，让调用方慢下来 |
| `DiscardPolicy` | 静默丢弃，不抛异常 | 可丢弃的任务（如日志采样） |
| `DiscardOldestPolicy` | 丢弃队头最老的任务 | 宁可丢旧的，也要接新的 |

`CallerRunsPolicy` 最值得记：它让提交线程（通常是业务线程）自己跑这个任务，从而"堵住"提交方，形成一道天然背压——上游提交太快，就被迫自己干活、慢下来。这和消息队列削峰里的背压是同一个思想：把拥塞信号传回上游，而不是让队列无限堆积。

## 八、队列的选择：有界还是无界

队列直接决定线程池会不会 OOM。`LinkedBlockingQueue`（无界，`Executors.newFixedThreadPool` 默认）最危险：队列无限塞，任务堆积时线程数不再涨（核心线程已满、队列永远塞得下），内存被队列撑爆。`ArrayBlockingQueue`（有界）更安全：队列有上限，满了才触发建非核心线程、最终到拒绝策略，整套"满则拒"机制才真正生效。

`SynchronousQueue` 是特殊的：它不缓存任务，每个任务必须立刻被一个线程接走——提交成功即有一个线程在跑，提交失败直接走拒绝策略。适合"任务量大且短暂"、配合较大 `maximumPoolSize` 的场景，缺点是没有排队缓冲。

生产环境的纪律是：**用有界队列**，让"满则拒"机制真正生效，而不是用无界队列把问题推迟成 OOM。这也是"不用 `Executors` 默认工厂、显式 `new ThreadPoolExecutor`"的原因——`Executors` 的默认队列大多无界。

## 九、线程池大小，和三个坑

线程池大小没有万能公式。CPU 密集型（计算为主）用"CPU 核数 + 1"；IO 密集型参考 `N_threads = N_cpu × (1 + 等待时间 / 计算时间)`，但"等待/计算比"必须实测。铁律是**以压测为准**——公式只给起点，真正的线程数要在目标负载下压出"延迟和吞吐的拐点"再定，而且要连同数据库连接池、下游限流一起看，任何一处是瓶颈，调线程池都白搭。

三个坑：一是用 `Executors` 默认工厂（无界队列 OOM、线程无上限爆炸）；二是 `submit` 吞异常——`submit(task)` 返回 `Future`，任务抛的异常被吞进 `Future`，不 `get()` 就永远看不到，任务"静默失败"；三是线程池 + `ThreadLocal` 不 `remove`——线程复用意味着 `ThreadLocal` 值也复用，上一个任务的用户信息可能被下一个任务 `get` 到，这正是 `ThreadLocal` 内存泄漏的温床。

线程池的本质是一道流量整形：`ctl` 管状态和线程数，`execute` 管任务按"核心 → 队列 → 非核心 → 拒绝"走，`runWorker` + `getTask` 管线程复用和回收，拒绝策略管"满"之后的姿态。把这四块串起来，线程池就不再是"会用的工具"，而是"能调好、能排障的工具"。

## 参考资料

- [OpenJDK：ThreadPoolExecutor 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/ThreadPoolExecutor.java)
- [Oracle：ThreadPoolExecutor（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/ThreadPoolExecutor.html)
- [Oracle：Executors（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/Executors.html)
