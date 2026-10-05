---
title: 《Attention Is All You Need》精读：Transformer 解决了什么
description: 2017 年这篇论文为什么重要？从序列建模的历史困境出发，逐步拆解 Transformer 的每个设计决策——为什么抛弃 RNN、Self-Attention 的计算逻辑、Multi-Head 的作用、位置编码的必要性——以及这些决策为后来的 GPT 和 BERT 路线奠定了什么基础。
category: Agent
subcategory: LLM 原理与训练
articleClass: flagship
seriesOrder: 2
featured: false
publishedAt: 2026-08-18T22:48:00+08:00
updatedAt: 2026-08-18T22:48:00+08:00
tags: [LLM, Transformer, Attention, Self-Attention, 论文精读, RNN, 序列建模]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

2017 年，Google Brain 和 Google Research 的研究团队发表了一篇标题极其大胆的论文：《Attention Is All You Need》。论文提出了 Transformer 架构，在机器翻译任务上达到了当时的最佳效果，同时训练速度比之前的方法快得多。

这篇论文的影响远超机器翻译。它奠定了 GPT、BERT、T5、LLaMA 等几乎所有现代大语言模型的架构基础。理解这篇论文，就是理解大模型能力来源的第一步。

这篇文章不是逐段翻译论文，而是解答三个核心问题：Transformer 之前的方法有什么根本性问题？Transformer 的每个设计决策是怎么来的？这些决策在今天的 LLM 里还留着多少，又改变了什么？

## 序列建模的历史困境：RNN 与它的对手

要理解 Transformer 解决了什么，先要知道它之前的方案有什么局限。

2017 年之前，序列到序列（Seq2Seq）任务的主流方案是**循环神经网络（RNN）**，以及它的变体 LSTM（长短时记忆网络）和 GRU（门控循环单元）。从语言模型、机器翻译到语音识别，RNN 家族几乎垄断了所有涉及序列的任务。

RNN 处理序列的方式是逐步递推：读取第 t 个输入时，把第 t 个输入向量和上一步的隐藏状态 h_{t-1} 合并，计算新的隐藏状态 h_t，再把 h_t 传递给下一步：

```text
h_t = f(W_h · h_{t-1} + W_x · x_t + b)
```

这个设计看起来很合理——用一个递推的"记忆"来积累上文信息。但它有两个根本性的问题，随着研究者把序列越做越长，这两个问题越来越无法回避。

**第一个问题：严格的串行依赖**。计算第 100 步的隐藏状态，必须先算完第 99 步；算第 99 步，必须先算完第 98 步……整个序列是一条没有分支的串行链。无论 GPU 有多少计算核心，都没法并行利用——序列长度 1000 的文本，就必须串行走 1000 步。这个问题在训练时尤其严重。训练需要大量重复前向和反向传播，而串行的前向传播直接限制了能高效处理的序列长度，也限制了模型能被训练到多大的规模。

**第二个问题：长距离依赖衰减**。信息从第 1 步传递到第 100 步，要经过 99 次隐藏状态更新，每次更新都是一次有损变换。早期的信息在经历太多步骤后会被"稀释"，被后来的信息覆盖。LSTM 通过引入遗忘门、输入门、输出门等控制机制缓解了这个问题，让模型能够选择性地保留或丢弃历史信息，但没有从根本上解决——在足够长的序列上，远距离的依赖仍然难以稳定保持。

当时已经有研究者在 Seq2Seq 的 Encoder-Decoder 框架里加入了 Attention 机制（Bahdanau et al., 2015）。Bahdanau 的贡献是让 Decoder 在生成每个词时，不再只依赖 Encoder 最后一个隐藏状态（这相当于把整个源句子压缩成一个向量，信息损失严重），而是可以"回看"Encoder 所有时间步的隐藏状态，通过学到的对齐权重动态地提取最相关的信息。这个改进显著提升了翻译质量，尤其是对长句子的处理。

但 Bahdanau Attention 只是在 RNN 的骨架上打了一个补丁。Encoder 和 Decoder 本身仍然是串行的 RNN，所有串行依赖的问题一个都没解决。

《Attention Is All You Need》的作者们问了一个更激进的问题：**如果 Attention 是关键，为什么还需要 RNN？能不能把 RNN 完全去掉，只用 Attention 来建模序列？**

答案是肯定的。而这个答案改变了整个 NLP 领域的走向。

## Self-Attention：直接连接任意两个位置

Transformer 的核心机制是 **Self-Attention**（自注意力）。"Self"意味着序列中的每个位置不是在关注另一个序列（比如 Bahdanau Attention 里源语言和目标语言之间的对齐），而是在关注同一个序列内部的其他位置。

这个设计打破了 RNN 的串行约束：任意两个位置之间的信息交换，只需要一步直接计算，不再需要信息经过中间状态逐步传递。"The cat sat on the mat" 里，"cat" 和 "sat" 之间的关系可以直接计算，而不需要等信息从 "cat" 一步步传播到 "sat"。

### Q、K、V 的直觉

Self-Attention 把每个位置的向量通过三个独立的线性变换，分别映射成三个角色：Query（查询）、Key（索引）、Value（内容）。

最直观的理解方式是类比一个简单的信息检索系统：你有一组记录，每条记录有一个用于匹配的索引（Key）和实际要取回的内容（Value）。当你想查某个信息时，你带着一个查询条件（Query）去和所有记录的 Key 做匹配，匹配度高的记录贡献更多 Value 给最终结果。

在 Self-Attention 里，每个 Token 的隐藏向量通过线性变换得到自己的 Q、K、V：

```text
Q = X · W_Q
K = X · W_K
V = X · W_V
```

X 是输入矩阵（所有位置的向量堆在一起），W_Q、W_K、W_V 是三个可学习的权重矩阵。每个 Token 同时扮演三个角色：作为"查询者"（用 Q 去读取其他位置的信息）、作为"被查询者"（用 K 提供自己的索引、用 V 提供自己的内容）。

### 计算过程和缩放的原因

注意力计算分三步：

第一步，用每个位置的 Q 和所有位置的 K 做点积，得到原始相似度分数：

```text
Scores = Q · K^T
```

第二步，把分数除以 √d_k 进行缩放，然后通过 Softmax 转换成权重：

```text
Attention Weights = Softmax(Q · K^T / √d_k)
```

为什么要除以 √d_k？原论文的解释是：当向量维度 d_k 较大时，点积的绝对值会随维度增大而增大（因为两个 d 维向量的点积期望方差是 d，标准差是 √d）。当分数绝对值很大时，Softmax 函数会进入梯度极小的饱和区——一个分数比其他分数大很多，Softmax 之后几乎 100% 的权重都集中在那个位置，整个注意力机制退化成硬选择，梯度几乎不流动。除以 √d_k 把分数的尺度压缩回合理范围，让 Softmax 输出的权重分布更平滑，训练更稳定。

第三步，用权重对所有位置的 V 加权求和，得到每个位置的输出：

```text
Output = Attention Weights · V
```

这个输出是所有位置 V 的线性组合，不是从原文里硬拷贝某个词。"猫坐在垫子上"里，"它"字的输出向量可以是"猫"的 V 占 70%、"垫子"的 V 占 20%、其他位置各占一点的混合——具体权重由 Q·K^T 决定，而 W_Q、W_K、W_V 是通过训练学到的，模型自己学会了用什么样的 Q 和 K 能产生有用的对齐。

整个计算可以写成一个简洁的公式：

```text
Attention(Q, K, V) = Softmax(Q · K^T / √d_k) · V
```

### 为什么能并行

RNN 串行的根本原因是：计算第 t 步必须依赖第 t-1 步的结果。Self-Attention 没有这个依赖——所有位置的 Q、K、V 可以从输入矩阵 X 同时计算出来，所有 Q·K^T 的点积可以通过一次矩阵乘法批量完成，所有位置的输出向量也可以同时得到。整个计算就是几次矩阵乘法，GPU 能高效利用其并行计算能力。

这个并行性在训练阶段尤其重要：同一批文本的所有序列可以同时计算，同一条序列的所有位置也可以同时计算，大大提高了 GPU 利用率，让研究者得以在更大的数据和模型规模上训练。

![Transformer Self-Attention 与 RNN 序列建模的对比：任意距离一步交互 vs 逐步传递](/images/posts/transformer-self-attention-vs-rnn.svg)

## Causal Mask：自回归语义的保证

如果 Self-Attention 让每个位置都能看到所有其他位置，那在训练语言模型时会有一个问题：位置 t 的预测目标是位置 t+1 的 Token，但如果位置 t 能直接看到 t+1，它就"提前知道了答案"，预测变成了抄答案，模型学不到任何东西。

解决方式是 **Causal Mask（因果掩码）**：在计算 Softmax 之前，把位置 t 与所有 t+1 之后位置的注意力分数全部设为负无穷（−∞）。Softmax 之后，−∞ 对应的权重趋于 0，这些位置对输出没有贡献。效果等同于：位置 t 只能看到位置 1 到 t，不能"偷看"右边的未来答案。

这既保证了自回归语义（每个位置的预测只依赖已生成的历史），也充分保留了 GPU 的并行优势（训练时整段文本仍然可以同时计算，只是每个位置的注意力权重被 Mask 成了下三角矩阵）。

加了 Causal Mask 的 Self-Attention，就是 GPT 路线所用的 Masked Self-Attention 的本质。

## Multi-Head Attention：为什么需要多个头

单个 Self-Attention 每次只学习一种 Q-K 匹配关系：对于同一个 Query，它用同一套线性变换看待所有 Key，产生一种聚合模式。这在表达能力上是有限制的。

**Multi-Head Attention（多头注意力）**并行运行 h 个独立的 Self-Attention 头，每个头有自己的 W_Q、W_K、W_V 投影矩阵，在不同的子空间里各自学习关系：

```text
MultiHead(Q, K, V) = Concat(head_1, ..., head_h) · W_O

head_i = Attention(X · W_Q_i, X · W_K_i, X · W_V_i)
```

把 h 个头的输出拼接后，再经过一个线性层 W_O 压缩回原始维度。

直觉上，不同的头可以同时关注不同类型的语言关系。某些头可能更关注局部的句法依存（动词和它的主语），某些头可能追踪更远的语义引用（代词和它指代的名词），还有些头可能专注于短语边界。多头机制让模型在同一层里同时编码多种语言关系，而不是被迫用一种投影去处理所有情况。

可解释性研究（Clark et al., 2019 对 BERT 的分析）发现，训练后的模型中，不同头确实会自发地专注于不同的语言现象：一些头专门追踪句法依存关系，另一些头追踪共指关系，还有些头倾向于关注同一句话里相邻的词。但大多数头的功能是分布式的，不能用单一的语言学概念描述。

**参数和计算复杂度**：多头并不会等比例地增加计算量。每个头使用的维度是 d_model / h，如果模型维度 d_model = 512，h = 8 个头，每个头的维度就是 64。8 个头的总计算量和用一个 512 维的单头大体相当，但表达能力更丰富。

原论文使用 8 个头，d_model = 512。现代大模型通常有 32-96 个头，维度也大得多，但多头的基本设计没有改变。一个重要的现代变体是 **Grouped-Query Attention（GQA）**：多个 Query 头共享同一套 K/V 头，显著减少推理时 KV Cache 的存储和带宽消耗，在几乎不损失模型质量的前提下大幅提升推理效率。

## 位置编码：让 Attention 感知序列顺序

Self-Attention 有一个先天的盲点：它只关心各个向量之间的相似度，完全不感知向量在序列里的位置。把"猫咬了狗"里的三个词随机打乱顺序，Self-Attention 的每个 Q·K^T 计算结果完全一样，只是最终输出矩阵的行被重新排列了。语言的大量信息编码在顺序里，Transformer 必须要有某种方式注入位置信息。

### 正弦位置编码的设计

原论文使用的是**正弦位置编码（Sinusoidal Positional Encoding）**，不依赖额外的可学习参数，直接根据公式计算每个位置的固定向量：

```text
PE(pos, 2i)   = sin(pos / 10000^(2i / d_model))
PE(pos, 2i+1) = cos(pos / 10000^(2i / d_model))
```

每个位置 pos 对应一个 d_model 维的向量，向量的每个维度是该位置在不同频率下的正弦或余弦值。频率从低到高覆盖了不同的"周期"——低维度对应长周期（能区分相距很远的位置），高维度对应短周期（能区分相邻位置）。把位置向量直接加到对应的 Token Embedding 上，Transformer 就能从输入里感知相对和绝对位置了。

为什么选正弦和余弦，而不是简单的 0, 1, 2, ... 整数编码或其他方案？原论文给了几个理由。

第一，正弦编码不需要训练额外参数——位置向量根据公式算好直接加，不占参数预算，也不需要初始化。

第二，对于任意固定偏移量 k，PE(pos+k) 可以表示为 PE(pos) 的一个线性变换。用线性代数证明，sin(pos+k) 和 cos(pos+k) 都可以写成 sin(pos) 和 cos(pos) 的线性组合（利用和差化积公式）。这意味着模型可以相对容易地从位置 pos 的编码推算出偏移 k 后的位置编码，相对位置信息在数学上是可提取的。

第三，正弦编码在超出训练长度的序列上也有合理的行为——因为公式是连续定义的，超出训练长度的位置仍然有明确的编码，虽然不保证好的外推效果，但至少不是完全无意义的。而可学习的位置编码在超出训练长度时完全没有依据。

论文也做了对比实验，用可学习的位置编码效果几乎一样，这说明位置编码的具体形式不是最关键的，有位置信息比没有重要得多。

### RoPE：现代 LLM 的标准选择

今天的主流大模型基本不再用原论文的正弦编码，而是改用 **RoPE（Rotary Position Embedding，旋转位置编码）**（Su et al., 2021）。

RoPE 的工作方式完全不同：它不是把位置向量加到 Token Embedding 上，而是在计算 Q·K^T 之前，对 Q 和 K 分别做一个依赖位置的旋转变换。旋转的角度由位置决定，这样 Q_pos_i · K_pos_j 的点积结果就自然包含了 pos_i 和 pos_j 的相对距离信息，而不依赖绝对位置。

这个设计有几个实际优势：它直接把相对位置信息编码在注意力权重里，理论上对相对位置更敏感；外推性更好，配合特定的缩放策略能够在比训练序列更长的上下文上保持较好的性能；参数效率高，不需要额外的嵌入表。RoPE 是 LLaMA、Mistral、Qwen、GPT-NeoX 等几乎所有主流开源模型的标准配置。

## 完整的 Transformer Block

Self-Attention 只是 Transformer 的一个子层，完整的 Transformer Block 还包含前馈网络、残差连接和层归一化。

### 前馈网络（FFN）

每个 Attention 子层之后，接一个两层的全连接网络，对序列里每个位置独立做非线性变换。原论文使用 ReLU 激活：

```text
FFN(x) = max(0, x · W_1 + b_1) · W_2 + b_2
```

这里有一个重要的参数：FFN 中间层的维度（d_ff）通常远大于模型隐藏维度（d_model）。原论文用 d_model = 512，d_ff = 2048，扩展比例是 4 倍；现代大模型通常维持类似的比例，有时更大。这个"先扩张再压缩"的结构提供了大量额外的非线性表示容量。

Self-Attention 和 FFN 在功能上有明确的分工：Attention 负责在不同位置之间交换和整合信息，FFN 在每个位置独立地对整合后的信息做进一步的非线性变换和特征提取。两者缺一不可，论文的消融实验证明去掉任何一个性能都会显著下降。

现代大模型普遍把 ReLU 换成了 **SwiGLU**（一种门控激活函数），理论上提供更好的梯度流动，实验上在多数任务上表现更好。结构上仍然是两层全连接，但激活方式不同。

### 残差连接：让深层网络可训练

每个子层（Self-Attention 或 FFN）的前后都有一个残差连接（Residual Connection）：把子层的输入直接加到它的输出上：

```text
output = LayerNorm(x + Sublayer(x))
```

这个看起来很简单的设计对深层网络的可训练性至关重要。在没有残差连接的深层网络里，梯度在反向传播时经过每一层都会被乘以某个矩阵，很容易在层数多时指数级衰减（梯度消失）或爆炸。残差连接提供了一条梯度的"高速公路"：梯度可以绕过子层直接流回早期层，保证早期层也能接收到有效的训练信号。

残差连接还有一个好处：如果某个子层的贡献在特定情境下几乎为零，模型可以学会让该子层的输出接近零，此时整个 Block 退化成恒等映射。这给了网络一种"跳过某层"的灵活性，让深层架构比不加残差时更容易训练。

### 层归一化：控制数值稳定性

层归一化（LayerNorm）对每个位置的隐藏向量独立做均值和方差的归一化，然后经过可学习的缩放和偏移：

```text
LayerNorm(x) = γ · (x - μ) / σ + β
```

它的作用是控制每层输出的数值分布，防止随着层数加深，激活值的方差无限增大或缩小，保证训练的数值稳定性。

原论文使用 Post-Norm：先计算子层，再加残差，最后做归一化（Add & Norm 顺序）。现代大模型普遍改用 **Pre-Norm**：在进入子层之前先做归一化。Pre-Norm 在深层模型上训练更稳定，不容易在早期训练中出现梯度爆炸，代价是最终性能可能略低于精心调参的 Post-Norm（但工程上 Pre-Norm 更可靠）。

现代大模型还用 **RMSNorm** 替换了 LayerNorm。RMSNorm 去掉了均值中心化的步骤，只做方差归一化，计算量更小，实验上效果相当。

![Transformer Decoder Block 的完整结构：Multi-Head Attention、残差连接、FFN 与各部件职责](/images/posts/transformer-block-structure.svg)

## Encoder-Decoder 架构与三种 Attention

原始 Transformer 面向机器翻译，设计了完整的 Encoder-Decoder 结构，里面有三种不同类型的 Attention，各自解决不同的问题。

### Encoder：双向建模源语言

Encoder 读取整个源语言序列，由 N 个相同的 Block 堆叠而成（原论文 N=6）。每个 Block 包含 Self-Attention（不加 Causal Mask，每个位置可以看到整个源语言序列的所有位置）和 FFN。Encoder 的目标是产生源语言序列的上下文表示，每个位置的输出向量都融合了整段源文本的信息。这种双向建模（每个位置既能看左边也能看右边）对理解型任务很适合，BERT 正是沿用了这个思路。

### Decoder：自回归生成目标语言

Decoder 也由 N 个 Block 堆叠（N=6），但每个 Block 包含两个 Attention 子层，而不是 Encoder 的一个。

第一个子层是 Masked Self-Attention，处理已经生成的目标语言序列，加了 Causal Mask，每个位置只能看到自己和它之前的位置。这保证生成时不会"看到未来"。

第二个子层是 Cross-Attention（交叉注意力）：Query 来自 Decoder 当前位置的隐藏状态，但 Key 和 Value 来自 Encoder 的最终输出。这让 Decoder 在生成每个目标语言词时，可以直接对整个源语言的 Encoder 输出做加权检索，把翻译所需的源文信息精准地引入生成过程。

Cross-Attention 本质上就是 Bahdanau et al. 提出的 Attention 思想的一个干净实现——只不过在 Transformer 里，Encoder 的表示本身已经是经过多层 Self-Attention 处理的上下文向量，而不是 RNN 的隐藏状态。

### 三种 Attention 的协作关系

用翻译"The cat sat"→"猫坐了"来说明：

Encoder 处理"The cat sat"，通过 Self-Attention 让"cat"的表示融入"sat"的信息，让"sat"的表示融入"The cat"的语境，每个词的最终表示都是全局语境的函数。

Decoder 在生成"猫"时，先通过 Masked Self-Attention 处理已生成的部分（还是空的），再通过 Cross-Attention 对 Encoder 的输出检索——Q 来自"我要生成下一个词"的当前状态，K 和 V 来自 Encoder 处理的"The cat sat"，模型从中提取"cat"附近的信息，生成"猫"。

生成"坐"时，Masked Self-Attention 先看到已生成的"猫"，Cross-Attention 再从 Encoder 输出中查询"sat"相关的信息，生成"坐"。

这个协作机制让 Encoder 和 Decoder 可以各自做擅长的事：Encoder 一次性处理完整源文，Decoder 逐步生成目标文并实时引用所需的源文信息。

## 原论文的训练细节

除了架构设计，原论文还引入了几个对训练稳定性和最终性能很重要的工程细节。

**Warmup 学习率调度**：论文用了一个特殊的学习率策略，训练初期逐步增大学习率（warmup），之后按步数的负 0.5 次方逐渐衰减：

```text
lr = d_model^(-0.5) · min(step^(-0.5), step · warmup_steps^(-1.5))
```

Warmup 的必要性在于：训练初期参数随机初始化，梯度估计非常噪声，如果一开始就用很大的学习率，容易造成参数剧烈震荡，破坏初始结构。先用小学习率让参数进入一个合理的范围，再逐步增大，训练更稳定。

**Dropout**：在每个子层的输出、残差连接之前，以及 Embedding 和位置编码求和之后都加了 Dropout（原论文 p=0.1），用于正则化，防止过拟合。

**Label Smoothing**：训练时不用硬标签（正确 Token 概率为 1，其他为 0），而是用标签平滑（0.1），把一小部分概率分配给其他 Token。这稍微惩罚了模型过度自信，改善了 BLEU 分数，尽管它降低了训练时的困惑度。

**Byte Pair Encoding（BPE）分词**：原论文使用了 BPE 在英德和英法翻译数据上构建共享词表（37000 个词片段），这让源语言和目标语言共享词表空间，有助于跨语言的词汇迁移。

## 实验结果：用数字说话

论文在 WMT 2014 英德翻译和英法翻译任务上的结果奠定了 Transformer 的地位：

英德翻译上，Big Transformer 达到了 28.4 BLEU，超过了当时所有已发表的单模型和集成模型。之前最好的集成模型需要多个 RNN 的组合才能达到 26.3，Transformer 的单模型就已经超越。

英法翻译上，41.8 BLEU 同样刷新了当时最好结果。

更重要的是训练效率：Big Transformer 在 8 块 P100 GPU 上训练 3.5 天，计算成本远低于同期其他顶尖模型（部分模型需要数千 GPU 小时）。"用更少的计算，得到更好的结果"——这正是后来大规模预训练的核心逻辑。

**消融实验**是论文里最有说服力的内容：作者系统地去掉或替换架构里的各个组件，观察对最终 BLEU 的影响。去掉多头、减少头数、把 dot-product Attention 换成 additive Attention、去掉位置编码、去掉残差连接……每种变化都有明确的性能下降。这说明最终结果不是调参调出来的偶然，每个设计决策都有贡献。

其中一个有趣的发现：把 8 个头减少到 1 个头（单头 Attention），BLEU 从 25.8 降到 23.3，损失不小；但把 8 个头增加到 16 或 32 个，收益有限甚至略降。在当时的模型规模下，8 个头是一个合适的点。

## 论文的分叉：BERT 和 GPT 各走哪条路

《Attention Is All You Need》的 Encoder-Decoder 设计面向翻译，但论文发表后迅速启发了两条截然不同的路线，并最终发展出了今天的 LLM 格局。

**Encoder-only 路线（BERT，2018 年）**：只用 Encoder，每个位置都可以看到双向上下文，用 Masked Language Model（MLM）目标训练——随机遮盖输入序列里 15% 的 Token，让模型预测被遮盖的部分。BERT 在 GLUE、SQuAD 等一系列 NLP 理解基准上刷新了记录，成为这一时代 NLP 的预训练范式。双向建模对理解任务（分类、相似度、信息抽取）更友好，但不天然支持从左到右的长文本生成。

**Decoder-only 路线（GPT，2018 年起）**：只用带 Causal Mask 的 Decoder，所有文本放进同一自回归序列，预测下一个 Token。OpenAI 的 GPT 系列展示了这条路线的潜力：GPT-2（15 亿参数）展示了规模带来的 few-shot 行为，GPT-3（1750 亿参数）在几乎没有任务特定训练数据的情况下通过 in-context learning 完成各种任务。这条路线最终通过 InstructGPT、ChatGPT 和 Claude 等后训练技术，发展成了今天的对话式 LLM 产品。

两条路线的分叉不是一个简单的"哪个更好"问题，而是两种不同训练目标和使用场景的选择。BERT 的双向建模让每个 Token 都有充分的上下文，适合提取式和分类式任务；GPT 的自回归目标让模型天然擅长生成，随着规模增大，生成能力和涌现的推理能力（in-context learning）变得越来越强大。今天工业界主流的大模型（Claude、GPT-4、LLaMA、Qwen 等）几乎全是 Decoder-only 架构，但 Encoder 路线在搜索、检索、分类场景仍然活跃。

## 七年后，原论文还留着什么

《Attention Is All You Need》距今已经七年，现代 LLM 在细节上做了大量改动，但核心骨架惊人地稳定：

| 组件 | 原论文（2017） | 现代 LLM（2024–2025） |
|------|---------------|----------------------|
| 位置编码 | 正弦绝对编码 | RoPE（旋转相对位置编码） |
| 归一化类型 | LayerNorm | RMSNorm |
| 归一化位置 | Post-Norm（子层之后） | Pre-Norm（子层之前） |
| 激活函数 | ReLU | SwiGLU / GeLU |
| Attention 变体 | Multi-Head Attention | GQA 或 MQA（共享 K/V 头） |
| 架构形态 | Encoder-Decoder | Decoder-only |
| 参数规模 | ~65M | 7B – 405B |
| 训练数据 | WMT 翻译数据（数亿词） | 数万亿 Token |

不变的东西：Token Embedding 加位置信息，输入多层 Attention 和 FFN 组成的 Block，每个 Block 内有残差连接和归一化，最终通过线性投影预测下一个 Token。这个骨架一个字都没动。

改变的东西：归一化位置（Post 改 Pre，训练更稳定）、归一化方法（LayerNorm 改 RMSNorm，计算更高效）、激活函数（ReLU 改 SwiGLU，表达能力更强）、位置编码（固定正弦改 RoPE，外推性更好）、K/V 共享（GQA 减少推理时的显存和带宽）、架构形态（Encoder-Decoder 简化为 Decoder-only，更适合规模化预训练）。

这篇论文最有影响力的贡献不是任何一个具体参数或技巧，而是证明了一件事：**只用 Attention 就够了**。把序列建模从 RNN 的串行递推解放成了并行矩阵运算，让研究者得以在千倍大的数据和百倍大的模型规模上训练，推动了 GPT-3、ChatGPT 和整个当代 LLM 时代的到来。

如果你只想记住一件事：Self-Attention 让序列里任意两个位置的交互只需要一步，而不是经过中间状态逐步传递。就是这一步，改变了整个领域。

## 参考资料

- [Attention Is All You Need（Vaswani et al., 2017）](https://arxiv.org/abs/1706.03762)
- [Neural Machine Translation by Jointly Learning to Align and Translate（Bahdanau et al., 2015）](https://arxiv.org/abs/1409.0473)
- [BERT: Pre-training of Deep Bidirectional Transformers（Devlin et al., 2018）](https://arxiv.org/abs/1810.04805)
- [What Does BERT Look At? An Analysis of BERT's Attention（Clark et al., 2019）](https://arxiv.org/abs/1906.04341)
- [RoFormer: Enhanced Transformer with Rotary Position Embedding（Su et al., 2021）](https://arxiv.org/abs/2104.09864)
- [GQA: Training Generalized Multi-Query Transformer Models（Ainslie et al., 2023）](https://arxiv.org/abs/2305.13245)
