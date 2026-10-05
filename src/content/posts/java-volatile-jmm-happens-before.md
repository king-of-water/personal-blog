---
title: volatile 与 JMM：可见性、有序性与 happens-before
description: 从可见性问题出发拆解 JMM 的主内存与工作内存模型，讲清 volatile 保证的可见性与有序性（四种内存屏障、StoreLoad 为什么最贵、x86 上怎么实现）、以及它不保证的原子性；再整理 happens-before 的完整规则与「它不是时间先后」这个关键澄清，最后逐行拆解双重检查锁为什么必须 volatile。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 40
featured: true
publishedAt: 2026-06-07T23:12:00+08:00
updatedAt: 2026-06-07T23:12:00+08:00
tags: [Java, volatile, JMM, happens-before, 可见性, 有序性, 内存屏障, StoreLoad, 双重检查锁, DCL]
---

写一个简单的并发程序：一个线程不停地改一个 `boolean flag`，另一个线程不停地读它、读到 `true` 就退出。直觉上应该能停，但实际可能永远停不下来——读线程一直看到 `false`。这不是逻辑错，是**可见性**问题：一个线程对变量的修改，另一个线程看不到。

这就是 JMM（Java Memory Model）和 `volatile` 要解决的领域。JMM 定义了多线程下"变量的读写之间到底谁先看到什么"，`volatile` 是其中最轻量、最常用的一把工具。它是理解 `synchronized`、锁、`ConcurrentHashMap` 的 `get` 为什么无锁、乃至整个并发编程的地基。

本文回答一个问题：`volatile` 到底保证什么、不保证什么，背后的 JMM 和 happens-before 规则是怎么组织的，以及**内存屏障这个"有序性"的实现手段具体长什么样**。上一篇讲了 JVM 的堆和栈（内存的"物理布局"），这篇讲 JMM（内存的"并发语义"），两者名字都带"内存"但不是一回事，会专门区分。

## 一、并发下的三个问题：可见性、有序性、原子性

多线程共享数据时，会出现三类不同的问题，很多混淆都源于把它们搅在一起。

**可见性**：一个线程改了变量，另一个线程能不能看到。上面那个 `flag` 的例子就是可见性问题——改了看不到。根源是每个线程有自己的缓存（寄存器、CPU 缓存），写还没同步出去，别的线程读的还是旧值。

**有序性**：代码的执行顺序，可能被编译器、CPU 指令重排打乱。单线程下重排不影响结果（编译器会保证有数据依赖的语句不乱序），但多线程下别的线程可能观察到"中间态"的执行顺序。

**原子性**：一个操作是不是不可分割。`i++` 其实是"读、加一、写回"三步，多线程下两步之间会被穿插，导致丢更新。

`volatile` 管的是前两个（可见性 + 有序性），**不管第三个（原子性）**。记住这条边界，就抓住了 `volatile` 的全部。

## 二、JMM：主内存和工作内存

JMM 把内存抽象成两块：**主内存**（所有线程共享）和每个线程的**工作内存**（线程私有的本地缓存）。线程对变量的读写先在工作内存里进行，再在某个时刻同步回主内存。于是线程 A 改了工作内存里的 `flag`，还没同步回主内存，线程 B 从主内存（或自己的缓存）读到的还是旧值——这就是可见性问题的来源。

![JMM 的主内存与工作内存模型](/images/posts/java-jmm-memory-model.svg)

这里要特别注意一个概念陷阱：JMM 的"主内存 / 工作内存"和上一篇文章讲的"堆 / 栈"**不是一回事**。

- **堆、栈**是 JVM 运行时数据区的**物理划分**——变量在栈上、对象在堆上，讲的是"东西放在哪"；
- **主内存、工作内存**是 JMM 的**抽象模型**——用来描述"多线程下变量的可见性规则"，它没有说"主内存就是堆、工作内存就是栈"。

实际上，堆上对象的字段、栈上的局部变量，都遵循 JMM 的可见性规则。把两个"内存"概念混在一起，是理解 Java 并发最常见的误区。

## 三、volatile 保证什么：可见性 + 有序性

`volatile` 是一个字段修饰符，它给这个字段的读写加了两个保证。

**可见性**：一个线程写了 `volatile` 字段，这个写会立刻刷回主内存；另一个线程读这个字段，会从主内存读最新值、并使自己的本地缓存失效。所以 `volatile` 字段的读写，在所有线程之间是"可见"的——这就是开头 `flag` 例子的解法：把 `flag` 声明成 `volatile boolean flag`，读线程就能看到写了。

**有序性**：`volatile` 的读写会插入**内存屏障**，禁止指令重排跨越它。

### 四种内存屏障

"内存屏障"不是一个笼统的概念，JMM 里定义了四种，各自禁止一种重排方向：

| 屏障 | 禁止的重排 | 说明 |
| --- | --- | --- |
| `LoadLoad` | 上面的**读** 与 下面的**读** | 两个读不能交换顺序 |
| `StoreStore` | 上面的**写** 与 下面的**写** | 两个写不能交换顺序 |
| `LoadStore` | 上面的**读** 与 下面的**写** | 读不能排到写之后 |
| `StoreLoad` | 上面的**写** 与 下面的**读** | 写不能排到读之后，**最贵的一种** |

前三种在 x86 上几乎不花钱——因为 x86 本身就是 TSO（全存储序）模型，硬件天然保证读读、写写、读写不乱序，所以这些屏障在 x86 上编译后往往是**空操作**，只约束编译器不要重排。

**只有 `StoreLoad` 是真正有代价的**：它要求"前面所有的写都真正对其他核可见了，后面的读才能开始"。这会强制 CPU 把写缓冲（store buffer）排空，代价远高于其他三种。x86 上它需要真实的指令。

`volatile` 读写的屏障插法（JMM 的保守策略）：

```text
volatile 写：
    StoreStore 屏障      ← 保证前面的普通写先于 volatile 写完成
    volatile 写
    StoreLoad 屏障       ← 保证 volatile 写先于后面的所有读

volatile 读：
    volatile 读
    LoadLoad 屏障        ← 保证 volatile 读先于后面的普通读
    LoadStore 屏障       ← 保证 volatile 读先于后面的普通写
```

这套插法的含义是：**`volatile` 写像一堵墙，墙前面的写不能翻到墙后面；`volatile` 读也像一堵墙，墙后面的读写不能翻到墙前面**。两道墙合起来，就让"volatile 写之前的操作"和"volatile 读之后的操作"之间建立起了顺序。

![volatile 的四种内存屏障与插入位置](/images/posts/memory-barriers.svg)

### volatile 在字节码和汇编层怎么实现

往下钻一层，能看到这套屏障的真身。

**字节码层**：`volatile` 字段在 class 文件里会带上 `ACC_VOLATILE` 访问标志。JVM 执行 `getfield` / `putfield` 时，正是靠读这个标志来决定"要不要插屏障"——所以 `volatile` 不是语法糖，它是**JVM 指令级的语义**。

**汇编层**：x86 上，HotSpot 给 `volatile` 写生成的实际指令是：

```asm
lock addl $0x0, (%rsp)     ; 对栈顶地址加 0 —— 借 lock 前缀的全屏障效果
```

这条指令看着很怪（给栈上的值加 0，等于什么都没干），但 `lock` 前缀的**副作用**正是我们想要的：它会锁住总线/缓存行，强制排空写缓冲、让所有核看到最新的内存状态——等价于一个完整的 `StoreLoad` 屏障。用 `lock addl` 而不是 `mfence`，是因为它在实际 CPU 上更快。

这也解释了一个常见疑问：**"`volatile` 是不是加锁？"** ——不是。它不加锁、不阻塞线程，只是在关键位置插了一两条屏障指令。代价远低于锁，但也因此只提供可见性和有序性，不提供互斥。

### 用法示例

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

逐行看这段代码在保证什么：

- **① 与 ② 之间**：`StoreStore` 屏障保证"`config` 的赋值"一定先于"`ready = true`"完成。所以任何线程只要看到 `ready == true`，`config` 必然已经写好了；
- **② 是 volatile 写**：它让 `ready` 的新值立刻对别的线程可见；
- **③ 是 volatile 读**：读线程在这里拿到 `ready` 的最新值；`LoadLoad` + `LoadStore` 屏障保证后面的读（④）不会跑到它前面去；
- **④ 使用 `config`**：由于前面的屏障，这里读到的 `config` 一定是最新的、完整的。

所以 `volatile` 的价值不只是"`ready` 这个布尔值可见"，更是"**看到 `ready == true` 时，`config` 也一定已经准备好**"。这种"用 volatile 标志位发布一个对象"的模式，是并发编程里的经典用法——它的正式名字叫 **safe publication（安全发布）**。

![volatile 的可见性与内存屏障](/images/posts/java-volatile-visibility.svg)

这张图把 volatile 的两个保证拆成看得见的两列：左列是写，`config` 的准备在 StoreStore 屏障之前、`ready` 的写在屏障之后，屏障挡住了"写往前排"；右列是读，`ready` 的读在 LoadLoad 之后、`config` 的使用在 LoadStore 之前，屏障挡住了"读往后排"。可见性和有序性，一个管"能不能看到"，一个管"看到的时候顺序对不对"。

## 四、volatile 不保证什么：原子性

`volatile` 最容易被误用的地方，是以为它能让 `i++` 线程安全。

```java
private volatile int count = 0;

// 两个线程各执行 10000 次 count++，结果大概率 < 20000
count++;
```

`count++` 是"读、加一、写回"三步。`volatile` 保证的是"每次读都读到最新值、每次写都让别的线程可见"，但它**不保证这三步之间别的线程不插进来**。

具体怎么丢的更新：两个线程同时读到 `count == 5`，各自加一成 6，各自写回——两次自增只加了 1。丢更新的根子是"读改写不是原子的"，`volatile` 解决不了这个。

要原子地自增，得用 `AtomicInteger`（CAS）、`synchronized` 或锁。所以 `volatile` 的正确用途是：**一个线程写、多个线程读**的标志位、状态量；只要涉及"读-改-写"，`volatile` 就不够，得升级到 CAS 或锁。

还有两个容易忽略的边界：

- **`volatile` 数组只保证数组引用的可见性，不保证元素的可见性**。`volatile int[] arr` 的意思是"`arr` 这个引用本身是 volatile 的"，而 `arr[0] = 1` 是对**元素**的写，不受 `volatile` 保护。要元素级别的可见性，得用 `AtomicIntegerArray`。
- **32 位 JVM 上，非 volatile 的 `long` / `double` 读写可能不是原子的**（会被拆成两次 32 位操作），极端情况下可能读到一个"半个值"。加上 `volatile` 就保证了 64 位读写的原子性——这也算是 `volatile` 的一个附加收益。

## 五、happens-before：JMM 的规则

`volatile` 的保证，最终都落在一组叫 **happens-before（先行发生）** 的规则上。它定义了"操作 A 的结果对操作 B 可见"的条件。完整的规则有这些：

1. **程序顺序规则**：同一个线程内，按代码顺序，前面的操作 happens-before 后面的操作；
2. **volatile 规则**：对一个 `volatile` 字段的**写**，happens-before 后续对这个字段的**读**；
3. **监视器锁规则**：对一个锁的**解锁**，happens-before 后续对这个锁的**加锁**；
4. **线程启动规则**：`Thread.start()` happens-before 新线程中的**所有**操作；
5. **线程终止规则**：线程中的**所有**操作 happens-before 其他线程从它的 `join()` 成功返回；
6. **中断规则**：对线程 `interrupt()` 的调用 happens-before 被中断线程检测到中断；
7. **终结器规则**：对象的构造完成 happens-before 它的 `finalize()` 开始；
8. **传递性**：A happens-before B，B happens-before C，则 A happens-before C。

规则 4 和 5 很实用，但经常被忽略：**启动一个线程之前的操作，对那个新线程全部可见**（不用加 `volatile`）；**一个线程结束前的操作，对 `join` 它的线程全部可见**。如果你发现自己为了"把数据传给子线程"而加了一堆 `volatile`，那多半是多余的——`start()` 本身就建立了 happens-before。

### 一个必须澄清的误解：happens-before 不是"时间先后"

这是最容易搞错的一点：**happens-before 不是墙上时钟的先后顺序**。

它定义的是一个**可见性保证**：如果 A happens-before B，那么"A 的执行结果对 B 可见"，并且"在 B 看来，A 已经执行完了"。但它**不要求** A 在物理时间上真的先于 B 执行完——CPU 完全可以并行执行，只是保证 B 看到的效果是"A 先完成了"。

反过来更重要：**两个操作如果没有 happens-before 关系，即使看起来"一个在前面"，JMM 也不保证可见性**。第三节那个 `ready/config` 的例子，如果把 `ready` 的 `volatile` 去掉：`publish()` 里确实先写了 `config`、后写了 `ready`，在同一个线程里这是有先后顺序的；但**另一个线程读的时候，没有任何规则保证它能看到那个顺序**——它可能看到 `ready == true` 却看到旧的 `config`。这就是"没有 happens-before 关系 = 不保证可见性"的实际后果。

happens-before 的价值在于：它把"可见性"这个模糊的感觉，变成了**可推导的规则**。第三节 `ready/config` 的正确性就能这样推导出来：

```text
① 程序顺序：① config 赋值 happens-before ② ready = true
② volatile 规则：② ready 写 happens-before ③ ready 读
③ 程序顺序：③ ready 读 happens-before ④ use(config)
④ 传递性：① happens-before ④  →  config 的准备对消费方可见
```

这套推导，就是 JMM 给并发代码的"正确性证明"。写并发代码时，与其凭感觉加 `volatile`，不如这样一步步找 happens-before 链——链断了，那里就是 bug。

![happens-before 的规则体系与推导](/images/posts/happens-before-rules.svg)

## 六、经典案例：双重检查锁为什么要 volatile

单例模式的双重检查锁（DCL），是 `volatile` 最著名的应用，也是最容易被问倒的题。

```java
class Singleton {
    private static volatile Singleton instance;

    static Singleton getInstance() {
        if (instance == null) {              // ① 第一次检查
            synchronized (Singleton.class) {
                if (instance == null) {      // ② 第二次检查
                    instance = new Singleton();   // ③ 创建
                }
            }
        }
        return instance;
    }
}
```

### 两次检查各是干什么的

这段代码的精妙全在"为什么要检查两次"，逐层看：

- **① 第一次检查（锁外）**：单例创建成功后，后续**所有**调用都会看到 `instance != null`，于是直接在锁外返回——**完全不进入 `synchronized`**。这是性能关键：`synchronized` 有开销，不能让每次 `getInstance()` 都去抢锁。只有"实例还没创建"时的少数调用才会走到锁里。
- **② 加锁**：用类对象作锁，保证同一时刻只有一个线程能创建实例。
- **③ 第二次检查（锁内）**：为什么锁里还要再查一次？因为**可能有两个线程同时通过了 ①**——它们都看到 `instance == null`，于是在 ② 处排队等锁。线程 A 先进去、创建了实例、释放锁；线程 B 拿到锁时，如果不检查就往下执行，就会**创建出第二个实例**，单例就破了。第二次检查拦住的正是这种情况。

如果没有 ①（只有锁内一次检查），代码是线程安全的，但每次调用都要抢锁，性能差；如果没有 ②（只有锁外一次检查），那 `synchronized` 就白加了，多个线程会同时创建实例。**两次检查缺一不可，它们分别解决"性能"和"正确性"。**

### volatile 防的不是"创建两次"

现在看最关键的 `volatile`。很多人以为它防的是"重复创建"——**不是**，重复创建已经被第二次检查挡住了。`volatile` 防的是**"拿到半成品对象"**。

因为 `new Singleton()` 在 JVM 里**不是一步**，它拆成三步：

```text
① memory = allocate();     // 分配内存
② ctorInstance(memory);    // 调用构造器，初始化对象
③ instance = memory;       // 把引用赋给 instance
```

没有 `volatile` 时，**② 和 ③ 之间没有数据依赖**（③ 依赖的是 ① 分配的内存地址，不是 ② 的结果），所以编译器和 CPU 可以合法地把它们重排成：

```text
① memory = allocate();     // 分配内存
③ instance = memory;       // 先把引用暴露出去（此时对象还是半成品！）
② ctorInstance(memory);    // 再慢慢初始化
```

重排之后就有窗口期了：`instance` 已经不为 null，但它指向的对象**还没初始化完**。这时另一个线程走到 ① 第一次检查，看到 `instance != null`，直接返回这个半成品对象——用了就出错，而且这种 bug 极难复现。

加上 `volatile` 之后，`instance = memory` 这个赋值带上了 `StoreStore` 屏障，**禁止 ② 和 ③ 重排**——引用被暴露出去时，对象一定已经初始化完成了。所以 `volatile` 在这里防的是**重排**，不是重复创建。

![双重检查锁的重排与 volatile 的作用](/images/posts/java-dcl-volatile.svg)

这张图把"为什么是半成品"画了出来：正常顺序是"分配 → 初始化 → 赋引用"，重排后变成"分配 → 赋引用 → 初始化"，引用先暴露、初始化后发生，别的线程在中间窗口里拿到的就是没初始化的对象。`volatile` 挡的就是这个重排。理解了这张图，"双重检查锁为什么 volatile"这道题就从死记变成了推导。

`volatile` 是整个 Java 并发工具箱里最轻的一件：它不阻塞、不加锁，只靠"可见性 + 有序性"就能解决一大类"一写多读"的同步问题。但它的边界同样清晰——**不保证原子性，不保证 64 位之外的元素级可见性**。理解了它管什么、不管什么，再看 `synchronized`、`ReentrantLock`、CAS 这些下一层的工具，就有了对照的基准：它们都是在 `volatile` 给的可见性之上，再加上了互斥或原子操作。

## 参考资料

- [The Java Language Specification：Java Memory Model](https://docs.oracle.com/javase/specs/jls/se8/html/jls-17.html#jls-17.4)
- [JSR 133：Java Memory Model and Thread Specification](https://www.cs.umd.edu/~pugh/java/memoryModel/)
- [Oracle：volatile 关键字教程](https://docs.oracle.com/javase/tutorial/essential/concurrency/atomic.html)
