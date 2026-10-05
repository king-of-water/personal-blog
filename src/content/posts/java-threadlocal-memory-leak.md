---
title: ThreadLocal：线程私有变量、ThreadLocalMap 与内存泄漏
description: 深入 ThreadLocal 源码：ThreadLocalMap 的开放地址法与线性探测、threadLocalHashCode 的黄金分割散列、set/get 的完整流程、Entry 的弱引用 key 与强引用 value 的引用链、expungeStaleEntry/cleanSomeSlots/rehash 的清理与扩容，以及内存泄漏的精确成因。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 60
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, ThreadLocal, ThreadLocalMap, 线性探测, 弱引用, 强引用, expungeStaleEntry, 内存泄漏, InheritableThreadLocal]
---

`ThreadLocal` 给每个线程一份变量副本，但它的实现里藏着一套不那么显眼的机制：值不是存在 `ThreadLocal` 对象里，而是存在每个 `Thread` 自己的一张 `ThreadLocalMap` 里，这张表用**开放地址法**解决冲突，`key` 是**弱引用**、`value` 是**强引用**，靠 `expungeStaleEntry` 惰性清理。内存泄漏的根源，全在这几个设计细节里。

大多数讲 `ThreadLocal` 的文章停在"用完记得 `remove`，否则内存泄漏"，却不讲"为什么 key 是弱引用、value 是强引用"、"泄漏时到底谁引用着谁"、"`ThreadLocalMap` 是怎么清理和扩容的"。这几个问题不讲清，`remove` 就只是一条要死记的规矩，而不是推导出来的必然结论。

本文把 `ThreadLocal` 的源码机制摊开讲。目标是：读完你能画出 `Thread → ThreadLocalMap → Entry → value` 的完整引用链，说清弱引用 key 的设计意图，以及 `set`/`get`/`remove` 分别触发了什么清理。主要依据是 JDK 8 源码。

## 一、存储结构：值存在 Thread 的 ThreadLocalMap 里

`ThreadLocal` 最反直觉的一点：**值不是存在 `ThreadLocal` 对象里**。每个 `Thread` 对象有两个字段——`threadLocals` 和 `inheritableThreadLocals`，类型都是 `ThreadLocal.ThreadLocalMap`。`ThreadLocal.set(v)` 的实际动作是 `Thread.currentThread().threadLocals.set(this, v)`，也就是"拿当前线程的那张表，以这个 `ThreadLocal` 对象作 key，把 v 存进去"。

`ThreadLocalMap` 是一个**自定义的哈希表**，不是 `HashMap`，它有三个关键设计：

```java
static class ThreadLocalMap {
    static class Entry extends WeakReference<ThreadLocal<?>> {
        Object value;                       // value 是强引用
        Entry(ThreadLocal<?> k, Object v) {
            super(k);                       // key 是弱引用（传给 WeakReference 构造器）
            value = v;
        }
    }
    private Entry[] table;                   // 开放地址法的数组
    private int size = 0;
    private int threshold;                   // 扩容阈值 = table.length * 2/3
}
```

第一，`Entry` 继承 `WeakReference<ThreadLocal<?>>`——`key` 是弱引用、`value` 是强引用，这个不对称是内存泄漏的根。第二，它用**开放地址法（线性探测）**解决哈希冲突，而不是 `HashMap` 的"数组 + 链表"链地址法——冲突时往下找下一个空位。第三，阈值是 `2/3`，比 `HashMap` 的 `0.75` 更早触发扩容，因为它要留余量给"清理"。

![ThreadLocal 的值存在每个 Thread 自己的表里](/images/posts/java-threadlocal-structure.svg)

这张图解释了"线程私有"是怎么实现的：同一个 `ThreadLocal` 对象作 key，在不同线程的 `threadLocals` 表里映射到不同的 value。value 跟着线程走，线程结束、表被回收，value 也一起回收。

## 二、threadLocalHashCode 与线性探测

`ThreadLocalMap` 用开放地址法，所以每个 `ThreadLocal` 需要一个散列值来决定初始位置。这个散列值不是 `hashCode()`，而是：

```java
private final int threadLocalHashCode = nextHashCode();
private static AtomicInteger nextHashCode = new AtomicInteger();
private static final int HASH_INCREMENT = 0x61c88647;   // 黄金分割比

private static int nextHashCode() {
    return nextHashCode.getAndAdd(HASH_INCREMENT);
}
```

`0x61c88647` 是黄金分割比（约 0.618）乘 2^32 得到的数。每个新创建的 `ThreadLocal`，它的 `threadLocalHashCode` 就是上一个的值加上这个常数。这样做的效果是：**连续的 `ThreadLocal` 在 2 的幂大小的表里，初始位置会被均匀错开**，而不是挤在一起。它配合"开放地址法"，让"不同 `ThreadLocal` 落到不同 slot、冲突了就线性探测下一个"这套逻辑，在大多数情况下能直接命中。

线性探测的 `nextIndex` 很简单，走到末尾就绕回开头：

```java
private static int nextIndex(int i, int len) {
    return ((i + 1 < len) ? i + 1 : 0);
}
```

## 三、set 的完整流程

`set` 是理解 `ThreadLocalMap` 的核心，因为它既插入、又顺便清理：

```java
private void set(ThreadLocal<?> key, Object value) {
    Entry[] tab = table;
    int len = tab.length;
    int i = key.threadLocalHashCode & (len - 1);    // ① 定位初始 slot
    for (Entry e = tab[i]; e != null; e = tab[i = nextIndex(i, len)]) {
        ThreadLocal<?> k = e.get();
        if (k == key) {                             // ② key 匹配 → 覆盖 value
            e.value = value;
            return;
        }
        if (k == null) {                            // ③ 遇到 stale entry → 替换
            replaceStaleEntry(key, value, i);
            return;
        }
    }
    tab[i] = new Entry(key, value);                 // ④ 找到空位 → 插入
    int sz = ++size;
    if (!cleanSomeSlots(i, sz) && sz >= threshold)  // ⑤ 惰性清理 + 判断扩容
        rehash();
}
```

流程里的第 ③ 步是 `ThreadLocal` 独有的：`k == null` 表示这个 Entry 的 key（弱引用的 `ThreadLocal`）已经被 GC 回收了，留下一个"脏"槽位。`set` 遇到它就调 `replaceStaleEntry` 把它替换掉——这就是"惰性清理"的一种，`set` 顺路把脏槽位打扫了。

第 ⑤ 步的 `rehash()` 也不是简单扩容，它先做一次全表清理，清理完还不够才扩容，这个在第五节展开。

## 四、get 的完整流程

`get` 同样带清理逻辑：

```java
private Entry getEntry(ThreadLocal<?> key) {
    int i = key.threadLocalHashCode & (table.length - 1);
    Entry e = table[i];
    if (e != null && e.get() == key)
        return e;                          // 直接命中
    else
        return getEntryAfterMiss(key, i, e);  // 未命中：线性探测 + 清理 stale
}

private Entry getEntryAfterMiss(ThreadLocal<?> key, int i, Entry e) {
    Entry[] tab = table;
    int len = tab.length;
    while (e != null) {
        ThreadLocal<?> k = e.get();
        if (k == key) return e;            // 找到了
        if (k == null)
            expungeStaleEntry(i);          // 遇到 stale → 清理
        else
            i = nextIndex(i, len);         // 继续线性探测
        e = tab[i];
    }
    return null;                           // 没有这个 key
}
```

注意 `get` 也可能触发 `expungeStaleEntry`——它不只是"读"，还会"打扫"。这也是"惰性清理"的另一处：靠 `get`/`set` 这些常规操作路过时清理脏槽位，而不是专门的 GC 线程去清。

## 五、清理与扩容：expungeStaleEntry、cleanSomeSlots、rehash

"惰性清理"里最核心的是 `expungeStaleEntry`，它清理一个脏槽位，并顺手把它后面连续的非空 Entry 重新定位：

```java
private int expungeStaleEntry(int staleSlot) {
    Entry[] tab = table;
    int len = tab.length;
    tab[staleSlot].value = null;   // 断开 value 的强引用
    tab[staleSlot] = null;         // 删除这个 Entry
    size--;
    // 往后 rehash 连续的非空 Entry
    Entry e; int i;
    for (i = nextIndex(staleSlot, len); (e = tab[i]) != null; i = nextIndex(i, len)) {
        ThreadLocal<?> k = e.get();
        if (k == null) {           // 又遇到 stale，继续删
            e.value = null;
            tab[i] = null;
            size--;
        } else {                   // 非 stale，重新定位到它该在的 slot
            int h = k.threadLocalHashCode & (len - 1);
            if (h != i) {
                tab[i] = null;
                while (tab[h] != null) h = nextIndex(h, len);
                tab[h] = e;
            }
        }
    }
    return i;
}
```

为什么要"往后 rehash"？因为开放地址法下，一个 Entry 之所以不在它 hash 计算出的位置，是因为插入时那个位置被占了、往后探测放到了别处。现在删掉一个前面的 Entry，空出了位置，后面那些"错位"的 Entry 就可以（也需要）挪回更靠前的位置，否则 `get` 时线性探测会漏掉它们。这个"清理 + 重新排位"是 `ThreadLocalMap` 比 `HashMap` 复杂的地方——`HashMap` 的链表删除只要改 `next` 指针，开放地址法的删除却要连锁处理后续节点。

`cleanSomeSlots` 是更轻量的清理，做 O(log n) 次探测、只清理碰巧遇到的 stale：

```java
private boolean cleanSomeSlots(int i, int n) {
    boolean removed = false;
    Entry[] tab = table;
    int len = tab.length;
    do {
        i = nextIndex(i, len);
        Entry e = tab[i];
        if (e != null && e.get() == null) {   // 碰巧遇到 stale
            n = len;
            removed = true;
            i = expungeStaleEntry(i);         // 清理
        }
    } while ((n >>>= 1) != 0);                // O(log n) 次
    return removed;
}
```

`rehash`（扩容入口）则先全表清理、清理后还超阈值才真正扩容：

```java
private void rehash() {
    expungeStaleEntries();                  // 先全表清一遍 stale
    if (size >= threshold - threshold / 4)  // 清完仍超过阈值的 3/4
        resize();                           // 才扩容到 2 倍
}
```

`resize` 把表翻倍，重新 hash 所有非 stale 的 Entry 到新表，顺便把 stale 的 value 断开。于是"清理"和"扩容"是绑在一起的：扩容前先清，清理能腾出空间就不必扩容。

![ThreadLocalMap 的线性探测与 stale 清理](/images/posts/java-threadlocal-map.svg)

## 六、强弱引用与内存泄漏的精确成因

现在可以精确地画出内存泄漏的引用链了。

`Thread`（线程对象）→ `threadLocals` 字段（强引用）→ `ThreadLocalMap` → `Entry[]` → `Entry` 对象 → `value` 字段（强引用）→ 你存的值。这条链上**每一环都是强引用**，所以只要线程活着，`value` 就活。

而 `Entry` 到 `ThreadLocal`（key）的引用是**弱引用**（`Entry extends WeakReference<ThreadLocal<?>>`）。当外部没有强引用指向这个 `ThreadLocal` 对象时，它会被 GC 回收，此时 `Entry` 的 key 变成 `null`，但 `Entry` 和它的 `value` 还在表里、还被上面的强引用链拴着。

于是泄漏的精确表述是：**key 被回收后，value 失去了"该由哪个 ThreadLocal 拥有"的标识，却还挂在线程的表里**。`get`/`set` 路过时会靠 `expungeStaleEntry` 清理掉它们，但这个清理是"碰巧路过才清"——如果这个 `ThreadLocal` 再也没人访问，脏 Entry 就永远留在表里。线程池场景把这个坑放大：线程长期复用，表也跟着长期存活，脏 Entry 越积越多，value 占的内存收不回。

![key 被回收后，value 残留造成泄漏](/images/posts/java-threadlocal-leak.svg)

**为什么 key 要设计成弱引用？** 是为了让 `ThreadLocal` 对象本身在业务不再使用它时能被 GC 回收，而不是被每张线程表永久抓着。代价就是留下 key=null 的脏 Entry，靠惰性清理兜底。如果 key 是强引用，`ThreadLocal` 对象就永远回收不了，反而泄漏得更彻底——所以弱引用 key 不是 bug，是"让 ThreadLocal 对象可回收、用惰性清理处理残留"的权衡。

**结论**：`remove()` 是正解，因为只有它主动、精确地断开 `value` 的强引用；惰性清理是兜底，不及时、不彻底，不能依赖。用完 `ThreadLocal` 在 `finally` 里 `remove`，是唯一可靠的做法。

## 七、remove 与 InheritableThreadLocal

`remove()` 做的事很直接：定位到 key，把它连同 value 从表里删掉，并做一次 `expungeStaleEntry` 把后面的 Entry 重新排位。它和 `set(null)` 不一样——`set(null)` 只是把 value 置空，Entry 还在；`remove` 是把 Entry 整个删除、引用彻底断开。

`InheritableThreadLocal` 是另一个点：子线程创建时（`Thread` 构造器里），会把父线程的 `inheritableThreadLocals` 表**浅拷贝**一份给子线程。注意是浅拷贝——子线程拿到的是父线程当时的 value 引用（或值），之后父线程再 `set`，子线程看不到。它适合"父线程的上下文传给子线程"的场景，但不适合"父子线程共享可变状态"，那从来不是 `ThreadLocal` 的职责。

![InheritableThreadLocal 的父子拷贝](/images/posts/java-threadlocal-inheritable.svg)

`ThreadLocal` 的价值在"隔离"：它用"每线程一份"换掉了"共享 + 同步"的复杂度。代价是它把 value 挂在了线程身上，线程不死、value 不散，所以必须自己记住 `remove`。把 `Thread → ThreadLocalMap → 弱引用 key + 强引用 value` 这条链、以及 `expungeStaleEntry` 的清理逻辑记牢，`ThreadLocal` 的用法和它的坑，就都不是需要死记的规矩，而是能自己推导的结论。

## 参考资料

- [OpenJDK：ThreadLocal 源码](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/lang/ThreadLocal.java)
- [OpenJDK：Thread 源码（threadLocals 字段）](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/lang/Thread.java)
- [Oracle：ThreadLocal（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/lang/ThreadLocal.html)
