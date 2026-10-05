---
title: volatile 与 JMM：可见性、有序性与 happens-before
description: 从「一个线程改了变量、另一个线程却看不到」的可见性问题出发，拆解 JMM 的主内存与工作内存模型、volatile 保证的可见性与有序性（以及它不保证的原子性）、happens-before 规则，最后落到双重检查锁为什么必须 volatile。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 40
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, volatile, JMM, happens-before, 可见性, 有序性, 内存屏障, 双重检查锁]
---

写一个简单的并发程序：一个线程不停地改一个 `boolean flag`，另一个线程不停地读它、读到 `true` 就退出。直觉上应该能停，但实际可能永远停不下来——读线程一直看到 `false`。这不是逻辑错，是**可见性**问题：一个线程对变量的修改，另一个线程看不到。

这就是 JMM（Java Memory Model）和 `volatile` 要解决的领域。JMM 定义了多线程下"变量的读写之间到底谁先看到什么"，`volatile` 是其中最轻量、最常用的一把工具。它是理解 `synchronized`、锁、`ConcurrentHashMap` 的 `get` 为什么无锁、乃至整个并发编程的地基。

本文回答一个问题：`volatile` 到底保证什么、不保证什么，背后的 JMM 和 happens-before 规则是怎么组织的。上一篇讲了 JVM 的堆和栈（内存的"物理布局"），这篇讲 JMM（内存的"并发语义"），两者名字都带"内存"但不是一回事，会专门区分。

## 一、并发下的三个问题：可见性、有序性、原子性

多线程共享数据时，会出现三类不同的问题，很多混淆都源于把它们搅在一起。

**可见性**：一个线程改了变量，另一个线程能不能看到。上面那个 `flag` 的例子就是可见性问题——改了看不到。

**有序性**：代码的执行顺序，可能被编译器、CPU 指令重排打乱。单线程下重排不影响结果（有依赖约束），但多线程下别的线程可能观察到"中间态"的执行顺序。

**原子性**：一个操作是不是不可分割。`i++` 其实是"读、加一、写回"三步，多线程下两步之间会被穿插，导致丢更新。

`volatile` 管的是前两个（可见性 + 有序性），不管第三个（原子性）。记住这条边界，就抓住了 `volatile` 的全部。

## 二、JMM：主内存和工作内存

JMM 把内存抽象成两块：**主内存**（所有线程共享）和每个线程的**工作内存**（线程私有的本地缓存）。线程对变量的读写先在工作内存里进行，再在某个时刻同步回主内存。于是线程 A 改了工作内存里的 `flag`，还没同步回主内存，线程 B 从主内存（或自己的缓存）读到的还是旧值——这就是可见性问题的来源。

![JMM 的主内存与工作内存模型](/images/posts/java-jmm-memory-model.svg)

这里要特别注意一个概念陷阱：JMM 的"主内存 / 工作内存"和上一篇文章讲的"堆 / 栈"**不是一回事**。堆、栈是 JVM 运行时数据区的物理划分——变量在栈上、对象在堆上；主内存、工作内存是 JMM 的抽象模型——用来描述"多线程下变量的可见性规则"，它没有说"主内存就是堆、工作内存就是栈"。实际上，堆上对象的字段、栈上的局部变量，都遵循 JMM 的可见性规则。把两个"内存"概念混在一起，是理解 Java 并发最常见的误区。

## 三、volatile 保证什么：可见性 + 有序性

`volatile` 是一个字段修饰符，它给这个字段的读写加了两个保证。

**可见性**：一个线程写了 `volatile` 字段，这个写会立刻刷回主内存；另一个线程读这个字段，会从主内存读最新值、并使自己的本地缓存失效。所以 `volatile` 字段的读写，在所有线程之间是"可见"的——这就是开头 `flag` 例子的解法：把 `flag` 声明成 `volatile boolean flag`，读线程就能看到写了。

**有序性**：`volatile` 的读写会插入内存屏障，禁止指令重排跨越它。具体说，`volatile` 写之前的操作不会重排到写之后，`volatile` 读之后的操作不会重排到读之前。

```java
class Config {
    private volatile boolean ready = false;

    void publish() {
        config = buildConfig();   // ① 准备好数据
        ready = true;             // ② volatile 写，屏障保证 ① 不会重排到 ② 之后
    }

    void consume() {
        if (ready) {              // ③ volatile 读
            use(config);          // ④ 屏障保证 ③ 不会重排到 ④ 之后
        }
    }
}
```

这个例子里，`volatile` 的价值不只是"`ready` 这个布尔值可见"，更是"看到 `ready == true` 时，`config` 也一定已经准备好"。因为屏障保证 ① 一定发生在 ② 之前、③ 一定发生在 ④ 之前，配合"② 的写对 ③ 的读可见"，`config` 的准备动作对消费方就是完整可见的。这种"用 volatile 标志位发布一个对象"的模式，是并发编程里的经典用法。

![volatile 的可见性与内存屏障](/images/posts/java-volatile-visibility.svg)

这张图把 volatile 的两个保证拆成看得见的两列：左列是写，`config` 的准备在 StoreStore 屏障之前、`ready` 的写在屏障之后，屏障挡住了"写往前排"；右列是读，`ready` 的读在 LoadLoad 之后、`config` 的使用在 LoadStore 之前，屏障挡住了"读往后排"。可见性和有序性，一个管"能不能看到"，一个管"看到的时候顺序对不对"。

## 四、volatile 不保证什么：原子性

`volatile` 最容易被误用的地方，是以为它能让 `i++` 线程安全。

```java
private volatile int count = 0;

// 两个线程各执行 10000 次 count++，结果大概率 < 20000
count++;
```

`count++` 是"读、加一、写回"三步。`volatile` 保证的是"每次读都读到最新值、每次写都让别的线程可见"，但它不保证"读-改-写"这三步之间别的线程不插进来。两个线程可能同时读到 `count == 5`，各自加一成 6，各自写回——两次自增只加了 1。丢更新的根子是"读改写不是原子的"，`volatile` 解决不了这个。

要原子地自增，得用 `AtomicInteger`（CAS）、`synchronized` 或锁。所以 `volatile` 的正确用途是：**一个线程写、多个线程读**的标志位、状态量；只要涉及"读-改-写"，`volatile` 就不够，得升级到 CAS 或锁。

## 五、happens-before：JMM 的规则

`volatile` 的保证，最终都落在 JMM 的一组规则上，叫 **happens-before（先行发生）**。它定义"操作 A 的结果对操作 B 可见"的条件。核心几条：

1. **程序顺序规则**：同一个线程内，前面的操作 happens-before 后面的操作；
2. **volatile 规则**：对一个 `volatile` 字段的写，happens-before 后续对这个字段的读；
3. **锁规则**：一个锁的解锁，happens-before 后续对这个锁的加锁；
4. **传递性**：A happens-before B，B happens-before C，则 A happens-before C。

happens-before 的价值在于，它把"可见性"这个模糊的感觉，变成了可推导的规则。第三节那个 `ready/config` 的例子，就可以用规则推导：① 程序顺序 happens-before ②（同一线程），② 是 volatile 写、③ 是 volatile 读、② happens-before ③（volatile 规则），③ happens-before ④（程序顺序），再由传递性推出 ① happens-before ④——所以 `config` 的准备对消费方可见。这套推导，就是 JMM 给并发代码的"正确性证明"。

## 六、经典案例：双重检查锁为什么要 volatile

单例模式的双重检查锁（DCL），是 `volatile` 最著名的应用，也是最容易被问倒的题。

```java
class Singleton {
    private static volatile Singleton instance;

    static Singleton getInstance() {
        if (instance == null) {              // 第一次检查
            synchronized (Singleton.class) {
                if (instance == null) {      // 第二次检查
                    instance = new Singleton();
                }
            }
        }
        return instance;
    }
}
```

为什么这里必须有 `volatile`？因为 `new Singleton()` 不是一步，它拆成：① 分配内存；② 调用构造器初始化；③ 把引用赋给 `instance`。没有 `volatile` 时，② 和 ③ 可能被重排——③ 先执行、② 还没完成。这时另一个线程走到第一次检查，看到 `instance != null`，直接返回这个**还没初始化完的对象**，用了就出错。

加了 `volatile`，内存屏障禁止 ② 和 ③ 重排，`instance` 引用暴露给其他线程时，对象一定已经初始化完成。这就是"双重检查锁必须 volatile"的完整原因——它防的不是"创建两次"，而是"拿到半成品对象"。

![双重检查锁的重排与 volatile 的作用](/images/posts/java-dcl-volatile.svg)

这张图把"为什么是半成品"画了出来：正常顺序是"分配 → 初始化 → 赋引用"，重排后变成"分配 → 赋引用 → 初始化"，引用先暴露、初始化后发生，别的线程在中间窗口里拿到的就是没初始化的对象。`volatile` 挡的就是这个重排。理解了这张图，"双重检查锁为什么 volatile"这道题就从死记变成了推导。

`volatile` 是整个 Java 并发工具箱里最轻的一件：它不阻塞、不加锁，只靠"可见性 + 有序性"就能解决一大类"一写多读"的同步问题。但它有明确的边界——不保证原子性。理解了它管什么、不管什么，再看 `synchronized`、`ReentrantLock`、CAS 这些下一层的工具，就有了对照的基准：它们都是在 `volatile` 给的可见性之上，再加上了互斥或原子操作。

## 参考资料

- [The Java Language Specification：Java Memory Model](https://docs.oracle.com/javase/specs/jls/se8/html/jls-17.html#jls-17.4)
- [JSR 133：Java Memory Model and Thread Specification](https://www.cs.umd.edu/~pugh/java/memoryModel/)
- [Oracle：volatile 关键字教程](https://docs.oracle.com/javase/tutorial/essential/concurrency/atomic.html)
