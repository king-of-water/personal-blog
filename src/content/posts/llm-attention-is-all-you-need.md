---
title: 《Attention Is All You Need》精读：Transformer 解决了什么
description: 2017 年这篇论文为什么重要？从序列建模的历史困境出发，逐步拆解 Transformer 的每个设计决策——为什么抛弃 RNN、Self-Attention 的计算逻辑、Multi-Head 的作用、位置编码的必要性——以及这些决策为后来的 GPT 和 BERT 路线奠定了什么基础。
category: Agent
subcategory: LLM 原理与训练
articleClass: focused
seriesOrder: 5
featured: false
publishedAt: 2026-10-04T04:00:00+08:00
updatedAt: 2026-10-04
tags: [LLM, Transformer, Attention, Self-Attention, 论文精读, RNN, 序列建模]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

2017 年，Google Brain 和 Google Research 的研究团队发表了一篇标题极其大胆的论文：《Attention Is All You Need》。论文提出了 Transformer 架构，在机器翻译任务上达到了当时的最佳效果，同时训练速度比之前的方法快得多。

这篇论文的影响远超机器翻译。它奠定了 GPT、BERT、T5、LLaMA 等几乎所有现代大语言模型的架构基础。理解这篇论文，就是理解大模型能力来源的第一步。

这篇文章不是逐段翻译论文，而是解答三个核心问题：Transformer 之前的方法有什么问题？Transformer 的设计决策是怎么来的？这些决策在今天的 LLM 里还留着多少？

## 在 Transformer 之前，序列建模靠什么

要理解 Transformer 解决了什么，先要知道它之前的方案有什么局限。

2017 年之前，序列到序列（Seq2Seq）任务的主流方案是**循环神经网络（RNN）**，以及它的变体 LSTM（长短时记忆网络）和 GRU（门控循环单元）。

RNN 处理序列的方式是逐步递推：读取第 t 个输入时，把第 t 个输入向量和上一步的隐藏状态 h_{t-1} 合并，计算新的隐藏状态 h_t，再把 h_t 传递给下一步。

这个设计带来一个根本性的问题：**序列依赖**。

计算第 100 步的隐藏状态，必须先算完第 99 步；算第 99 步，必须先算完第 98 步……整个序列是一条串行链。无论 GPU 有多少计算核心，都没法并行利用——序列长度 1000 的文本，就必须串行走 1000 步。

这个问题在训练时尤其严重。训练需要大量重复前向和反向传播，而串行的前向传播直接限制了能高效处理的序列长度。

第二个问题是**长距离依赖衰减**。信息从第 1 步传递到第 100 步，要经过 99 次隐藏状态更新，每次更新都是一次有损压缩。早期的信息在经历太多步骤后会被"稀释"。LSTM 通过门控机制缓解了这个问题，但没有从根本上解决——在足够长的序列上，远距离的信息仍然难以保持完整。

当时已经有研究者在 RNN 的 Encoder-Decoder 框架里加入了 Attention 机制（Bahdanau et al., 2015），让 Decoder 在生成每个词时可以"回看"Encoder 的全部输出，而不只依赖最后一个隐藏状态。这个改进显著提升了翻译质量。

《Attention Is All You Need》的作者们问了一个更激进的问题：**如果 Attention 是关键，为什么还需要 RNN？能不能把 RNN 完全去掉，只用 Attention？**

答案是肯定的。

## Self-Attention：让每个 Token 直接"看到"整个序列

Transformer 的核心机制是 **Self-Attention**（自注意力）。"Self"意味着序列中的每个位置不是在关注另一个序列（比如源语言和目标语言之间的 Attention），而是在关注同一个序列内部的其他位置。

Self-Attention 的计算分三步：

**第一步：线性投影**。把每个位置的向量分别通过三个独立的线性层，得到三个向量：Query（Q）、Key（K）、Value（V）。

```
Q = X · W_Q
K = X · W_K
V = X · W_V
```

其中 X 是输入矩阵（所有位置的向量堆在一起），W_Q、W_K、W_V 是三个可学习的权重矩阵。

**第二步：计算注意力权重**。用每个位置的 Q 和所有位置的 K 做点积，得到相似度分数，经过缩放和 Softmax 转换成权重：

```
Attention Scores = Q · K^T / √d_k
Attention Weights = Softmax(Attention Scores)
```

除以 √d_k（Key 向量的维度的平方根）是为了控制点积的量级——当 d_k 较大时，点积的绝对值也会很大，导致 Softmax 进入梯度极小的饱和区，除以 √d_k 可以把分数缩放到合适的范围。

**第三步：加权求和**。用注意力权重对所有位置的 V 加权求和，得到每个位置的输出：

```
Output = Attention Weights · V
```

输出是所有位置的 V 的线性组合，每个位置的 V 对输出的贡献由注意力权重决定——权重越高，贡献越大。

这个机制的关键特性是：**序列中任意两个位置之间的交互只需要一步计算**，不需要像 RNN 那样经过中间步骤传递信息。"The cat sat on the mat" 这句话里，"cat" 和 "sat" 之间的关系可以直接计算，而不需要信息从 "cat" 一步步传播到 "sat"。

而且整个计算是矩阵运算，可以在 GPU 上完全并行——序列里所有位置的 Q、K、V 可以同时计算，所有 Q·K^T 的点积可以批量做。这直接解决了 RNN 串行计算的瓶颈。

![Transformer Self-Attention 与 RNN 序列建模的对比：任意距离一步交互 vs 逐步传递](/images/posts/transformer-self-attention-vs-rnn.svg)

## Multi-Head Attention：为什么需要多个头

单个 Self-Attention 只能计算一种 Q-K 匹配关系。Multi-Head Attention（多头注意力）并行运行多个独立的 Attention，让模型在同一层里同时捕捉不同类型的关系。

具体做法：把输入向量分别投影到 h 个不同的子空间，每个子空间跑一个独立的 Self-Attention（一个"头"），然后把所有头的输出拼接起来，通过一个线性层压缩回原始维度：

```
MultiHead(Q, K, V) = Concat(head_1, ..., head_h) · W_O

head_i = Attention(Q · W_Q_i, K · W_K_i, V · W_V_i)
```

为什么需要多个头？

原论文给了一个直觉：不同的头可以关注不同类型的关系。有些头可能关注局部的句法依存关系（动词和它的主语），有些头可能追踪更远的语义引用（代词和它指代的名词短语）。多头机制让模型在同一个表示空间里同时编码多种语言关系。

论文原作者 Jakob Uszkoreit 后来在博客里讨论过，不同头确实会自发地专注于不同的语言现象，但这种专业化是训练出来的，不是硬编码的。可解释性研究（比如 Clark et al., 2019 对 BERT 的头分析）发现：一些头确实学会了追踪句法依存关系，另一些头学会了追踪共指关系，但大多数头的功能是分布式的，很难用单一语言描述。

实现上，多头不会等比例地增加计算量，因为每个头使用的维度是 d_model / h。如果模型维度是 512，8 个头，每个头的维度就是 64。总计算量和单头的大维度 Attention 相当，但表达能力更丰富。

原论文使用 8 个头，维度 d_model = 512，每个头 d_k = d_v = 64。现代大模型通常有 32-96 个头，维度也大得多，但基本结构没变。

## 位置编码：为什么需要，怎么加

Self-Attention 有一个盲点：它只看各个向量之间的相似度，对向量在序列里的位置完全无感。

"The cat sat" 和 "The sat cat" 对 Self-Attention 来说是等价的——因为 Q·K^T 的计算不涉及位置，只涉及向量本身的值。如果我们把这两句话的 Token 顺序打乱，输出向量只是被重新排列，不会发生任何变化。

语言的很多信息编码在顺序里。"cat bit dog" 和 "dog bit cat" 意思相反但词汇相同。Transformer 要处理语言，必须能区分位置。

解决方案是在 Token Embedding 里加入位置信息。原论文使用的是**正弦位置编码（Sinusoidal Positional Encoding）**：

```
PE(pos, 2i)   = sin(pos / 10000^(2i / d_model))
PE(pos, 2i+1) = cos(pos / 10000^(2i / d_model))
```

每个位置 pos 对应一个向量，向量的每个维度是该位置在不同频率下的正弦或余弦值。把位置向量加到对应的 Token Embedding 上，Transformer 就能从输入里感知位置了。

为什么选正弦/余弦？原论文的两个理由：

一，不需要学习额外参数——位置编码是固定的，根据公式算好直接加上去。

二，对于固定的偏移量 k，PE(pos+k) 可以表示为 PE(pos) 的线性变换。这意味着模型从 PE(pos) 可以相对容易地"推算"出 PE(pos+k)，相对位置信息在数学上是可提取的。

论文也做了对比实验，用可学习的位置编码效果几乎一样。原论文选正弦的另一个原因是：正弦编码在比训练序列更长的序列上也有合理的行为（虽然不保证），而可学习的位置编码在超出训练长度时完全没有依据。

现代 LLM 基本不再用原论文的正弦编码，改用了效果更好的 **RoPE（旋转位置编码）**。RoPE 不是把位置信息加到 Embedding 上，而是在计算 Q·K^T 之前，对 Q 和 K 做依赖位置的旋转变换，让点积结果自然地包含相对位置信息。RoPE 的外推性更好，是 LLaMA、GPT-NeoX 等模型的标准配置。

## Encoder-Decoder 架构和两类 Attention

原始 Transformer 面向机器翻译，设计了 Encoder-Decoder 结构，里面有三种不同类型的 Attention：

**Encoder 的 Self-Attention**：Encoder 处理源语言序列，每个位置可以看到整个源语言序列的所有位置（双向）。输入是源语言 Token，每个 Token 的表示融入了整段源语言的上下文。

**Decoder 的 Masked Self-Attention**：Decoder 处理目标语言序列，但生成时不能看到未来的词——你不能靠看到"答案"来"预测答案"。解决方式是 **Causal Mask（因果掩码）**：位置 t 只能看到位置 1 到 t 的信息，把 t+1 之后的位置的注意力分数全部设为 -∞（Softmax 之后就是 0）。这保证了自回归生成的语义——每个位置的预测只依赖它之前的历史。

**Decoder 的 Cross-Attention**：Decoder 还需要把源语言的信息融入目标语言的生成里。Cross-Attention 的 Query 来自 Decoder 当前状态，Key 和 Value 来自 Encoder 的输出。这让 Decoder 在生成每个目标词时，可以对整个源语言序列做加权检索，直接利用 Encoder 算好的表示。

前馈层（FFN）也是 Transformer Block 的一部分：每个 Attention 子层之后，接一个两层的全连接网络，对每个位置独立做非线性变换。原论文的 FFN 是：

```
FFN(x) = max(0, xW_1 + b_1)W_2 + b_2
```

这是 ReLU 激活的两层 MLP。现代 LLM 通常换成 SwiGLU 或 GeLU，形式不同但位置和功能一样。

每个子层（Self-Attention、Cross-Attention、FFN）都有残差连接（把输入直接加到输出）和 LayerNorm（或现代版的 RMSNorm）。这两个设计让几十层的深度网络训练稳定，梯度能够回流到早期层。

## 原论文的实验结果说明了什么

论文在 WMT 2014 英德翻译和英法翻译任务上的结果：

- 英德翻译：BLEU 分数 28.4，超过之前最好的模型（使用 ensemble 的 RNN），单模型就超越了之前所有方法
- 英法翻译：BLEU 分数 41.8，新的最佳结果
- 训练成本：英德任务的 Big Transformer 用 8 块 P100 GPU 训练 3.5 天，远低于同期其他顶尖模型

更重要的是训练效率的提升。RNN 的训练因为串行依赖无法高效并行，Transformer 的 Self-Attention 天然是矩阵运算，GPU 利用率高很多。这个效率优势意味着：同样的计算资源，可以训更大的模型，或者处理更长的序列。

消融实验（Ablation Study）是论文里的重要内容：去掉多头、减少头数、换掉位置编码、去掉残差、换不同的 Attention 变体……每种变化都有明确的 BLEU 下降，说明每个设计选择都在贡献。这不是一个"调出来的"结果，每个组件都有其存在的理由。

## 这篇论文奠定了什么，今天还剩多少

《Attention Is All You Need》发表后，迅速启发了两条路线：

**Encoder-only（BERT 路线）**：只用 Encoder，双向 Self-Attention，用 Masked Language Model 目标训练（随机遮掩 Token 让模型预测）。BERT（Devlin et al., 2018）在一系列 NLP 理解任务上刷新了记录，成为 NLP 的预训练范式。适合分类、相似度、抽取等理解型任务。

**Decoder-only（GPT 路线）**：只用带 Causal Mask 的 Decoder，自回归预测下一个 Token。GPT（Radford et al., 2018）展示了生成预训练的威力，GPT-2 展示了规模带来的 few-shot 能力，GPT-3 在 1750 亿参数下展示了 in-context learning。这条路线最终发展成了今天的 ChatGPT、Claude、LLaMA 等生成式 LLM。

今天的 LLM 和原论文的 Transformer 有哪些主要差异？

| 组件 | 原论文（2017） | 现代 LLM（2024） |
|------|---------------|-----------------|
| 位置编码 | 正弦绝对编码 | RoPE（旋转相对位置编码） |
| 归一化 | LayerNorm（Post-Norm） | RMSNorm（Pre-Norm） |
| 激活函数 | ReLU | SwiGLU / GeLU |
| Attention 变体 | Multi-Head Attention | GQA（分组查询注意力） |
| 架构形态 | Encoder-Decoder | Decoder-only |
| 规模 | ~65M 参数 | 7B–405B 参数 |

核心骨架——Token Embedding、Multi-Head Self-Attention（Q·K^T / √d · V）、前馈层、残差连接——在七年后的今天基本没变。论文里最有影响力的贡献不是某个具体参数，而是证明了"只用 Attention 就够了"，把序列建模从串行计算解放成了并行矩阵运算，让大规模语言模型的训练成为可能。

## 参考资料

- [Attention Is All You Need（Vaswani et al., 2017）](https://arxiv.org/abs/1706.03762)
- [Neural Machine Translation by Jointly Learning to Align and Translate（Bahdanau et al., 2015）](https://arxiv.org/abs/1409.0473)
- [BERT: Pre-training of Deep Bidirectional Transformers（Devlin et al., 2018）](https://arxiv.org/abs/1810.04805)
- [What Does BERT Look At? An Analysis of BERT's Attention（Clark et al., 2019）](https://arxiv.org/abs/1906.04341)
- [RoFormer: Enhanced Transformer with Rotary Position Embedding（Su et al., 2021）](https://arxiv.org/abs/2104.09864)
