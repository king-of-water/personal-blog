---
title: synchronized 与 ReentrantLock：锁升级与 AQS
description: 从 synchronized 锁的 Monitor 讲起，拆解无锁、偏向锁、轻量级锁、重量级锁的升级过程，再讲 ReentrantLock 底层的 AQS（state + CLH 队列 + CAS）和 CAS 的乐观锁思想，最后给出两者的选型。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 50
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, synchronized, ReentrantLock, AQS, CAS, 锁升级, 偏向锁, 轻量级锁, Monitor, Condition]
---

Java 里锁住一段代码有两种最主流的方式：`synchronized` 关键字，和 `ReentrantLock`。它们都能保证互斥，但一个是语法内置、自动管理，一个是普通类、手动 `lock/unlock`。要真正理解它们的区别、以及"为什么 `synchronized` 在 JDK 8 之后没那么慢了"，得先看懂它俩背后的机制——`synchronized` 的锁升级，和 `ReentrantLock` 的 AQS。

这篇文章把这两个锁从用法讲到原理。上一篇讲了 `volatile` 和 JMM，它给的是"可见性 + 有序性"；锁在这之上再加一样东西——**互斥**，让"读-改-写"这类非原子操作变成原子的。所以锁和 `volatile` 不是二选一，锁内部本身就依赖 `volatile` 和 CAS 来保证状态可见。

本文回答一个问题：`synchronized` 和 `ReentrantLock` 分别怎么实现锁，锁升级和 AQS 这两套机制是怎么工作的，实际该怎么选。主要依据是 JDK 源码，版本差异在关键处标注。

## 一、synchronized 锁的是什么：Monitor

`synchronized` 有三种写法：修饰实例方法（锁的是 `this`）、修饰静态方法（锁的是 `Class` 对象）、修饰代码块（锁的是括号里的对象）。无论哪种，最终都落到"锁一个对象"——这个对象关联着一个 **Monitor（管程）**。

```java
// 实例方法：锁 this
synchronized void instanceMethod() { }

// 静态方法：锁 Class 对象
synchronized static void staticMethod() { }

// 代码块：锁指定对象（锁的粒度更可控）
Object lock = new Object();
void block() {
    synchronized (lock) { }
}
```

三种写法锁的是三个不同的对象，所以"实例方法加了锁"和"静态方法加了锁"并不互斥——它们锁的根本不是同一个东西。这也是为什么"给两个 `synchronized` 方法会不会互相阻塞"这个问题，不能只看 `synchronized` 关键字，要看它们锁的是不是同一个对象。

Monitor 是操作系统的互斥原语，HotSpot 里每个对象都能通过对象头的 Mark Word 关联到一个 `ObjectMonitor`。上一篇 JVM 内存结构里讲过 Mark Word——哈希码、GC 分代年龄、锁状态全挤在那个机器字里，`synchronized` 加锁时，Mark Word 会指向这个 Monitor，或者记录锁的状态。

`wait()` / `notify()` 也建立在 Monitor 上：一个对象的 Monitor 里有等待队列，`wait` 让线程进入等待、释放锁，`notify` 唤醒等待线程。所以"锁"和"等待/唤醒"是同一个 Monitor 提供的两件事，这也是为什么 `wait/notify` 只能在 `synchronized` 块里用——没持有 Monitor 就没有等待队列可用。

`synchronized` 是可重入的：同一个线程可以重复进入自己已持有的锁，Monitor 里记录重入次数，每次 `synchronized` 块退出减一，减到零才真正释放。可重入保证了"外层方法加了锁、内层方法又加同一把锁"不会自己把自己卡死。

## 二、锁升级：从无锁到重量级锁

早期的 `synchronized` 直接是重量级锁——每次加锁都要向操作系统申请互斥量、线程阻塞切换，开销很大，所以有"synchronized 很慢"的说法。JDK 6 之后引入了锁升级，让"大多数时候根本不会竞争"的锁几乎零开销。

升级路径是：**无锁 → 偏向锁 → 轻量级锁 → 重量级锁**，只在发生竞争时才往上升，且不可逆（不会降级）。

![synchronized 的锁升级路径](/images/posts/java-synchronized-lock-upgrade.svg)

- **偏向锁**：锁被某个线程第一次获取时，Mark Word 记录这个线程 ID，之后同一线程再次进入，不用任何同步操作、直接放行。它省的是"单线程反复加锁"的开销。JDK 15 起默认禁用、JDK 21 移除偏向锁——因为现代应用里"同一个锁被同一个线程反复获取"的场景，收益已经盖不过维护成本。
- **轻量级锁**：有第二个线程来抢时，偏向锁升级成轻量级锁。抢锁的线程用 CAS 把 Mark Word 换成指向自己栈里"锁记录"的指针，CAS 成功即加锁成功，失败则自旋一小会儿再试。轻量级锁不阻塞线程，靠 CAS + 自旋，适合"竞争不激烈、临界区很短"的场景。
- **重量级锁**：自旋到一定次数还没抢到，升级成重量级锁——真正向操作系统申请 Monitor，抢不到锁的线程被挂起（`park`），等锁释放再唤醒。线程挂起/唤醒有上下文切换成本，所以只在竞争激烈时才值得。

这套升级的意义是：**大多数锁其实很少被竞争**（锁是短暂持有的），让它们停留在偏向锁/轻量级锁，几乎零开销；只有真的竞争激烈，才付出重量级锁的代价。这是"乐观地假设无竞争、竞争了再升级"的思路。

## 三、ReentrantLock：能超时、能中断、能公平

`ReentrantLock` 是一个实现了 `Lock` 接口的类，用法上比 `synchronized` 灵活得多：

```java
ReentrantLock lock = new ReentrantLock();
lock.lock();
try {
    // 临界区
} finally {
    lock.unlock();   // 必须在 finally 里释放
}
```

它比 `synchronized` 多出几个能力。`tryLock()` 尝试获取锁、拿不到立即返回 false，而不是阻塞；`tryLock(timeout, unit)` 最多等一段时间；`lockInterruptibly()` 在等待锁时能被中断；构造时可以指定公平锁（先来后到）还是非公平锁（默认，性能更好）。

还有 `Condition`：`ReentrantLock` 可以创建多个条件队列，`await()` / `signal()` 对应 `wait` / `notify`，但能精确唤醒某个条件上的线程，而不是像 `notify` 那样随机唤醒一个。一个锁 + 多个 Condition，是实现"生产者-消费者"这类需要多个等待队列的经典工具——`notEmpty`（生产者往满队列放时等这个）、`notFull`（消费者从空队列取时等这个），`signal` 精确唤醒对应条件的线程。

公平锁和非公平锁的差别也值得一句：非公平锁（默认）的新线程来了直接 CAS 抢，抢不到才排队；公平锁则先看队列里有没有人，有人就老实排队。非公平锁通常吞吐更高——省掉了"排队再唤醒"的往返，代价是可能让老等待线程更晚拿到锁。

## 四、AQS：ReentrantLock 的底座

`ReentrantLock` 不是从零实现锁，它站在 **AQS（AbstractQueuedSynchronizer）** 的肩膀上。AQS 是 `java.util.concurrent` 里几乎所有同步器的公共底座——`ReentrantLock`、`Semaphore`、`CountDownLatch`、`ReentrantReadWriteLock` 都基于它。

AQS 的核心就三样东西：一个 `volatile int state`、一个 FIFO 队列、一堆 CAS 操作。

![AQS 的 state、CLH 队列与 CAS](/images/posts/java-aqs-structure.svg)

`state` 表示锁的状态：`0` 是无锁，`1` 是有人持锁，可重入时每进一层 `state` 加一、每出一层减一。加锁就是"用 CAS 把 `state` 从 0 改成 1"——CAS 成功，说明抢到了锁；CAS 失败，说明被别人抢走了，把自己挂到 FIFO 队列尾部等待。释放锁时把 `state` 减一，减到 0 就唤醒队头等待的线程。

所以 `ReentrantLock` 的本质是：**用 CAS 抢一个 `volatile` 的 `state`，抢不到就进队列挂起**。理解了 AQS，`Semaphore`（`state` 是许可证数）、`CountDownLatch`（`state` 是倒计数）就都是"换一种 `state` 语义 + 换一种唤醒条件"的变体。这就是为什么 AQS 是 Java 并发里最值得吃透的一个类。

## 五、CAS：乐观锁，以及 ABA 问题

AQS 的 `state` 抢锁靠 CAS（Compare-And-Swap，比较并交换）。CAS 是一个乐观的原子操作：先读当前值，计算新值，然后"如果当前值还是我读到的那个，就把它改成新值，否则失败重来"。它由 `Unsafe` 提供、底层是 CPU 的 CAS 指令，全程无锁、不阻塞。

CAS 没有锁，也就没有锁的开销，但它有两个问题。一是**自旋**：CAS 失败要重试，竞争激烈时大量线程空转浪费 CPU——这也是 AQS 里"自旋几次还不行就挂起"的原因。二是 **ABA 问题**：CAS 只比较"值变没变"，如果一个值从 A 改成 B、又改回 A，CAS 会认为"没变"，但中间其实发生过变化。解决 ABA 要加版本号（`AtomicStampedReference`），或者设计上让值单调递增、不回退。

CAS 是理解 Java 并发的一把总钥匙：`AtomicInteger`、`ConcurrentHashMap` 的空桶插入、AQS 的抢锁，全都是 CAS。上一篇说 `volatile` 不保证原子性、`i++` 要升级到 CAS——这里的 `AtomicInteger` 内部就是用 CAS 做自增。

## 六、synchronized 还是 ReentrantLock

| 需求 | 选择 | 理由 |
| --- | --- | --- |
| 简单互斥，锁短暂持有 | `synchronized` | 语法简单、自动释放、锁升级后性能不差 |
| 需要超时获取、可中断 | `ReentrantLock` | `tryLock` / `lockInterruptibly` |
| 需要公平锁 | `ReentrantLock` | 构造参数指定公平 |
| 需要多个等待队列 | `ReentrantLock` | 多个 `Condition` |
| 需要跨方法 lock/unlock | `ReentrantLock` | 锁可以传出去，`synchronized` 受块结构限制 |

一个朴素的原则：**默认用 `synchronized`，它简单、不易错（自动释放，不会忘了 `unlock` 导致死锁）；只有当明确需要超时、中断、公平或多条件时，才上 `ReentrantLock`**。很多人因为"`synchronized` 慢"的旧印象而弃用它，但锁升级之后，普通场景下它的性能和 `ReentrantLock` 差距已经很小，换来的是"不会漏释放"的省心。

锁还带来一个绕不开的坑：死锁。两个线程各自持有一把锁、又都等对方的锁，就永远卡住。预防有三条：一是按固定顺序加锁（大家都先 A 后 B，就不会互相等）；二是用 `tryLock(timeout)` 拿不到就放弃、先释放已持有的；三是缩小锁的范围、减少同时持有多把锁。死锁不是概率问题，是顺序问题——只要有两把锁、两个线程、各自不按顺序加锁，就可能发生。

锁的完整图景是：`volatile` 解决可见性和有序性，CAS 提供无锁的原子操作，AQS 用"CAS + volatile + 队列"搭出可阻塞的锁，`synchronized` 则用锁升级把"多数无竞争"的锁成本压到最低。四者层层叠起来，才是 Java 并发真正的地基。

## 参考资料

- [Oracle：synchronized 与 Intrinsic Locks](https://docs.oracle.com/javase/tutorial/essential/concurrency/locksync.html)
- [OpenJDK：ReentrantLock 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/locks/ReentrantLock.java)
- [OpenJDK：AbstractQueuedSynchronizer 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/locks/AbstractQueuedSynchronizer.java)
- [JEP 374：Deprecate and Disable Biased Locking](https://openjdk.org/jeps/374)
