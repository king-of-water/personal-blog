---
title: ThreadLocal：线程私有变量与内存泄漏
description: 拆解 ThreadLocal 的原理——每个 Thread 内部有个 ThreadLocalMap，key 是弱引用的 ThreadLocal、value 是强引用的值，说清线程私有变量怎么实现，以及为什么 key 被 GC 后 value 会残留造成内存泄漏、该怎么用 remove 避免。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 60
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, ThreadLocal, ThreadLocalMap, 弱引用, 内存泄漏, 线程私有, InheritableThreadLocal]
---

一个很常见的需求：把"当前登录用户""当前请求上下文""数据库连接"这类数据，在同一个线程的整条调用链里随手可取，又不想一层层传参、也不想为它加锁。`ThreadLocal` 就是为这个需求设计的——它给每个线程一份独立的变量副本，线程内随意读写、线程间互不干扰。

但 `ThreadLocal` 有个著名的坑：用不好会**内存泄漏**，尤其在线程池场景下。这个坑的根源藏在它的实现里——`ThreadLocal` 的值不是存在 `ThreadLocal` 对象里，而是存在每个 `Thread` 自己的一张表里，key 还是个弱引用。

本文回答一个问题：`ThreadLocal` 的线程私有是怎么实现的，内存泄漏到底怎么发生、怎么避免。它建立在上一篇锁和 JMM 的认知之上——线程私有的变量天然无竞争，不需要锁。

## 一、ThreadLocal 是什么：每个线程一份副本

`ThreadLocal<T>` 的用法很简单：`set(value)` 存、`get()` 取、`remove()` 删。神奇之处在于，同一个 `ThreadLocal` 对象，在不同线程里 `get()` 到的是各自 `set` 的值，互不干扰。

```java
ThreadLocal<String> userId = new ThreadLocal<>();

// 线程 A 里 set "alice"，线程 B 里 set "bob"
userId.set(currentUser);   // 各自存各自的
String u = userId.get();    // 各自取各自的
```

它解决的问题是"线程私有状态"。本来一个线程的私有状态，用局部变量就能存，但局部变量跨不了方法——`userId` 想在 `serviceA` 里 set、在 `serviceB` 里 get，中间隔着好几层调用，用局部变量就得一路传参。`ThreadLocal` 相当于一个"跟着线程走的全局变量"，省掉了传参。

它也天然无并发问题：既然每个线程一份副本，就不存在多线程写同一个变量的竞争，不需要锁。这是它和"用共享变量 + 加锁"的根本区别——`ThreadLocal` 是"隔离"而不是"同步"。

## 二、原理：值存在 Thread 的 ThreadLocalMap 里

`ThreadLocal` 最反直觉的一点是：**值不是存在 `ThreadLocal` 对象里的**。每个 `Thread` 对象内部有一个 `threadLocals` 字段，类型是 `ThreadLocal.ThreadLocalMap`，一张自定义的哈希表。`ThreadLocal.set(v)` 的实际动作是：

```text
Thread.currentThread().threadLocals.set(this, v)
```

也就是"拿当前线程的那张表，以这个 `ThreadLocal` 对象作 key，把 v 存进去"。`get()` 同理，用 `this` 作 key 从当前线程的表里查。

![ThreadLocal 的值存在每个 Thread 自己的表里](/images/posts/java-threadlocal-structure.svg)

这张图解释了"线程私有"是怎么实现的：不是 `ThreadLocal` 有多份，而是同一个 `ThreadLocal` 对象作为 key，在不同线程的 `ThreadLocalMap` 里映射到不同的 value。value 跟着线程走，线程结束、表被回收，value 也一起回收。

关键在一个细节：`ThreadLocalMap` 的 Entry 继承自 `WeakReference<ThreadLocal>`，也就是说 **key（ThreadLocal 对象）是弱引用，value（存的值）是强引用**。这个不对称，是内存泄漏的根源。

## 三、内存泄漏：key 没了，value 还在

弱引用的语义是：一个对象只被弱引用指向时，GC 会把它回收。所以 `ThreadLocal` 对象（key）一旦没有被外部强引用，就会被 GC 回收——这本身是好的，避免 `ThreadLocal` 对象长期占用。

但问题出在 value 上。key 被回收后，`ThreadLocalMap` 里留下一个"key 为 null、value 还在"的 Entry，而 value 是强引用，它还被这张表指着。只要**线程还活着**，`Thread` → `threadLocals` → Entry → value 这条强引用链就不断，value 就回收不了。

![key 被回收后，value 残留造成泄漏](/images/posts/java-threadlocal-leak.svg)

在普通"线程跑完就死"的场景下，线程结束、整张表一起回收，泄漏窗口很短。但**线程池**会放大这个坑：线程池里的线程长期存活、反复复用，第一个任务 `set` 了一个大对象、用完没 `remove`，这个对象就跟着线程一直活着，第二个、第三个任务不断累积，内存越涨越高——这就是 `ThreadLocal` 内存泄漏最典型的现场。

所以结论是：**用完 `ThreadLocal` 必须 `remove()`**。`remove()` 会把这个 key 对应的 Entry 从 `ThreadLocalMap` 里删掉，value 的强引用断开，才能被 GC。尤其在线程池里，`remove` 不是可选项，是必须项。

两个补充能让"泄漏"的定性更准确。第一，key 之所以设计成弱引用，是为了让 `ThreadLocal` 对象本身在不再被业务引用时能被 GC 回收，而不是被 map 永久抓着。第二，key=null 的残留 Entry 并非完全无人管——`ThreadLocalMap` 在后续 `get`/`set` 时会顺便做惰性清理（`expungeStaleEntry`）。但这个清理是"碰巧路过才清"，不及时、也不彻底（一直不访问这个 `ThreadLocal` 就永远不清），所以不能指望它兜底，`remove` 才是正解。这解释了为什么"内存泄漏"不是"必然马上 OOM"，而是"在『不用 remove + 线程长期存活 + 频繁 set 大对象』的组合下，内存持续上涨"。

## 四、怎么用对

正确用法是 `try/finally` 里 `remove`：

```java
try {
    userId.set(currentUser);
    doBusiness();
} finally {
    userId.remove();   // 用必删，线程池场景尤其重要
}
```

`ThreadLocal` 适合的场景，都是"线程私有的、跨方法传递的状态"：当前登录用户、请求上下文、事务、数据库连接、以及 `SimpleDateFormat` 这类线程不安全的对象（每个线程一份，避免共享时的并发错乱）。它不适合的场景也明确：它不是同步机制，替代不了锁或 `volatile`；它也不适合存"需要跨线程共享"的数据，那本来就不是它的职责。

还有一个变体 `InheritableThreadLocal`：创建子线程时，把父线程的 `ThreadLocal` 值复制一份给子线程。它适合"主线程里的上下文要传给子线程"的场景，但要注意复制的是一份快照，之后父线程再改，子线程看不到。

## 五、一个反直觉的点：ThreadLocal 不等于"全局变量的线程版"

很多人把 `ThreadLocal` 理解成"线程自己的全局变量"，这没错，但容易滑向一个误区：以为它和"用 `static` 全局变量 + 加锁"是等价的两种写法。其实两者解决的是不同的问题——`static` + 锁是"多个线程共享一份、靠锁保证安全"；`ThreadLocal` 是"每个线程各有一份、天然隔离、根本不用锁"。

所以选 `ThreadLocal` 的判断是：**这份数据是不是真的"线程私有"？** 如果是（请求上下文、用户会话），用 `ThreadLocal` 干净利落；如果数据本质是共享的（计数器、全局配置），用 `ThreadLocal` 会让每个线程看到不同步的副本，反而是错的。先想清楚"这份状态属于线程，还是属于系统"，再用 `ThreadLocal`。

`ThreadLocal` 的价值在"隔离"：它用"每线程一份"换掉了"共享 + 同步"的复杂度。代价是要自己记住 `remove`——因为它的实现把 value 挂在了线程身上，线程不死、value 不散。理解了这张图（Thread → ThreadLocalMap → 弱引用 key + 强引用 value），`ThreadLocal` 的用法和它的坑，就都清楚了。

## 参考资料

- [Oracle：ThreadLocal（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/lang/ThreadLocal.html)
- [OpenJDK：ThreadLocal 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/lang/ThreadLocal.java)
- [OpenJDK：Thread 源码（threadLocals 字段）](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/lang/Thread.java)
