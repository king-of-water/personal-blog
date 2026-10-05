---
title: synchronized 与 ReentrantLock：锁升级与 AQS
description: 从 synchronized 的 Monitor 与 Mark Word 讲起，拆解无锁、偏向锁、轻量级锁、重量级锁的升级过程；再把 ReentrantLock 的底座 AQS 摊开——state、CLH 队列、acquire/addWaiter/acquireQueued/release 逐行讲解，公平锁与非公平锁的源码差异，可重入怎么实现，Condition 的双队列，最后是 CAS 与 ABA。
category: 后端
subcategory: Java
articleClass: flagship
seriesOrder: 50
featured: true
publishedAt: 2026-06-08T20:21:00+08:00
updatedAt: 2026-06-08T20:21:00+08:00
tags: [Java, synchronized, ReentrantLock, AQS, CAS, 锁升级, 偏向锁, 轻量级锁, Monitor, Condition, CLH, ABA]
---

Java 里锁住一段代码有两种最主流的方式：`synchronized` 关键字，和 `ReentrantLock`。它们都能保证互斥，但一个是语法内置、自动管理，一个是普通类、手动 `lock/unlock`。要真正理解它们的区别、以及"为什么 `synchronized` 在 JDK 8 之后没那么慢了"，得先看懂它俩背后的机制——`synchronized` 的锁升级，和 `ReentrantLock` 的 AQS。

这篇文章把这两个锁从用法讲到原理，而且**把 AQS 的源码逐行摊开**——因为"state + 队列 + CAS"这句话谁都说得出来，但真正决定行为的是 `acquire` 里的那三行、`acquireQueued` 里的那个 `for(;;)`、以及公平锁与非公平锁只差的那一个方法调用。

上一篇讲了 `volatile` 和 JMM，它给的是"可见性 + 有序性"；锁在这之上再加一样东西——**互斥**，让"读-改-写"这类非原子操作变成原子的。所以锁和 `volatile` 不是二选一，锁内部本身就依赖 `volatile` 和 CAS 来保证状态可见。

## 一、synchronized 锁的是什么：Monitor

`synchronized` 有三种写法：

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

这三种写法的区别，全在"锁的是哪个对象"上，逐个看：

- **修饰实例方法**：等价于把整个方法体包在 `synchronized (this)` 里，锁的是**当前实例**。所以同一个类的两个不同实例，各自锁各自的，互不影响。
- **修饰静态方法**：等价于 `synchronized (Xxx.class)`，锁的是**这个类的 Class 对象**。Class 对象全局唯一，所以静态方法的锁是"全类共享"的。
- **修饰代码块**：锁的是括号里那个**显式对象**。这是唯一能自己控制锁对象的写法，也是唯一能缩小锁范围的写法——前两种会把整个方法都锁住。

最关键的一点：**三种写法锁的是三个不同的对象**。所以"实例方法加了锁"和"静态方法加了锁"并不互斥——它们锁的根本不是同一个东西。这也是为什么"给两个 `synchronized` 方法会不会互相阻塞"这个问题，不能只看 `synchronized` 关键字，必须看它们**锁的是不是同一个对象**。

那么"锁一个对象"到底锁住了什么？答案是对象关联的 **Monitor（管程）**。

HotSpot 里，每个对象都能通过对象头的 **Mark Word** 关联到一个 `ObjectMonitor`。Mark Word 是对象头里的一个机器字（64 位 JVM 上是 8 字节），哈希码、GC 分代年龄、锁状态全挤在里面——它是个"复用字段"，不同锁状态下存的东西不一样。`synchronized` 加锁时，Mark Word 会指向某个 Monitor，或者记录锁的状态（下一节展开）。

`wait()` / `notify()` 也建立在 Monitor 上：一个对象的 Monitor 里有等待队列，`wait` 让线程进入等待并**释放锁**，`notify` 唤醒等待线程。所以"锁"和"等待/唤醒"是同一个 Monitor 提供的两件事，这也是为什么 `wait/notify` 只能在 `synchronized` 块里用——没持有 Monitor，就没有等待队列可用。

`synchronized` 还是**可重入**的：同一个线程可以重复进入自己已持有的锁，Monitor 里记录重入次数，每次 `synchronized` 块退出减一，减到零才真正释放。可重入保证了"外层方法加了锁、内层方法又加同一把锁"不会自己把自己卡死——这是锁的基本素养，`ReentrantLock` 的名字里那个 "Reentrant" 说的就是它。

## 二、锁升级：从无锁到重量级锁

早期的 `synchronized` 直接是重量级锁——每次加锁都要向操作系统申请互斥量、线程阻塞切换，开销很大，所以有"synchronized 很慢"的说法。JDK 6 之后引入了锁升级，让"大多数时候根本不会竞争"的锁几乎零开销。

升级路径是：**无锁 → 偏向锁 → 轻量级锁 → 重量级锁**，只在发生竞争时才往上升，且不可逆（不会降级）。

![synchronized 的锁升级路径](/images/posts/java-synchronized-lock-upgrade.svg)

判断当前处于哪个阶段，看的是 Mark Word 里的**锁标志位**：

| 锁状态 | Mark Word 存的内容 | 标志位 |
| --- | --- | --- |
| 无锁 | hashCode + 分代年龄 | `01` |
| 偏向锁 | 偏向线程 ID + Epoch + 分代年龄 | `01` |
| 轻量级锁 | 指向线程栈中「锁记录」的指针 | `00` |
| 重量级锁 | 指向 `ObjectMonitor` 的指针 | `10` |
| GC 标记 | 空 | `11` |

三种锁各自的机制：

- **偏向锁**：锁被某个线程第一次获取时，Mark Word 记录这个线程 ID（这就是"偏向"——偏向第一个来的人）。之后同一线程再次进入，只要比对一下线程 ID 相等，不用任何同步操作、直接放行。它省的是"单线程反复加锁"的开销。**JDK 15 起默认禁用、JDK 21 正式移除偏向锁**（JEP 374）——因为现代应用里"同一个锁被同一个线程反复获取"的场景越来越少，收益盖不过维护成本。
- **轻量级锁**：有第二个线程来抢时，偏向锁升级成轻量级锁。抢锁的线程在**自己的栈帧里**开辟一块"锁记录"（Lock Record），用 CAS 把 Mark Word 换成指向这块锁记录的指针：CAS 成功即加锁成功；失败说明有别人在抢，就自旋一小会儿再试。轻量级锁**不阻塞线程**，靠 CAS + 自旋，适合"竞争不激烈、临界区很短"的场景。
- **重量级锁**：自旋到一定次数还没抢到，升级成重量级锁——真正向操作系统申请 Monitor，抢不到锁的线程被挂起（`park`），等锁释放再被唤醒。线程挂起/唤醒涉及用户态与内核态切换，成本高，所以只在竞争激烈时才值得。

这套升级的意义是：**大多数锁其实很少被竞争**（锁是短暂持有的），让它们停留在偏向锁/轻量级锁，几乎零开销；只有真的竞争激烈，才付出重量级锁的代价。这是"乐观地假设无竞争、竞争了再升级"的思路——和 `CAS` 的乐观思想一脉相承。

## 三、ReentrantLock：能超时、能中断、能公平

`ReentrantLock` 是一个实现了 `Lock` 接口的类，标准用法是"`lock()` 之后立刻 `try/finally`"：

```java
ReentrantLock lock = new ReentrantLock();
lock.lock();
try {
    // 临界区
} finally {
    lock.unlock();   // 必须在 finally 里释放
}
```

这个模板的每一部分都有理由，不能省：

- **`lock()` 写在 `try` 外面**：如果把它写进 `try` 里，那么 `lock()` 本身抛异常时，`finally` 里的 `unlock()` 仍会执行，而此时你**并没有持有锁**——`unlock()` 会抛 `IllegalMonitorStateException`，还会把真正的异常盖掉。所以加锁必须在 `try` 之前。
- **`unlock()` 必须在 `finally` 里**：`synchronized` 是 JVM 自动释放的（方法/代码块退出就放），而 `ReentrantLock` 完全靠手动——临界区里一旦抛异常又没在 `finally` 释放，这把锁就永远锁着，其他线程全部卡死。这是 `ReentrantLock` 相比 `synchronized` 最需要小心的地方。

它比 `synchronized` 多出四个能力：

- **`tryLock()`**：尝试获取锁，拿不到**立即返回 false**，不阻塞。适合"抢不到就干别的"的场景；
- **`tryLock(timeout, unit)`**：最多等一段时间，超时返回 false。这是**防死锁**的利器（下一节讲）；
- **`lockInterruptibly()`**：等待锁的过程中**能被中断**，抛出 `InterruptedException` 并放弃等待；
- **公平锁**：构造时传 `true` 即为公平锁（先来后到），默认是性能更好的非公平锁。

这四个能力 `synchronized` 一个都没有——它的加锁要么拿到、要么无限等，且不可中断、不可超时、不保证公平。这是 `ReentrantLock` 存在的全部理由。

还有 `Condition`：

```java
ReentrantLock lock = new ReentrantLock();
Condition notEmpty = lock.newCondition();   // 一个锁可以创建多个条件队列
Condition notFull  = lock.newCondition();

// 消费者：队列空就等 notEmpty
lock.lock();
try {
    while (queue.isEmpty())
        notEmpty.await();        // 释放锁并等待，被唤醒后重新抢锁
    consume(queue.poll());
} finally {
    lock.unlock();
}
```

`await()` / `signal()` 对应 `wait` / `notify`，但有一个关键区别：`notify` 只能**随机**唤醒一个等待线程（可能是同类，比如生产者唤醒了生产者，白白空转），而 `Condition` 能**精确唤醒指定条件上的线程**——`notEmpty.signal()` 只会唤醒等"非空"的消费者线程。

一个锁 + 多个 Condition，是实现"生产者-消费者"的经典工具：队列满时生产者等 `notFull`，队列空时消费者等 `notEmpty`，各等各的、各醒各的。这个"多个等待队列"的能力，底层是每个 `Condition` 对象都有自己独立的队列（第五节展开）。

公平锁和非公平锁的差别也值得先交代一句：**非公平锁（默认）的新线程来了直接 CAS 抢，抢不到才排队；公平锁则先看队列里有没有人在等，有人就老实排队**。非公平锁通常吞吐更高——省掉了"排队再唤醒"的往返，代价是可能让等了很久的线程更晚拿到锁（这就是"饥饿"）。两者的源码差异小到只差一个方法调用，下一节直接对比。

## 四、AQS：ReentrantLock 的底座

`ReentrantLock` 不是从零实现锁，它站在 **AQS（AbstractQueuedSynchronizer）** 的肩膀上。AQS 是 `java.util.concurrent` 里几乎所有同步器的公共底座——`ReentrantLock`、`Semaphore`、`CountDownLatch`、`ReentrantReadWriteLock` 都基于它。

AQS 的核心就三样东西：一个 `volatile int state`、一个 FIFO 队列、一堆 CAS 操作。

![AQS 的 state、CLH 队列与 CAS](/images/posts/java-aqs-structure.svg)

### state 与模板方法

`state` 表示同步状态，具体含义由子类定义：`ReentrantLock` 里 `0` 是无锁、`1` 是有人持锁、可重入时每进一层加一；`Semaphore` 里它是许可证数；`CountDownLatch` 里它是倒计数。

AQS 用的是**模板方法模式**：AQS 自己实现了"排队、挂起、唤醒"这套通用骨架，把"什么算获取成功"留给子类实现。子类要重写的就是这几个方法：

```java
// 子类实现这几个（AQS 里默认抛 UnsupportedOperationException）
protected boolean tryAcquire(int arg) { throw new UnsupportedOperationException(); }
protected boolean tryRelease(int arg) { throw new UnsupportedOperationException(); }
protected int tryAcquireShared(int arg) { throw new UnsupportedOperationException(); }
protected boolean tryReleaseShared(int arg) { throw new UnsupportedOperationException(); }
protected boolean isHeldExclusively() { throw new UnsupportedOperationException(); }
```

而 AQS 提供的是不让重写的 `final` 模板方法：`acquire` / `release` / `acquireShared` / `releaseShared`。分工很清楚：**子类只回答"能不能拿到"，AQS 负责"拿不到怎么办"**。

### acquire：加锁的三行

```java
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                          // ① 先试着拿一次
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))  // ② 拿不到：入队 + 排队等
        selfInterrupt();                             // ③ 等待期间被中断过，补上中断标志
}
```

这三行是 AQS 的入口，逐行看：

- **`tryAcquire(arg)`**：调子类的实现，尝试获取锁。成功返回 `true`，整个 `acquire` 就结束了——**注意这是"快速路径"**：无竞争时加锁只走这一行，不进队列、不挂起；
- **`addWaiter(Node.EXCLUSIVE)`**：失败说明锁被人占着，把当前线程包装成一个 `Node`（独占模式），**加入队列尾部**，返回这个节点；
- **`acquireQueued(node, arg)`**：在队列里"自旋 + 挂起"地等，直到拿到锁。它的返回值是"等待过程中是否被中断过"；
- **`selfInterrupt()`**：如果确实被中断过，这里补一次自我中断——因为 `acquire` 的语义是"不响应中断"，中断标志不能丢，要留给调用者处理。

### addWaiter：CAS 入队

```java
private Node addWaiter(Node mode) {
    Node node = new Node(Thread.currentThread(), mode);
    Node pred = tail;                       // 先读一次尾节点
    if (pred != null) {                     // 队列非空
        node.prev = pred;
        if (compareAndSetTail(pred, node)) { // CAS 把自己挂到尾部
            pred.next = node;
            return node;
        }
    }
    enq(node);                              // 队列空 或 CAS 失败 → 走完整入队循环
    return node;
}
```

这段的关键在 **CAS 入队**：多个线程可能同时想入队，所以"把 tail 指向自己"必须用 CAS 保证只有一个成功。失败的那个不重试 `addWaiter`，而是走 `enq(node)` —— 那是一个 `for(;;)` 循环，负责"队列还没建好（head/tail 为 null）时先初始化"以及"CAS 反复重试直到成功"。所以 `addWaiter` 是快路径，`enq` 是兜底慢路径。

### acquireQueued：自旋与挂起

```java
final boolean acquireQueued(final Node node, int arg) {
    boolean failed = true;
    try {
        boolean interrupted = false;
        for (;;) {                                        // 自旋
            final Node p = node.predecessor();            // 我的前驱
            if (p == head && tryAcquire(arg)) {           // ① 前驱是 head → 轮到我了
                setHead(node);                            //    把自己设为 head
                p.next = null;                            //    断开旧 head，帮助 GC
                failed = false;
                return interrupted;
            }
            if (shouldParkAfterFailedAcquire(p, node) &&  // ② 该挂起了吗
                parkAndCheckInterrupt())                  // ③ 挂起，醒来检查中断
                interrupted = true;
        }
    } finally {
        if (failed) cancelAcquire(node);                  // 异常退出要取消排队
    }
}
```

这个循环是 AQS 最核心的一段，三处要看清：

- **① `p == head && tryAcquire(arg)`**：为什么判断"前驱是 head"？因为 `head` 是**已经拿到锁的那个节点**，如果我的前驱就是 head，说明锁一释放就轮到我，这时候才值得去抢。这也解释了队列里其他节点为什么不去抢——它们前面还有人，抢了也白抢。抢到后把自己设为新 `head`。
- **② `shouldParkAfterFailedAcquire(p, node)`**：抢失败后判断"现在能不能安心挂起"。它检查前驱的 `waitStatus`：如果是 `SIGNAL`，说明前驱承诺"我释放时会唤醒你"，可以挂起；如果前驱已取消（`waitStatus > 0`），就往前找一个有效前驱、把失效的节点摘掉；否则用 CAS 把前驱状态置为 `SIGNAL`——**先让前驱答应唤醒我，下次循环才挂起**。
- **③ `parkAndCheckInterrupt()`**：真正调用 `LockSupport.park()` 挂起线程。被 `unpark` 唤醒后，它返回"是否被中断过"，然后循环继续——**回到 ① 再抢一次**。

所以队列里的线程并不是"一直睡着"，而是"被唤醒 → 抢一次 → 抢不到继续睡"的循环。这就是 AQS 的等待模型。

### Node 的 waitStatus：队列节点之间靠它通信

上面反复提到 `waitStatus`，它是 `Node` 里一个 `volatile int` 字段，是队列节点之间唯一的"通信语言"。它的取值和含义：

| 取值 | 常量 | 含义 |
| --- | --- | --- |
| `1` | `CANCELLED` | 该节点已取消（等待超时或被中断），要跳过它 |
| `0` | — | 初始状态 |
| `-1` | `SIGNAL` | **后继节点在等我唤醒它**——我释放锁时必须 `unpark` 它 |
| `-2` | `CONDITION` | 该节点在条件队列里等条件（不在同步队列） |
| `-3` | `PROPAGATE` | 共享模式下，释放要向后传播 |

关键是 `SIGNAL = -1`：**它是"后者向前面的人提的请求"**。队列里后面的节点想安心睡觉，就得先把前驱置成 `SIGNAL`，意思是"你释放锁的时候记得叫我"。`shouldParkAfterFailedAcquire` 的源码就是这个意思：

```java
private static boolean shouldParkAfterFailedAcquire(Node pred, Node node) {
    int ws = pred.waitStatus;
    if (ws == Node.SIGNAL)
        return true;                  // ① 前驱已答应唤醒我 → 可以安心挂起
    if (ws > 0) {                     // ② 前驱已取消（CANCELLED）
        do {
            node.prev = pred = pred.prev;   //    往前找，跳过所有取消的节点
        } while (pred.waitStatus > 0);
        pred.next = node;                   //    把自己接到有效前驱后面
    } else {
        compareAndSetWaitStatus(pred, ws, Node.SIGNAL);   // ③ 请求前驱：释放时叫醒我
    }
    return false;                     // 前两种情况下都不挂起，回循环再抢一次
}
```

三种分支对应三种处境，逐条看：

- **① 前驱已经是 `SIGNAL`**：说明之前已经"打过招呼"了，可以放心 `park` —— 返回 `true` 让上层去挂起；
- **② 前驱是 `CANCELLED`（>0）**：这个前驱自己都放弃了，不可能唤醒我。于是用 `do-while` 一路往前找，跳过所有取消的节点，把自己挂到一个**有效的**前驱后面。顺带把这些失效节点从链上摘掉；
- **③ 前驱是初始状态 0**：说明还没跟它打招呼，用 CAS 把它置成 `SIGNAL`，然后**返回 `false`（先不挂起）**，回到 `acquireQueued` 的循环再抢一次锁。

为什么第 ③ 种情况不直接挂起？因为这里有个**竞态**：在我把前驱置为 `SIGNAL` 的这一刻，前驱**可能刚好释放了锁**。如果此时直接 `park`，那次唤醒就会丢失，线程可能永远睡着。所以设计成"先打招呼，再回循环抢一次"——如果这期间锁真被释放了，这一次就能抢到；如果没抢到，下一轮循环时前驱已是 `SIGNAL`，才会真的挂起。**"改状态 → 重试 → 再挂起"这个顺序，是 AQS 避免丢唤醒的关键。**

![AQS acquire 的完整流程：自旋、入队、挂起、唤醒](/images/posts/aqs-acquire-flow.svg)

### release：释放与唤醒

```java
public final boolean release(int arg) {
    if (tryRelease(arg)) {              // ① 子类实现：state 减到 0 才返回 true
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);         // ② 唤醒 head 的后继节点
        return true;
    }
    return false;
}
```

两行要点：

- **`tryRelease(arg)`**：由子类实现。注意它返回的是"**是否完全释放**"——可重入锁里 `state` 减到 0 才返回 `true`，只减到 1 不算释放（还有人持有），也就不会去唤醒别人；
- **`unparkSuccessor(h)`**：唤醒 `head` 的后继。为什么要判断 `h.waitStatus != 0`？因为如果状态是 0，说明没有线程在等（`shouldParkAfterFailedAcquire` 还没来得及把它置为 `SIGNAL`），也就没人可唤醒。

被唤醒的那个线程，此刻正卡在 `acquireQueued` 的 `parkAndCheckInterrupt()` 里，于是它返回、循环继续、回到 ① 抢锁——闭环完成。

### tryAcquire：公平与非公平的唯一差异

现在看子类怎么实现 `tryAcquire`。`ReentrantLock` 内部有两个 `Sync` 子类，非公平锁的版本：

```java
// 非公平锁
final boolean nonfairTryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {                                        // 锁没人持有
        if (compareAndSetState(0, acquires)) {           // 直接 CAS 抢，不看队列
            setExclusiveOwnerThread(current);
            return true;
        }
    }
    else if (current == getExclusiveOwnerThread()) {      // 可重入：持锁的就是我自己
        int nextc = c + acquires;                        // state 累加
        if (nextc < 0) throw new Error("Maximum lock count exceeded");
        setState(nextc);                                 // 已经持有锁，普通 set 即可，无需 CAS
        return true;
    }
    return false;
}
```

公平锁的版本：

```java
// 公平锁
protected final boolean tryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        if (!hasQueuedPredecessors() &&                  // ★ 关键差异：先看队列里有没有人在等
            compareAndSetState(0, acquires)) {
            setExclusiveOwnerThread(current);
            return true;
        }
    }
    else if (current == getExclusiveOwnerThread()) {      // 可重入逻辑完全相同
        int nextc = c + acquires;
        if (nextc < 0) throw new Error("Maximum lock count exceeded");
        setState(nextc);
        return true;
    }
    return false;
}
```

**两份代码只差一个 `hasQueuedPredecessors()`**：公平锁在 CAS 抢锁之前，先检查"AQS 队列里有没有排在我前面的人"，有就放弃这次抢、老实排队；非公平锁不做这个检查，上来就抢——哪怕队列里已经有人等了很久。

这解释了"非公平锁为什么吞吐更高"：它允许"刚到的新线程"直接插队拿到锁，省掉了"唤醒队列里的线程 → 线程被调度起来 → 再抢"这一整趟昂贵的往返。代价是队列里的线程可能被反复插队、迟迟拿不到锁（饥饿）。**默认用非公平，就是为了这点吞吐。**

![公平锁与非公平锁的抢锁差异](/images/posts/reentrantlock-fair-vs-nonfair.svg)

另外注意可重入那段里的一个细节：`setState(nextc)` 用的是**普通赋值而不是 CAS**。为什么可以？因为能走到这个分支，说明 `current == getExclusiveOwnerThread()`——锁已经是我自己的了，不存在竞争，没必要 CAS。

### tryRelease 与可重入的完整闭环

```java
protected final boolean tryRelease(int releases) {
    int c = getState() - releases;
    if (Thread.currentThread() != getExclusiveOwnerThread())
        throw new IllegalMonitorStateException();   // ① 只有持有者能释放
    boolean free = false;
    if (c == 0) {                                   // ② 减到 0 才算真正释放
        free = true;
        setExclusiveOwnerThread(null);
    }
    setState(c);
    return free;
}
```

- **① 那句检查**：如果当前线程不是锁的持有者，直接抛 `IllegalMonitorStateException`——这就是"没加锁却 `unlock()`"报的错；
- **② `c == 0` 才 `free = true`**：可重入锁加了几次就要减几次，只有减到 0 才真正释放、才返回 `true`、才会去唤醒队列里的线程。**加锁 3 次只 `unlock` 1 次，锁不会释放**——这是使用可重入锁的常见 bug。

### Condition 的双队列

`Condition` 的底层是 `ConditionObject`，它是 AQS 的内部类，**自己维护一条独立的等待队列**（用 `firstWaiter` / `lastWaiter` 串起来的单向链表）。于是 AQS 里同时存在两条队列：

- **同步队列（CLH）**：等锁的线程在这里排队，节点是 `Node`；
- **条件队列**：调 `await()` 的线程在这里等条件，每个 `Condition` 一条。

`await()` 和 `signal()` 做的其实是"在两条队列之间搬运线程"：

- **`await()`**：把当前线程包成节点加入**条件队列** → 完全释放锁（`fullyRelease`，一次把重入计数清零）→ 挂起。被唤醒后，它还要**从条件队列转移到同步队列**，重新去抢锁；
- **`signal()`**：把**条件队列的头节点**取出，转移到**同步队列尾部**。注意它只是"转移"，被唤醒的线程还得在同步队列里排队抢锁——所以 `signal` 之后线程并不会立刻执行。

![Condition 的条件队列与 AQS 同步队列](/images/posts/condition-two-queues.svg)

这就解释了为什么 `await()` 必须"释放锁"：不释放，别的线程根本进不来，也就永远没人 `signal` 它，直接死锁。

所以 `ReentrantLock` 的完整本质是：**用 CAS 抢一个 `volatile` 的 `state`，抢不到就进 CLH 队列挂起，`Condition` 再给它加一条条件队列**。理解了 AQS，`Semaphore`（`state` 是许可证数）、`CountDownLatch`（`state` 是倒计数）就都是"换一种 `state` 语义 + 换一种 `tryAcquire` 判断"的变体。这就是为什么 AQS 是 Java 并发里最值得吃透的一个类。

## 五、CAS：乐观锁，以及 ABA 问题

AQS 的 `state` 抢锁靠 CAS（Compare-And-Swap，比较并交换）。看 `AtomicInteger` 自增的源码，就是 CAS 最直白的样子：

```java
// AtomicInteger
public final int incrementAndGet() {
    return U.getAndAddInt(this, VALUE, 1) + 1;
}

// Unsafe.getAndAddInt —— CAS 的标准写法：循环 + 比较 + 交换
public final int getAndAddInt(Object o, long offset, int delta) {
    int v;
    do {
        v = getIntVolatile(o, offset);                       // 读当前值
    } while (!compareAndSwapInt(o, offset, v, v + delta));   // 若没被别人改过，就写回新值
    return v;
}
```

这段 `do-while` 是 CAS 的教科书结构，三步：

1. **`getIntVolatile`**：读当前值 `v`（用 volatile 读，保证拿到最新值）；
2. **`compareAndSwapInt(o, offset, v, v + delta)`**：一条 CPU 原子指令，语义是"如果 `o` 在 `offset` 处的值**仍然等于** `v`，就把它改成 `v + delta` 并返回 true；否则什么都不做、返回 false"；
3. **失败了就循环重来**：重新读、重新算、重新试。

关键在于"**比较 + 交换"是一步完成的原子操作**，中间不可能被插入别的线程。所以它不需要锁：没有加锁、没有阻塞、没有上下文切换。CAS 由 `Unsafe` 提供，底层就是 CPU 的 `cmpxchg` 指令。

CAS 没有锁的开销，但它有两个问题：

**一是自旋。** CAS 失败要重试，竞争激烈时大量线程在原地空转、白白烧 CPU——这也是 AQS 里"自旋几次还不行就挂起"的原因：自旋适合短临界区，长等待必须让出 CPU。

**二是 ABA 问题。** CAS 只比较"值变没变"。如果一个值从 A 改成 B、又改回 A，CAS 会认为"没变过"，但中间其实已经发生了变化。经典场景是栈/链表：线程 1 读到头节点 A、准备把栈顶 CAS 成 A.next；此时线程 2 把 A、B 弹出又把 A 压回，线程 1 的 CAS 仍然成功，但栈的结构已经不是它以为的样子了。解法是**加版本号**——每次修改版本号加一，CAS 同时比较"值和版本号"，这就是 `AtomicStampedReference` 干的事；另一种思路是设计上让值单调递增、永不回退，从根上避免"改回去"。

CAS 是理解 Java 并发的一把总钥匙：`AtomicInteger`、`ConcurrentHashMap` 的空桶插入、AQS 的抢锁和入队，全都是 CAS。上一篇说 `volatile` 不保证原子性、`i++` 要升级到 CAS——现在能看到 CAS 具体长什么样了。

## 六、synchronized 还是 ReentrantLock

| 需求 | 选择 | 理由 |
| --- | --- | --- |
| 简单互斥，锁短暂持有 | `synchronized` | 语法简单、自动释放、锁升级后性能不差 |
| 需要超时获取、可中断 | `ReentrantLock` | `tryLock` / `lockInterruptibly` |
| 需要公平锁 | `ReentrantLock` | 构造参数指定公平（靠 `hasQueuedPredecessors`） |
| 需要多个等待队列 | `ReentrantLock` | 多个 `Condition`，各自独立队列 |
| 需要跨方法 lock/unlock | `ReentrantLock` | 锁可以传出去，`synchronized` 受块结构限制 |

一个朴素的原则：**默认用 `synchronized`，它简单、不易错（自动释放，不会忘了 `unlock` 导致死锁）；只有当明确需要超时、中断、公平或多条件时，才上 `ReentrantLock`**。很多人因为"`synchronized` 慢"的旧印象而弃用它，但锁升级之后，普通场景下它的性能和 `ReentrantLock` 差距已经很小，换来的是"不会漏释放"的省心。

锁还带来一个绕不开的坑：**死锁**。两个线程各自持有一把锁、又都等对方的锁，就永远卡住。预防有三条：

1. **按固定顺序加锁**：所有线程都"先 A 后 B"，就不会出现"A 等 B、B 等 A"的环路；
2. **用 `tryLock(timeout)`**：拿不到就放弃、先释放已持有的锁，过一会儿重试——这正是 `ReentrantLock` 比 `synchronized` 多出来的能力，也是它能防死锁的原因；
3. **缩小锁范围**：减少同时持有多把锁的机会，从源头降低成环概率。

死锁不是概率问题，是**顺序问题**——只要有两把锁、两个线程、各自不按顺序加锁，就可能发生，和运行快慢无关。

锁的完整图景是：`volatile` 解决可见性和有序性，CAS 提供无锁的原子操作，AQS 用"CAS + `volatile state` + CLH 队列"搭出可阻塞的锁，`synchronized` 则用锁升级把"多数无竞争"的锁成本压到最低。四者层层叠起来，才是 Java 并发真正的地基。

## 参考资料

- [Oracle：synchronized 与 Intrinsic Locks](https://docs.oracle.com/javase/tutorial/essential/concurrency/locksync.html)
- [OpenJDK：AbstractQueuedSynchronizer 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/locks/AbstractQueuedSynchronizer.java)
- [OpenJDK：ReentrantLock 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/locks/ReentrantLock.java)
- [JEP 374：Deprecate and Disable Biased Locking](https://openjdk.org/jeps/374)
