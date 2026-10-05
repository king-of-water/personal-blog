---
title: 用一个最小 Raft 实现理解选主、日志复制与成员变更
description: 从三节点 KV 状态机出发，逐步实现 Raft 的任期、投票、AppendEntries、提交规则、崩溃恢复、快照与 Joint Consensus，并解释每条安全约束挡住了什么故障。
category: 后端
subcategory: 分布式
articleClass: flagship
seriesOrder: 140
publishedAt: 2026-08-29T14:44:00+08:00
tags: [Raft, 共识算法, Leader Election, 日志复制, 状态机复制, 成员变更]
---

三台机器保存同一个 KV。客户端向任意节点发送 `set x=1`，系统要在节点崩溃、消息乱序、重复和网络分区下保持一条统一的命令历史。只做主从复制很容易写出第一版：指定 A 为主，A 把命令发给 B、C，多数成功后回复客户端。困难从 A 失联开始：谁有资格接管，两个分区会不会各自选主，新主缺少的日志怎样补齐，旧主恢复后是否还能接受写入？

Raft 把这些问题拆成选主、日志复制和安全性约束，并让日志只从 Leader 流向 Follower。本文用一个最小实现回答：**每个节点要保存哪些状态、RPC 怎样改变状态、日志何时可以提交，以及集群成员变化时为什么不能直接改一份节点列表？** 讲解以 Ongaro 和 Ousterhout 的[扩展版 Raft 论文](https://raft.github.io/raft.pdf)为协议依据，代码是用于暴露边界的伪 Go，不是一份可直接上线的实现。

## 一、Raft 复制的是确定性状态机的输入

假设 KV 状态机只有三个命令：

```go
type Command struct {
    Op    string // set, delete, cas
    Key   string
    Value string
    Expect string
}

func apply(kv map[string]string, cmd Command) Result {
    // 相同初始状态 + 相同命令顺序 => 相同结果
}
```

每个副本按同样顺序应用已提交命令，最终得到相同 KV。共识算法负责让副本对日志顺序和提交位置达成一致，不负责让非确定性业务代码自动变得确定。若 `apply` 内部读取本机时间、随机数或外部 HTTP，三个副本即使拥有相同日志也可能产生不同状态。时间戳和随机结果应由 Leader 作为命令参数写入日志。

Raft 的客户端路径可以概括为：Leader 接收命令，把它追加到本地日志；通过 `AppendEntries` 复制给 Follower；确认多数派持久化后推进 `commitIndex`；各节点按顺序应用到状态机；Leader 最后回复客户端。

![Raft 从客户端命令到多数派提交和状态机应用的路径](/images/posts/raft-log-replication.svg)

“写到多数节点”还不够。多数派必须属于同一个任期与成员配置，日志前缀必须匹配，Leader 只能按特定规则用多数派推进提交。下面的状态和 RPC 共同建立这些条件。

## 二、每个节点只需要三类核心状态

所有节点持久化以下字段，重启后不能丢：

```go
type PersistentState struct {
    CurrentTerm uint64
    VotedFor    NodeID // 当前任期投给谁，空值表示尚未投票
    Log         []Entry
}

type Entry struct {
    Index   uint64
    Term    uint64
    Command Command
}
```

`currentTerm` 是逻辑时代。节点看到更高 term 的请求或响应时，立即更新 term、转为 Follower 并清空 `votedFor`。同一任期最多投一票，这两个字段必须在回复投票前持久化；否则节点重启后忘记投过票，可能在同一任期帮助两个候选者赢得多数派。

日志条目由 `(index, term)` 标识。index 表示位置，term 表示创建它的 Leader 任期。命令内容相同不代表是同一条日志，两个不同任期都可能收到 `set x=1`。

运行时还需要易失状态：

```go
type VolatileState struct {
    CommitIndex uint64 // 已知已提交的最高位置
    LastApplied uint64 // 已应用到状态机的最高位置
    Role        Role   // follower, candidate, leader
}

type LeaderState struct {
    NextIndex  map[NodeID]uint64 // 下一条准备发送的位置
    MatchIndex map[NodeID]uint64 // 已确认复制的最高位置
}
```

`commitIndex` 和 `lastApplied` 分开，因为提交与应用不是同一个动作。日志已经被多数派确认时可以提交，状态机线程可能稍后才执行。应用必须严格按 index 递增，崩溃恢复时可从快照位置继续重放。

## 三、节点角色由超时与消息驱动

每个节点在 Follower、Candidate 和 Leader 之间迁移。Follower 只响应 RPC；一段时间没收到有效 Leader 心跳便成为 Candidate；Candidate 赢得多数票后成为 Leader；任何角色看见更高 term 都退回 Follower。

![Raft 节点在 Follower、Candidate 和 Leader 之间的迁移](/images/posts/raft-role-state-machine.svg)

Raft 不靠一个完美故障检测器判定 Leader 已死。Election timeout 只表达“在这段时间内没有观察到有效 Leader，可以尝试发起新任期”。网络延迟、进程暂停和丢包都可能触发选举，即使旧 Leader 仍在运行。安全性来自 term 和多数派，不来自超时准确。

### 为什么选举超时要随机化

若所有 Follower 都在 300 ms 超时，它们会同时成为 Candidate，各投自己一票，再互相拒绝，形成 split vote。每轮都同时超时，集群可能一直没有 Leader。Raft 让节点从一个区间随机选择 election timeout，例如 300 到 500 ms。较早超时的节点有机会先请求并获得多数票。

心跳间隔应明显小于最小 election timeout，选举超时还要大于正常网络往返与调度抖动。论文用下面的不等式描述可用性条件：

```text
broadcastTime << electionTimeout << MTBF
```

它影响快速选主和稳定性，不是安全性前提。即使超时配置很差，协议可以频繁换主但仍不允许两个多数派提交冲突日志。

## 四、RequestVote 用日志新旧约束候选者

Candidate 开始新选举时先增加 term，投自己一票，持久化 `currentTerm` 与 `votedFor`，然后向其他节点发送：

```go
type RequestVoteArgs struct {
    Term         uint64
    CandidateID  NodeID
    LastLogIndex uint64
    LastLogTerm  uint64
}
```

Follower 只有在候选者 term 不旧、自己在该 term 尚未投票，并且候选者日志至少和自己一样新时才投票。日志新旧先比较最后一条的 term，再比较 index：

```go
func upToDate(candidateTerm, candidateIndex uint64) bool {
    myTerm, myIndex := lastLogTerm(), lastLogIndex()
    return candidateTerm > myTerm ||
        (candidateTerm == myTerm && candidateIndex >= myIndex)
}
```

这条限制保护 Leader Completeness：一条已经提交的日志存在于旧配置多数派中；未来候选者必须从该多数派获得票；交集节点不会投给日志更旧的候选者。新 Leader 因此包含所有已提交条目。

比较日志长度不够。候选者可能有很多旧 term 的未提交条目，而投票者拥有更短但 term 更新的已提交前缀。先比较 lastLogTerm 才符合协议的新旧关系。

### 一次选举怎样结束

五节点集群中，Candidate 获得自己和另外两个节点的票便成为 Leader。收到旧 term 的投票响应可以忽略；收到更高 term 响应必须退回 Follower；选举超时仍未获多数则开始新 term，再次随机等待并请求投票。

网络分区可能让少数派节点不断提高 term。分区恢复后，它的高 term 请求会迫使当前 Leader 退位，即使少数派没有更新日志。Pre-Vote 是常见工程扩展：节点在正式增加 term 前先询问自己是否可能获胜，隔离节点无法获得预投票多数，便不会扰动健康 Leader。它不是原始论文核心协议，但 etcd/raft 等实现普遍提供类似能力。

## 五、AppendEntries 同时承担心跳和日志复制

Leader 对每个 Follower 发送：

```go
type AppendEntriesArgs struct {
    Term         uint64
    LeaderID     NodeID
    PrevLogIndex uint64
    PrevLogTerm  uint64
    Entries      []Entry
    LeaderCommit uint64
}
```

空 `Entries` 就是心跳。Follower 先检查 term，再检查 `PrevLogIndex` 位置是否存在且 term 相同。前缀不匹配便拒绝；匹配时，Follower 删除与新条目冲突的后缀，追加缺失条目，并把本地 `commitIndex` 推进到 `min(LeaderCommit, lastNewEntryIndex)`。

前缀检查建立 Log Matching Property：若两份日志在同一 index 有相同 term，那么该位置之前的所有条目也相同。Leader 通过 `nextIndex` 向前回退，直到找到双方最后一个共同位置，再覆盖 Follower 的冲突后缀。

```go
func replicate(peer NodeID) {
    next := leader.NextIndex[peer]
    args := AppendEntriesArgs{
        PrevLogIndex: next - 1,
        PrevLogTerm:  log[next-1].Term,
        Entries:      log[next:],
        LeaderCommit: commitIndex,
    }
    reply := send(peer, args)
    if reply.Success {
        leader.MatchIndex[peer] = args.PrevLogIndex + len(args.Entries)
        leader.NextIndex[peer] = leader.MatchIndex[peer] + 1
    } else {
        leader.NextIndex[peer]--
    }
}
```

逐个 index 回退易懂但很慢。生产实现会让 Follower 返回冲突 term 及该 term 的最早 index，Leader 可以一次跳过整段冲突日志。这个优化不能改变前缀校验规则。

### 旧 Leader 的未提交日志怎样处理

任期 2 的 Leader A 将条目复制到自己和一个 Follower，还没形成三节点多数就失联。任期 3 的 B 从另外两个节点当选并写入不同条目。A 恢复后看见 term 3 立即退位；B 的 AppendEntries 找到共同前缀，并覆盖 A 的未提交后缀。

客户端可能已经把请求交给 A，但未收到结果。它不能假定命令失败，应带同一请求 ID 向新 Leader 查询或重试。Raft保证已提交日志不丢，不保证每个收到的客户端请求都提交，也不自动去重客户端重试。

## 六、Leader 何时可以推进 commitIndex

Leader 根据 `matchIndex` 找到一个位置 N：多数节点已经复制到 N，且 `log[N].term == currentTerm`，便把 `commitIndex` 推进到 N。

```go
for n := lastLogIndex(); n > commitIndex; n-- {
    if log[n].Term == currentTerm && replicatedOnMajority(n) {
        commitIndex = n
        break
    }
}
```

“当前任期”条件经常被漏掉。旧 term 条目即使恰好存在于多数节点，也不能只凭副本数直接提交。论文给出的反例中，某个旧条目在一时的多数派上存在，但仍可能由后续合法 Leader 覆盖。当前 Leader 先提交一条本任期日志后，它之前的整个前缀会随 Log Matching 和 Leader Completeness 一起间接提交。

因此新 Leader 上任后通常尽快追加一条 no-op。no-op 在当前 term 被多数复制后，Leader 就能确认此前继承的日志前缀已经提交，同时建立线性一致读需要的任期权威证据。

### 提交、应用和响应的顺序

Leader 应在条目持久化并被多数派确认后提交，再应用状态机并返回结果。若先回复客户端再形成多数，Leader 崩溃后命令可能消失。Follower 通过后续 `LeaderCommit` 获知提交位置，逐条应用。

客户端请求需要唯一 ID。Leader 可以在状态机中保存 `client_id -> last_sequence/result`，同一序号再次到达时返回旧结果，不追加第二次业务副作用。这个去重表也属于状态机数据，必须进入快照。

## 七、持久化顺序决定崩溃后是否违背协议

节点在发送成功响应前，必须确保持久状态已经落盘。投票前持久化 term 与 votedFor；AppendEntries 成功前持久化新日志；客户端成功前确保提交条件成立。仅把字段写进操作系统 page cache，断电后仍可能丢失，实际实现要明确 WAL、fsync 和存储设备的持久化语义。

一种常见架构是 Ready/Advance 循环：Raft 状态机产生待持久化 entries、待发送 messages、已提交 entries 和 snapshot；宿主程序先把 hard state 与 entries 持久化，再发送消息和应用已提交项，完成后通知 Raft 前进。etcd 的[raft 包文档](https://pkg.go.dev/go.etcd.io/etcd/raft/v3)明确区分这些步骤，避免协议状态机直接承担磁盘和网络 IO。

崩溃恢复时，节点加载 snapshot、WAL 日志和 hard state，重建内存索引。状态机应用本身也要可恢复：要么快照包含 `lastApplied`，要么 apply 操作可按 index 去重。日志持久化成功而状态机事务失败时，应用线程应重试同一条已提交命令，不能跳到下一条。

## 八、读请求同样需要一致性协议

直接从 Leader 内存读可能返回旧数据。一个被网络隔离的旧 Leader 不知道新 Leader 已经在更高 term 提交写入，仍会接受本地读。线性一致读必须证明当前节点仍是本任期 Leader，并确保状态机已经应用到某个安全 read index。

最简单的方法是把读也写入日志，代价是每次读都要多数复制。ReadIndex 方法让 Leader 在当前 term 已提交条目的前提下，通过与多数节点交换心跳确认领导权，再返回一个 commit index；等本地 `lastApplied >= readIndex` 后执行读取。Leader lease 可以减少心跳，但正确性依赖时钟漂移和租约假设，必须与协议实现匹配。

Follower read 可以提供不同语义：读本地状态延迟低，但可能陈旧；先从 Leader 获得 read index 再等待本地追上，可以保持线性一致但多一次通信。接口必须向调用方说明是哪种读，不能用一个 `consistent=true` 隐藏所有差异。

## 九、日志压缩用快照替换已经应用的前缀

日志无限增长会拖慢重启与落后节点追赶。节点可以在 index K 创建状态机快照，记录 `lastIncludedIndex=K`、`lastIncludedTerm` 和完整业务状态，然后删除 K 之前的日志。快照生成必须对应一个精确应用位置，不能一边复制可变状态一边继续 apply，得到混合时刻的数据。

Follower 落后到 Leader 已删除的日志之前时，Leader 发送 `InstallSnapshot`。Follower 原子安装快照，更新提交与应用位置，再从 K+1 接收日志。传输中断可以重试，临时快照不能覆盖当前可启动的旧快照。

快照与备份用途不同。Raft snapshot 用于压缩复制日志和快速追赶，通常会在集群内一起演进；操作误删和数据腐败可能已经进入所有副本与新快照。灾难恢复仍需要独立备份、保留策略和恢复演练。

## 十、成员变更为什么不能直接替换节点列表

三节点旧配置 `{A,B,C}` 要改成 `{B,C,D}`。若某些节点先采用新配置、另一些仍使用旧配置，旧多数 `{A,B}` 与新多数 `{C,D}` 没有交集，两个分区可能各自选出 Leader并提交冲突日志。

Raft 论文使用 Joint Consensus，让配置先进入联合状态 `C_old,new`。这一阶段的选举和提交必须同时获得旧配置多数与新配置多数；联合配置提交后，再提交只包含新成员的 `C_new`。两个连续阶段保证任何合法多数都有足够交集。

```text
C_old = {A, B, C}
        │ 提交 joint 配置；旧多数和新多数都必须同意
        ▼
C_joint = old{A,B,C} + new{B,C,D}
        │ 提交最终配置
        ▼
C_new = {B, C, D}
```

配置本身必须是 Raft 日志条目，由同一复制协议排序。若运维脚本在每台机器本地改配置文件，节点对当前 quorum 的定义就可能不同。

### Learner 先追日志，再成为投票成员

新节点 D 刚启动时日志为空。直接把它加入投票集合会立刻提高 quorum 要求，却还不能帮助形成多数，集群故障容忍度反而下降。常见实现先把 D 加为 learner：它接收日志但不投票；追到接近 Leader 后再提升为 voting member。[etcd 运行时重配置文档](https://etcd.io/docs/v3.8/op-guide/runtime-configuration/)要求 learner 日志追上 Leader 后才能 promote。

移除节点也有顺序。两节点集群先坏一台，再想通过配置变更移除坏节点，剩余一台无法形成原配置多数，变更不能提交。etcd/raft 的实现说明因此建议至少三个节点。成员变更是协议操作，不能用“机器已经下线”绕过 quorum。

## 十一、把一次分区与恢复完整走完

五节点集群 A、B、C、D、E，A 是 term 7 Leader。日志 20 已提交并应用。客户端提交日志 21，A 复制到 B 后网络分区，形成 `{A,B}` 与 `{C,D,E}`。

1. A 和 B 只有两票，不能在五节点配置中提交 21。A 可以暂时接受并复制请求，但不能回复成功。
2. C、D、E 超时后，C 在 term 8 获得三票成为 Leader。C 的日志至少包含所有已提交到 20 的条目。
3. C 追加 term 8 的 no-op 到 21，并在 C、D、E 形成多数后提交。若 index 21 与 A 的未提交内容冲突，这个位置现在属于 C 的 no-op。
4. 客户端对 A 的请求超时，带同一 request ID 向新 Leader 重试。C 可以把业务命令追加到 22。
5. 网络恢复，A 收到 term 8 的 AppendEntries 后退位。前缀检查发现 21 冲突，删除旧 21，追加 C 的 21、22。
6. C 将 `LeaderCommit=22` 传播给所有节点。每个状态机按 21、22 顺序应用，客户端去重表保证重试不产生第二次效果。

这个过程允许同时存在认为自己是 Leader 的 A 和 C，但只有 C 所在多数派能提交。Raft 的安全承诺是不存在两个已提交的冲突历史，不是任何时刻全世界只有一个进程带 Leader 标签。

## 十二、最小实现还缺哪些生产能力

能通过基础测试的 Raft 核心距离生产库还有很远。至少要补齐批量复制、pipeline、冲突快速回退、快照分块传输、Pre-Vote、CheckQuorum、Leader transfer、成员变更、磁盘损坏处理、消息限流、慢节点保护和可观测性。传输层要去重或容忍重复，存储层要处理 torn write 与校验失败。

线程模型也会改变 bug 数量。较稳妥的做法是让协议状态只在一个事件循环中修改，网络、磁盘与状态机通过消息交接；若多个 goroutine 直接读写 term、role、log 和 commitIndex，数据竞争会把协议不变量拆散。

Raft 库只输出协议决定，宿主应用负责持久化、传输和状态机。如果宿主先发送消息后落盘，或者把未提交条目交给业务层，库内部再正确也无济于事。集成接口的顺序约束应有测试和断言。

## 十三、客户端怎样找到当前 Leader

共识组内部选出 Leader 后，客户端还要把请求送到它。客户端可以先连接任意节点，Follower 返回当前已知 Leader 地址；也可以从服务发现获取所有成员并逐个尝试。Leader 地址只是提示，因为返回响应到客户端再次连接之间可能已经换主。

客户端缓存 Leader 可以减少一次转发，但缓存要在连接失败、`NOT_LEADER` 或更高 term 提示后失效。一次请求跨越换主时，客户端可能先把命令发给旧 Leader，再因超时发给新 Leader。请求 ID 和序号仍要由状态机去重，Leader 跳转本身不能证明第一次请求没有提交。

由 Follower 透明代理写请求可以简化客户端，却增加一跳网络和代理侧结果未知。代理必须传播原请求 ID、deadline 和取消信号，不能在收到 `NOT_LEADER` 后无限重试。若成员配置发生变化，客户端的种子地址至少要覆盖仍可能存活的节点，或者依赖一个独立发现层；只记住已经被移除的旧节点会让健康集群在客户端看来完全不可达。

## 十四、怎样测试一个 Raft 实现

单元测试先覆盖每条局部规则：同一 term 只投一票；旧 term RPC 被拒绝；更高 term 使任何角色退位；日志不够新的候选者拿不到票；PrevLog 不匹配不追加；只有当前 term 条目按多数推进提交；apply 顺序连续。

随后用确定性模拟器控制消息投递、丢弃、重复、节点重启和磁盘状态，探索大量交错。核心不变量包括：Election Safety，同一 term 最多一个 Leader；Log Matching，相同 `(index, term)` 之前前缀相同；Leader Completeness，已提交条目存在于后续所有 Leader；State Machine Safety，任何节点在同一 index 不会应用不同命令。

最后在真实进程和存储上做故障注入：网络分区、延迟、乱序、节点暂停、kill -9、断电恢复、磁盘满、快照中断和成员变更期间故障。客户端历史应交给线性一致性 checker 验证，不能只比较测试结束时五台机器的最终 KV；冲突可能发生后又被覆盖，最终状态相同会掩盖安全性错误。

运行中至少暴露 term、role、leader ID、commitIndex、lastApplied、lastLogIndex、每个 peer 的 matchIndex/nextIndex、选举次数、心跳和复制延迟、WAL fsync 延迟、快照位置与大小。排障时需要把一次 term 变化与投票、日志冲突和网络事件串起来。

## 十五、读懂 Raft 的检查顺序

看到一次异常时，可以沿四条问题排查：当前 term 从哪里来，节点在该 term 是否投过票；候选者最后日志是否足够新；Leader 与 Follower 的共同前缀在哪里；某个 index 依据哪一组多数和哪条当前任期日志被提交。四个答案能还原大多数选主和复制问题。

Raft 的每条规则都在保护多数派历史的连续性。随机超时改善选主速度，term 隔离不同领导时代，投票的新旧检查让已提交日志进入下一任 Leader，AppendEntries 前缀检查修复分歧，当前任期提交规则封住旧日志反例，联合配置让 quorum 定义平滑切换。把这些规则实现成显式状态迁移，才有机会在故障测试里证明它们仍然成立。

## 参考资料

- Diego Ongaro、John Ousterhout：[In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf)
- Diego Ongaro：[Consensus: Bridging Theory and Practice](https://github.com/ongardie/dissertation/blob/master/stanford.pdf)
- [etcd/raft Go package documentation](https://pkg.go.dev/go.etcd.io/etcd/raft/v3)
- [etcd：Runtime reconfiguration](https://etcd.io/docs/v3.8/op-guide/runtime-configuration/)
- [The Raft Consensus Algorithm](https://raft.github.io/)
