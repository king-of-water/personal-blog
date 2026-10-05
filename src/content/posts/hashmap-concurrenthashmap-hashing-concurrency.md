---
title: HashMap 与 ConcurrentHashMap：从哈希到并发安全
description: 拆解 HashMap 的哈希定位、链表与红黑树冲突处理、扩容时的 rehash 与高低位拆分，说明它为什么线程不安全（JDK 7 死循环到 JDK 8 的改进），再讲 ConcurrentHashMap 从分段锁到 CAS+synchronized 的演进。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 20
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, HashMap, ConcurrentHashMap, 哈希, 红黑树, 扩容, 分段锁, CAS, 线程安全]
---

`HashMap` 是 Java 里用得最多的数据结构之一，但它有个众所周知的坑：多线程下会出问题，轻则丢数据、重则死循环。于是又有了 `ConcurrentHashMap`。要真正理解"为什么 `HashMap` 不安全、`ConcurrentHashMap` 怎么做到安全"，得先看懂 `HashMap` 内部怎么组织数据——哈希、桶、链表、红黑树、扩容，这些机制是并发问题生长出来的土壤。

本文回答一个问题：`HashMap` 怎样用哈希把 Key 定位到桶、冲突和扩容怎么处理、为什么线程不安全；`ConcurrentHashMap` 又怎样在不锁全表的前提下做到并发安全。主要依据是 JDK 源码，版本差异会在关键处标注（默认 JDK 8+，它和 JDK 7 的差异正是理解演进的重点）。

## 一、HashMap 的核心：哈希定位到桶

`HashMap` 底层是一个数组，每个数组位置叫一个桶（bucket）。`put(key, value)` 时，先用 `key.hashCode()` 算哈希，再定位到某个桶；`get(key)` 走同样的定位。定位的公式是关键：

```java
// JDK 8 的 put 里，定位桶下标
int h = key.hashCode() ^ (key.hashCode() >>> 16); // 扰动：高 16 位和低 16 位异或
int index = (n - 1) & h;                          // n 是数组长度，且 n 是 2 的幂
```

两个细节值得记。第一，`(n - 1) & h` 能替代 `h % n`，前提是 `n` 是 2 的幂——这就是"为什么 `HashMap` 容量必须是 2 的幂"：位运算比取模快，而且容量翻倍时正好只有一位参与变化。第二，那个 `h >>> 16` 的扰动，是为了把 hashCode 的高位信息混进低位——因为 `(n - 1) & h` 只用到 h 的低几位（数组长度是 2 的幂，`n-1` 只有低位是 1），而很多对象的 hashCode 是高位差异大、低位差异小（比如按固定步长递增的整数，或内存地址的低位常常相同），直接取低位会让大量 Key 挤进同一个桶。扰动一下，高位的信息也参与了定位，分布才更均匀。

`put` 的完整流程可以串成五步：① 算 `hash`（含扰动）；② 用 `(n-1) & hash` 定位桶；③ 桶空，直接放进去；④ 桶不空，沿链表或红黑树找有没有 `equals` 相等的 Key，有就覆盖 value、没有就追加；⑤ 插入后检查是否要树化或扩容。`get` 是同样的前两步定位，然后沿链表或树找 Key。这条流程是理解后面所有行为——冲突、树化、扩容、并发——的骨架。

## 二、冲突怎么处理：链表，满了转红黑树

不同的 Key 可能定位到同一个桶，这就是哈希冲突。JDK 7 及以前，冲突的 Key 串成一条链表挂在桶上；JDK 8 起，链表太长了就转成红黑树，把查找从 O(n) 降到 O(log n)。

转换有阈值，而且两个条件要同时满足：**链表长度达到 8，且数组长度达到 64**，才树化；树节点数量降到 6，再退回链表。数组长度不够 64 时先扩容而不是树化——因为树化是有代价的，桶太少说明问题在"数组太小"，扩容更划算。

![HashMap 的数组、链表与红黑树结构](/images/posts/hashmap-structure.svg)

这张图要记的是"为什么不是纯数组"：哈希冲突不可避免，纯数组存不下两个同桶的 Key。链表解决冲突、红黑树解决"链表太长查得慢"，这是 `HashMap` 在"空间"和"查找速度"之间做的两段式权衡。

## 三、扩容：翻倍，然后把每个 Key 重新放一遍

当元素数量超过 `容量 × 负载因子`（默认 0.75），`HashMap` 触发扩容：数组长度翻倍，然后所有 Key 重新定位到新数组。扩容是 `HashMap` 最重的操作，也是并发问题的高发区。

扩容的完整动作是：① 新建一个两倍大的数组；② 遍历旧数组的每个桶；③ 对每个桶里的链表，按 `(oldCap & hash)` 拆成两段——结果为 0 的留在原下标，结果为 1 的挪到"原下标 + oldCap"；④ 把拆好的两段分别挂到新数组对应位置。整个过程不改变 Key 之间的相对顺序（尾插），这是和 JDK 7 头插的关键区别。

JDK 8 这个优化叫高低位拆分。因为数组长度是 2 的幂，翻倍后新下标只取决于哈希的某一位：`(旧长度) & hash` 为 0 的 Key 留在原桶，为 1 的 Key 挪到"原桶 + 旧长度"的位置。于是每个桶的链表在扩容时最多拆成两段，各走各的，不用逐个重新算下标。

![扩容时的高低位移拆分](/images/posts/hashmap-resize.svg)

这个优化把"全量 rehash"变成了"按一位拆分"，JDK 7 里每个元素都要重新算 `index` 的活儿省掉了大半。但它也引入了并发场景下的新行为——下一节说。

## 四、为什么线程不安全：从 JDK 7 死循环到 JDK 8 的改进

`HashMap` 没有任何同步，多线程同时 `put` 会怎样？两个线程同时扩容、同时操作同一个桶的链表，就可能出问题。

JDK 7 的问题是致命的：链表用**头插法**，并发扩容时可能把链表接成环。具体怎么成的环？JDK 7 扩容时，遍历旧链表、把每个节点用头插法插进新数组。两个线程同时扩容同一个桶：线程 A 把节点 x 摘下来、正要插进新位置，还没插完，线程 B 也来遍历同一个链表——它看到的链表已经被 A 改了一半，x 的 `next` 指向新位置，而新位置里的节点 `next` 又指回 x，环就形成了。之后 `get` 一个不在表里的 Key 时，会沿着环永远转下去，CPU 打满。JDK 8 改成尾插法、且按高低位一次性拆两段，不再逐个摘插，环的问题就没了。

JDK 8 把链表改成**尾插法**，扩容时也按高低位拆分，不再倒置链表，环的问题基本消除。但 `HashMap` 仍然线程不安全——只是从"可能死循环"降级成"可能丢数据、可能读到不一致的中间状态"。比如两个线程同时 `put` 不同的 Key，`size` 的 `++` 会丢更新；一个线程扩容时另一个线程 `get`，可能读到还没搬完的数据。所以"JDK 8 的 `HashMap` 多线程就不会死循环了"这句话对，但"所以可以用了"这句话错。

## 五、ConcurrentHashMap：从分段锁到 CAS + synchronized

`ConcurrentHashMap` 是线程安全版，但它的"安全"不是简单地在 `HashMap` 外面套一把大锁——那会退化成 `HashTable`，并发写全串行。它的演进有两条路线。

JDK 7 用**分段锁（Segment）**：把整个数组分成 16 段，每段一把锁，写操作只锁自己那段，不同段之间可以并行写。它把"锁全表"降成了"锁一段"，但锁的粒度还是粗——同一段里的两个不同桶，写的时候还是互相阻塞。默认 16 段，是在"并发度"和"内存开销"之间取的折中：段数越多、锁粒度越细、并发越高，但每段都要维护自己的锁和计数，成本也越高。

JDK 8 彻底重写了：放弃分段锁，改用 **CAS + synchronized**。`put` 时，如果桶是空的，用 CAS 把新节点直接放进去——成功即完成，全程无锁；如果桶不空（有链表或树），对这个桶的头节点加 `synchronized`，只锁这一个桶，锁内做和 `HashMap` 一样的"找 Key / 覆盖 / 追加 / 树化 / 扩容"。锁的粒度从"一段"细化到"一个桶"，并发度大幅提升。`get` 则完全不加锁，因为 `Node` 的 `val` 和 `next` 都是 `volatile`，读到的总是可见的最新值——这正是上一篇讲 JMM 时说的"堆上共享字段靠 `volatile` 保证可见性"的落地。

![ConcurrentHashMap 从分段锁到 CAS+synchronized 的演进](/images/posts/concurrenthashmap-evolution.svg)

这张图的核心是"锁的粒度在缩小"：`HashTable` 锁全表 → JDK 7 锁分段 → JDK 8 锁单个桶。粒度越细，写并发度越高，实现的复杂度也越高——`ConcurrentHashMap` 的演进史，就是一部"把锁做小"的历史。

`ConcurrentHashMap` 的扩容还有一个 `HashMap` 没有的设计：**多线程协同迁移**。一个线程触发扩容后，开始把旧数组的桶搬到新数组；其他线程在这期间来 `put`，发现正在扩容，不会傻等，而是领一段迁移任务、帮忙一起搬（`helpTransfer`）。于是扩容的活儿被多个线程分摊，不会因为一个触发扩容的线程慢而卡住整张表。这也是它高并发下仍能保持可用性的关键——`HashMap` 扩容是单线程扛，`ConcurrentHashMap` 扩容是大家一起扛。

## 六、两个容易被问倒的细节

`ConcurrentHashMap` 的 `size()` 怎么做到并发下相对准确？它不维护一个会被并发写坏的 `int size`，而是用 `baseCount` 加一个 `CounterCell[]` 数组：竞争低时直接 CAS 累加 `baseCount`，竞争高时不同线程往不同的 `CounterCell` 里累加，`size()` 时把两者加起来。这是"分散计数"的思路——把一个热点计数器拆成多个，避免所有线程抢同一个变量。

`ConcurrentHashMap` 为什么不允许 `null` 的 Key 和 Value？官方说法是：在并发场景下，`get(key)` 返回 `null` 会带来二义性——是"这个 Key 不存在"，还是"存了但值是 null"？`HashMap` 允许 null 是因为单线程下可以先用 `containsKey` 区分，但 `ConcurrentHashMap` 里这个区分是竞态的、不可靠的，所以干脆从根上禁止 null，消灭这个歧义。

## 七、怎么选

| 场景 | 选择 | 理由 |
| --- | --- | --- |
| 单线程、或局部变量临时用 | `HashMap` | 无同步开销，最快 |
| 多线程读多写少 | `ConcurrentHashMap` | `get` 无锁，读性能接近 `HashMap` |
| 多线程写也频繁 | `ConcurrentHashMap` | 桶级锁，并发度远高于 `HashTable` |
| 想要强一致的 `size` 或需要锁语义 | 看具体需求 | `ConcurrentHashMap` 的 `size` 是弱一致快照 |
| 想用 `HashMap` + 自己加锁 | 不建议 | 锁的粒度、读写互斥都要自己拿捏，易错 |

一条朴素的判断：只要涉及多线程，默认用 `ConcurrentHashMap`，别给 `HashMap` 手工套锁——套锁容易，套对粒度难。`ConcurrentHashMap` 的 `get` 无锁、写锁粒度细到桶，已经替你把最难的部分做完了。

## 参考资料

- [OpenJDK：HashMap 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/HashMap.java)
- [OpenJDK：ConcurrentHashMap 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/ConcurrentHashMap.java)
- [Oracle：HashMap JavaDoc](https://docs.oracle.com/javase/8/docs/api/java/util/HashMap.html)
- [Oracle：ConcurrentHashMap JavaDoc](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/ConcurrentHashMap.html)
