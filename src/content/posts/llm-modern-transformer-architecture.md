---
title: 现代 LLM 的 Transformer：从 Token 输入到下一个 Token
description: 从一条具体的请求出发，逐层拆解现代 Decoder-only Transformer 的每个组件：Embedding、RoPE 位置编码、RMSNorm、GQA 注意力、SwiGLU 前馈层、残差连接，以及 logits 到采样的完整流程。解释每个设计决策相比原始 Transformer 改了什么、为什么改。
category: Agent
subcategory: LLM 原理与训练
articleClass: flagship
seriesOrder: 3
featured: false
publishedAt: 2026-08-18T23:12:00+08:00
updatedAt: 2026-08-18T23:12:00+08:00
tags: [LLM, Transformer, Decoder, RoPE, RMSNorm, GQA, SwiGLU, 采样, 推理]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

《Attention Is All You Need》给了 Transformer 的骨架，但今天的 LLaMA 3、Mistral、Qwen、DeepSeek 和 GPT 系列里的 Transformer，已经在每个细节上做了修改。如果只知道 2017 年的原始版本，看到现代模型的代码会有很多疑问：RoPE 是什么、为什么用 RMSNorm 不用 LayerNorm、GQA 里的 G 是什么意思、SwiGLU 和 ReLU 哪里不同、为什么参数量大部分都在 FFN 里。

这篇文章以一次完整的推理为线索，从 Token 输入开始，到输出下一个 Token 的概率为止，逐层解释现代 Decoder-only Transformer 的每个组件，以及每个设计相比 2017 年版本的改动理由。最后用 LLaMA 3 8B 的真实参数做一次完整的数量核算，把所谓"8B 参数"对应到具体位置。

如果你已经读过上一篇《[Attention Is All You Need 精读](/posts/llm-attention-is-all-you-need/)》，这篇文章是它的直接续篇——原始 Transformer 介绍过的概念这里只简要回顾，重点放在改动和原因。如果没读过，这篇文章也会在必要的地方补充背景。

## 从 Encoder-Decoder 到 Decoder-only：一个关键的架构简化

原始 Transformer 有 Encoder 和 Decoder 两个部分，面向机器翻译设计：Encoder 双向读取整段源语言，Decoder 自回归生成目标语言，两者通过 Cross-Attention 连接。这套设计对翻译很合理——源语言序列和目标语言序列是两个独立的流，需要一个专门的接口来连接它们。

但翻译只是语言任务的一种。当研究者把这套架构用于更一般的语言建模时，一个问题变得明显：**为什么不能把所有文本放进同一个序列，用统一的方式建模？**

答案是完全可以。把"系统指令 + 历史对话 + 当前输入 + 待生成内容"全部拼成一条 Token 序列，送进一个带 Causal Mask 的 Self-Attention，每个位置预测它右边的下一个 Token——这就是 Decoder-only 架构的核心思路。去掉了独立的 Encoder、去掉了 Cross-Attention，结构变得极度统一：同样的 Block，重复 N 层，处理同一条序列。

这个简化有几个深远的好处。

**规模化训练变得更简单**。整个网络只有一种结构，参数分配更均匀，工程实现和并行优化更直接。没有 Encoder 和 Decoder 的分层，不需要决定资源在两个部分之间怎么分配。

**训练目标更统一**。Decoder-only 的训练目标是在每个位置预测下一个 Token（Next Token Prediction），整条序列里的每个位置都有一个监督信号。同样的数据，每条样本可以产生序列长度个训练信号，数据利用率更高。

**In-context learning 天然适配**。把任务说明、示例和问题全部拼进同一序列，模型以完全统一的方式处理它们——不需要用不同的模块分别处理指令和内容。这让 in-context learning 的工作方式更自然。

**长上下文更容易扩展**。原始 Encoder-Decoder 要分别处理两个序列，长上下文的 KV Cache 管理更复杂。Decoder-only 只有一条序列，Cache 结构更简单，现代的各种长上下文技术（RoPE 缩放、Sliding Window Attention 等）直接适用于这一条序列。

今天主流的生成式 LLM——GPT-4、Claude、LLaMA 3、Mistral、Qwen——全部是 Decoder-only 架构。Encoder-only（BERT 路线）在理解型任务（分类、检索、语义相似度）里仍然活跃，但在通用语言生成的赛道上基本让位给了 Decoder-only。

一条完整的推理流程：

```text
输入文本
  → Tokenizer：文本 → Token ID 序列
  → Token Embedding：ID 序列 → 向量序列
  → N 层 Transformer Block（含 RoPE + RMSNorm + GQA + SwiGLU）
  → 最后的 RMSNorm
  → LM Head：向量 → logits（词表中每个 Token 一个分数）
  → 采样策略：从 logits 选出下一个 Token
  → 把新 Token 追加到序列，重复以上流程
```

现代 LLM 通常有 32 到 128 层 Transformer Block，每层的结构完全相同，共享相同的设计，但参数独立——每一层都学习了不同层次的特征和关系。

![现代 Decoder-only Transformer 的完整结构：从 Token Embedding 到采样输出](/images/posts/modern-transformer-decoder-architecture.svg)

## Token Embedding：把离散编号放进连续空间

推理的第一步是把 Token ID 序列转换成向量序列。Embedding 层是一个可学习的查找表（矩阵），大小是 `vocab_size × d_model`（词表大小 × 模型隐藏维度）。每个 Token ID 对应矩阵里的一行，查找直接通过索引完成，不需要矩阵乘法，时间复杂度是 O(1)。

```python
# 概念示意
embedding_table = nn.Embedding(vocab_size, d_model)  # 如 128256 × 4096
x = embedding_table(token_ids)  # 输入: [seq_len], 输出: [seq_len, d_model]
```

LLaMA 3 8B 的具体数字：vocab_size = 128256，d_model = 4096，Embedding 层参数约 5.25 亿，占模型总参数的约 6%。

**Weight Tying（权重绑定）**是很多模型（包括 LLaMA 系列）的一个重要优化：让输入 Embedding 矩阵和最后的 LM Head（输出投影层）共享同一套权重。输出层用转置的 Embedding 矩阵把隐藏向量投影到词表维度，推理时等效于在词表里找和当前隐藏状态最相似的 Token 向量。

Weight Tying 节省了约 5 亿参数，而且在实践中效果与独立权重相当甚至更好。直觉上，输入 Embedding 描述"这个 Token 进入模型时是什么"，输出 Embedding 描述"模型认为这个 Token 值得输出时像什么"——两者使用一致的语义空间是合理的。

理解 Embedding 要避免一个常见误区：Token 的 Embedding 向量不是固定的语义标签，它只是进入第一层 Transformer 之前的初始向量。经过每一层 Attention 和 FFN 后，这个向量会被持续更新，融入前后文信息。"苹果"在"吃苹果"和"苹果公司"两个上下文里，初始 Embedding 相同，经过若干层 Transformer 后的隐藏状态会截然不同。这种上下文感知的表示更新，正是 Transformer 比静态词向量强大的根本原因。不同层的隐藏状态捕捉不同粒度的语言信息：早期层更接近词形和局部搭配，越往深层越接近抽象语义，这也是为什么提取文本向量用于检索时，有时会比较不同层的输出效果。

## RoPE：把相对位置信息编码进注意力计算

Self-Attention 本身对位置无感——把序列里的 Token 随机打乱，每个 Q·K^T 的点积结果完全相同，只是输出矩阵的行被重排了。位置信息必须显式注入。

原始 Transformer 使用正弦绝对位置编码，把位置向量加到 Token Embedding 上。这个方法有两个局限：第一，外推性差，超过训练序列长度后行为未知；第二，绝对位置不如相对位置有用，"第 5 号位置"远没有"这两个词相差 3 个位置"信息量大。

**RoPE（Rotary Position Embedding，旋转位置编码）**（Su et al., 2021）采用了完全不同的思路：不在 Embedding 阶段加位置信息，而是在每层 Attention 计算之前，对 Q 和 K 向量做一个依赖位置的旋转变换，让 Q·K^T 的点积自然包含相对位置信息。

### RoPE 的数学直觉

RoPE 把 Q 和 K 的每两个维度视为复平面上的一个坐标，对位置 m 的向量旋转角度 mθ（θ 由该维度对应的频率决定）：

```text
q_m' = q_m · e^{imθ}    （对位置 m 的 Q 做旋转）
k_n' = k_n · e^{inθ}    （对位置 n 的 K 做旋转）
```

旋转后，两个向量的点积变成：

```text
q_m' · k_n' = Re[q_m · k_n* · e^{i(m-n)θ}]
```

结果只依赖相对偏移 m-n，绝对位置信息 m 和 n 被消掉了。无论两个 Token 在序列里的绝对位置是多少，只要它们的相对距离相同，注意力权重就相同。这在数学上精确地实现了相对位置编码。

不同维度使用不同的旋转频率（低维度对应低频率，高维度对应高频率），让模型同时拥有捕捉短距离和长距离相对关系的能力——类似正弦编码用不同频率覆盖不同的位置"周期"。

### 为什么 RoPE 比原始正弦编码更好

**外推性更平滑**。因为只编码相对距离，遇到超出训练长度的序列时，模型处理的是"更大的相对偏移"，而不是完全陌生的绝对位置 ID。退化更平滑，配合缩放策略可以扩展到训练长度的数倍甚至数十倍。

**每层都生效**。原始正弦编码只在输入 Embedding 时加一次，后续层里没有位置信息的直接注入。RoPE 在每一层的 Attention 计算前都对 Q 和 K 做旋转，位置信息在整个网络里一直有效。

**不增加参数**。RoPE 是根据位置算好的固定旋转，不需要额外的可学习 Embedding 参数。

**长上下文扩展**：原始 RoPE 训练在特定长度（如 8K Token）上，超出后相对距离的分布会落到训练时未见过的范围，性能退化。现代模型通过两种主要技术扩展有效上下文。ABF（Adjusted Base Frequency）把 RoPE 的基础频率从默认的 10000 调大（LLaMA 3 用了 500000），低频维度的旋转周期变长，能区分更远距离的 Token，是目前最简单有效的方法之一。YaRN（Yet another RoPE extensioN method）对不同频率的维度用不同的缩放策略，在保持短距离精度的同时更好地外推长距离——LLaMA 3 的 128K 上下文正是用 ABF + YaRN 的组合实现的。两种方法都无需重新训练整个模型，只需要在 RoPE 计算中调整参数，然后在扩展后的上下文长度上继续微调（Continue Pretraining）若干步，让模型适应更大的相对偏移分布。

RoPE 是 LLaMA、Mistral、Qwen、GPT-NeoX 等几乎所有主流开源模型的标准配置，已经全面取代了原始的正弦绝对位置编码。

## RMSNorm：更轻量的归一化

原始 Transformer 使用 LayerNorm（层归一化），现代 LLM 普遍换成了 **RMSNorm（Root Mean Square Layer Normalization）**（Zhang & Sennrich, 2019）。

LayerNorm 做两件事：均值中心化（减去均值），然后方差缩放（除以标准差），最后乘以可学习的缩放参数 γ 和偏移 β：

```text
LayerNorm(x) = γ · (x - μ) / sqrt(σ² + ε) + β
```

RMSNorm 发现均值中心化那步对最终效果贡献不大，去掉它，只保留 RMS（均方根）缩放：

```text
RMSNorm(x) = x / RMS(x) · γ
RMS(x) = sqrt(mean(x²))
```

相比 LayerNorm 少了均值计算和偏移参数 β，约快 10-15%，参数更少，在大规模训练中效果持平甚至略好。对于一个 8B 参数的模型，每次前向传播经历 32 层 × 2 次归一化 = 64 次归一化，速度提升积累起来相当可观。

### Pre-Norm：改变归一化位置

归一化位置的改变比类型改变影响更大。原始 Transformer 用 **Post-Norm**：子层计算完，和残差相加，再做归一化：

```python
# Post-Norm（原始 Transformer）
x = layer_norm(x + self_attention(x))
x = layer_norm(x + ffn(x))
```

现代 LLM 几乎全部改用 **Pre-Norm**：归一化在进入子层之前做，子层的输出直接加回去：

```python
# Pre-Norm（现代 LLM 标准）
x = x + self_attention(rms_norm(x))
x = x + ffn(rms_norm(x))
```

Pre-Norm 在极深的网络（32-128 层）里训练更稳定，不容易出现梯度爆炸或梯度消失。Post-Norm 理论上上限更高，但需要更精细的初始化和学习率调整才能稳定。工业界的选择很一致：Pre-Norm 更稳定、更容易扩展，这是现代大规模训练的首选。

## GQA：用更少的 KV 头控制显存

原始 Multi-Head Attention（MHA）给每个 Query 头配一对独立的 Key 和 Value 头：h 个 Q 头，h 个 K 头，h 个 V 头。LLaMA 3 8B 有 32 个 Q 头，标准 MHA 就需要 32 对 KV 头。

这在推理时会是一个大问题。自回归生成时，每生成一个 Token，都需要把所有历史 Token 的 Key 和 Value 缓存在显存里（KV Cache），并在 Decode 阶段从显存读取。32 层网络，每层 32 对 KV 头，每对是 head_dim 维的向量，上下文越长，KV Cache 越大，显存和内存带宽压力越重。

**GQA（Grouped-Query Attention）**（Ainslie et al., 2023）的方案：把 h 个 Q 头分成 g 组，每组内的多个 Q 头共享同一对 K/V 头。h 个 Q 头，只有 g 个 KV 头（g < h）。

LLaMA 3 8B 的实际配置：32 个 Q 头，8 个 KV 头，每 4 个 Q 头共享一对 KV，KV Cache 是标准 MHA 的 1/4。

### MHA、GQA、MQA 的设计空间

三种 Attention 变体形成了一个设计空间：

| 变体 | Q 头数 | KV 头数 | KV Cache 大小 | 模型质量 |
|------|--------|---------|--------------|---------|
| MHA（Multi-Head） | h | h | 100% | 最高 |
| GQA（Grouped-Query） | h | g（1 < g < h） | g/h × 100% | 接近 MHA |
| MQA（Multi-Query） | h | 1 | 1/h × 100% | 略有损失 |

GQA 是 MHA 和 MQA 之间的折中：实验表明，使用 8 个 KV 头（而不是 1 个）已经足以保留大部分模型质量，同时把 KV Cache 压缩到 MHA 的 1/4。这就是为什么 LLaMA 3、Mistral、Qwen 等主流模型都选择了 GQA 而不是走到极端的 MQA。

在推理代码里，GQA 通过重复 KV 头来实现——每个 KV 头被复制 n_heads/n_kv_heads 次，让每个 Q 头都有对应的 K 和 V：

```python
# 含 GQA 和 RoPE 的完整注意力计算（简化示意）
Q = x @ W_Q                              # [seq, n_heads * head_dim]
K = x @ W_K                              # [seq, n_kv_heads * head_dim]
V = x @ W_V                              # [seq, n_kv_heads * head_dim]

Q = apply_rope(Q, position_ids)
K = apply_rope(K, position_ids)

# 把每个 KV 头重复，匹配 Q 的头数
K = K.repeat_interleave(n_heads // n_kv_heads, dim=1)
V = V.repeat_interleave(n_heads // n_kv_heads, dim=1)

# Causal Mask + Scaled Dot-Product Attention
attn_output = F.scaled_dot_product_attention(Q, K, V, is_causal=True)
output = attn_output @ W_O               # 输出投影
```

Causal Mask 在这里通过 `is_causal=True` 激活——把注意力分数矩阵的上三角填充为 −∞，Softmax 后这些位置的权重变为 0，每个位置只能读取自己和左边的历史，不能"偷看"右边未来的 Token。这既保证了自回归语义，也让整条序列在训练时可以并行计算。

推理的 Decode 阶段，每步只有一个新 Token 需要计算 Q，历史 Token 的 K/V 直接从 KV Cache 里读取，不需要重新计算。KV Cache 体积 = 层数 × 序列长度 × n_kv_heads × head_dim × 2（K 和 V）× 字节数。对于 LLaMA 3 8B，128K 上下文的 KV Cache 约 16GB（BF16 精度），和模型权重本身的 16GB 相当。

## SwiGLU 前馈层：门控激活与参数效率

每个 Attention 子层之后，紧跟一个前馈网络（FFN）。Attention 负责跨位置的信息聚合，FFN 负责对每个位置独立地做非线性特征变换。两者是互补的，消融实验表明去掉任何一个性能都会显著下降。

原始 Transformer 的 FFN 用 ReLU：

```text
FFN(x) = max(0, x · W_1 + b_1) · W_2 + b_2
```

中间维度通常是 d_model 的 4 倍（d_ff = 4 × d_model），先"扩张"再"压缩"，提供大量的非线性表示容量。

现代 LLM 普遍换成了 **SwiGLU**（Noam Shazeer, 2020）：

```text
SwiGLU(x) = (Swish(x · W_gate) ⊙ x · W_up) · W_down
Swish(x) = x · σ(x) = x / (1 + e^{-x})
```

其中 ⊙ 是逐元素乘法，W_gate、W_up、W_down 是三个独立的投影矩阵。SwiGLU 比 ReLU 多了一个门控分支，两个分支做 Hadamard 乘积，一个分支决定"通过多少"（门），另一个分支决定"通过什么"（内容）。

**为什么 SwiGLU 更好？** 门控结构让 FFN 有更强的选择性表示能力——对于每个输入，模型可以学会动态地"选择"哪些信息应该传递。Swish 是平滑版的 ReLU，没有 x=0 处的不可导点，梯度更平滑，训练更稳定。Noam Shazeer 2020 年的论文对比了多种 GLU 变体，SwiGLU 在多个基准上表现最优，随后被 PaLM、LLaMA 等主流模型采用。

**维度调整**：为了让 SwiGLU 版本的 FFN 参数量和 ReLU 版本相当（考虑到多了一个 W_gate 矩阵），中间维度从 4×d_model 缩减到约 8/3×d_model。LLaMA 3 8B 的 FFN 隐藏维度是 14336，约等于 3.5 × 4096，这是对"8/3 × d_model"取整后对齐到 128 的倍数的结果（对 GPU 计算效率友好）。

### Mixture-of-Experts：FFN 的稀疏化扩展

标准 FFN 对每个 Token 激活所有参数——如果中间维度是 14336，每个 Token 都经过完整的 14336 维变换。**MoE（Mixture-of-Experts）** 提出了一种稀疏化思路：把一个大 FFN 替换成多个"专家"FFN，每个 Token 只激活其中少数几个专家。

```text
MoE(x) = Σ g_i(x) · Expert_i(x)
```

Router 网络根据输入 x 计算每个专家的权重 g_i，只激活权重最高的 top-k 个专家（通常 k=2）。这样，模型的总参数量可以很大（很多专家），但每个 Token 的实际计算量（FLOPs）只是激活了 k 个专家的开销，推理效率显著高于同参数量的密集模型。

Mixtral 8×7B 有 8 个专家，每个 Token 激活 2 个，等效计算量约 2 个普通 7B 模型，但参数总量是 46.7B，因为存储了所有专家的权重。DeepSeek-V2 使用了更细粒度的 MoE，把参数效率发挥到了极致。MoE 是目前实现"大参数量 + 合理推理成本"的主要技术路线。

## 残差连接：深层网络可训练的基础

每个子层（Attention 和 FFN）的前后都有一个残差连接——把子层的输入直接加到它的输出：

```text
x = x + Attention(RMSNorm(x))
x = x + FFN(RMSNorm(x))
```

这个设计对深层网络的可训练性至关重要，影响远超它看起来的简单性。

**梯度高速公路**：反向传播时，梯度需要从最后一层传递回第一层。没有残差连接，32 层网络里梯度要依次经过 32 个雅可比矩阵，极容易爆炸或消失。残差连接提供了一条"直达通道"：梯度可以沿着 + 路径直接流回早期层，无需经过每个子层的变换，保证早期层也能接收到有效的训练信号。这正是 ResNet 在 2015 年解决"深层网络比浅层更难训练"这个反直觉问题的核心机制，Transformer 直接继承了这一设计。

**子层作为增量更新**：直观上，残差结构让每个子层学习"在当前表示上做什么修改"，而不是从头学习完整的变换。这让每层的学习任务更局部，训练更稳定，也让不同层自然分工——早期层处理局部语法和词形关系，中间层建立语义关联，深层处理复杂的跨位置推理。当某个子层在特定输入上不需要贡献时，它可以学会输出接近零的向量，整个 Block 退化成恒等映射，这给网络提供了一种弹性的"可选精炼"机制。

**初始化策略**：LLaMA 系列对残差路径的权重做了特殊的初始化缩放（W_down 和 W_O 用 1/√(2N) 的因子缩放，N 是层数），让网络在训练初期接近恒等映射，随着训练进行每层的贡献逐渐增大。这一策略改善了深层网络早期的训练稳定性，让学习率和批量大小的选择范围更宽。

## LM Head：从最后一层隐藏状态到词表分数

经过 N 层 Transformer Block 的处理，序列里每个位置都有一个 d_model 维的隐藏状态向量，这个向量融合了从输入到该位置的全部上下文信息。在自回归生成里，我们只关心最后一个位置的隐藏状态——它代表"读完整个输入后，下一个 Token 应该是什么"。

在把这个向量送入 LM Head 之前，还有一个最终的 RMSNorm：

```python
hidden = transformer_blocks(x)     # [seq_len, d_model]
hidden = final_rms_norm(hidden)    # 最后一次归一化
logits = hidden @ embedding_table.T  # [seq_len, vocab_size]
```

由于 Weight Tying，LM Head 直接复用了 Embedding 表的转置。这个矩阵乘法把 d_model 维向量投影到 vocab_size 维空间，每个词表里的 Token 得到一个分数，叫做 **logit**。

Logit 是未归一化的原始分数，正值表示模型倾向于预测这个 Token，负值表示不倾向，绝对值越大表示倾向越强烈。LLaMA 3 8B 的词表有 128256 个 Token，所以每个位置会产生 128256 个 logit。

训练时，所有位置的 logit 都有用——每个位置 t 的预测目标是位置 t+1 的真实 Token，计算交叉熵损失，梯度经过反向传播更新全部参数。推理时，只取最后一个位置的 logit，用它来选下一个 Token。

**为什么不直接看最大 logit？** 从 logit 到最终选择的 Token 中间还有几个步骤，涉及温度缩放和采样策略——这决定了模型输出的多样性和确定性，是生成质量的重要控制旋钮。

## 采样策略：从概率分布到具体的 Token

Logit 经过 Softmax 变成概率分布后，还需要按某种策略选出一个 Token。这个步骤有几个关键参数，对输出质量的影响不亚于模型本身。

### Temperature：控制分布的锐利程度

在 Softmax 之前把 logit 除以温度参数 T：

```text
P(token_i) = exp(logit_i / T) / Σ exp(logit_j / T)
```

T < 1 时，除法让分数之间的差距被放大，Softmax 之后概率分布更尖，高概率的 Token 更容易被选中，输出更确定、更保守。T 趋向 0 时退化成 argmax，每次都选概率最高的那个词。

T > 1 时，除法压缩了分数差距，概率分布更平坦，低概率 Token 也有不小的机会被选中，输出更随机、更多样。

T = 1 是原始的 Softmax，不做任何缩放。

实践建议：代码生成通常用 T ≈ 0.1-0.3（低温，精确优先），创意写作用 T ≈ 0.7-1.0（适度随机），头脑风暴类任务可以用更高温度。值得注意的是：**Temperature = 0（或接近 0）意味着每次都选最高概率词，不代表结果是"事实正确的"**——高确定性和高准确性是两件事，模型的信心与它输出内容的真实性没有直接对应关系。

### Top-k 采样：截断长尾

只保留概率最高的 k 个 Token，其余 Token 的概率置为 0，然后在这 k 个里按概率采样。k = 1 等同于 greedy decoding（贪婪解码，每次选最高概率词）。k 的典型值是 20-50。

Top-k 的局限：k 是固定的，不管当前概率分布有多尖或多平。当模型非常确定时（一个 Token 概率 99%，其他都不到 1%），保留 50 个候选反而引入了很多噪声；当模型非常不确定时（50 个 Token 概率都差不多），限制 k 又可能截掉一些合理候选。

**Top-p（Nucleus Sampling）**解决了 top-k 固定截断的问题。按概率从高到低排列 Token，把概率累加，一旦累加值超过阈值 p，就停下来，只在已选中的 Token 里采样。p = 0.9 意味着：选出概率最高的若干个 Token，直到它们的概率之和达到 90%，然后在这个集合里按比例采样。当分布很尖时，这个集合可能只有 2-3 个 Token；当分布很平时，可能包含几十个。Top-p 自动适应当前的不确定度，是目前最常用的采样过滤方式。

实践中通常组合使用：先对 logit 做 temperature 缩放，再做 top-p 过滤，再采样。API 里的 `temperature` 和 `top_p` 参数直接对应这两个操作，大多数模型的默认推荐配置是 temperature=1.0 + top_p=0.9，或 temperature=0.7 + top_p=0.95。

**Repetition Penalty 和 Min-p**：对已经出现过的 Token 的 logit 做惩罚（除以一个大于 1 的值），降低被再次选中的概率，避免重复输出；参数过大会影响流畅性，要谨慎调整。Min-p 是比 top-p 更激进的截断方式，把概率低于"最高概率 × p"的 Token 全部去掉，在模型非常确定时比 top-p 更激进地剪枝，实验上在某些任务上有优势。

## 参数量拆解：8B 在哪里

以 LLaMA 3 8B 为例，完整拆解主要参数来源，验证"8B"这个数字。

**基本配置**：
- 词表大小：128256
- 模型维度（d_model）：4096
- 层数（N）：32
- Q 头数：32，KV 头数：8，头维度：128
- FFN 中间维度：14336

### Embedding 层

Token Embedding 表：128256 × 4096 ≈ **5.25 亿参数**

由于 Weight Tying，LM Head 不额外占参数（复用 Embedding 矩阵的转置）。

### 每层 Attention

使用 GQA（32 个 Q 头，8 个 KV 头），每头维度 128：

- W_Q：d_model × (n_heads × head_dim) = 4096 × (32 × 128) = 4096 × 4096 ≈ 16.8M
- W_K：d_model × (n_kv_heads × head_dim) = 4096 × (8 × 128) = 4096 × 1024 ≈ 4.2M
- W_V：同 W_K ≈ 4.2M
- W_O（输出投影）：(n_heads × head_dim) × d_model = 4096 × 4096 ≈ 16.8M

每层 Attention 约 **42M 参数**，32 层合计约 **1.34B**。注意 W_K 和 W_V 因为 GQA 只用了 8 个 KV 头，参数比标准 MHA 小了 4 倍——这是 GQA 在参数层面的直接体现。

### 每层 FFN（SwiGLU）

SwiGLU 有三个投影矩阵，中间维度 14336：

- W_gate：4096 × 14336 ≈ 58.7M
- W_up：4096 × 14336 ≈ 58.7M
- W_down：14336 × 4096 ≈ 58.7M

每层 FFN 约 **176M 参数**，32 层合计约 **5.63B**。FFN 的参数是 Attention 的 4 倍多，这是现代 LLM 参数分布最显著的特征。

### 归一化和汇总

RMSNorm 每层有 2 个（Attention 前和 FFN 前），加上最后的 RMSNorm，共 65 个，每个有 d_model = 4096 个参数：约 **0.27M 参数**，可忽略。

| 组件 | 参数量 |
|------|--------|
| Token Embedding | ~5.25B × (1/10) = ~524M |
| Attention（32层）× GQA | 32 × 42M ≈ 1.34B |
| FFN（32层）× SwiGLU | 32 × 176M ≈ 5.63B |
| RMSNorm | ~0.27M（可忽略） |
| **合计** | **~7.5B** |

实际 LLaMA 3 8B 的精确参数量是 8,030,261,248（约 8.03B），和上面的粗算接近（差异来自 RoPE 无需参数、FFN 维度取整等因素）。"8B"是向上取整的近似值。大约 70% 的参数集中在 FFN 层，这也解释了为什么 MoE 主要针对 FFN 做稀疏化——FFN 是最大的参数仓库，也是稀疏化收益最大的地方。

### 参数量分布对推理的影响

Attention 层的参数比 FFN 少得多（约 17% 对 70%），但两者对推理性能的影响完全不同。Attention 的计算量随序列长度二次增长（每个位置都要和所有历史位置算关系），而 FFN 对每个位置独立计算，是线性增长。在长上下文推理中，计算瓶颈从 FFN 的矩阵乘法转移到了 Attention 的二次方复杂度——这也是 Flash Attention、Sliding Window Attention、稀疏 Attention 等优化的动机所在。

反过来看参数加载：Decode 阶段每生成一个 Token 都要把全部权重（8B 参数 × 2 字节 = 16GB）从显存读一遍，此时瓶颈是内存带宽而不是计算。这就是为什么小批量推理时 GPU 算力利用率极低——时间都花在搬运权重上，而不是做矩阵乘法。Continuous Batching 通过把多个请求拼成一个批次来摊薄权重加载成本，正是针对这个瓶颈的优化。

理解了参数在哪里、计算量集中在哪，就能理解推理优化的方向：Attention 优化针对长上下文计算量，批处理优化针对小批量权重加载，量化优化针对显存占用和带宽，KV Cache 优化针对 Decode 阶段的显存增长。这四条线分别从不同角度切入同一个问题——让有限的硬件资源服务更多请求、更长上下文、更低延迟。

## 与原始 Transformer 的对照

把所有改动汇总成一张表，便于对照：

| 组件 | 原始 Transformer（2017） | 现代 LLM（2024-2025） | 改动动机 |
|------|------------------------|----------------------|---------|
| 架构形态 | Encoder-Decoder | Decoder-only | 统一序列处理，规模化训练 |
| 位置编码 | 正弦绝对编码 | RoPE | 相对位置、更好的外推性 |
| 归一化类型 | LayerNorm | RMSNorm | 更快，参数更少，效果持平 |
| 归一化位置 | Post-Norm | Pre-Norm | 深层训练更稳定 |
| 激活函数 | ReLU | SwiGLU | 门控结构，更强表达能力 |
| Attention 变体 | Multi-Head（h KV头） | GQA（g < h KV头） | 减少 KV Cache，降低推理带宽 |
| 参数规模 | ~65M | 7B–405B | 规模定律驱动 |
| 训练数据量 | 数亿词 | 数万亿 Token | Chinchilla 定律 |
| 上下文长度 | ~512 Token | 8K–1M Token | RoPE 扩展 + 系统优化 |

核心骨架——Token Embedding、多层 Self-Attention + FFN、残差连接、最终预测——七年后完全没有变。改变的都是各个部件的具体实现，而且每一处改动都有明确的工程或性能动机，不是为了创新而创新。

**稳定的什么，变化的为何变**：RoPE 替换正弦编码，是因为相对位置更有用、外推性更好；RMSNorm 替换 LayerNorm，是因为均值中心化没有必要，可以省下计算；Pre-Norm 替换 Post-Norm，是因为在 32-128 层的深度下训练稳定性是硬需求；SwiGLU 替换 ReLU，是因为门控结构在实验上带来更好的质量；GQA 替换 MHA，是因为 Decode 阶段的 KV Cache 内存带宽是实际推理的核心瓶颈。每一条都是工程现实驱动的务实调整，而不是理论上的架构革命。

这种演化模式说明了一件重要的事：理解 2017 年的原始 Transformer，就理解了今天所有 LLM 的骨架。理解现代 LLM 里的这些改动，就能读懂 LLaMA、Mistral、Qwen 的技术报告和代码，也能在出现新的架构变体时快速判断它改了什么层（Attention、FFN、归一化、位置编码、架构形态）、改动的工程动机是什么，而不会被新名词挡住视线。

![现代 LLM 各组件改动总览：从 RoPE 到 GQA 的演化脉络](/images/posts/modern-transformer-component-evolution.svg)

## 参考资料

- [LLaMA 3 技术报告（Meta, 2024）](https://arxiv.org/abs/2407.21783)
- [RoFormer: Enhanced Transformer with Rotary Position Embedding（Su et al., 2021）](https://arxiv.org/abs/2104.09864)
- [Root Mean Square Layer Normalization（Zhang & Sennrich, 2019）](https://arxiv.org/abs/1910.07467)
- [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints（Ainslie et al., 2023）](https://arxiv.org/abs/2305.13245)
- [GLU Variants Improve Transformer（Noam Shazeer, 2020）](https://arxiv.org/abs/2002.05202)
- [The Nucleus Sampling paper（Holtzman et al., 2020）](https://arxiv.org/abs/1904.09751)
