---
title: KV Cache：大模型生成为什么越来越占显存
description: 从 Attention 的重复计算问题出发，拆解 KV Cache 的工作机制：缓存了什么、节省了什么、又为什么让显存成为长上下文部署的瓶颈。进一步解释 GQA、PagedAttention 和 Prefix Cache 在工程上如何缓解这个矛盾。
category: Agent
subcategory: LLM 原理与训练
articleClass: focused
seriesOrder: 30
featured: false
publishedAt: 2026-08-20T10:44:00+08:00
updatedAt: 2026-08-20T10:44:00+08:00
tags: [LLM, KV Cache, Attention, GQA, PagedAttention, 推理优化, 显存]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

大模型生成文字是一个逐 Token 的过程：每次只预测下一个 Token，把它拼回输入，再预测下一个。这个机制带来一个显而易见的浪费：生成第 100 个 Token 时，前 99 个 Token 的中间计算结果和第 1 次生成时完全一样，却要重新算一遍。

KV Cache 就是把这部分重复计算存起来，下次直接读。机制本身不复杂，但它带来的一个连锁效应——上下文越长，显存占用越大——正是今天长上下文模型部署成本高的直接原因，也是 GQA、PagedAttention 这些工程优化要解决的核心问题。

这篇文章承接《[大模型通识：从 Token、Transformer 到训练与推理](/posts/llm-fundamentals-from-token-to-inference/)》里关于推理和 KV Cache 的部分，专门把这一层讲清楚。

理解 KV Cache 之前，值得先说清楚"推理"到底是哪两个阶段。一次完整的大模型推理分两步：**Prefill**（预填充）和 **Decode**（解码）。Prefill 阶段，模型并行处理整段输入 Prompt，为每一层、每一个 Token 计算出对应的 Key 和 Value，写入缓存，同时完成第一个输出 Token 的预测，这一步的计算是高度并行的，对 GPU 算力利用充分。Decode 阶段，模型逐 Token 生成，每步只有一个新 Token 进入模型，需要从缓存里读取所有历史 Token 的 K/V 做 Attention，然后预测下一个 Token，这一步计算量极小但显存读写量大。KV Cache 的意义完全发生在 Decode 阶段——如果没有缓存，每步 Decode 不仅要算新 Token 的 K/V，还要把所有历史 Token 的 K/V 全部重新算一遍，每步的计算量随序列长度线性增长，总计算量是 O(N²)。有了缓存，每步只需算 1 个新 Token 的 K/V，从缓存读取历史，总计算量降到 O(N)，代价是缓存占用的显存也是 O(N)。

## Attention 是什么，为什么每步都要重复计算

先把 Attention 的计算形式放在这里。每个 Transformer 层里，每个 Token 的表示向量会被投影成三个向量：Query（Q）、Key（K）、Value（V）。当前 Token 的 Q 和序列中所有 Token 的 K 做点积，经过 Softmax 变成权重，再用这个权重对所有 V 加权求和，得到这个 Token 更新后的表示。

公式是：

```
Attention(Q, K, V) = softmax(Q · Kᵀ / √d) · V
```

在生成阶段（Decode），每生成一个新 Token，模型需要让新 Token 的 Q 和**所有历史 Token**的 K 做点积，用得到的权重对所有历史 Token 的 V 求和。这是 Attention 的语义要求——每个新词要"看到"整个历史才能做出正确的预测。

问题在于，某个历史 Token（比如 Token₅）的 K 和 V 是由它的输入向量决定的，和当前生成第几步完全无关。生成第 50 个 Token 时，Token₅ 的 K₅ 和 V₅ 和生成第 10 个 Token 时算出来的 K₅ 和 V₅ 数值完全相同。但如果没有缓存，每次都要从 Token₅ 的输入向量重新投影一遍，这是纯粹的浪费。

![没有 KV Cache 与有 KV Cache 的推理对比](/images/posts/kv-cache-compute-vs-memory.svg)

## KV Cache 缓存了什么，节省了什么

KV Cache 的思路直接：第一次算出某个 Token 的 K 和 V 之后，把它们存进显存里的一块缓冲区。下次生成新 Token 时，不再重新计算历史 Token 的 K 和 V，直接从缓冲区读取，只计算新 Token 自己的 K 和 V，把它追加到缓冲区里。

每层有自己的 K/V 缓存。一个 32 层的模型，每层都需要存当前序列长度对应的 K 矩阵和 V 矩阵。

节省的是计算量，代价是显存。

没有 KV Cache 时，生成第 N 个 Token 需要对前 N-1 个历史 Token 全部重新做一次 K/V 投影，总计算量随序列长度 N 线性增长（每步），累计到整个生成过程是 O(N²)。有 KV Cache 后，每步只需要计算 1 个新 Token 的 K/V，计算量是 O(N)，代价是缓存大小也是 O(N)。

这个取舍对大多数场景是合算的：显存更便宜，重复计算的代价更高。但当上下文很长时，缓存的显存占用会成为新瓶颈。

## KV Cache 到底占多少显存

计算一下。KV Cache 的大小大致是：

```
缓存大小 = 2 × 层数 × 每层 K/V 头数 × 头维度 × 序列长度 × 每个数值的字节数
```

以 LLaMA 3 8B 为例（近似数字）：32 层，每层 8 个 KV 头，头维度 128，float16 精度（2 字节）。

- 1K Token 的序列：2 × 32 × 8 × 128 × 1024 × 2 = 约 134 MB
- 128K Token 的序列：2 × 32 × 8 × 128 × 131072 × 2 = 约 17 GB

一个请求的 128K 上下文缓存就要 17 GB，这还只是一个 8B 的小模型。对于 70B 的模型，KV 头数和头维度更大，缓存会成倍增长。

如果同时服务 8 个并发请求，缓存需求乘以 8，而模型权重本身只需要加载一份。这就是为什么长上下文服务的显存成本主要来自 KV Cache，而不是模型权重。

## GQA 和 MQA：减少 KV 头数来省显存

Grouped-Query Attention（GQA）和 Multi-Query Attention（MQA）是缓解 KV Cache 显存压力的架构选择，在训练时就确定了。

标准的 Multi-Head Attention（MHA）每个 Q 头都有独立的 K 和 V。如果有 32 个注意力头，就有 32 组独立的 K/V。MQA 走另一个极端：所有 Q 头共享同一组 K 和 V，KV 头数从 32 变成 1，缓存大小缩减 32 倍。代价是一定的模型质量损失，因为所有头只能从同一个 K/V 表示里提取信息。

GQA 是折中：把 32 个 Q 头分成若干组，每组共享一对 K/V。LLaMA 3 8B 使用 8 个 KV 头对应 32 个 Q 头，每 4 个 Q 头共享一对 K/V，缓存缩减到 MHA 的 1/4，模型质量介于 MHA 和 MQA 之间。这是目前主流开源模型采用的配置。

从缓存计算角度看：相同序列长度下，GQA（8 KV 头）比 MHA（32 KV 头）的 KV Cache 小 4 倍，对应到上面的例子就是 128K Token 的缓存从 17 GB 降到约 4 GB。这对并发服务的显存规划有显著影响。

GQA 的质量损失为什么这么小？关键在于 Attention 机制里 Q/K/V 的分工：每个 Q 头决定"要问什么问题"，K 头决定"如何被检索"，V 头携带"实际内容"。实验表明，在充分训练的大模型里，即使多个 Q 头共享同一组 K/V，不同 Q 头仍然可以通过不同的查询方向从相同的 K/V 里提取不同的信息——K/V 提供了足够丰富的"答案池"，多个 Q 头用不同的方式去检索它。这也是为什么 GQA 用 8 个 KV 头而不是更极端的 1 个（MQA）：太少的 KV 头会成为信息瓶颈，8 个是在质量和缓存大小之间经过实验找到的折中点。Ainslie et al. 2023 年的 GQA 论文里提供了详细的消融实验，支持这个结论。

## PagedAttention：把显存碎片问题解决掉

KV Cache 的另一个工程问题是显存碎片。传统实现预先为每个请求分配一块连续的显存空间来存 KV Cache，按最大可能的序列长度分配。这会导致两个问题：

第一，大多数请求实际生成的序列比分配的空间短得多，提前分配的显存被浪费了。第二，不同长度的请求碎片化地占用显存，新请求来时可能找不到足够大的连续块，即使总空闲显存足够。

[PagedAttention](https://arxiv.org/abs/2309.06180)（vLLM 的核心贡献）把 KV Cache 管理借鉴了操作系统的虚拟内存分页机制：把每个请求的 KV Cache 切成固定大小的"页"（block），按需分配，不要求物理连续，用一个页表记录每个请求的逻辑页和物理块的映射关系。

这样做有两个直接收益。其一，不再需要提前按最大长度分配，实际用多少分多少，显存利用率大幅提升。其二，多个请求如果有相同的前缀（比如共享同一个 system prompt），它们的 KV 块可以共享同一块物理显存，进一步节省空间。这个特性是 Prefix Cache 的基础。

PagedAttention 还支持一种更精细的内存管理——**Copy-on-Write**：当一个请求 fork 成多条生成路径时（比如 beam search 或 best-of-N 采样），不同路径可以共享相同前缀的 KV 页，只有当某条路径产生了和其他路径不同的新 Token 后，才需要为它单独分配新页，原页保持共享。这对 beam search 来说尤其重要——beam=4 意味着 4 条候选路径，如果每条路径都保存完整的独立 KV Cache，内存用量直接乘以 4；有了 Copy-on-Write，绝大多数前缀页是共享的，真实内存开销远低于 4 倍。

## Prefix Cache：共享前缀减少重复计算

Prefix Cache 是一个更高层的优化：如果多个请求有完全相同的 Token 前缀，这段前缀对应的 KV Cache 只需要计算一次，后续请求可以直接复用。

最典型的场景是共享 system prompt。如果你的应用每个请求都带同一段几千 Token 的 system prompt，没有 Prefix Cache 时每个请求都要重新计算这段 prompt 的 KV；有了 Prefix Cache，第一个请求算完之后缓存住，后续所有请求直接读缓存，节省了这段 Prefill 计算和时间。

Prefix Cache 有严格的匹配要求：Token 序列必须完全一致，同一个 Tokenizer，同一套模型配置。如果 system prompt 里有一个字不同，就是不同的前缀，无法复用。这也是为什么使用 Prefix Cache 时通常建议把 system prompt 固定，不要动态插入变量。

## Prefill 和 Decode：两个阶段对 KV Cache 的影响不同

一次完整的推理分两个阶段，KV Cache 在两个阶段里的角色不同。

**Prefill 阶段**：模型并行处理整个输入 prompt，一次性计算所有输入 Token 的 K 和 V，写入 KV Cache。这一步是计算密集的，因为 Transformer 的 Attention 计算可以在 GPU 上高度并行，N 个 Token 可以同时算。Prefill 越快，首 Token 延迟（Time To First Token，TTFT）越短。

**Decode 阶段**：逐 Token 生成，每步只有一个新 Token 需要计算 K/V，同时需要从 KV Cache 里读取所有历史 Token 的 K/V 来做 Attention。这一步是内存带宽密集的：计算量很小（只有一个新 Token），但需要从显存读取越来越大的缓存。

这个区别有几个实际影响。

第一，**生成速度受内存带宽限制，而不是算力限制**。在 Decode 阶段，GPU 的计算核心大部分时间在等数据——KV Cache 从显存传输过来的速度，才是决定每 Token 生成速度（Token per second）的主要瓶颈。这也是为什么高带宽显存（HBM3 vs HBM2）对长上下文推理的意义比对训练更大。

第二，**长 prompt 会有明显的首 Token 延迟**。发送一个 10 万 Token 的 prompt 时，Prefill 需要处理所有 Token，这段时间你看不到任何输出。Prefill 完成后才进入 Decode，开始逐 Token 生成。对于需要实时流式输出的应用，长 prompt 的 Prefill 延迟是一个需要关注的指标。

第三，**batch 推理的优化策略不同**。Prefill 可以把多个请求的不同 prompt 凑成一个 batch 并行处理；Decode 阶段多个请求可能处于不同的生成位置，需要专门的 continuous batching 技术把不同长度的序列打包在一起，避免 GPU 空转。这是推理服务（vLLM、TensorRT-LLM）最核心的工程问题之一。

**量化对 KV Cache 的影响**：模型权重可以量化到 INT4，KV Cache 同样可以单独量化。KV Cache 量化通常采用 INT8（而不是 INT4，因为激活值分布比权重更不均匀，更激进的量化精度损失更明显）。开启 KV Cache INT8 量化可以把缓存占用减半，代价是极长序列下（>64K Token）可能有轻微的注意力精度损失。vLLM 支持 `--kv-cache-dtype fp8` 和 `int8` 两种量化选项。一个粗略的感受：对于 LLaMA 3 8B，用 BF16 存 KV Cache 时 128K 上下文需要约 17GB；切到 INT8 就只需要约 8.5GB，这让单张 A100 40GB 从勉强运行变为有余裕同时服务两三个长上下文请求。

## 上下文窗口和 KV Cache 的关系

澄清一个容易混淆的点：上下文窗口的大小限制不主要来自 KV Cache，而是来自模型的位置编码设计和训练时使用的序列长度。

KV Cache 的大小随序列长度线性增长，在显存足够时可以装得下任意长度的缓存。上下文窗口的限制是模型在超过训练时的序列长度时，位置编码的外推效果会变差，模型开始"迷失"，输出质量下降。

所以说"这个模型支持 128K 上下文"，指的是模型被训练成在 128K 长度范围内能保持可靠的注意力和位置理解，同时也意味着 128K 长度的 KV Cache 是这个模型在推理时显存规划的参考上限。

Prefill 阶段（处理整个输入 prompt）是计算密集的，KV Cache 在这里被建立；Decode 阶段（逐 Token 生成）是内存带宽密集的，每步从显存读取整个缓存，计算量很小但读写量不小。这也是为什么长上下文的生成速度受内存带宽限制，而不是受算力限制。

## 实际使用中需要关心的几点

如果你在调用 API 或部署推理服务，KV Cache 会在以下场景里直接影响到你：

**长 system prompt 的成本**：每次请求都要重新 Prefill 整个 system prompt，Token 消耗和延迟都会累积。如果服务商支持 Prompt Caching（Anthropic、OpenAI 均已支持），把固定的 system prompt 放在消息开头，可以享受后续请求的缓存命中折扣，通常能省下 80-90% 的重复 Prefill 成本。

多轮对话是 Prefix Cache 最大的受益场景之一。考虑一个连续对话：第 1 轮的输入是 `[system, user_1]`，第 2 轮的输入变成 `[system, user_1, assistant_1, user_2]`——注意第 2 轮的输入完整包含了第 1 轮的全部内容，只是在末尾追加了新内容。这意味着只要服务端用同样的方式拼接消息，第 2 轮请求的前缀和第 1 轮完全一致，可以直接复用第 1 轮算好的 KV Cache，只需要为新追加的 `assistant_1` 和 `user_2` 部分做增量 Prefill。对话轮次越多，这种复用带来的延迟和成本节省就越明显——这也是为什么很多 API 的计费模型里，"cache read"的价格远低于"cache write"或常规 input token 价格（Anthropic 的 cache read 定价约为普通 input 的 1/10）。但前提是应用层不能在历史消息里做任何修改（比如截断、重排、注入动态变量），否则前缀匹配会在某个位置断开，断点之后的部分全部需要重新计算，缓存收益大幅降低。

**并发请求数和显存的关系**：如果你在自己部署模型服务，并发 N 个请求就需要 N 份 KV Cache 的显存（除非有 Prefix Cache 命中）。规划 GPU 显存时，KV Cache 通常是比模型权重更难预测的那个变量，因为它随序列长度动态增长。

**如何估算一次部署的显存需求**：规划自建推理服务时，显存预算大致可以拆成三块——模型权重、KV Cache、框架开销（激活、CUDA 上下文、通信缓冲等）。以 LLaMA 3 8B、单张 A100 80GB 为例：BF16 权重约 16GB；框架开销按 10-15GB 估算；剩下的约 50GB 留给 KV Cache。按前面算出的每 1K Token 约 134MB，再乘上期望支持的并发数和平均上下文长度：如果要支撑 8 路并发、每路平均 8K 上下文，KV Cache 需要 8 × 8 × 134MB ≈ 8.6GB，绰绰有余；但如果把上下文提到 32K，就变成约 34GB，开始逼近上限。这就是为什么"同一个模型支持更长上下文"在服务端几乎总是等价于"能同时服务的并发数下降"——两者争抢的是同一块显存。

值得强调的是，KV Cache 的大小是**动态**的：它随每个请求的实际生成长度增长，而不是一开始就按最大值占满。这既是好事（空闲时不浪费），也是难处（容量规划要考虑最坏情况，否则高并发时会出现 OOM 或请求排队）。PagedAttention 的价值正在于此——它让"用多少分多少"成为可能，把平均利用率和峰值可用并发同时推高。

**会话不会保留 KV Cache**：一次 API 调用结束后，缓存通常被释放。下次调用时，即使发送了相同的历史消息，服务端也会重新 Prefill。这是 Token 消耗随对话轮次增加的直接原因——每轮都要把整段历史重新算一遍，只有当轮的 Prompt Caching 能帮上一部分忙。

一个粗略的估算方式：如果你的应用有一段 4000 Token 的固定 system prompt，每天处理 10000 个请求，Prompt Caching 命中率 90%，每个 Token 的 input 价格是 $3/M Token，那么每天节省的成本大约是：4000 × 10000 × 0.9 × 3 / 1,000,000 = $108。这个数量级提醒我们，在 Token 成本里，KV Cache 相关的优化（Prompt Caching、Prefix Caching）往往比压缩 system prompt 本身更值得先做。

## 极长上下文的挑战与研究方向

当上下文长度进入百万 Token 级别（如 Gemini 1.5 宣称的 1M 上下文），KV Cache 的显存压力会成为比计算量更大的瓶颈。目前研究和工程界在探索几个方向来突破这个限制。

**Sliding Window Attention**：不缓存全部历史，只保留最近 N 个 Token 的 KV Cache（比如 4096 个），超出窗口的旧 Token 被丢弃。这让缓存大小固定，不随生成长度增长。Mistral 模型使用了 4K 的 Sliding Window，配合 RoPE 的缩放策略，在实际任务中保持了可用的长上下文能力。代价是模型无法直接访问窗口外的历史信息，需要在训练时就考虑这个约束，让模型学会在有限窗口内做推理。

**Sparse Attention**：不是所有历史 Token 都对当前预测同等重要，可以选择性地只保留少数"关键" Token 的 KV，或者用更低精度存储不太重要的 KV。StreamingLLM（Xiao et al., 2023）发现在自回归生成中，最开始的几个 Token（Attention Sink）和最近的 Token 对注意力权重贡献最大，中间的大量 Token 可以丢弃或降精度存储，而不显著影响生成质量。这种方法可以让固定显存支持更长的有效上下文。

**Hierarchical KV Cache**：把历史序列分成若干块，对每块做一次"摘要压缩"，在更高层级上存一个压缩版本的 KV，当前 Token 先查近距离的完整 KV，再查远距离的压缩 KV。类似人类阅读时对遥远段落的模糊记忆和对当前段落的精确记忆。这类方法仍在研究阶段，工程上还没有成为标准配置。

**Offload to CPU/Disk**：把不活跃的 KV Cache 从 GPU 显存卸载到 CPU 内存甚至磁盘，需要时再加载回来。FlexGen 等系统探索了这个方向，适合批处理场景（对延迟容忍度高），但对实时交互场景的延迟影响较大，因为 CPU-GPU 数据传输的带宽远低于 GPU 显存内部带宽。

这些方向各有权衡，目前还没有一个"银弹"方案同时解决显存、速度和质量。主流生产系统仍然选择标准的 KV Cache + GQA + PagedAttention + Prefix Caching 这套组合，在 128K 上下文内提供稳定可预期的性能。更激进的长上下文技术往往需要在模型架构或训练阶段就做定制，而不是纯推理优化。

## 参考资料

- [Efficient Memory Management for Large Language Model Serving with PagedAttention（vLLM 论文）](https://arxiv.org/abs/2309.06180)
- [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints](https://arxiv.org/abs/2305.13245)
- [Anthropic: Prompt Caching 文档](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [vLLM 项目](https://github.com/vllm-project/vllm)
