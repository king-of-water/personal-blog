---
title: 现代 LLM 的 Transformer：从 Token 输入到下一个 Token
description: 从一条具体的请求出发，逐层拆解现代 Decoder-only Transformer 的每个组件：Embedding、RoPE 位置编码、RMSNorm、GQA 注意力、SwiGLU 前馈层、残差连接，以及 logits 到采样的完整流程。解释每个设计决策相比原始 Transformer 改了什么、为什么改。
category: Agent
subcategory: LLM 原理与训练
articleClass: focused
seriesOrder: 8
featured: false
publishedAt: 2026-10-04T05:00:00+08:00
updatedAt: 2026-10-04
tags: [LLM, Transformer, Decoder, RoPE, RMSNorm, GQA, SwiGLU, 采样, 推理]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

《Attention Is All You Need》给了 Transformer 的骨架，但今天的 LLaMA 3、Mistral、Qwen、DeepSeek 和 GPT 系列里的 Transformer，已经在每个细节上做了修改。如果只知道 2017 年的原始版本，看到现代模型的代码会有很多疑问：RoPE 是什么、为什么用 RMSNorm 不用 LayerNorm、GQA 里的 G 是什么意思、SwiGLU 和 ReLU 哪里不同。

这篇文章以一次完整的推理为线索，从 Token 输入开始，到输出下一个 Token 的概率为止，逐层解释现代 Decoder-only Transformer 的每个组件，以及每个设计相比 2017 年版本的改动理由。

如果你已经读过《[Attention Is All You Need 精读](/posts/llm-attention-is-all-you-need/)》，这篇文章是它的直接续篇。如果没有，也没关系——这篇文章会在必要的地方简单回顾背景。

## 现代 LLM 的整体架构：Decoder-only

首先是架构形态的差异。原始 Transformer 有 Encoder 和 Decoder 两个部分，面向翻译任务（读源语言，生成目标语言）。现代生成式 LLM（GPT、LLaMA、Mistral、Claude 等）都是 **Decoder-only** 架构——只有一种 Block，类似原始 Transformer 的 Decoder，但去掉了 Cross-Attention（因为没有 Encoder 的输出可以查询）。

Decoder-only 的工作方式更简单：把所有的文本——system prompt、历史对话、当前输入——全部拼成一个 Token 序列，送进同一个自回归预测流水线，每次输出下一个 Token 的概率分布。

一条完整的推理流程：

```
输入文本
  → Tokenizer：文本 → Token ID 序列
  → Token Embedding：ID 序列 → 向量序列
  → N 层 Transformer Block（含 RoPE + RMSNorm + GQA + SwiGLU）
  → 最后的 RMSNorm
  → LM Head：向量 → logits（每个词表位置一个分数）
  → 采样策略：选出下一个 Token
  → 把新 Token 追加到序列，重复上面流程
```

现代 LLM 通常有 32 到 80 层 Transformer Block，每层的结构完全相同，共享相同的设计，但参数独立。

![现代 Decoder-only Transformer 的完整结构：从 Token Embedding 到采样输出](/images/posts/modern-transformer-decoder-architecture.svg)

## Token Embedding：ID 变成向量

第一步：把每个 Token ID 转换成向量。

Embedding 层是一个可学习的查找表（矩阵），大小是 vocab_size × d_model（词表大小 × 模型隐藏维度）。每个 Token ID 对应矩阵里的一行，前向传播时直接查表即可——不需要任何矩阵乘法，O(1) 查找。

```python
# 概念示意（非实际代码）
embedding_table = nn.Embedding(vocab_size, d_model)  # 如 128K × 4096
x = embedding_table(token_ids)  # 输入: [seq_len], 输出: [seq_len, d_model]
```

LLaMA 3 8B 的维度：vocab_size = 128256，d_model = 4096，Embedding 层参数约 5 亿，占模型总参数的约 6%。

**初始化**：Embedding 权重通常用均值为 0 的正态分布初始化，标准差很小。训练会让出现在相似上下文里的 Token 的 Embedding 向量在几何上靠近，但这种靠近是分布式的——不是某一个维度代表"动词"，而是信息分散在所有维度里。

**Embedding 和输出层共享权重（Weight Tying）**：很多模型（包括 LLaMA 系列）让输入 Embedding 矩阵和最后的 LM Head（输出投影层）共享同一套权重——即输出层用转置的 Embedding 矩阵把隐藏向量投影到词表维度。这样做节省了参数（减少约 5 亿参数），而且在实践中效果和独立权重相当甚至更好，因为输入和输出的 Token 表示使用了一致的语义空间。

理解 Embedding 有一个常见误区：Token 的 Embedding 向量不是"固定的语义"，它只是进入第一层 Transformer 之前的初始表示。经过每一层 Attention 和 FFN 之后，这个向量会被不断更新，融入上下文信息。同一个词"苹果"，在"吃苹果"和"苹果公司"两个上下文里，进入第一层时 Embedding 相同，但经过若干层 Transformer 之后，两者的隐藏状态向量会截然不同，因为前后文改变了模型对这个词含义的"理解"。这种上下文感知的表示更新，正是 Transformer 比静态词向量（如 Word2Vec）强大的根本原因。

## RoPE：让相对位置信息进入注意力计算

原始 Transformer 用正弦绝对位置编码：把位置向量加到 Token Embedding 上，然后整个流程就没有位置信息了。这有两个局限：外推性差（训练时见过的最长序列是上限，超出后行为未知），以及绝对位置不如相对位置有用（"第 5 号位置"不如"这两个词相差 3 个位置"信息量大）。

**RoPE（Rotary Position Embedding，旋转位置编码）**（Su et al., 2021）的思路不同：不在 Embedding 阶段加位置信息，而是在每层的 Attention 计算里，对 Q 和 K 向量做依赖位置的旋转变换，让 Q·K 的点积自然包含相对位置信息。

数学上，RoPE 把向量的每两个维度视为一个复平面上的坐标，对位置 m 的向量旋转角度 mθ_d（θ_d 是该维度对应的频率）。两个位置 m 和 n 的向量点积里，旋转的效果恰好只保留相对偏移 m-n，绝对位置信息被消掉了：

```
Q_m · K_n ∝ Re[q_m · k_n* · e^{i(m-n)θ}]
```

其中 * 是共轭，Re 是实部。结果只依赖 m-n，不依赖 m 或 n 的绝对值。

实践中 RoPE 的优势：

**外推性更好**：因为只编码相对位置，当序列长度超过训练长度时，模型遇到的是"更大的相对偏移"，而不是完全陌生的绝对位置 ID，退化更平滑。配合 YaRN（LLaMA 3 的方法）或 ABF（Adjusted Base Frequency）等技术，可以把有效上下文从训练时的 8K 扩展到 128K 甚至更长。

**不增加参数**：RoPE 是根据位置算好的固定旋转矩阵，不需要额外学习位置 Embedding 参数。

**每层都生效**：原始正弦编码只在输入 Embedding 时加一次，后续层里就没有位置信息的直接注入了。RoPE 在每一层的 Attention 计算前都对 Q 和 K 做旋转，位置信息在整个网络里一直有效。

## RMSNorm：更简单的归一化

原始 Transformer 用 LayerNorm，现代 LLM 普遍换成了 **RMSNorm（Root Mean Square Layer Normalization）**（Zhang & Sennrich, 2019）。

LayerNorm 做两件事：用均值中心化（减去均值），然后用标准差缩放（除以标准差），最后乘以可学习的缩放参数 γ 和偏移参数 β。

RMSNorm 发现中心化那步（减均值）对效果贡献不大，去掉它，只保留 RMS（均方根）缩放：

```
RMSNorm(x) = x / RMS(x) × γ
RMS(x) = sqrt(mean(x²))
```

相比 LayerNorm 少了均值计算和偏移参数 β，计算更快（约快 10-15%），参数更少，效果在大规模训练中持平甚至略好。

另一个差异是 **Pre-Norm 还是 Post-Norm**。原始 Transformer 用 Post-Norm（归一化在子层输出之后，和残差相加之后）。现代 LLM 几乎全部用 **Pre-Norm**（归一化在子层输入之前）：

```python
# Pre-Norm（现代 LLM 标准）
x = x + self_attention(rms_norm(x))
x = x + ffn(rms_norm(x))

# Post-Norm（原始 Transformer）
x = layer_norm(x + self_attention(x))
x = layer_norm(x + ffn(x))
```

Pre-Norm 训练更稳定，在极深的网络（32-80 层）里不容易出现梯度爆炸或梯度消失，是现代大规模训练的标准选择。

## GQA：减少 KV 头数节省显存和带宽

原始 Multi-Head Attention（MHA）：h 个 Query 头，h 个独立的 Key 头，h 个独立的 Value 头。LLaMA 3 8B 有 32 个 Q 头，标准 MHA 下就需要 32 个 KV 头。

在《[KV Cache：大模型生成为什么越来越占显存](/posts/llm-kv-cache-memory-tradeoff/)》里讲过，Decode 阶段每生成一个 Token 都要从显存读取整个 KV Cache。KV 头数越多，KV Cache 越大，读取开销越高。

**GQA（Grouped-Query Attention）**（Ainslie et al., 2023）的方案：把 h 个 Q 头分成 g 组，每组共享一对 K/V 头。h 个 Q 头，g 个 KV 头（g < h）。

LLaMA 3 8B：32 个 Q 头，8 个 KV 头，每 4 个 Q 头共享一对 KV。KV Cache 是 MHA 的 1/4。

**GQA 相比 MQA 的折中**：更极端的版本是 MQA（Multi-Query Attention），所有 Q 头共享同一个 K 和 V 头，KV Cache 缩减到 1/32——但模型质量损失也更明显。GQA 的分组设计是在显存节省和模型质量之间找到更好的平衡点。实践发现，8 个 KV 头（而不是 1 个）已经足以保留大部分模型质量，同时把 KV Cache 压缩到 MHA 的 1/4。这就是为什么 LLaMA 3、Mistral 等主流模型都选择了 GQA 而不是 MQA。

**Causal Mask 的实现方式**：在实际代码里，Causal Mask 通常不是逐步"遮掉"某些位置，而是用一个下三角矩阵（上三角全为 -∞ 或一个很大的负数）实现：位置 i 的 Attention 分数矩阵里，所有 j > i 的位置被填充 -∞，Softmax 之后这些位置的权重变成 0，等效于这些位置"不存在"。Flash Attention 的 `is_causal=True` 参数就是在告诉 kernel 使用这个下三角掩码。

完整的注意力计算流程（含 GQA 和 RoPE）：

```python
# 简化示意
Q = x @ W_Q  # [seq, n_heads * head_dim]
K = x @ W_K  # [seq, n_kv_heads * head_dim]，n_kv_heads < n_heads
V = x @ W_V  # [seq, n_kv_heads * head_dim]

# 应用 RoPE
Q = apply_rope(Q, position_ids)
K = apply_rope(K, position_ids)

# 扩展 KV 以匹配 Q 的头数（每个 KV 头重复 n_heads/n_kv_heads 次）
K = K.repeat_interleave(n_heads // n_kv_heads, dim=1)
V = V.repeat_interleave(n_heads // n_kv_heads, dim=1)

# Causal Mask + Scaled Dot-Product Attention
attn_output = F.scaled_dot_product_attention(Q, K, V, is_causal=True)

# 输出投影
output = attn_output @ W_O
```

**Causal Mask（因果掩码）**：Decoder-only 模型在训练时对整段序列并行计算，但每个位置的预测目标是它的下一个 Token，不能看到未来的词。Causal Mask 把每个位置右边的位置的注意力分数设为 -∞（Softmax 后变成 0），强制每个位置只能关注自己和左边的历史。

推理时（Decode 阶段），每步只有一个新 Token 需要处理，历史 Token 的 K/V 从 KV Cache 里读取，不需要再计算。

## SwiGLU：更好的前馈层激活函数

原始 Transformer 的前馈层（FFN）用 ReLU：

```
FFN(x) = ReLU(xW_1)W_2
```

现代 LLM 普遍用 **SwiGLU**（Noam Shazeer, 2020）：

```
SwiGLU(x, W, V, W_2) = (Swish(xW) ⊙ xV) W_2
Swish(x) = x · σ(x)  = x / (1 + e^{-x})
```

其中 ⊙ 是逐元素乘法，W 和 V 是两套独立的投影权重，W_2 是输出投影。SwiGLU 比 ReLU FFN 多了一个分支，两个分支做 Hadamard 乘积后再输出。

为什么 SwiGLU 更好？

直觉上，GLU（门控线性单元）的乘法结构类似一个"门"——一个分支决定"通过多少"，另一个分支决定"通过什么"，两者相乘得到最终输出。这种门控结构让 FFN 有更强的选择性表示能力，在相同参数量下性能更好。

Swish 激活函数（σ(x) * x）是平滑版的 ReLU——它没有 ReLU 在 x=0 处的不可导点，梯度更平滑，训练更稳定。Noam Shazeer 在 2020 年的论文里对比了多种 GLU 变体，SwiGLU 在多个基准上表现最优，随后被 PaLM、LLaMA 等主流模型采用。

实际上，为了让 SwiGLU 版本的 FFN 参数量和 ReLU 版本相当，W 和 V 的中间维度会从 4×d_model 缩小到约 2.67×d_model（即 8/3 × d_model）。LLaMA 3 8B 的 FFN 隐藏维度是 14336（约 3.5 × d_model = 3.5 × 4096）。

FFN 层是 Transformer Block 里参数量最大的部分——在 GQA 配置下，每个 Block 里 FFN 的参数量约是 Attention 层的 3-4 倍。这也是为什么 FFN 的效率改进（比如 Mixture-of-Experts，MoE）在大模型里越来越受关注：MoE 把 FFN 替换成多个"专家" FFN，每个 Token 只激活其中少数几个，用更少的计算量实现更大的有效参数量。Mixtral 8×7B 和 DeepSeek-V2 都是 MoE 架构的代表。

## 残差连接：为什么不能去掉

每个子层（Attention 和 FFN）的输出都通过残差连接（Skip Connection）加回输入：

```
x = x + Attention(RMSNorm(x))
x = x + FFN(RMSNorm(x))
```

残差连接在深度网络里至关重要，原因有两个：

**梯度高速公路**：反向传播时，梯度必须从最后一层传递回第一层。没有残差连接，32 层网络里梯度要乘以 32 次雅可比矩阵，极容易爆炸或消失。有了残差连接，梯度可以直接沿着 `+` 路径"跳过"子层传回去，保持梯度在早期层的有效性。

**子层作为增量更新**：直观上，残差结构让每个子层学习"在当前表示上做什么修改"，而不是从头学习完整的变换。这让每层的学习任务更局部，训练更稳定，也让不同层分工更清晰——早期层学语法和局部模式，深层学语义和长距离关系。

**初始化和子层缩放**：一些模型（如 GPT-2）会对残差路径的输出乘以 1/√N（N 是层数），让深层网络的初始化更接近恒等变换，训练开始时每层的影响很小，训练过程中逐渐增大。

## LM Head 和 logits：向量到词表分数

最后一层 Transformer Block 输出的是 [seq_len, d_model] 的向量序列。要预测下一个 Token，需要把最后一个位置的向量（d_model 维）映射到词表大小的分数向量（vocab_size 维）：

```python
hidden = transformer_blocks(x)  # [seq, d_model]
hidden = rms_norm(hidden)        # 最后一个 RMSNorm
logits = hidden @ embedding_table.T  # [seq, vocab_size]，Weight Tying：用转置的 Embedding 矩阵
```

logits 是未归一化的分数，词表里每个候选 Token 一个数值。正值代表模型倾向于预测这个 Token，负值代表不倾向。

在自回归生成中，只有最后一个位置的 logits 有用（预测序列的下一个 Token），前面的位置在训练中用于计算每个位置的预测误差，推理时不需要。

## 采样：temperature、top-p 和 top-k

logits 经过 Softmax 变成概率分布，然后按某种策略选出一个 Token。这个选择过程有几个常见的控制参数：

**Temperature（温度）**：在 Softmax 之前把 logits 除以 temperature：

```
P(token_i) = exp(logit_i / T) / Σ exp(logit_j / T)
```

T < 1：概率分布变尖，高概率 Token 被进一步放大，输出更确定（保守）。T = 0 时退化成 argmax（每次都选概率最高的词）。T > 1：概率分布变平，各 Token 的选择概率更均等，输出更随机（多样）。对于创意写作通常用 T ≈ 0.7-1.0，对于代码生成通常用 T ≈ 0.1-0.3。

**Top-k 采样**：只保留概率最高的 k 个 Token，其余设为 0，在这 k 个里按概率采样。k=1 就是 greedy decoding（每次选最高概率）。k 的典型值是 40-50。

**Top-p（Nucleus Sampling）采样**：不按固定 k 个截断，而是选出累积概率超过 p 的最少 Token 集合，在这个集合里采样。p=0.9 意味着：把 Token 按概率从高到低排，取前若干个直到它们的概率之和超过 90%，然后在这些 Token 里采样。这比 top-k 更自适应——当概率分布很尖（模型很确定）时，top-p 会自动缩小候选集合。

实际应用里通常组合使用：先做 temperature 缩放，再做 top-p 过滤，再采样。API 里的 `temperature`、`top_p` 参数直接对应这两个操作。

**Repetition Penalty**：对最近已经出现过的 Token 的 logit 做惩罚（除以一个大于 1 的值），降低它们被再次选中的概率，减少重复输出。对于长文本生成比较有用，但参数过大会让输出回避所有重复词，影响质量。

## 参数量怎么算

以 LLaMA 3 8B 为例，大致拆解主要参数来源：

| 组件 | 参数量（近似） |
|------|--------------|
| Token Embedding (128K × 4096) | ~524M |
| 每层 Attention (Q/K/V/O 投影) | ~67M × 32层 = ~2.1B |
| 每层 FFN (SwiGLU，3 个矩阵) | ~101M × 32层 = ~3.2B |
| RMSNorm 参数 | 可忽略 |
| 合计 | ~8B |

Attention 层的参数：
- Q 投影：d_model × d_model = 4096 × 4096 ≈ 16.8M
- K 投影：d_model × (n_kv_heads × head_dim) = 4096 × (8 × 128) ≈ 4.2M
- V 投影：同 K ≈ 4.2M
- O 投影：d_model × d_model ≈ 16.8M
- 单层约 42M（使用 GQA 的版本）

FFN 层的参数（SwiGLU，中间维度 14336）：
- Gate 投影：4096 × 14336 ≈ 58.7M
- Up 投影：4096 × 14336 ≈ 58.7M
- Down 投影：14336 × 4096 ≈ 58.7M
- 单层约 176M

LLaMA 3 8B 的实际配置：32 个 Transformer Block，总参数约 80 亿。"8B"是四舍五入的近似值。

## 参考资料

- [LLaMA 3 技术报告（Meta, 2024）](https://arxiv.org/abs/2407.21783)
- [RoFormer: Enhanced Transformer with Rotary Position Embedding（Su et al., 2021）](https://arxiv.org/abs/2104.09864)
- [Root Mean Square Layer Normalization（Zhang & Sennrich, 2019）](https://arxiv.org/abs/1910.07467)
- [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints（Ainslie et al., 2023）](https://arxiv.org/abs/2305.13245)
- [GLU Variants Improve Transformer（Noam Shazeer, 2020）](https://arxiv.org/abs/2002.05202)
- [The Illustrated Transformer（Jay Alammar）](https://jalammar.github.io/illustrated-transformer/)
