---
title: Java 线程池：从线程复用到生产配置与任务治理
description: 从一次商品详情请求理解线程池的意义，串起七个参数、入队与扩容、execute 与 submit、线程工厂、拒绝策略、延迟任务和优雅停机，并用可运行实验验证容易误解的行为。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 70
featured: true
publishedAt: 2026-06-11T09:15:00+08:00
updatedAt: 2026-10-06T02:05:00+08:00
tags: [Java, 线程池, ThreadPoolExecutor, Future, ThreadFactory, 拒绝策略, 定时任务]
tools:
  - name: documd-visuals
    href: /toolbox/#documd-visuals
  - name: humanizer
    href: /toolbox/#humanizer
---

一个商品详情请求，需要查询价格、库存和推荐商品。把三次查询拆成异步任务，可以让它们并行等待下游响应。但如果推荐服务突然变慢，持续进来的请求会留下大量未完成任务：每个任务新建线程，可能耗尽线程资源；改成固定线程池，任务又可能积压在无界队列中。

线程池要解决的不只是“少创建几个线程”。它还要决定：允许多少任务同时执行，剩下的任务能等多久，容量不足时怎样回应调用方，以及任务失败、请求超时和服务停机时谁负责收尾。

本文围绕普通 `ThreadPoolExecutor` 展开，再说明定时线程池与延迟队列的区别。API 依据 Java 17 官方文档，实现依据固定版本的 [OpenJDK 17.0.16 源码](https://github.com/openjdk/jdk17u/blob/jdk-17.0.16%2B8/src/java.base/share/classes/java/util/concurrent/ThreadPoolExecutor.java)。文末实验使用本机 OpenJDK 11 验证两者共有的行为；文中的容量数字用于解释机制，不是通用生产配置。

## 一、为什么要用线程池：复用、限制并发与管理任务

直接为每个请求创建线程，需要反复分配线程资源、启动线程，执行结束后再回收。对于大量短任务，这些成本可能占去相当一部分处理时间。线程池让工作线程执行完一个任务后继续接下一个任务，把创建与回收分摊到多个任务上。

复用发生在工作线程的循环里：先执行创建时携带的任务，再不断从队列取任务。没有任务时可以等待，而不是立即退出。一个工作线程在同一时刻只执行一个任务；十个线程也不会让一个原本耗时一秒的远程查询自动变成一百毫秒，只是允许更多查询同时等待。

第二个意义是限制并发。假设推荐接口最多能承受八个并行调用，创建八十个线程并不会扩大它的容量，反而可能增加连接等待和超时。线程池可以约束工作线程数量，但这还不等于完整的下游限流：多个应用实例会叠加并发，拒绝策略也可能让调用线程参与执行。

第三个意义是统一管理任务的生命周期。任务可以排队、拒绝、取消、等待结果，也可以在应用关闭时停止接收并等待已有任务结束。队列承担短暂缓冲，不能增加系统的长期处理能力。如果每秒进入一千个任务，而系统只能完成八百个，队列只是推迟拥塞发生的时间。

这些能力都有边界。内存队列不是持久化消息队列，进程退出会丢失其中的任务；线程池也不会自动保证订单任务重试、幂等或补偿。对于必须执行的业务，应先建立持久任务记录或使用合适的消息系统，再让线程池承担本机执行。

Java 21 的虚拟线程改变了大量阻塞任务的线程成本，但不能消除数据库连接数、远程接口容量等资源限制。官方建议不要为了复用虚拟线程而把它们池化；需要限制某类资源的并发时，可以另用信号量。本文讨论的是平台线程池，不能直接把它的大小公式套到虚拟线程上。[Java 21 虚拟线程说明](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html)

## 二、先分清任务、执行器与结果

`Runnable` 表示可以执行的任务，`run()` 不返回业务结果；`Callable<V>` 的 `call()` 返回 V，并允许抛出受检异常。它们描述“要做什么”，本身不决定任务在哪个线程执行。

`Executor` 提供 `execute(Runnable)` 这个执行入口。`ExecutorService` 在它之上增加任务提交、结果等待和关闭等能力。`ThreadPoolExecutor` 是常见的线程池实现；`ScheduledThreadPoolExecutor` 则增加延迟与周期调度。`Executors` 是创建执行器等对象的工具类，不是另一种任务执行机制。

`Future` 可以理解为任务的结果句柄：调用方通过它观察完成、失败或取消，并在需要时等待返回值。拿到 Future 并不表示业务已经完成，也不一定表示任务会执行——后面会看到，静默拒绝可能留下一个永远未完成的 Future。

这几个概念在商品详情请求中各有位置：库存查询被包装成 Callable，线程池负责安排执行，Future 交给请求协调方保存。协调方决定等多久、怎样处理异常，以及库存不可用时是否返回降级结果。不能只写一行 `submit`，就把剩余责任交给线程池。

## 三、七个参数要放在一起理解

下面这个小线程池用于演示，核心线程上限是 2，最大工作线程数是 4，队列只能放 2 个任务：

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    2, 4,
    30, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(2),
    Executors.defaultThreadFactory(),
    new ThreadPoolExecutor.AbortPolicy()
);
```

| 参数 | 管什么 | 容易误解的地方 |
| --- | --- | --- |
| corePoolSize | 优先创建线程时采用的数量上限 | 默认按需创建，不是构造时立即启动这些线程 |
| maximumPoolSize | 允许存在的工作线程数量上限 | 队列入队成功时通常不会向这个上限扩容 |
| keepAliveTime | 允许超时退出的线程空闲等待多久 | 不是任务执行超时 |
| unit | 空闲等待时间的单位 | 要与实际传入的数值一起看 |
| workQueue | 保存尚未被工作线程取走的任务 | 容量、顺序与入队语义会改变扩容行为 |
| threadFactory | 创建工作线程 | 不为每个业务任务各创建一个线程 |
| handler | 无法接收任务时怎样处理 | 饱和与关闭都可能触发它 |

### 核心数量与最大数量，不是两批固定身份的线程

刚构造时，线程池通常还没有工作线程。提交任务后，如果当前工作线程数少于核心数量，会尝试创建线程。即使已有工作线程暂时空闲，这一步仍然以“线程数量”判断，而不是先统计有没有人忙。

需要提前启动时，可以调用 `prestartCoreThread()` 或 `prestartAllCoreThreads()`。预启动能减少首次任务遇到的创建成本，但会提前占用资源，并不适合所有闲置时间很长的线程池。

“核心线程”和“非核心线程”方便描述数量区间，不能理解成线程创建后永久贴上不同标签。在取任务时，线程池根据当前总线程数和配置判断是否采用限时等待；`addWorker` 的布尔参数主要决定创建时按核心上限还是最大上限检查。

默认情况下，超过核心数量的空闲线程可以在 keepAliveTime 后退出；开启 `allowCoreThreadTimeOut(true)` 后，核心范围内的空闲线程也允许超时，此时 keepAliveTime 必须大于零。它让偶尔使用的线程池释放资源，但会带来下一次流量到来时重新创建线程的成本。

运行中可以调整核心数、最大数和空闲时间，但调整要满足 `0 <= corePoolSize <= maximumPoolSize`，且 maximumPoolSize 必须大于零。扩大核心数前先扩大最大数，缩小最大数前先缩小核心数。减少数量不会强杀正在执行的任务；更改这些参数也不会自动改变已有队列的容量。[ThreadPoolExecutor 参数与线程管理](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)

## 四、任务为什么先排队，再扩容

沿用上面的 2 / 4 / 2 配置，连续提交 A 到 G。为避免任务执行完改变现场，先让正在执行的任务等待同一个开关，直到观察结束才释放。

| 提交任务 | 提交后的现场 | 原因 |
| --- | --- | --- |
| A | 工作线程 1 执行 A | 线程数少于 core，尝试新建 |
| B | 工作线程 2 执行 B | 仍少于 core |
| C | C 进入队列 | 已达到 core，先尝试入队 |
| D | C、D 在队列中 | 队列还有容量 |
| E | 工作线程 3 执行 E | 队列已满，尝试按 max 扩容 |
| F | 工作线程 4 执行 F | 队列仍满，尚未达到 max |
| G | 抛出拒绝异常 | 队列满且工作线程已达到 max |

这里有一个很直观的现象：E、F 比 C、D 晚提交，却先开始执行。它们被作为新工作线程的首次任务直接执行，C、D 还在队列中。因此，队列是 FIFO，不代表整个线程池会严格按提交顺序开始执行。需要某个业务键严格串行时，要另外设计有序执行机制。

![普通线程池接收任务：新建、入队、扩容与拒绝的分支](/images/posts/java-threadpool-flow.svg)

图中的第二步使用 `offer` 尝试入队，不是使用 `put` 等待队列腾出位置。“用了阻塞队列”不等于提交线程会在这里阻塞。队列拒绝入队时，线程池才会继续尝试创建工作线程。

入队成功后还要复查：如果线程池已关闭，且能把刚入队的任务移除，就调用拒绝处理器；如果任务已经被其他工作线程取走，移除会失败，不能再把它当成仍在队列中的任务处理。如果队列中有任务却没有工作线程，则会尝试补一个不携带首次任务的工作线程，让它去队列取任务。

这样也能解释一个常见配置疑问：使用默认无界 LinkedBlockingQueue 时，达到 core 后任务通常都能入队，max 即使设置得很大也不会解决堆积。它不是完全失效，而是正常入队路径没有走到“入队失败后扩容”这一步。

`SynchronousQueue` 则不保存任务，只有能直接交接给等待者时 offer 才成功。交接失败后，线程池仍会尝试创建工作线程；创建也失败才拒绝。因此“没有消费者就立即拒绝”少说了一步。[SynchronousQueue 的交接语义](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/SynchronousQueue.html)

## 五、execute 与 submit：执行入口相近，结果和异常路径不同

`execute` 接收 Runnable，不返回 Future。`submit` 有三种常见形式：

```java
Future<?> a = pool.submit(() -> System.out.println("done"));
Future<String> b = pool.submit(() -> System.out.println("done"), "OK");
Future<Integer> c = pool.submit(() -> Integer.valueOf(42));
```

正常完成后，a.get() 返回 null，b.get() 返回预先提供的 "OK"，c.get() 返回 Callable 计算出的 42。第二种写法并不是从 Runnable 中提取返回值。

普通 ThreadPoolExecutor 继承的 submit，会通过 `newTaskFor` 把任务包装成默认的 `FutureTask`，再交给 execute。它没有一套绕过队列与拒绝策略的独立通道。[AbstractExecutorService 的默认提交实现](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/AbstractExecutorService.html)

![普通工作线程中的异常：直接执行与 FutureTask 包装后的不同路径](/images/posts/java-threadpool-results.svg)

### 异常发生在提交阶段，还是执行阶段

使用 AbortPolicy 时，任务根本进不去，execute 和 submit 都可能在调用方线程抛出 `RejectedExecutionException`。这属于提交失败，不能等着从 Future 里拿异常，因为调用方可能连 Future 都没拿到。

任务已经被工作线程接收，随后执行失败，是另一条路径。直接 execute 一个普通 Runnable，未捕获的 RuntimeException 或 Error 会使该工作线程异常退出，并进入未捕获异常处理器；线程池在状态与容量允许时会补工作线程。异常不会跨线程回到原先提交它的调用栈。

submit 默认包装的 FutureTask 会保存任务失败，工作线程通常可以继续执行其他任务。调用 `future.get()` 时抛出 `ExecutionException`，其 cause 是原任务异常。如果没人等待或检查这个 Future，业务层就可能没有感知到失败。

所以“submit 吞异常”只是现象的简称。准确的问题是：异常已经成为结果状态，却没有负责检查结果的人。反过来，execute 一个 FutureTask 也会走保存结果的路径；决定异常表现的不只是入口名字，还有实际运行的任务包装。

图描述的是普通工作线程执行场景。若拒绝处理器是 CallerRunsPolicy，任务可能直接在提交线程执行：普通 Runnable 的异常可能回到调用方，而 FutureTask 仍会保存异常。

### 等待超时、取消与线程内互等

`get(200, TimeUnit.MILLISECONDS)` 超时，只说明调用方没有在这段等待时间内得到结果，不会自动取消任务。排队或执行中的任务仍可能继续访问下游。调用方应根据业务期限决定是否取消，并设置实际网络操作的超时。

`cancel(true)` 会尝试中断正在执行的任务；中断是协作信号，不是强制终止。任务忽略中断、卡在不响应中断的操作中，仍可能继续。取消也不会撤销已发送的请求、已提交的数据库事务或其他外部副作用。[Future 的等待与取消契约](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Future.html)

还有一种容易误认为“线程数不够”的卡死：单线程池里，父任务提交子任务到同一个线程池，然后等待子任务的 Future。唯一的线程正在等待，子任务只能排队，双方无法前进。更大的有界线程池也可能在所有线程都执行这类父任务时出现同类问题。避免占用有限工作线程同步等待同池子任务，通常比盲目扩大线程数更可靠。

## 六、生产中的自定义线程池，要把结果观察也配好

多数业务说的“自定义线程池”，首先是显式创建和配置 ThreadPoolExecutor，而不是重新实现一套调度器。下面示例为某类下游查询建立独立线程池；8 / 16 / 64 都需要按实际容量和延迟预算调整。

```java
ThreadPoolExecutor recommendPool = new ThreadPoolExecutor(
    8, 16,
    30, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(64),
    namedFactory("product-recommend"),
    new ThreadPoolExecutor.AbortPolicy()
);

static ThreadFactory namedFactory(String prefix) {
    AtomicInteger sequence = new AtomicInteger();
    ThreadFactory defaults = Executors.defaultThreadFactory();
    return worker -> {
        Thread thread = defaults.newThread(worker);
        thread.setName(prefix + "-" + sequence.incrementAndGet());
        thread.setDaemon(false);
        thread.setUncaughtExceptionHandler((t, failure) ->
            System.err.println(t.getName() + " failed: " + failure));
        return thread;
    };
}
```

线程工厂接收的是工作线程要运行的 Runnable，负责返回一个尚未启动的线程；线程池负责启动它。给线程起业务名称，可以在日志和线程转储中区分库存、推荐、异步通知等任务。非守护线程有助于显式管理生命周期，但不关闭它们也可能阻止 JVM 退出。

`UncaughtExceptionHandler` 处理的是线程没有捕获的异常。它不能自动观察 submit 保存到 Future 中的失败。关键任务应由调用方检查结果；需要统一统计异步失败时，可以在 ThreadPoolExecutor 子类的 afterExecute 钩子中补充检查：

```java
@Override
protected void afterExecute(Runnable task, Throwable failure) {
    super.afterExecute(task, failure);
    if (failure != null) {
        // 本例交给线程的 UncaughtExceptionHandler，避免重复记录。
        return;
    }
    if (task instanceof Future<?> && ((Future<?>) task).isDone()) {
        try {
            ((Future<?>) task).get();
        } catch (CancellationException cancelled) {
            // 单独统计取消；它不等于执行失败。
        } catch (ExecutionException failed) {
            System.err.println("async task failed: " + failed.getCause());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
```

这段应放在子类内部，文末实验提供完整可编译的示例。默认 FutureTask 把异常保存在内部，所以 afterExecute 的 failure 参数可能为 null。先检查 isDone，可以避免在未完成的结果上等待，尤其是周期任务正常执行一次后，整个 Future 还没有结束。日志示例只是演示，实际需要接入业务指标与告警，并保证观察代码自身不抛异常、不卡住工作线程。[afterExecute 的异常说明](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html#afterExecute(java.lang.Runnable,java.lang.Throwable))

线程池通常应该在服务生命周期内复用。每次请求创建一个线程池，会重新支付创建成本，也让并发上限变成“每个请求各有一份”。同时，耗时和重要性不同的任务可以适度隔离：推荐变慢不应把库存查询所需的所有工作线程占满。但每拆一个池，都要核对它们合计消耗的资源。

请求上下文也需要单独治理。工作线程会复用，上一个任务留下的 ThreadLocal 值可能被下一个任务读到。应在提交时捕获必要上下文，在执行时安装，并在 finally 中清理或恢复旧值。不能靠线程工厂给每个任务传用户信息，因为工厂只在线程创建时运行。存在 CallerRuns 时，恢复旧值尤其重要，否则会破坏调用线程本来的上下文。可以结合本站 [ThreadLocal 文章](/posts/java-threadlocal-memory-leak/) 理解这个问题。

## 七、队列与拒绝策略，决定容量耗尽后的行为

先比较常见队列。这里的“无界”指没有实用的业务容量约束，不代表内存无限。

| 队列 | 是否保存等待任务 | 对普通线程池的影响 |
| --- | --- | --- |
| ArrayBlockingQueue(n) | 固定容量、FIFO | 满后尝试扩容，随后可能拒绝 |
| LinkedBlockingQueue(n) | 指定容量、FIFO | 可以有界；不传容量时上限为 Integer.MAX_VALUE |
| SynchronousQueue | 不保存任务，只交接 | 交接失败后尝试扩容 |
| PriorityBlockingQueue | 无界、按比较器排序 | 通常不因队列满扩容；低优先级任务可能长期等待 |

有界 FIFO 队列常用于需要限制积压的在线业务，但容量必须与任务大小、等待预算一起设置。优先级队列则需要定义任务比较方式；submit 的包装也可能改变实际入队的对象，不能只给原始 Runnable 实现比较接口就认为一定可用。[ArrayBlockingQueue 的容量契约](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ArrayBlockingQueue.html)

Executors 的默认配置也要看具体工厂：newFixedThreadPool 和 newSingleThreadExecutor 使用无界队列；newCachedThreadPool 使用 SynchronousQueue，最大线程数设置得非常大；定时线程池使用无界的延迟任务队列。这些选择各有用途，但在线服务需要明确资源边界时，显式配置通常更容易检查。[Executors 工厂方法](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Executors.html)

| 拒绝策略 | 具体行为 | 调用方必须知道的代价 |
| --- | --- | --- |
| AbortPolicy | 抛出 RejectedExecutionException | 调用方必须处理提交失败 |
| CallerRunsPolicy | 未关闭时由提交线程运行任务；关闭后丢弃 | 请求线程可能被拖慢；关闭后的 Future 可能不完成 |
| DiscardPolicy | 直接丢弃任务 | 不抛异常不代表接收成功 |
| DiscardOldestPolicy | 未关闭时移除队头，再尝试提交 | 队头未必是最早提交；被移除的 Future 未必完成 |

CallerRuns 可以让上游慢下来，这叫背压。但它并不是严格的业务并发限流器：十个调用线程都遇到饱和时，可能同时在池外执行任务，加上原有工作线程，总并发超过 maximumPoolSize。它也可能把慢查询带到 HTTP 请求线程或事件循环中。因此，不能只因为“不会丢任务”就默认选它。

Discard 与 DiscardOldest 对 Future 特别危险：submit 已经创建结果句柄，处理器却丢掉包装任务而不把它标记完成，get 就可能一直等待。DiscardOldest 移除的是队头；在优先级队列中，这可能反而移除最高优先级任务。没有等待容量的 SynchronousQueue 也不适合直接套用这种“移除再重试”的策略。

对可以降级的推荐查询，AbortPolicy 加明确的降级响应往往更好观察。对必须执行的订单通知，应先有可靠任务记录，再决定失败重试方式。自定义处理器可以记录拒绝原因或转交可靠系统，但不要把同一任务无限重投到已经饱和的线程池，也不要在处理器里进行无界阻塞。

## 八、延迟队列与定时线程池，解决的是另一种等待

前面的队列等待，是“暂时没有空闲执行容量”；延迟队列等待，是“任务还没到允许执行的时间”。订单三十分钟未付款后检查关闭，就属于后者，不能用线程 sleep 三十分钟占着工作线程等。

`DelayQueue` 保存实现了 Delayed 的元素，依据剩余延迟判断是否到期。队列非空时，poll 仍可能返回 null，因为没有到期元素；take 会等待到期。它本身是无界队列，不负责安排线程，也不保证业务任务持久化。[DelayQueue 的到期语义](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/DelayQueue.html)

不能简单给普通 ThreadPoolExecutor 换上 DelayQueue，就认为完成了定时调度。普通线程池新建工作线程时，可能直接运行 firstTask，绕过队列的到期检查；submit 默认生成的 FutureTask 也没有实现 Delayed。文末用“明天才到期”的任务验证了首次任务仍会立即执行。

ScheduledThreadPoolExecutor 会把任务包装成带触发时间的调度任务，放入内部 DelayedWorkQueue。这个队列是延迟优先队列，核心线程数决定主要执行容量，调大 maximumPoolSize 通常没有用。这是它与普通池“队列满后扩容”的根本区别。[固定版本的调度实现](https://github.com/openjdk/jdk17u/blob/jdk-17.0.16%2B8/src/java.base/share/classes/java/util/concurrent/ScheduledThreadPoolExecutor.java#L453)

![定时任务：到期执行、正常周期重排与异常终止](/images/posts/java-threadpool-schedule.svg)

```java
ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(
    2, namedFactory("order-check"),
    new ThreadPoolExecutor.AbortPolicy()
);
timer.setRemoveOnCancelPolicy(true);
timer.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
timer.setContinueExistingPeriodicTasksAfterShutdownPolicy(false);

ScheduledFuture<?> check = timer.schedule(
    () -> System.out.println("check order status"),
    5, TimeUnit.SECONDS
);
```

“五秒后执行”准确地说是“五秒后允许执行”。到期时如果工作线程都在忙，任务仍然要等；调度器没有实时性保证。订单检查也不能只相信入队时的状态，执行时仍应核对当前订单是否未支付，并保证关闭操作幂等。

周期任务有两种不同时间基准。scheduleAtFixedRate 按计划开始时刻推进，例如初始延迟后每隔十秒产生下一次计划；scheduleWithFixedDelay 则在上一次执行结束后再等十秒。同一周期任务的各次执行不会互相重叠；执行较慢时，固定频率任务可以晚于计划，不能保证准点。

周期任务如果抛出异常，后续执行会被抑制，失败保存在 ScheduledFuture 中。普通未捕获异常处理器未必能看到它。需要保留观察途径；如果某些业务异常可恢复，可以明确捕获并上报，再决定继续周期，但不能为了“永不停”而吞掉所有错误。

取消的延迟任务默认可能保留在队列中直到到期，setRemoveOnCancelPolicy(true) 用于及时移除。关闭时是否继续已有延迟任务、是否继续周期任务也应明确配置，避免服务准备退出，却还在等很远的触发时间。[定时线程池的调度与取消约定](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ScheduledThreadPoolExecutor.html)

重业务可以由小调度池触发，再交给有界业务池执行，但转交失败同样需要处理。对于订单过期这类重要事件，本地调度通常只能作为执行手段：恢复所需的订单或任务状态应持久化，进程重启后有扫描、重建或可靠事件机制。把几百万个未来任务放进无界内存延迟队列，也不会因为“不占睡眠线程”就没有内存风险。

## 九、生产参数怎么定：先确定资源与等待预算

“CPU 核数加一”可以作为某些计算任务的起点，不能当成规则。容器实际可用 CPU、任务计算成本、其他线程的竞争都会影响结果。阻塞型任务增加线程能提高资源利用，但仍要看数据库连接池、HTTP 连接数和下游承载能力。

假设推荐客户端只有八个可用连接，却配置十六个并发工作线程，一部分线程可能只是在等连接。继续加线程不一定缩短请求时间。多个实例同时扩容时，还要核对它们合计给下游带来的并发，而不是只看单实例线程池。

队列容量应从可接受等待时间倒推。假设详情请求总预算 200 毫秒，下游执行预留 150 毫秒，留给排队及其他开销的空间已经很小。若稳定情况下吞吐为每秒 800 次，平均排队 50 毫秒，对应平均等待任务数约为 40。这个计算用于建立量级感，不代表“容量设置 40 就保证 p99 达标”，更不能忽略突发流量与长尾耗时。

即使队列只有一个任务，如果全部工作线程都被慢请求占住，它仍然可能等很久。应记录提交时间或截止时间，在开始执行时判断是否已经过期，避免请求早已返回，后台才开始无意义的下游查询。网络超时、任务期限、Future 等待超时与空闲线程回收时间是四件不同的事。

至少观察工作线程数、活跃数、队列长度、拒绝数，以及排队时长、执行时长、成功率、取消数和请求最终延迟。getActiveCount 等统计是近似值，不应用它们做精确准入判断；getCompletedTaskCount 也不等于业务成功数，失败任务同样可能完成其执行过程。

验证配置时需要覆盖正常流量、突发流量、下游变慢以及恢复过程。正常吞吐足够，并不能证明下游故障时不会拖垮请求线程。还要确认拒绝后的响应、取消后的残留任务、队列清空所需时间和告警是否真的可见。

## 十、优雅停机，以及线程什么时候退出

先停止业务入口继续生产任务，再调用 shutdown：它停止接收新任务，允许已接收任务继续完成。awaitTermination 用于等待结束，本身不会发起关闭。

shutdownNow 会尝试中断正在运行的任务，并返回未执行的队列任务；它不能强制杀死线程。对于普通 ThreadPoolExecutor，返回的 FutureTask 也不会因为被取出队列就自动取消，调用方应处理其结果状态与业务补偿。

```java
pool.shutdown();
try {
    if (!pool.awaitTermination(10, TimeUnit.SECONDS)) {
        for (Runnable pending : pool.shutdownNow()) {
            if (pending instanceof Future<?>) {
                ((Future<?>) pending).cancel(false);
            }
            // 关键业务还应记录未执行任务，按业务约定补偿。
        }
        if (!pool.awaitTermination(5, TimeUnit.SECONDS)) {
            System.err.println("pool still has running tasks");
        }
    }
} catch (InterruptedException interrupted) {
    for (Runnable pending : pool.shutdownNow()) {
        if (pending instanceof Future<?>) {
            ((Future<?>) pending).cancel(false);
        }
    }
    Thread.currentThread().interrupt();
}
```

这个等待时间只是示例，应与部署停机期限配合。最后一次等待仍超时，就不能宣称任务全部停止。正在执行的写操作也不能仅凭中断信号判断是否成功，应结合业务状态核对。

工作线程的退出有两类常见原因：任务异常导致退出，或取任务阶段发现应该回收。正常执行完任务后，runWorker 会再次调用 getTask；需要保留的空闲线程等待新任务，允许超时的线程限时等待，符合退出条件时结束循环。keepAliveTime 约束的是这段空闲等待，不是 task.run 的执行时长。

线程池状态可以用一个小表记住，不必先研究位运算：

| 状态 | 是否接收新任务 | 对已有任务的处理 |
| --- | --- | --- |
| RUNNING | 是 | 正常执行和取队列任务 |
| SHUTDOWN | 否 | 继续处理已接收任务 |
| STOP | 否 | 不再消费队列，尝试中断工作线程 |
| TIDYING | 否 | 工作线程已退出，执行终止钩子 |
| TERMINATED | 否 | 终止钩子执行完毕 |

实现补充：OpenJDK 用原子整数 ctl 的高 3 位保存状态，低 29 位保存工作线程数，使并发更新可以协调地检查这两部分。理解行为时，知道它代表“状态 + 线程数量”就够了。tryTerminate 检查能否完成终止，并在需要时唤醒空闲线程推进收尾；它本身不负责补建线程。关闭后仍有队列任务时，允许补工作线程的逻辑在其他工作线程管理路径中。

## 十一、用可运行实验验证，而不只背结论

仓库中的 [ThreadPoolBehaviorChecks.java](https://github.com/king-of-water/personal-blog/blob/main/scripts/experiments/ThreadPoolBehaviorChecks.java) 使用同步门闩固定现场，不靠“睡一会儿猜任务已经开始”。所有等待有超时，测试结束会关闭线程池。可在仓库根目录运行：

```sh
javac -d /tmp scripts/experiments/ThreadPoolBehaviorChecks.java
java -cp /tmp ThreadPoolBehaviorChecks
```

实验覆盖：核心线程按需创建与预启动；2 / 4 / 2 配置的入队、扩容和拒绝；无界队列为何不触发正常扩容；execute 与 submit 的异常、工作线程替换和 afterExecute 观察；CallerRuns 的执行位置与关闭后丢弃；Discard 留下未完成 Future；周期异常停止与取消移除；普通线程池绕过延迟到期检查；shutdownNow 返回的任务需要显式取消。

这些是机制验证，不是容量压测。它们不能证明十六个线程适合某个真实接口，也不能模拟进程崩溃后的可靠恢复。

回到最初的商品详情请求：推荐任务提交失败时，调用方明确降级；成功提交后，协调方保存 Future，并在请求预算内等待结果；任务开始前检查是否已经过期，下游调用使用自己的超时；失败与取消被分别记录；服务停机时停止入口，处理未执行任务并等待工作线程退出。线程复用只负责其中一部分，其余约束需要配置与业务代码共同完成。

## 参考资料

- [OpenJDK 17.0.16：ThreadPoolExecutor 固定版本源码](https://github.com/openjdk/jdk17u/blob/jdk-17.0.16%2B8/src/java.base/share/classes/java/util/concurrent/ThreadPoolExecutor.java)
- [Java 17：ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)、[AbstractExecutorService](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/AbstractExecutorService.html)
- [Java 17：ThreadFactory](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadFactory.html)、[Future](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Future.html)、[Executors](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Executors.html)
- [Java 17：ScheduledThreadPoolExecutor](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ScheduledThreadPoolExecutor.html)、[DelayQueue](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/DelayQueue.html)
