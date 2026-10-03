---
title: KV Cache：大模型生成为什么越来越占显存
description: 从 Attention 的重复计算问题出发，拆解 KV Cache 的工作机制：缓存了什么、节省了什么、又为什么让显存成为长上下文部署的瓶颈。进一步解释 GQA、PagedAttention 和 Prefix Cache 在工程上如何缓解这个矛盾。
category: Agent
subcategory: LLM 原理与训练
articleClass: focused
seriesOrder: 30
featured: false
publishedAt: 2026-10-03T23:45:00+08:00
updatedAt: 2026-10-03
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

## PagedAttention：把显存碎片问题解决掉

KV Cache 的另一个工程问题是显存碎片。传统实现预先为每个请求分配一块连续的显存空间来存 KV Cache，按最大可能的序列长度分配。这会导致两个问题：

第一，大多数请求实际生成的序列比分配的空间短得多，提前分配的显存被浪费了。第二，不同长度的请求碎片化地占用显存，新请求来时可能找不到足够大的连续块，即使总空闲显存足够。

[PagedAttention](https://arxiv.org/abs/2309.06180)（vLLM 的核心贡献）把 KV Cache 管理借鉴了操作系统的虚拟内存分页机制：把每个请求的 KV Cache 切成固定大小的"页"（block），按需分配，不要求物理连续，用一个页表记录每个请求的逻辑页和物理块的映射关系。

这样做有两个直接收益。其一，不再需要提前按最大长度分配，实际用多少分多少，显存利用率大幅提升。其二，多个请求如果有相同的前缀（比如共享同一个 system prompt），它们的 KV 块可以共享同一块物理显存，进一步节省空间。这个特性是 Prefix Cache 的基础。

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

## 上下文窗口和 KV Cache 的关系

澄清一个容易混淆的点：上下文窗口的大小限制不主要来自 KV Cache，而是来自模型的位置编码设计和训练时使用的序列长度。

KV Cache 的大小随序列长度线性增长，在显存足够时可以装得下任意长度的缓存。上下文窗口的限制是模型在超过训练时的序列长度时，位置编码的外推效果会变差，模型开始"迷失"，输出质量下降。

所以说"这个模型支持 128K 上下文"，指的是模型被训练成在 128K 长度范围内能保持可靠的注意力和位置理解，同时也意味着 128K 长度的 KV Cache 是这个模型在推理时显存规划的参考上限。

Prefill 阶段（处理整个输入 prompt）是计算密集的，KV Cache 在这里被建立；Decode 阶段（逐 Token 生成）是内存带宽密集的，每步从显存读取整个缓存，计算量很小但读写量不小。这也是为什么长上下文的生成速度受内存带宽限制，而不是受算力限制。

## 实际使用中需要关心的几点

如果你在调用 API 或部署推理服务，KV Cache 会在以下场景里直接影响到你：

**长 system prompt 的成本**：每次请求都要重新 Prefill 整个 system prompt，Token 消耗和延迟都会累积。如果服务商支持 Prompt Caching（Anthropic、OpenAI 均已支持），把固定的 system prompt 放在消息开头，可以享受后续请求的缓存命中折扣，通常能省下 80-90% 的重复 Prefill 成本。

**并发请求数和显存的关系**：如果你在自己部署模型服务，并发 N 个请求就需要 N 份 KV Cache 的显存（除非有 Prefix Cache 命中）。规划 GPU 显存时，KV Cache 通常是比模型权重更难预测的那个变量，因为它随序列长度动态增长。

**会话不会保留 KV Cache**：一次 API 调用结束后，缓存通常被释放。下次调用时，即使发送了相同的历史消息，服务端也会重新 Prefill。这是 Token 消耗随对话轮次增加的直接原因——每轮都要把整段历史重新算一遍，只有当轮的 Prompt Caching 能帮上一部分忙。

一个粗略的估算方式：如果你的应用有一段 4000 Token 的固定 system prompt，每天处理 10000 个请求，Prompt Caching 命中率 90%，每个 Token 的 input 价格是 $3/M Token，那么每天节省的成本大约是：4000 × 10000 × 0.9 × 3 / 1,000,000 = $108。这个数量级提醒我们，在 Token 成本里，KV Cache 相关的优化（Prompt Caching、Prefix Caching）往往比压缩 system prompt 本身更值得先做。

## 参考资料

- [Efficient Memory Management for Large Language Model Serving with PagedAttention（vLLM 论文）](https://arxiv.org/abs/2309.06180)
- [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints](https://arxiv.org/abs/2305.13245)
- [Anthropic: Prompt Caching 文档](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [vLLM 项目](https://github.com/vllm-project/vllm)
