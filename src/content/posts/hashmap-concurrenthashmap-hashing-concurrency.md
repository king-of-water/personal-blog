---
title: HashMap 与 ConcurrentHashMap：从哈希到并发安全
description: 从「hash 值不等于索引位置」讲起，深入 HashMap 源码：put 完整流程、扩容 resize 的高低位拆分、树化与退化阈值、红黑树五条性质、负载因子 0.75 的权衡、JDK 7 头插死循环；再深入 ConcurrentHashMap：分段锁到 CAS+synchronized、为什么用 synchronized 而不是 ReentrantLock、sizeCtl 与 ForwardingNode 与 transfer 的多线程协同扩容、get 无锁与 baseCount+CounterCell 计数；最后补 LinkedHashMap 的 LRU 与被淘汰的 Hashtable。
category: 后端
subcategory: Java
articleClass: flagship
seriesOrder: 20
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, HashMap, ConcurrentHashMap, 哈希, 红黑树, 负载因子, 扩容, resize, 分段锁, CAS, ForwardingNode, sizeCtl, LinkedHashMap, LRU, Hashtable]
---

`HashMap` 和 `ConcurrentHashMap` 是 Java 里被问到最多的两个类，但大多数人对它们的理解停在"数组加链表、链表太长转红黑树、CHM 用 CAS 不用锁"这三句话。这三句话没错，却远远不够——真正决定它们行为的是几个具体的源码机制：`resize` 里那段"高低位拆分"、树化的精确阈值、JDK 7 头插法怎么把链表接成环、CHM 的 `sizeCtl` 怎么协调多个线程一起扩容。

这篇文章把这些机制摊开讲。目标是：读完你能自己复述出 `put` 的每一步、`resize` 的每一段拆分、以及 CHM 扩容时多个线程是怎么"认领"迁移任务的。主要依据是 JDK 8 的源码，JDK 7 的差异会单独标出来——它们之间的变化，正是理解"为什么要这样写"的钥匙。

## 一、数据结构：数组、链表、红黑树

`HashMap` 底层是一个 `Node<K,V>[] table` 数组，每个数组位置叫一个桶。`Node` 有 `hash`、`key`、`value`、`next` 四个字段——`next` 说明同一个桶里的冲突 Key 会串成一条单向链表。

当链表太长，查找退化成 O(n)，JDK 8 把长链表转成红黑树。树节点是 `TreeNode`（继承 `Node`），它有 `parent`、`left`、`right`、`prev` 等字段，构成一棵自平衡的二叉搜索树，查找降到 O(log n)。

所以 `HashMap` 的完整结构是"数组 + 链表 + 红黑树"三段式：数组负责快速定位，链表解决冲突，红黑树解决"链表太长查得慢"。三种结构在同一个桶里只会出现一种——要么空、要么链表、要么红黑树，树和链表不会同时挂在一个桶上。

![HashMap 的数组、链表与红黑树结构](/images/posts/hashmap-structure.svg)

## 二、hash 值不等于索引位置

先澄清一个最容易混的概念：**`hashCode()` 算出的 hash 值，不等于 Key 在数组里的索引位置**。这是两个环节、两个结果：

- **hash 值**是 Key 的 32 位整数摘要，由 `hashCode()` 经扰动得到。同一个 Key，hash 值永远不变。
- **索引位置**是"这个 Key 落在第几个桶"，由 `hash & (capacity - 1)` 决定。同一个 Key，**扩容后索引就可能变**。

中间隔着"按容量取模"这一步，所以两者不能混为一谈。理解这个区分，才能听懂后面"扩容要重新定位"和"高低位拆分"到底在做什么——变的从来不是 hash 值，是"hash 值对容量取模"的结果。

`put` 的第一步就是算索引，公式是 `(n - 1) & hash`，其中 `n` 是数组长度。这里有两个前提，缺一个公式就不成立。

**前提一：数组长度必须是 2 的幂。** 只有当 `n` 是 2 的幂时，`n - 1` 的二进制才是"低 k 位全是 1"（比如 `n=16`，`n-1=15=1111₂`），此时 `(n-1) & hash` 恰好等于 `hash % n`，而且位运算比取模快得多。这也是为什么 `HashMap` 的默认容量是 16、扩容永远是翻倍——保证容量一直是 2 的幂。

**前提二：hash 要先扰动。** 直接用 `key.hashCode()` 的低几位，分布往往很差——很多 hashCode 的高位差异大、低位差异小。JDK 8 的扰动函数是：

```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

它把 hashCode 的高 16 位和低 16 位做一次异或，让高位的信息"混进"低位。因为 `(n-1) & hash` 只用到 hash 的低几位（数组长度通常远小于 2^16），不扰动的话，高位差异根本参与不了定位，大量 Key 会挤进同一个桶。扰动一次，高位的随机性就传导到了定位里。

## 三、put 的完整流程

`put` 的每一步都有明确的判断，串起来是这样：

```java
final V putVal(int hash, K key, V value, ...) {
    Node<K,V>[] tab; Node<K,V> p; int n, i;
    // ① 表为空 → 先初始化（resize 里分配）
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;
    // ② 定位桶，桶为空 → 直接放新节点
    if ((p = tab[i = (n - 1) & hash]) == null)
        tab[i] = newNode(hash, key, value, null);
    else {
        Node<K,V> e; K k;
        // ③ 桶头就是目标 Key（hash 相等且 equals 相等）→ 覆盖
        if (p.hash == hash && ((k = p.key) == key || (key != null && key.equals(k))))
            e = p;
        // ④ 桶是红黑树 → 走树插入
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, hash, key, value);
        // ⑤ 桶是链表 → 遍历找 Key，找不到就尾插
        else {
            for (int binCount = 0; ; ++binCount) {
                if ((e = p.next) == null) {
                    p.next = newNode(hash, key, value, null);
                    if (binCount >= TREEIFY_THRESHOLD - 1)  // 链表长度达到 8
                        treeifyBin(tab, hash);              // 尝试树化
                    break;
                }
                if (e.hash == hash && ((k = e.key) == key || (key != null && key.equals(k))))
                    break;   // 找到目标 Key
                p = e;
            }
        }
        // 覆盖旧值
        if (e != null) { V oldValue = e.value; e.value = value; return oldValue; }
    }
    // ⑥ 新插入，计数 +1，超过阈值就扩容
    if (++size > threshold)
        resize();
    return null;
}
```

注意几个点。第一，判断 Key 相等是"`hash` 相等**且** `equals` 相等"——两个条件都要满足，所以重写 `equals` 必须同时重写 `hashCode`，否则"相等的 Key 定位到不同桶"，查不到。第二，链表插入是**尾插**（JDK 8），`binCount >= 7`（即链表长度到 8）才触发树化，这是下一节要展开的。第三，`size > threshold` 就扩容，`threshold = 容量 × 负载因子`，默认负载因子 0.75。

`get` 是 `put` 的"只读版"，同样先定位、再查找：算 hash → `(n-1) & hash` 定位桶 → 桶头 hash 和 equals 都匹配就返回 → 否则沿链表或树查找。它没有写路径的树化、扩容判断，所以逻辑简单得多。理解了 `put`，`get` 只是一次没有副作用的定位 + 遍历。

## 四、扩容 resize：高低位拆分

当 `size > threshold`，触发 `resize()`：数组容量翻倍，所有 Key 重新定位。这是 `HashMap` 最重、也最容易出并发问题的操作。

JDK 8 的关键优化是**高低位拆分**——不用逐个重新算下标，而是按 hash 的某一位，把每个桶的链表一次拆成两段：

```java
// resize 里遍历旧桶的核心逻辑（简化）
for (int j = 0; j < oldCap; ++j) {
    Node<K,V> e = oldTab[j];
    if (e == null) continue;
    Node<K,V> loHead = null, loTail = null;   // 低位链
    Node<K,V> hiHead = null, hiTail = null;   // 高位链
    do {
        Node<K,V> next = e.next;
        if ((e.hash & oldCap) == 0) {          // 关键判断
            // 追加到低位链（留在原下标 j）
        } else {
            // 追加到高位链（挪到 j + oldCap）
        }
    } while ((e = next) != null);
    newTab[j] = loHead;         // 低位链挂回原下标
    newTab[j + oldCap] = hiHead; // 高位链挂到 j + oldCap
}
```

为什么 `(e.hash & oldCap)` 这一位就能决定新位置？因为 `oldCap` 是 2 的幂（比如 16 = `10000₂`），扩容前定位用 `(oldCap-1) & hash`（只取低 4 位），扩容后定位用 `(newCap-1) & hash`（取低 5 位）。新旧下标只差"第 5 位"这一位——`oldCap & hash` 正是取这一位。这一位是 0，新下标 = 旧下标；这一位是 1，新下标 = 旧下标 + oldCap。

于是每个桶的链表在扩容时**最多拆成两段**，两段各自保持原有顺序（尾插），不用像 JDK 7 那样逐个重新算 `index`。这也是 JDK 8 相对 JDK 7 在扩容上的核心改进——下一节说 JDK 7 为什么没这个改进会出事。

![扩容时的高低位拆分](/images/posts/hashmap-resize.svg)

## 五、树化与退化：8、6、64 三个阈值

链表转红黑树有三个阈值，很多人只记得"8"这一个，其实有两个条件和一个退路。

**树化的两个条件**：链表长度达到 8（`binCount >= TREEIFY_THRESHOLD - 1`），**且**数组长度达到 64（`MIN_TREEIFY_CAPACITY`）。链表到 8 但数组不够 64 时，`treeifyBin` 不会真的树化，而是先 `resize` 扩容——因为数组太小，问题在于"桶太少、冲突太集中"，扩容把 Key 摊开比树化更划算。

**退化**：树节点减少到 6（`UNTREEIFY_THRESHOLD`），红黑树转回链表。

为什么是 8？JDK 源码注释里给了一个概率解释：如果 hashCode 分布良好，冲突近似泊松分布，一个桶里挂 8 个节点的概率约为千万分之一（`0.00000006`）。也就是说，正常情况下链表根本到不了 8，真到了 8，多半是 hashCode 写得烂或有人恶意构造，此时转红黑树是"防退化的兜底"。8 和 6 之间留了 2 的差值，是为了避免"树和链表在 7 附近反复横跳"的抖动。

## 六、红黑树特性：为什么用它替链表

`HashMap` 选的不是普通二叉搜索树，而是**红黑树**。原因是普通二叉搜索树在极端情况下会退化成链表——按顺序插入 1、2、3、4、5，树会长成一条"斜链"，查找又回到 O(n)。红黑树用一组约束保证**近似平衡**，把最坏情况的查找锁在 O(log n)。

红黑树的性质有五条：

1. 每个节点是红色或黑色；
2. 根节点是黑色；
3. 每个叶子节点（NIL 空节点）是黑色；
4. 红色节点的两个子节点必须是黑色（**不能有连续的红色**）；
5. 从任一节点到它所有叶子的路径，包含**相同数目的黑色节点**。

第 4 条和第 5 条是关键。第 4 条禁止"红红相连"，第 5 条保证"黑高一致"，两条合起来把**最长路径限制在最短路径的两倍以内**——最短路径全是黑节点，最长路径只能是"黑红交替"，而黑色节点数又被第 5 条锁死。于是树高被压在 O(log n)，查找、插入、删除都是 O(log n)。

**它是怎么维持平衡的**：插入或删除后如果违反了上面某条性质，就靠**左旋、右旋**改变局部结构，再配合**重新着色**修正。旋转只动几个指针、成本 O(1)，一次插入最多两次旋转，删除最多三次。这正是红黑树相对 AVL 树的取舍——AVL 树平衡更严格（查询略快），但插入删除要旋转更多次；红黑树放松一点平衡约束，换来更少的旋转次数，更适合"增删查都频繁"的场景，而 `HashMap` 恰好就是这种场景。

**那为什么阈值要 8 才树化**：树节点 `TreeNode` 比链表节点 `Node` 占的内存大得多（多了 `parent`、`left`、`right`、`red` 等字段），而红黑树查找虽然渐进复杂度更优，常数因子也比遍历短链表大。所以只有在"链表真的长了"时才值得付这个空间成本——上一节那个千万分之一的概率就是用来说明：绝大多数桶用链表就够了，树是极少数情况下的兜底。

![红黑树的五条性质与旋转](/images/posts/hashmap-red-black-tree.svg)

## 七、负载因子 0.75：在空间和冲突之间权衡

`threshold = capacity × loadFactor`，默认 `loadFactor = 0.75`。这个 0.75 不是随手定的，它平衡的是**空间利用率**和**冲突概率（查询效率）**这两件事。

**调大**负载因子（比如 1.0）：桶要装得更满才扩容，空间利用率高，但代价是冲突概率上升——桶里平均元素变多、链表变长、查询变慢，也更容易触发树化。等效于"省内存，费查询"。

**调小**负载因子（比如 0.5）：桶装一半就扩容，冲突少、查询快，但数组利用率低，而且**扩容更频繁**——每次扩容都要新建数组、把所有元素重新 hash 一遍，开销很大。等效于"费内存、费 CPU，换查询快"。

0.75 就是这两个方向的折中点。它还有一个数学上的便利：容量是 2 的幂时，`capacity × 0.75` 仍然是整数（`16 × 0.75 = 12`、`32 × 0.75 = 24`），阈值不用取整，实现干净。源码注释里的说法也是这个意思——0.75 让空间开销和查找开销在统计上取得较好的折中，同时让桶内元素数的期望值维持在一个很小的量级（这也是"链表长度到 8"属于极小概率的前提）。

**那要不要改它**：一般不要，默认值已经调好。确知"内存紧张、能接受查询略慢"可以往上调（上限 1.0）；确知"查询是瓶颈、内存充足"可以往下调——但往下调会明显增加扩容次数，得连着一起评估。

## 八、JDK 7 的头插死循环：为什么改了

JDK 7 的 `HashMap` 在并发扩容时会死循环，这是它最著名的坑。根源是 JDK 7 的两个设计：链表用**头插法**，且扩容时**逐个节点重新插入**新数组。

死循环的成环过程：扩容时，线程 A 遍历旧链表的节点 `x`，用头插法把它插到新桶（`x.next = newHead`）；在 A 还没完成整个链表迁移时，线程 B 也来扩容同一个桶，它看到的旧链表已经被 A 改了一半——`x.next` 指向了新位置，而新位置里的节点 `next` 又指回 `x`。两个线程反复头插、反复倒置，链表最终接成一个环。之后 `get` 一个不在表里的 Key，会沿着环永远转下去，CPU 打满。

JDK 8 的两个改动恰好拆掉了这个炸弹：一是**尾插法**（不再倒置链表顺序），二是**高低位拆分**（每个桶一次拆成两段、不再逐个摘插）。尾插保证链表顺序不变，拆分保证迁移过程更"原子"，环就形成不了了。但要记住：JDK 8 只是消除了死循环，`HashMap` 依然线程不安全——多线程同时 `put` 还是会丢数据、读到不一致的中间态。

## 九、ConcurrentHashMap：从分段锁到 CAS + synchronized

`ConcurrentHashMap` 的线程安全，不是"给 `HashMap` 套把大锁"（那是 `Hashtable`，并发写全串行），它的演进有两条路线。

JDK 7 用**分段锁（Segment）**：把整个数组分成 16 段，每段一把 `ReentrantLock`，写操作只锁自己那段，不同段可以并行写。它把"锁全表"降成"锁一段"，但粒度仍粗——同一段里的两个不同桶，写时还互相阻塞。

JDK 8 彻底重写，放弃分段锁，改用 **CAS + synchronized**，锁的粒度细化到**单个桶**。`put` 的完整流程，一个循环里装着四条分支：

```java
for (Node<K,V>[] tab = table;;) {
    Node<K,V> f; int n, i, fh;
    if (tab == null || (n = tab.length) == 0)
        tab = initTable();                       // ① 表未初始化
    else if ((f = tabAt(tab, i = (n-1) & hash)) == null) {
        if (casTabAt(tab, i, null, new Node(hash, key, value)))
            break;                               // ② 空桶：CAS 插入，无锁
    }
    else if ((fh = f.hash) == MOVED)
        tab = helpTransfer(tab, f);              // ③ 正在扩容：帮忙迁移
    else {
        synchronized (f) {                       // ④ 非空桶：锁桶头节点
            // 在锁内：链表/树里找 Key、尾插或覆盖、检查树化
        }
    }
}
```

这四条分支把 CHM 的并发设计暴露得很清楚：空桶用 CAS 无锁插入，非空桶锁桶头节点，正在扩容就去帮忙——每一条都是为了"把锁做小、把等待做短"。

锁的粒度从"一段"缩到"一个桶"，并发度大幅提升。之所以敢用 `synchronized`，是因为 JDK 6 之后 `synchronized` 有了锁升级（偏向锁、轻量级锁），在"锁竞争不激烈"时性能已经很好，配合"锁单个桶头节点"这种短临界区，绰绰有余。

**那为什么用 `synchronized` 而不是 `ReentrantLock`？** 这是 CHM 设计里被问得最多的一个问题，答案有三层。

**第一层：够用。** CHM 的临界区极短——只包住"一个桶里的链表/树遍历与插入"。这种短临界区在 `synchronized` 的锁升级路径里，绝大多数时候落在偏向锁（无竞争，几乎零开销）或轻量级锁（轻度竞争，CAS 自旋），根本走不到需要挂起线程的重量级锁。既然落不到重量级，`ReentrantLock` 那套等待队列和 `park/unpark` 的优势就发挥不出来。

**第二层：省内存。** `ReentrantLock` 是一个实实在在的对象，每个实例都带自己的 AQS 同步队列、`state` 字段、`exclusiveOwnerThread` 引用。CHM 的桶数量随容量增长（16 → 32 → 64 …），如果每个桶都配一把 `ReentrantLock`，光锁对象就是一笔可观的内存开销。而 `synchronized` 的锁信息直接编码在**对象头的 Mark Word** 里（第一篇讲对象内存布局时提过），不给桶额外分配任何锁对象——"每桶一把锁"的内存成本因此是零。

**第三层：省去锁对象的管理麻烦。** 用 `ReentrantLock` 就要管创建、持有、释放，还要时刻提防忘记 `unlock`；而 CHM 在扩容时桶头节点会被搬走、被替换成 `ForwardingNode`，锁定对象的生命周期本身就更复杂。`synchronized` 锁的是"当前桶头节点这个对象"，代码块结束自动释放，没有这些负担。

一句话总结：**JDK 8 的选择是用 Mark Word 里的内置锁，把"每桶一把锁"的内存成本降为零，代价是放弃 `ReentrantLock` 独有的超时、可中断、公平——而 CHM 的短临界区并不需要这些能力。**

![ConcurrentHashMap 从分段锁到 CAS+synchronized 的演进](/images/posts/concurrenthashmap-evolution.svg)

## 十、ConcurrentHashMap 的扩容：多线程协同迁移

CHM 的扩容是它和 `HashMap` 最大的区别，也是最该看源码的部分。核心围绕一个字段 `sizeCtl` 和一个节点 `ForwardingNode`。

**`sizeCtl`** 是一个"一字段多用"的控制量，不同取值含义不同：

```text
sizeCtl = 0       : 默认，初始化表时用
sizeCtl = -1      : 某个线程正在初始化表
sizeCtl = -(1+n)  : 有 n 个线程正在帮忙扩容
sizeCtl = 正数    : 下一个扩容阈值（0.75 × 表大小）
```

**扩容触发后**，CHM 不是让一个线程闷头搬，而是**多线程协同迁移**。迁移的核心方法 `transfer` 里，把旧数组按 `stride`（最小 16 个桶）切成一段段任务，每个线程用 CAS 在 `transferIndex` 上"认领"一段，认领到就搬自己那段：

```java
// transfer 里认领迁移任务的简化逻辑
while (advance) {
    if (transferIndex <= 0) break;            // 没有可领的段了
    int nextIndex = transferIndex;
    int nextBound = (nextIndex > stride) ? nextIndex - stride : 0;
    // CAS 抢这一段 [nextBound, nextIndex)
    if (U.compareAndSwapInt(this, TRANSFERINDEX, nextIndex, nextBound)) {
        // 认领成功，迁移这一段桶
        advance = false;
    }
}
```

**`ForwardingNode`** 是迁移完成的标记：一个桶迁移完后，原位置放一个 `ForwardingNode`（它的 `hash` 是特殊值 `MOVED`），里面保存新数组的引用。别的线程 `put`/`get` 遇到 `ForwardingNode`，就知道"这个桶搬走了，去新数组找"。更重要的是 `helpTransfer`：线程 `put` 时发现当前桶是 `ForwardingNode`（说明正在扩容），就顺手**帮忙迁移一段**，而不是傻等——这就是"多线程一起扩容"的实现。

这套机制的效果是：扩容的活儿被多个线程分摊，一个线程触发扩容后不会卡住整张表，其他线程来访问时顺手搭把手。这是 CHM 在高并发下保持可用的关键，也是"CHM 扩容比 HashMap 快"这句话的真正含义——不是单线程快，是"大家一起搬"。

![ConcurrentHashMap 的多线程协同扩容](/images/posts/concurrenthashmap-transfer.svg)

## 十一、get 无锁和 size 计数

**`get` 全程无锁**。CHM 的 `get` 不阻塞、不加锁，靠的是 `Node` 的 `val` 和 `next` 字段都声明为 `volatile`，读到的总是最新可见值。`get` 的流程：定位桶 → 桶是 `ForwardingNode` 就去新数组 → 桶头是目标就返回 → 否则沿链表/树找。整条路径没有一个 `synchronized` 或 CAS 写入，这也是上一篇 volatile 里"堆上共享字段靠 volatile 保证可见性"的直接应用。

**`size()` 的计数**则用"分散计数"解决热点：不维护一个会被并发写坏的 `int size`，而是用 `baseCount` 加一个 `CounterCell[]` 数组。竞争低时，直接 CAS 累加 `baseCount`；竞争高时（CAS 失败），线程去不同的 `CounterCell` 里累加；`size()` 时把 `baseCount` 和所有 `CounterCell` 加起来。这样"统计总大小"这个高频写，被摊到了多个计数器上，避免了所有线程抢同一个变量的瓶颈。`size()` 返回的是弱一致的快照，不是精确瞬时值——这是它"无锁、高性能"的代价。

## 十二、LinkedHashMap 与 Hashtable：两个近亲

### LinkedHashMap：在 HashMap 上挂一条双向链表

`LinkedHashMap` 继承 `HashMap`，只多做了一件事——在 `HashMap` 的节点上再挂一条**双向链表**，把"插入顺序"或"访问顺序"串起来。

它的节点是 `Entry`（继承 `HashMap.Node`），多了 `before` 和 `after` 两个指针。哈希表那部分完全复用 `HashMap`，所以查找仍是 O(1)；额外那条双向链表只决定**遍历顺序**。

关键在构造参数 `accessOrder`：

- `accessOrder = false`（默认）：链表维护**插入顺序**，遍历时按插入先后输出；
- `accessOrder = true`：链表维护**访问顺序**，每次 `get`/`put` 命中一个节点，就把它移到链表尾部。

`accessOrder = true` 让它天然支持 **LRU（最近最少使用）**：链表头部就是"最久没被访问"的元素。再重写 `removeEldestEntry`，就能实现"超出容量自动淘汰最久未用"：

```java
class LRUCache<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;

    LRUCache(int capacity) {
        super(capacity, 0.75f, true);   // 第三个参数 accessOrder = true
        this.capacity = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;       // 超容量就淘汰链表头部（最久未用）
    }
}
```

这就是"用 `LinkedHashMap` 几行实现 LRU"的由来，也是它最常被考的点。要注意两点：`accessOrder = true` 时 `get` 也是**结构性修改**（会动链表），并发下更不安全；它不影响 `HashMap` 那套扩容和树化逻辑，只是多维护一条链。

![LinkedHashMap 的双向链表与 LRU 淘汰](/images/posts/linkedhashmap-lru.svg)

### Hashtable：被淘汰的"线程安全版"

`Hashtable` 是 Java 最早的线程安全 Map：它所有方法都加 `synchronized`，锁的是**整个 Hashtable 对象**——任何读写都要抢同一把锁，并发写完全串行。本质上就是"给 `HashMap` 套一把大锁"。

它和 `HashMap` 还有几处不同：

| 维度 | HashMap | Hashtable |
| --- | --- | --- |
| 线程安全 | 不安全 | 安全（全表锁） |
| null 键值 | 允许（key 一个 null、value 可多个） | 都不允许 |
| 初始容量 | 16，扩容翻倍 | 11，扩容 `2n + 1` |
| 迭代器 | fail-fast | fail-fast（但 `Enumeration` 不是） |
| 现状 | 主要选择 | 已淘汰，只在遗留代码里见 |

它出局的理由只有一条：**锁粒度太粗**。并发场景下 `ConcurrentHashMap` 用"CAS + 桶级锁"把并发度做了上去，`Hashtable` 却始终是全表一把锁。今天写新代码，线程安全需求一律用 `ConcurrentHashMap`；`Hashtable`（以及 `Collections.synchronizedMap()` 包装出来的 Map，同一套全表锁思路）只在读老代码时才会遇到。

## 十三、怎么选

| 场景 | 选择 | 理由 |
| --- | --- | --- |
| 单线程、局部临时用 | `HashMap` | 无同步开销，最快 |
| 需要记住插入顺序 / 实现 LRU | `LinkedHashMap` | 在 HashMap 上挂双向链表，`accessOrder` 支持 LRU |
| 多线程读多写少 | `ConcurrentHashMap` | `get` 无锁，读性能接近 `HashMap` |
| 多线程写也频繁 | `ConcurrentHashMap` | 桶级锁 + 协同扩容，并发度远高于 `Hashtable` |
| 想要精确的 `size` | 看需求 | CHM 的 `size` 是弱一致快照 |
| 需要有序的线程安全 Map | `ConcurrentSkipListMap` | 跳表实现，有序 + 并发安全 |
| `Hashtable` | 换掉 | 全表锁已淘汰，用 `ConcurrentHashMap` |
| 想用 `HashMap` + 自己加锁 | 不建议 | 锁粒度、读写互斥要自己拿捏，易错 |

一条朴素的判断：只要涉及多线程，默认 `ConcurrentHashMap`，别给 `HashMap` 手工套锁。套锁容易，套对粒度难——CHM 的 `get` 无锁、写锁细到桶、扩容还多线程协同，已经把最难的部分做完了。

把这两张图记牢，`HashMap` 和 `ConcurrentHashMap` 就不再是"背几个概念"：HashMap 靠"2 的幂 + 扰动 + 高低位拆分"把哈希和扩容做快，代价是线程不安全；CHM 靠"CAS + 桶级锁 + sizeCtl 协同扩容 + volatile 无锁读"把安全做到细粒度，代价是实现复杂度。理解了机制，那些"为什么容量是 2 的幂""为什么树化阈值是 8""CHM 扩容为什么快"的问题，就都有了答案。

## 参考资料

- [OpenJDK：HashMap 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/HashMap.java)
- [OpenJDK：ConcurrentHashMap 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/ConcurrentHashMap.java)
- [Oracle：HashMap JavaDoc](https://docs.oracle.com/javase/8/docs/api/java/util/HashMap.html)
- [Oracle：ConcurrentHashMap JavaDoc](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/ConcurrentHashMap.html)
