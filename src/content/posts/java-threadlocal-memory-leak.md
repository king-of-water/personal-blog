---
title: ThreadLocal：请求上下文、线程复用与内存残留
description: 从请求用户信息串用出发，解释 ThreadLocal 的用途、独立存储与对象共享、ThreadLocalMap 的引用链、remove 与初始化、嵌套恢复和异步传播，再结合线性探测与清理机制验证生产中的边界。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 60
featured: true
publishedAt: 2026-06-10T20:47:00+08:00
updatedAt: 2026-10-06T12:26:00+08:00
tags: [Java, ThreadLocal, 请求上下文, 线程池, ThreadLocalMap, 内存泄漏, 异步传播, InheritableThreadLocal]
tools:
  - name: documd-visuals
    href: /toolbox/#documd-visuals
  - name: humanizer
    href: /toolbox/#humanizer
---

请求 A 已经处理完，请求 B 的日志里却出现了 A 的用户 ID。检查全局变量没有发现赋值错误，用户信息放在 ThreadLocal 里，看起来也是“线程私有”的。真正的问题在于：两次请求使用了同一个工作线程，A 结束时没有清理，B 又在没有安装新上下文的路径上读取了旧值。

另一种现象是内存持续占用。业务不再使用某个对象，它却仍被工作线程的 ThreadLocalMap 引用。这里可能发生了弱引用 key 被回收，也可能 key 一直有效。把所有问题都归结为“弱引用导致泄漏”，会漏掉后一种情况，更无法解释用户信息串用。

本文的问题是：怎样让上下文跟随正确的请求，又不把它留给后续任务？先解释用途和使用边界，再从线程复用走到引用链、清理和异步传播。API 依据 Java 17 官方文档，内部机制依据固定版本的 [OpenJDK 17.0.16 ThreadLocal 源码](https://github.com/openjdk/jdk17u/blob/jdk-17.0.16%2B8/src/java.base/share/classes/java/lang/ThreadLocal.java)。可运行实验使用本机 OpenJDK 11，验证共同的公开行为；实验不依赖 GC 恰好在某个时间发生。

## 一、为什么用 ThreadLocal：让同线程中的多层调用访问上下文

一个订单请求经过入口、业务服务、数据库访问和日志组件。入口完成认证后获得用户 ID，生成链路标识 Trace ID，后面多层调用都需要使用这些信息。

最直白的方式是通过参数传递。依赖清楚、容易测试，也容易看出某个函数需要哪些信息。代价是一些只负责转发的方法也要携带上下文参数。ThreadLocal 提供另一种选择：把值绑定到当前线程，同一线程中的下层代码从约定入口读取，不必逐层传参。

这种便利也带来隐藏依赖。一个方法签名不接收用户 ID，却在内部读取 ThreadLocal，测试与调用方就必须知道怎样建立上下文。如果需要让核心业务逻辑脱离线程环境运行，显式参数通常更合适；ThreadLocal 更适合由基础设施统一管理的日志上下文、调用范围内状态等。

它与 synchronized 或锁解决的问题不同。锁协调多个线程对同一份状态的访问，ThreadLocal 为不同线程维护各自的绑定。给库存数量套上 ThreadLocal，不会得到正确的全局库存；每个线程只会看到自己绑定的值。

这里还要区分线程生命周期与请求生命周期。在线服务的工作线程可以处理许多请求。ThreadLocal 只认识当前 Thread，不知道哪个 HTTP 请求刚刚开始，也不会收到“这个请求已经完成”的自动清理通知。请求入口或任务包装层必须管理这段范围。

本文的请求上下文只包含不可变的用户 ID 与 Trace ID，不携带完整请求、响应对象或数据库连接。用户 ID 应来自已经验证的身份，不能因为某段代码把字符串放进 ThreadLocal，就认为权限校验已经完成。

## 二、独立的是存储位置，不保证 value 对象互不共享

一个 ThreadLocal 对象通常作为稳定的访问入口，例如一个类里的 static final 字段。不同线程用同一个入口，各自找到自己的存储位置。ThreadLocal 并不是“给每个线程复制一份对象”的深拷贝工具。

```java
ThreadLocal<List<String>> local = new ThreadLocal<>();
List<String> shared = new ArrayList<>();

local.set(shared);
// 如果另一个线程也 local.set(shared)，两边绑定的是同一个列表。
```

两张线程表可以指向同一对象。此时对 shared 的并发读写仍然需要同步，或者改成各线程使用独立对象。ThreadLocal 不会替 ArrayList 获得线程安全。

`ThreadLocal.withInitial(ArrayList::new)` 可以让各线程首次访问时各自创建列表，因为每次初始化调用都执行 new。如果 Supplier 返回同一个全局列表，则仍然共享。判断是否隔离，要看 value 是怎样创建和传入的，不能只看变量类型。

普通 ThreadLocal 的 set/get/remove 都针对调用它们的当前线程。在请求线程调用 remove，清理的是请求线程自己的绑定，不能顺便清掉异步工作线程的表。线程名相同也不代表同一个 Thread；演示线程复用时应比较实际执行线程，而不是根据日志时间猜测。

这也解释了异步调用中常见的“上下文丢失”：请求线程设置了值，另一个工作线程直接 get，并没有这份绑定。问题与可见性关键字 volatile 无关。两边访问的是不同的存储位置，加锁或设置 volatile 都不会自动把值搬过去。[ThreadLocal API](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/ThreadLocal.html)

## 三、复现请求串用：key 没被回收，问题也会发生

用单线程池保证两次任务复用同一个工作线程。第一个任务设置用户，第二个任务模拟没有安装上下文就读取用户的路径。两个 Future 顺序等待，保证观察顺序，不依靠 sleep。

```java
ThreadLocal<String> user = new ThreadLocal<>();
ExecutorService worker = Executors.newSingleThreadExecutor();
try {
    worker.submit(() -> user.set("user-A")).get();
    String observed = worker.submit(() -> user.get()).get();
    System.out.println(observed); // user-A，而不是“没有当前用户”
} finally {
    worker.shutdown();
    worker.awaitTermination(5, TimeUnit.SECONDS);
}
```

例子中 user 仍有强引用，没有任何 GC 前提。任务 A 已完成，但工作线程没有结束，绑定也没有结束。任务 B 如果直接把 observed 当作当前用户，就可能做出错误的日志归属或权限决策。

![同一工作线程处理两个请求：未清理与 finally 清理的差别](/images/posts/threadlocal-request-reuse.svg)

不是每个后续请求都会立刻暴露问题。如果 B 在任何读取之前设置自己的上下文，旧值会被覆盖。但异常分支、跳过入口的内部任务、匿名请求以及提前读取的日志，都可能打破这个条件。修复应建立完整的范围约定，而不是希望每个调用者总会先 set。

在顶层请求边界，通常是安装上下文，执行处理，然后在 finally 中 remove：

```java
user.set("user-A");
try {
    // 日志、服务调用等同线程代码可以读取当前用户。
    handleRequest();
} finally {
    user.remove();
}
```

finally 覆盖的是正常返回、业务异常等退出路径。只在正常返回前写 remove，异常时仍会遗留。若中途切换到另一个线程，该线程上的安装与清理必须另行负责。

ThreadLocal 只负责保存绑定，不能推断 handleRequest 有没有启动尚未结束的子任务，也不能把上下文范围延伸到网络服务。关于任务异常与工作线程复用，可以结合本站 [线程池文章](/posts/java-threadpool-executor-params-rejection/) 阅读。

## 四、值到底放在哪里：Thread、Map、Entry 与引用链

在 OpenJDK 实现中，Thread 有普通线程局部变量表 threadLocals，以及继承用的 inheritableThreadLocals。普通 ThreadLocal.set 会找到当前 Thread 的表，以当前 ThreadLocal 对象作为 key 保存值；如果还没有表，则按需建立。它并不把所有线程的值集中存入 ThreadLocal 自己。

ThreadLocalMap 是专门的哈希表，其 Entry 继承 WeakReference：弱引用的目标是 ThreadLocal key，Entry.value 则普通地强引用业务对象。可以把它概括成两条路径：

- 工作线程 → ThreadLocalMap → Entry 数组 → Entry → value：强引用路径。
- Entry → ThreadLocal key：弱引用路径。

![工作线程到 value 的强引用链，以及 Entry 到 key 的弱引用](/images/posts/threadlocal-retention-paths.svg)

弱引用的目的，是允许不再被业务强引用的 ThreadLocal 对象被回收，避免线程表自己一直保住这个访问入口。它没有把 value 变成弱引用。GC 清掉 key 后，Entry 仍在数组中，value 仍可能从工作线程到达。

一个 key 已清空、但 Entry 还在的槽位，源码称为 stale entry，本文称“失效条目”。ThreadLocalMap 没有使用引用队列在 GC 后立即删除条目，而是在后续访问和容量管理过程中清理。源码注释明确说明了这一实现边界。[Entry 与失效条目设计](https://github.com/openjdk/jdk17u/blob/jdk-17.0.16%2B8/src/java.base/share/classes/java/lang/ThreadLocal.java#L291)

线程还活着，不代表 value 必然一直保留。remove、覆盖赋值或失效条目清理都可能切断这条路径。线程结束后，这份线程表也会被释放；value 能否最终被回收，还要看其他地方有没有引用。应当分析完整的可达关系，而不是把“线程不死，value 不散”当成规则。

## 五、两类残留：有效 key 与失效 key 要分开看

第一类是 key 仍然有效，业务值已经过期。典型情况是 static final ThreadLocal 作为长期入口，工作线程在请求结束后仍保留大对象。这条目不是 stale，自动清理 stale entry 的代码不会把它认作垃圾。只有业务覆盖、清理或其他生命周期处理，才能释放这条绑定对旧值的引用。

这里不一定表现为内存无限增长。只有一个 ThreadLocal、一个固定线程时，可能只是长期保留最后一次请求的数据。许多线程、多个入口或 value 内持续累积集合时，影响会变大。用户串用也可能在占用很小的情况下发生，不能只用堆内存指标判断有没有问题。

第二类是 key 已失效，value 还在。动态创建的 ThreadLocal 失去强引用后，GC 可以清空 Entry 的弱引用 key，但 value 没有随之立即被清掉。如果该线程长期空闲，或者后续访问没有触发相关清理，残留可能持续很久。

“这个 ThreadLocal 不再被访问，所以条目永远无法清理”是不准确的。同一工作线程操作其他 ThreadLocal，也可能在探测或清理过程中遇到它。反过来，线程频繁调用某个直接命中的 get，也不代表整张表会被扫描。清理是否发生，要看实际执行的路径。

还有一个边界：如果 value 对象自己直接或间接强引用 key，就可能形成线程 → Entry → value → ThreadLocal 的强路径。此时 Entry 到 key 的弱引用并不能让 key 回收。判断弱引用效果前，需要检查所有强引用，而不是只看 Entry 的声明。

排查时可以从长寿命工作线程沿 threadLocals 和 Entry.value 找到保留对象，确认 key 是有效还是已失效，再结合任务结束时间判断对象是否仍有用途。强引用路径存在是证据，但对象仍在使用、缓存有明确容量等情况不能直接定性为泄漏。恢复措施也要说明责任：谁创建这份绑定，谁结束范围，谁检查异常退出路径。

## 六、remove、set(null) 与再次初始化

set(null) 会让当前绑定的 value 变成 null，因此可以断开旧对象的这条引用。但 Entry 仍然存在，语义是“当前线程已经设置过，值就是 null”。remove 删除当前线程的绑定，后续 get 若没有中间 set，会重新初始化。

```java
AtomicInteger sequence = new AtomicInteger();
ThreadLocal<Integer> local =
    ThreadLocal.withInitial(sequence::incrementAndGet);

System.out.println(local.get()); // 1
local.set(null);
System.out.println(local.get()); // null，不重新调用 Supplier
local.remove();
System.out.println(local.get()); // 2，重新初始化
local.remove();
```

如果使用默认 ThreadLocal，初始值也是 null，两条路径的打印结果可能一样，但内部是否存在绑定不同。仅用“get 返回 null”不能判断 remove 有没有执行。[初始化与 remove 契约](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/ThreadLocal.html#remove())

另一个容易混淆的地方是：没有绑定时，get 不只是查询，它还会调用 initialValue，并把结果建立为当前线程的绑定。withInitial 可以创建新对象，普通 get 也可能建立一个 value=null 的条目。需要明确初始化有没有副作用，不能把它当成一个始终无成本的存在性检查。

对于最外层请求边界，结束时 remove 很合适。但嵌套范围内，外层上下文可能仍然要使用。例如外层 Trace ID 为 outer，内部临时切换成 inner；内部结束后，应恢复 outer，不能直接 remove 后让外层失去状态。

下面先给本文的上下文明确一个约定：只存非 null 的不可变 RequestContext，null 表示没有活动上下文。这样就能用读取到的 null 判断恢复时应该 remove 还是 set；它不适用于允许 null 本身代表有效业务值的通用 ThreadLocal。

```java
static final ThreadLocal<RequestContext> CURRENT = new ThreadLocal<>();

static void install(RequestContext context) {
    if (context == null) CURRENT.remove();
    else CURRENT.set(context);
}

static Runnable withContext(RequestContext context, Runnable action) {
    return () -> {
        RequestContext previous = CURRENT.get();
        install(context);
        try {
            action.run();
        } finally {
            install(previous);
        }
    };
}
```

previous 为 null 时，最后 remove 也会清掉 get 可能创建的 null 条目。previous 非 null 时，恢复原值，保留外层范围。这个帮助函数的完整类定义和测试在文末实验中；它没有扫描所有 ThreadLocal，只管理 CURRENT 这一项。

## 七、跨线程传播：提交时捕获，执行时安装，结束时恢复

请求线程的 ThreadLocal 不会自动传播到线程池工作线程。异步任务可能等到请求早已结束才开始，甚至在别的请求已经进入后才执行。正确的捕获时机，是创建任务包装或提交任务时，而不是在工作线程开始执行时再去读取“请求线程的当前值”。

![异步上下文：提交时捕获，执行时保存旧值并安装，finally 恢复](/images/posts/threadlocal-context-transfer.svg)

沿用上一节的包装器：

```java
RequestContext captured = CURRENT.get(); // 在提交方线程读取
Runnable task = withContext(captured, () -> {
    // 在实际执行线程中，CURRENT 已安装 captured。
    System.out.println(CURRENT.get().traceId);
});
pool.execute(task);
```

这里假设调用点一定有非 null 上下文；可被后台或匿名任务调用的接口，应定义缺失上下文的行为，不能直接解引用。captured 指向的是已经构造好的不可变上下文。若捕获完整可变请求对象，提交后请求线程还可能修改它，既有数据竞争，也可能把大型对象留在排队任务中。

上下文恢复代码要放在实际执行任务的 finally 中。调用方 Future.get 超时或发出 cancel，并不表示执行线程已经退出，不能在调用方替工作线程清理。任务在队列中尚未执行时，包装器仍持有 captured；清理 ThreadLocal 也不会清掉队列对象里的引用。排队容量、超时、取消和任务移除仍属于线程池治理。

如果拒绝策略是 CallerRuns，任务可能在提交线程直接执行。保存并恢复 previous 的包装器能保留调用方原来的上下文；简单地“结束就 remove”则可能破坏仍在处理请求的调用线程。拒绝且没有执行的任务不会安装这份上下文，但持有任务的队列、重试记录或其他集合仍可能保留快照。

包装器只影响被包装的任务。任务内部再提交另一个未包装任务，或某个框架自行选择执行线程，传播仍然可能断开。对于多种执行器，需要在约定边界统一处理，避免有的任务捕获、有的任务遗漏；同时避免多层包装重复安装、相互覆盖。

选择策略时，显式传递 RequestContext 是最容易看到依赖的方式。ThreadLocal 包装适合同步接口已经依赖当前上下文的代码。无论选择哪种，传播的数据应当最小化，并有明确的失效期限；不能把一次请求中的事务连接当作可任意跨线程共享的上下文。

## 八、InheritableThreadLocal：继承发生在创建线程时

InheritableThreadLocal 在创建子线程时，根据父线程当时的绑定计算子线程初始值。默认 childValue 返回父线程原来的 value；可以覆写它生成不同值或复制对象。因此，复制了映射结构不等于深拷贝了业务对象。[官方继承与 childValue 说明](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/InheritableThreadLocal.html)

默认情况下，父子线程绑定同一个可变列表时，子线程修改列表，父线程可能观察到变化。父线程随后 set 另一个列表，则只是替换自己的绑定，子线程仍持有原列表。这两种操作的区别，是“修改共享对象”和“更换存储位置里的引用”。

线程池的工作线程一般会被重复使用。假设请求 A 在提交时触发了首次工作线程创建，工作线程可能继承 A；随后请求 B 更新了提交线程中的值，再把任务交给已有工作线程，这次并没有创建线程，也就不会重新继承 B。线程池预启动、工厂选择不继承等情况，又可能让初始结果不同。

因此，InheritableThreadLocal 不适合作为通用的线程池请求传播方案。它的时间基准是线程创建，业务希望的时间基准通常是每次任务提交。前一节的任务快照与执行范围，才是在这两个时间基准之间建立明确关系。

创建子线程时是否继承还可以被关闭；即便继承成功，子线程的生命周期也可能远长于父请求。必须明确子任务何时完成，是否允许保留用户信息，以及它结束时怎样释放。父线程 remove 只清理父线程，不能撤销已经传给子线程的引用。

## 九、源码补充：线性探测与清理为何绑在一起

ThreadLocalMap 使用 Entry 数组与线性探测。初始位置由 threadLocalHashCode 与数组长度计算；槽位被其他 key 占用时，沿数组继续找，到末尾绕回开头。查找遇到空槽就结束，因此删除一个冲突链前面的条目后，需要重新安置后续条目，避免查找过早停止。

例如 A、B 都映射到槽位 3，A 放在 3，B 探测后放在 4。删除 A 后，如果只是把 3 清空，查找 B 从 3 开始会立刻认为不存在。expungeStaleEntry 清理失效条目的 value 和数组槽位，再处理后续连续非空区间中的条目，把仍有效的绑定重新放进能够被找到的位置。

set 有三个重要分支：找到同一个 key 则覆盖 value；遇到失效条目则调用 replaceStaleEntry；遇到空槽则插入新 Entry。replaceStaleEntry 不只是“把一个空 key 替换掉”，还需要检查附近的探测区间是否已有同一个 key，避免产生重复绑定，并处理区间中的其他失效条目。

get 直接命中有效 key 时，走快速返回路径，不会因此顺便全表打扫。未直接命中时才继续探测，可能触发失效条目清理。完整的公开 get 还包括没有绑定时的初始化，不能把内部 getEntry 的代码当成全部 get 行为。

| 清理入口 | 做什么 | 不能据此假定什么 |
| --- | --- | --- |
| get 的未命中探测 | 清理遇到的失效条目 | 每次 get 都清理全表 |
| set / replaceStaleEntry | 更新、插入时处理相关区间 | 覆盖一个有效 key 必然扫到其他残留 |
| cleanSomeSlots | 按启发式预算扫描部分槽位 | 整个过程最坏只花 O(log n) |
| rehash | 先全表清理，再决定扩容 | 一到插入阈值就无条件翻倍 |
| remove | 删除当前 key 的绑定并修复探测区间 | 替其他线程清理，或清掉所有 ThreadLocal |

cleanSomeSlots 在没有遇到失效条目时采用对数级扫描预算；遇到失效条目会重新增加扫描预算，并调用可能遍历更长冲突区间的 expungeStaleEntry。所以“扫描预算是对数级”不能直接写成“总运行时间最坏为 O(log n)”。

表长度为 2 的幂，插入阈值大致为长度的 2/3。rehash 先清理，再使用比插入阈值更低的判断线决定是否翻倍。这是控制装载与清理成本的实现细节，不应把阈值解释成已经得到官方证明的“专门给清理预留空间”。

散列常数 HASH_INCREMENT=0x61c88647 是 1640531527，除以 2³² 约为 0.381966，而不是 0.618。连续创建的 ThreadLocal 以这个增量分配内部散列值，在 2 的幂长度表中错开起始槽位；它不保证任意使用集合都没有冲突。应用代码通常没有必要复制这套散列实现，也不能用它替代生命周期管理。

以上路径对应固定版本的 [ThreadLocalMap 实现](https://github.com/openjdk/jdk17u/blob/jdk-17.0.16%2B8/src/java.base/share/classes/java/lang/ThreadLocal.java#L406)。内部结构解释“为什么需要这些动作”，公开 API 契约才是业务代码应依赖的边界。

## 十、把一个请求从入口检查到异步任务结束

订单请求进入后，先完成身份验证，再创建小型不可变上下文。入口安装 CURRENT，同线程里的日志与服务读取它。如果启动异步任务，提交方在此时捕获快照；异步任务执行时保存旧值、安装快照，退出时恢复。入口自己的 finally 负责结束请求线程上的范围。

如果处理抛异常，入口仍应清理；如果异步任务抛异常，任务包装仍应恢复，失败交给 Future 或执行器的观察机制。若任务根本被拒绝，调用方处理提交失败，不把“未执行”当作成功。取消或超时后，应分别核对任务是否还在运行、队列是否还保存包装对象，不能只检查当前线程 get 是不是 null。

可以用下面几项确认实现，而不是只检查代码里有没有 remove：

| 检查位置 | 要验证的结果 |
| --- | --- |
| 同线程连续两个请求 | 后一个不能读取前一个的用户 |
| 请求处理抛异常 | finally 后没有遗留当前请求上下文 |
| 嵌套临时上下文 | 内层结束后恢复外层 |
| 预启动的工作线程 | 未传播时没有请求值，传播后值正确 |
| CallerRuns 执行路径 | 任务结束后保留提交线程原上下文 |
| 可变 value | 不把绑定隔离误当成对象线程安全 |
| 排队和取消 | 包装任务里的快照也有生命周期约束 |

仓库提供 [ThreadLocalBehaviorChecks.java](https://github.com/king-of-water/personal-blog/blob/main/scripts/experiments/ThreadLocalBehaviorChecks.java)，包含本文帮助函数与八组确定性验证。所有跨线程结果等待都有超时，测试结束关闭线程池。可在仓库根目录运行：

```sh
javac -d /tmp scripts/experiments/ThreadLocalBehaviorChecks.java
java -cp /tmp ThreadLocalBehaviorChecks
```

实验验证公开行为和范围管理，没有通过反射访问 JDK 内部表，也不把 System.gc 当成回收保证。因此，它不声称复现了某个稳定的 GC 时间；失效 key 的保留与清理路径由固定源码取证。真实内存问题仍需结合线程生命周期、堆引用和业务对象用途分析。

本文的使用约定可以概括为：每份上下文有明确的拥有者与结束范围；只有必要的小型数据跨任务传播；清理发生在实际拥有绑定的线程中；内层范围恢复外层值。ThreadLocalMap 的弱引用和惰性清理提供实现上的回收机会，不能代替这些业务约定。

## 参考资料

- [Java 17：ThreadLocal](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/ThreadLocal.html)
- [Java 17：InheritableThreadLocal](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/InheritableThreadLocal.html)
- [OpenJDK 17.0.16：ThreadLocal 与 ThreadLocalMap 固定版本源码](https://github.com/openjdk/jdk17u/blob/jdk-17.0.16%2B8/src/java.base/share/classes/java/lang/ThreadLocal.java)
