---
title: 推理优化：Continuous Batching、量化与投机解码
description: 从"为什么 GPU 在推理时经常空转"出发，拆解三类推理优化技术：Continuous Batching 让 GPU 不浪费等待，量化（INT8/INT4/GPTQ/AWQ）缩小模型降低带宽压力，投机解码用小模型草稿加速大模型验证。这些优化合起来能让推理吞吐量提升 10-30 倍。
category: Agent
subcategory: LLM 原理与训练
articleClass: focused
seriesOrder: 70
featured: false
publishedAt: 2026-08-26T21:52:00+08:00
updatedAt: 2026-08-26T21:52:00+08:00
tags: [LLM, 推理优化, Continuous Batching, 量化, 投机解码, vLLM, PagedAttention, 吞吐量]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

把一个大模型部署成服务，面临的核心问题是：GPU 很贵，但大部分时间它在等数据。

推理的瓶颈不是算力不够，而是算力用不满。在《[KV Cache：大模型生成为什么越来越占显存](/posts/llm-kv-cache-memory-tradeoff/)》里讲过，Decode 阶段是内存带宽密集的——每生成一个 Token 只需要做少量矩阵运算，但需要从显存读取整个 KV Cache 和模型权重。GPU 的计算核心大部分时间在等数据传输，利用率很低。

这篇文章覆盖三类让推理变快变便宜的优化技术：

1. **Continuous Batching**：让 GPU 不因为等一个慢请求而浪费
2. **量化（Quantization）**：缩小模型，降低显存压力和带宽需求
3. **投机解码（Speculative Decoding）**：用小模型猜，用大模型验，整体更快

理解这些优化的共同前提是弄清楚 Decode 阶段的性能瓶颈在哪。大模型推理不缺算力（GPU 的浮点运算能力通常远超需求），缺的是**内存带宽**：每生成一个 Token，系统必须把模型全部权重和当前 KV Cache 从显存读到计算单元，即便新的计算量只需要其中极小一部分。对于 LLaMA 3 8B 这样的模型，权重约 16GB（BF16），每次 Decode 步骤都要读一遍。高端 GPU 的 HBM 带宽约 2-3 TB/s，纯算一个 Token 不到 1ms，但"搬运数据"的时间可能占掉了 90% 以上，真正做矩阵乘法的比例极低。这个现象叫做**内存带宽瓶颈（Memory-Bound）**，与之对应的是 Prefill 阶段——处理整段 Prompt 时 batch 里有很多 Token 可以并行算，算力被充分利用，处于**计算瓶颈（Compute-Bound）**。推理优化的核心逻辑就是：让更多时间花在真正的计算上，减少带宽浪费。

## 为什么朴素的 Batching 方案很低效

先理解问题。同时服务多个用户请求时，最自然的做法是把多个请求拼成一个 batch 一起送进模型，让 GPU 并行处理，提高利用率。这在 Prefill 阶段（处理用户输入）工作得很好——不同请求的 prompt 可以并行处理。

但 Decode 阶段有一个根本问题：**不同请求的生成长度不同**。

假设你有一个 batch 里有 8 个请求。有些请求可能生成 20 个 Token 就结束了，有些可能生成 500 个 Token。用静态 batching 时，batch 里最长的请求跑完之前，已经完成的请求占着的显存和计算位置都是浪费——那个位置既没有真正在算，又没有释放给新请求。

更大的问题是**显存的静态分配**：静态 batching 通常为每个请求预留最大可能长度的 KV Cache 空间。大多数请求实际生成长度远小于最大值，大量显存被预留却没有用到，新请求进不来，GPU 的有效并发数被压低。

这两个问题合在一起，导致朴素 batching 的 GPU 利用率很低，吞吐量差。

## Continuous Batching：请求做完就腾位置

Continuous Batching（也叫 In-flight Batching）是 vLLM 等推理框架的核心调度机制，思路是：不等整个 batch 完成，而是**当一个请求生成结束时，立刻把它从 batch 里移走，插入一个新的等待请求**。

在每个 Decode 步骤之后，调度器检查：哪些请求已经生成了结束符（EOS）？把它们移出，把等待队列里的新请求填进来，下一步继续跑。

效果：GPU 几乎没有空闲等待，新请求的首 Token 延迟（等待进入 batch 的排队时间）显著缩短，整体吞吐量大幅提升。Orca 论文（Yu et al., 2022）展示 Continuous Batching 相比静态 batching 的吞吐量提升可以达到 23 倍。

Continuous Batching 能工作的前提是 **PagedAttention**（同样来自 vLLM，Kwon et al., 2023）：把每个请求的 KV Cache 按页管理，不要求物理连续，不预先分配最大长度的空间，按需分配释放。没有 PagedAttention，动态加入和移走请求会导致显存碎片，Continuous Batching 的效益会大打折扣。

**Chunked Prefill** 是 Continuous Batching 的一个重要配套机制：一个很长的 Prompt（比如 32K Token）的 Prefill 本身就很耗时，如果让它独占 GPU 直到完成，其他等待中的请求会感受到明显的首 Token 延迟抖动。Chunked Prefill 把长 Prompt 的 Prefill 切成若干小块（比如每块 1024 Token），每个 Decode 步骤里穿插处理一小块，让 Prefill 和 Decode 请求交错调度，避免一个长 Prefill "卡住"整个调度循环，让延迟更平稳。vLLM 从 0.3 版本开始默认开启 Chunked Prefill。

**Prefix Caching** 是另一个高频优化：如果多个请求共享相同的系统提示（System Prompt），PagedAttention 可以让这些请求的 KV Cache 共享同一批物理内存页，只在第一个请求到来时计算一次，后续请求直接复用。这在 System Prompt 很长（数千 Token）的场景里可以大幅降低首次响应延迟，也节省了显存。Prefix Caching 要求请求的 Token 序列严格从头匹配，哪怕有一个 Token 不同也无法复用。

![Continuous Batching 与量化：提升 GPU 利用率的两条路径](/images/posts/inference-continuous-batching-quantization.svgContinuous Batching 与量化：提升 GPU 利用率的两条路径](/images/posts/inference-continuous-batching-quantization.svg)

## 量化：用精度换速度和显存

量化（Quantization）是把模型权重（以及有时激活值）从高精度浮点数换成低精度整数表示，核心动机是：

- 显存占用减小（float16 → int4 节省 4 倍显存）
- 从显存读取数据的带宽压力降低（读同样的数据，低精度字节更少）
- 部分硬件对整数运算有专门加速

### 权重量化 vs 激活量化

**权重量化（Weight-only Quantization）**：只把模型参数量化为低精度，推理时把权重读到计算单元后反量化回高精度再做矩阵运算。对精度影响小，实现简单，是目前最主流的量化方式。

**激活量化（Activation Quantization）**：同时量化前向传播中的激活值，矩阵乘法直接在低精度下进行，速度提升更大，但精度损失也更大，且激活值的分布变化更大，量化更困难。

### INT8 量化

INT8 将每个权重从 float16（2 字节，65536 个可能值）量化为 int8（1 字节，256 个可能值），显存减半。

LLM.int8()（Dettmers et al., 2022）是最早广泛使用的大模型 INT8 量化方法，关键发现是：大模型权重里存在极少数的"异常大值"（outlier），这些值如果被普通均匀量化截断，会导致显著的精度损失。LLM.int8() 的解法是混合精度：对包含异常值的少数维度保持 float16，其他维度做 INT8，通过一个分析步骤自动识别哪些维度需要保护。结果是几乎无损地把 8B 以上模型压缩到约一半显存。

### GPTQ：训练后 INT4 量化

GPTQ（Frantar et al., 2022）是目前最广泛使用的 INT4 量化方法，把模型压缩到约原来的 1/4 显存（相对 float16）。

GPTQ 是**训练后量化**（Post-Training Quantization，PTQ）——不需要重新训练，只需要一小批校准数据（通常几百条随机文本），在约 1-4 小时内完成量化。

原理：逐层量化，对每一层的权重矩阵，使用二阶导数信息（Hessian）找到最优的量化参数，让量化后该层的输出误差最小。相比简单的四舍五入量化，GPTQ 利用了权重之间的相关性来补偿量化误差，精度损失更小。

代价：INT4 量化会带来可感知的质量下降，通常体现为：模型在复杂推理任务上的能力轻微降低，以及在长文本生成时偶尔出现重复或语义混乱。对于指令遵循和常规问答，INT4 GPTQ 的质量损失在大多数用户测试里是可接受的。

### AWQ：保护重要权重

AWQ（Activation-aware Weight Quantization，Lin et al., 2023）是对 GPTQ 思路的改进，出发点是：不同权重对模型输出的重要性不同——某些权重对应的激活值经常很大（被频繁激活），量化这些权重会损失更多信息。

AWQ 先分析激活值来识别"重要"的权重通道，对这些通道做缩放（放大权重值，让量化时的相对误差更小），而不是对它们保留高精度（避免混合精度的实现复杂性）。结果是在接近 GPTQ 量化速度的前提下，精度更好，尤其在多语言和代码任务上差异更明显。

AWQ 是目前 Hugging Face `transformers` 库默认推荐的 INT4 量化方案之一，也是很多量化模型发布时使用的方法（比如 Mistral、LLaMA 系列的 AWQ 版本）。

### 量化的实际效果

以 LLaMA 3 70B 为例：

| 精度 | 显存占用 | 推荐场景 |
|------|----------|----------|
| float16 | 约 140 GB | 研究/高质量生产，8 × A100 |
| INT8 | 约 70 GB | 质量接近原模型，4 × A100 |
| INT4 (GPTQ/AWQ) | 约 35-40 GB | 单卡 A100 80GB 可运行，轻微质量损失 |

INT4 量化是"能不能跑"和"能跑好"之间的重要里程碑——它让很多研究者和工程师用普通的单卡 GPU 运行 70B 级别的模型成为可能。

## 投机解码：小模型猜，大模型验

投机解码（Speculative Decoding，Leviathan et al., 2023）是一种利用自回归生成本质特点的优化：大模型验证一批 Token 比生成一批 Token 快。

**为什么验证比生成快**？

自回归生成是串行的：每生成一个 Token 都需要一次完整的前向传播，然后用这个 Token 更新 KV Cache，再进行下一步。N 个 Token 需要 N 次串行前向传播。

但验证是可以并行的：如果我已经有了一个候选 Token 序列（比如 `["The", "answer", "is", "42"]`），我可以把这四个 Token 拼在一起，一次前向传播（类似 Prefill）得到模型对每个位置"下一个 Token 应该是什么"的预测，然后逐位检查候选序列是否与大模型的预测一致。这一次前向传播相当于验证了四个 Token，而并行的前向传播比四次串行快得多。

**流程**：

1. 用一个小的草稿模型（Draft Model）串行生成 K 个候选 Token（比如 K=4）
2. 把候选序列送给大的目标模型（Target Model）并行验证
3. 从左到右检查：如果目标模型同意当前位置的候选 Token，接受它，继续检查下一个；如果不同意，拒绝这个 Token 及之后的所有候选，用目标模型的预测替换被拒绝的位置
4. 无论接受了几个候选，目标模型都会多输出一个新的 Token（被拒绝位置的替换）

**为什么有加速**？关键在于草稿模型的"接受率"（acceptance rate）。如果草稿模型和目标模型的分布足够接近，大多数候选 Token 会被接受。一次目标模型前向传播（用于验证 K 个候选）比 K 次独立的目标模型前向传播便宜很多，整体相当于用一次大模型的代价换回了多个 Token，吞吐量提升了。

**关键条件**：

- 草稿模型必须足够小（通常是目标模型的 1/10 以下），否则草稿生成本身就很慢
- 草稿模型和目标模型的输出分布要相近，否则接受率低，反而不如直接用目标模型
- 最适合批量大小为 1 的场景（单个用户的低延迟请求）。批量较大时，目标模型已经有不错的 GPU 利用率，投机解码的相对收益变小

**Self-speculative decoding（自投机解码）**：不需要额外的草稿模型，而是用目标模型本身的早期层（early exit）生成草稿，再用完整的目标模型验证。代价是需要对模型架构做修改，但避免了维护两个模型的部署复杂性。

投机解码在 llama.cpp、vLLM 和 Hugging Face TGI 等主流推理框架里已有集成实现。对于需要低延迟、单用户实时交互的场景（比如编程助手的 token streaming），投机解码通常能带来 2-3 倍的速度提升。

**Medusa（Cai et al., 2024）**是投机解码的一个变体，不用单独的草稿模型，而是给目标模型加若干个额外的"Medusa Head"——在最后一层隐藏状态上并联多个预测头，每个头预测不同位置的 Token（第 +1、+2、+3 个），同时也对这些候选做树形搜索和验证。Medusa 不改变模型主干，只加少量参数，避免了维护两个完整模型的部署麻烦，实测在 batch size=1 场景下加速比与有匹配草稿模型的投机解码接近。

**Eagle（Li et al., 2024）**同样走无外部草稿模型路线，训练一个轻量的特征级 Draft 模块，直接预测目标模型下一步的隐藏状态（而不是 Token），再走目标模型的 LM Head 得到候选 Token。因为在特征空间匹配而不是 Token 空间，接受率更高，速度提升更稳定。Eagle-2 进一步引入了动态草稿长度，根据当前输入的难度自适应调整每次生成多少候选，避免在"模型非常确定"的情况下过度生成候选浪费验证时间。

## Flash Attention：让 Attention 计算本身更快

Attention 计算是推理的另一个瓶颈，尤其是在长上下文场景。

标准 Attention 的实现把中间矩阵（Q·Kᵀ）完整写回 HBM（显存），再从 HBM 读出来做 Softmax。对于长序列，这个中间矩阵很大，反复读写 HBM 是主要开销。

Flash Attention（Dao et al., 2022）通过**Tiling（分块）**重新实现了 Attention：把 Q、K、V 矩阵分成小块，用一个融合的 CUDA kernel 在 SRAM（片上缓存，比 HBM 快约 10 倍）里完成整个 Attention 计算，避免中间结果落盘到 HBM。

数学输出和标准 Attention 完全相同，但内存读写量从 O(N²) 降到了 O(N)。实测上，Flash Attention 在长序列（>1K Token）下比标准实现快 2-4 倍，显存占用也更低（不需要存储 N×N 的注意力矩阵）。Flash Attention 2 和 3 进一步优化了并行化策略，目前已经是所有主流推理框架的默认实现。

## 这些优化合起来能带来多大提升

一个实际的推理服务（比如 vLLM 部署 LLaMA 3 8B）通常会同时用到以下优化：

- **PagedAttention + Continuous Batching**：提升并发利用率，吞吐量 5-23 倍提升（相比朴素静态 batching）
- **Flash Attention**：长上下文 Attention 计算加速 2-4 倍
- **INT4 量化（GPTQ/AWQ）**：显存减半到 75%，允许更大批量或在更小显存的卡上运行
- **投机解码**（单用户低延迟场景）：首 Token 后的生成速度 2-3 倍提升

这些优化不是简单叠加的，但组合使用的效果是实质性的：一个 2023 年的推理部署方案和 2021 年的朴素部署相比，在相同硬件上的吞吐量可以高出一个数量级。

## 在实际部署中怎么选

**选 vLLM** 如果：你要部署自己的模型服务，需要高吞吐量，有 NVIDIA GPU。vLLM 集成了 Continuous Batching、PagedAttention、Flash Attention、各种量化支持，是目前生产级推理部署的事实标准。

**选 llama.cpp** 如果：你在 CPU 或 Apple Silicon 上运行，或者需要在消费级 GPU（RTX 3090/4090）上运行 70B 量化模型。llama.cpp 对各种硬件的兼容性最好，内存管理也很高效。

**选量化模型（GPTQ/AWQ/GGUF）** 如果：你的 GPU 显存不够运行原始精度的模型。Hugging Face Hub 上有大量预量化好的版本，可以直接下载使用，不需要自己跑量化流程。

**选投机解码** 如果：你的场景是单用户低延迟（编程助手、实时对话），批量大小通常为 1，且有一个匹配的小草稿模型可用。

以下是用 vLLM 启动一个本地推理服务最简单的方式——一行命令就开启了 Continuous Batching、PagedAttention 和 Flash Attention：

```bash
# 安装 vLLM
pip install vllm

# 启动 OpenAI 兼容的推理服务（float16 精度）
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Meta-Llama-3-8B-Instruct \
  --max-model-len 8192

# 启动 AWQ 量化版（显存减半，适合显存较小的 GPU）
python -m vllm.entrypoints.openai.api_server \
  --model TheBloke/Llama-3-8B-Instruct-AWQ \
  --quantization awq \
  --max-model-len 8192
```

服务启动后，客户端通过标准的 OpenAI Chat Completions API 调用，和调用 OpenAI 的方式完全相同，只需要把 `base_url` 指向本地：

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="token")

response = client.chat.completions.create(
    model="meta-llama/Meta-Llama-3-8B-Instruct",
    messages=[{"role": "user", "content": "解释一下 KV Cache 的原理"}],
    stream=True,  # 流式输出，首 Token 延迟更直观
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### 延迟 vs 吞吐量的权衡

推理优化里有一个永恒的张力：**延迟（Latency）**和**吞吐量（Throughput）**不总是同向优化的。

Continuous Batching 提升吞吐量，但会让单个请求的响应时间有时变长——当 GPU 在并发处理 64 个请求时，每一个的平均生成速度都不如独占 GPU 时快。对于交互式场景（用户盯着屏幕等），首 Token 延迟和每 Token 延迟是关键指标；对于批处理场景（离线评估、数据合成），总吞吐量是关键。

量化能同时改善两者：模型更小，每次前向传播更快，KV Cache 也更小，能容纳更大的 batch，延迟和吞吐量都受益。但量化有精度成本，对质量敏感的任务（复杂推理、数学）要先测评。

投机解码针对低延迟优化，在大 batch 下收益缩小甚至为负（草稿模型占用的显存和带宽对大 batch 来说是净开销）。

实际部署时的决策框架：
- **交互式服务（Chatbot、编程助手）**：优先 Continuous Batching + Flash Attention + INT4 量化；单用户实时流式输出场景考虑投机解码
- **高并发 API 服务**：优先最大化 batch size，INT4 量化让同等显存容纳更多并发
- **离线批处理**：关注吞吐量，INT4 量化 + 最大 batch，延迟不是主要约束
- **边缘/消费级设备**：llama.cpp + GGUF 量化，INT4 甚至 INT3，优先能跑起来

## 参考资料

- [Orca: A Distributed Serving System for Transformer-Based Generative Models（Yu et al., 2022）](https://www.usenix.org/conference/osdi22/presentation/yu)
- [vLLM: Efficient Memory Management for LLM Serving with PagedAttention（Kwon et al., 2023）](https://arxiv.org/abs/2309.06180)
- [Flash Attention: Fast and Memory-Efficient Exact Attention with IO-Awareness（Dao et al., 2022）](https://arxiv.org/abs/2205.14135)
- [GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers（Frantar et al., 2022）](https://arxiv.org/abs/2210.17323)
- [AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration（Lin et al., 2023）](https://arxiv.org/abs/2306.00978)
- [Fast Inference from Transformers via Speculative Decoding（Leviathan et al., 2023）](https://arxiv.org/abs/2211.17192)
