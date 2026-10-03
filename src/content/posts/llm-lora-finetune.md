---
title: 大模型微调：Full Fine-tuning、LoRA 与 QLoRA
description: 从"为什么不直接更新全部参数"出发，拆解 LoRA 用低秩矩阵逼近权重更新的原理，解释 rank、alpha、target modules 这些参数在实际训练中意味着什么，以及 QLoRA 怎样把 70B 模型的微调显存压进一块 GPU。
category: Agent
subcategory: LLM 原理与训练
articleClass: focused
seriesOrder: 40
featured: false
publishedAt: 2026-10-04T00:15:00+08:00
updatedAt: 2026-10-04
tags: [LLM, LoRA, QLoRA, 微调, Fine-tuning, PEFT, 参数高效微调]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

预训练模型在巨量通用语料上学会了语言能力，但它不知道你的公司叫什么、你的产品有哪些规则、你的用户期待什么风格的回答。对齐这个差距有几种方法：在 Prompt 里说清楚、用 RAG 把文档塞进上下文、或者更新模型参数让它"记住"新的行为。

微调属于第三种，也是这篇文章要讲的。在《[大模型通识：从 Token、Transformer 到训练与推理](/posts/llm-fundamentals-from-token-to-inference/)》里微调只有一段带过，这里把机制讲清楚——为什么 Full Fine-tuning 在大模型上走不通，LoRA 的低秩假设从哪里来，QLoRA 的四个技术细节分别解决了什么问题。

## 微调改变了什么，适合哪些场景

微调使用新的训练样本，在预训练权重基础上继续做梯度下降，让参数向目标行为靠拢。

适合用微调的场景：行为稳定、重复性高、用 Prompt 表达成本太高，或者风格/格式要求需要贯穿所有输出。典型例子是：把一个基础模型训练成某个角色的客服，让模型始终用特定的 JSON 结构输出，或者把通用代码模型特化到某个内部 DSL。

不适合用微调的场景：频繁更新的事实知识（上新产品、改价格），这类情况改数据库或 RAG 成本低很多；以及需要实时外部数据的任务——微调改变的是模型的参数，而不是它能访问的信息源。

一个经常被问到的问题：微调和 RAG 怎么选？

粗略的判断标准是：如果是**知识**（事实、文档内容），用 RAG；如果是**行为**（语气、格式、任务范式），用微调。实际生产系统常常组合两者：微调改善行为，RAG 提供时效性内容。

## Full Fine-tuning：全参数更新为什么在大模型上行不通

最直接的微调方式是 Full Fine-tuning：用新数据对所有参数做梯度下降，和预训练流程相同，只是数据换了、迭代轮数少得多。

问题在于参数量和显存。LLaMA 3 8B 有 80 亿个参数，每个 float16 参数占 2 字节，参数本身就是 16 GB。但训练时还需要：

- **梯度**：和参数同样大小，额外 16 GB
- **优化器状态**：Adam 需要一阶矩（momentum）和二阶矩（variance），各一份参数大小，额外 32 GB（如果是混合精度，这部分是 float32，即 32 GB）
- **激活值（activation）**：前向传播时的中间结果，用于反向传播，大小随 batch size 和序列长度增长

仅参数 + 梯度 + 优化器就需要约 64-80 GB。8B 的小模型尚且需要一块 A100 80GB 满载运行，70B 的模型理论需要约 480-560 GB，需要至少 6-8 张 A100 并行。

Full Fine-tuning 还有两个非显存的问题：

**灾难性遗忘（Catastrophic Forgetting）**：当新任务数据引起参数大幅更新时，模型可能"忘掉"原来的通用能力。训练一个法律助手之后，它可能变得不擅长写代码。原因是参数空间是共享的——更新处理法律语义的参数，可能破坏了那些参数之前编码的其他语言模式。

**数据要求高**：全参数更新需要足够的数据量才能稳定收敛，而不是过拟合到少量样本。收集和清洗几千到几万条高质量样本是一个非轻松的工程任务。

这些约束推动了参数高效微调（Parameter-Efficient Fine-Tuning，PEFT）的发展，核心思路是：不更新全部参数，只训练少量新增或选定的参数，让主干权重保持冻结。LoRA 是目前应用最广的 PEFT 方法。

## LoRA 的核心假设：权重更新是低秩的

LoRA（Low-Rank Adaptation）来自 2021 年 Microsoft 的论文。它的出发点是一个关于权重更新的观察：**在微调过程中，权重矩阵的变化量 ΔW 的内在维度很低**。

ΔW 虽然是一个大矩阵（比如 4096×4096），但它的信息量可以用一个低秩分解来近似：

```
ΔW ≈ B × A
```

其中 B 是 d×r 的矩阵，A 是 r×d 的矩阵，r 远小于 d（比如 r=8 或 r=16）。

原来需要存储和更新 d×d 个参数（4096×4096 = 16.7M），现在只需要 d×r + r×d 个参数（4096×8 + 8×4096 = 65K，大约是原来的 1/256）。

![LoRA 低秩矩阵分解：冻结权重 W 与可训练矩阵 B 和 A](/images/posts/lora-low-rank-decomposition.svg)

前向传播时，输出是：

```
y = (W + ΔW) × x = W × x + B × A × x
```

W 的梯度不计算（冻结），只有 B 和 A 的梯度被计算和更新。**初始化时，A 用标准高斯分布初始化，B 初始化为全零，所以训练开始时 ΔW = B×A = 0，不改变原模型的输出**，训练从原始点开始，稳定性好。

**为什么低秩假设是合理的？**

从几个角度理解。

一，语言模型在预训练中学会的是高维表示空间，微调通常是在现有能力上做小幅度的行为对齐，而不是学全新的语言能力。这种"对齐式"的更新，内在维度确实不高。Aghajanyan et al. (2020) 的研究发现，大模型在微调阶段的参数更新确实集中在少数几个方向上，有效维度远低于参数矩阵的名义维度。

二，LoRA 论文本身做了消融实验，在 GPT-3 的代码补全和文本摘要任务上，rank=4 到 rank=64 之间的效果差异在大多数评估指标上都不显著。这说明有效信息确实集中在少数奇异向量上，大部分维度是冗余的。

三，实践上的广泛验证。用 rank=8 或 rank=16 的 LoRA 微调后的模型，在大多数指令遵循、格式对齐和领域适配任务上的效果与 Full Fine-tuning 相当，只是在需要极度专业化知识或训练数据量非常大的场景下才有显著差距。

## rank 和 alpha：两个最重要的超参数

**rank（r）**控制 B 和 A 的"宽度"，即低秩分解的维数。

- rank 越高，可训练参数越多，表达能力越强，但也越容易过拟合，训练成本越高
- rank 越低，参数越少，训练快，正则化效果更强，适合数据量少的场景

实践中常用的值：

| 数据量 | 推荐 rank |
|--------|-----------|
| 几百到几千条 | 4 或 8 |
| 几千到两万条 | 16 或 32 |
| 几万条以上，追求接近 Full FT 效果 | 64 或更高 |

没有一个放之四海而皆准的值，通常需要用验证集的表现来决定。

**alpha（α）**是一个缩放因子，控制 ΔW 对原始输出的贡献比例：

```
y = W × x + (α / r) × B × A × x
```

用 α/r 来缩放 LoRA 的输出。直观理解：alpha 越大，LoRA 对输出的影响越强，相当于让新行为的"声音"更大；alpha 越小，更倾向于保留原模型行为。常见设置是 α = r（缩放系数为 1）或者 α = 2r（系数为 2）。

在 Hugging Face PEFT、Unsloth 等框架里，默认 alpha=16，rank=8，是一个比较安全的起点。

## target modules：在哪些层加 LoRA

LoRA 可以加到任何线性层（Linear Layer）上。Transformer 里主要的线性层有两类：

**注意力层**：q_proj（Query 投影）、k_proj（Key 投影）、v_proj（Value 投影）、o_proj（Attention 输出投影）

**前馈层（FFN/MLP）**：根据具体架构不同，名称是 gate_proj、up_proj、down_proj（LLaMA 风格的 SwiGLU 架构）或 fc1、fc2（传统 FFN）

最常见的配置是只加到注意力层的 q_proj 和 v_proj 上——这是 LoRA 原论文的设置，也是很多教程的默认值，参数量最小。

但后续研究发现，把 LoRA 加到更多层（包括 k_proj、o_proj 和 FFN 层）通常能进一步提升效果，代价是可训练参数量增加，但仍然远小于 Full Fine-tuning，因为只有这些小矩阵参与梯度计算。

实践建议：

- 快速实验、数据量少：只加 q_proj + v_proj
- 追求更好效果：加所有注意力层（q, k, v, o）
- 全力冲效果：加所有线性层（注意力 + FFN），此时参数量接近 Full Fine-tuning 的 1-5%，但显存节省仍然显著

## QLoRA：把 70B 模型的微调装进一块 GPU

QLoRA（Quantized LoRA）是 2023 年 Dettmers et al. 提出的，核心思路是把基础模型的权重量化到 4-bit，然后在量化后的模型上做 LoRA。

显存节省非常显著。LLaMA 3 70B 参数量 700 亿，float16 存储需要约 140 GB，超出任何单卡 GPU 的显存。4-bit 量化后，参数只需要约 35 GB，加上 LoRA 的可训练参数和 Adam 优化器状态（只有 LoRA 部分是 bfloat16，约 5-10 GB），总显存约 40-48 GB，可以在一块 A100 80GB 或两块 A6000 48GB 上完成训练。

QLoRA 的四个关键技术设计：

**NF4（NormalFloat 4-bit）量化**：普通的 INT4 量化是均匀分布的，但神经网络权重通常接近正态分布（中间多、两端少），均匀量化会把精度浪费在尾部。NF4 把 16 个量化级别分配到标准正态分布的等概率分位点上，让量化误差更小，信息损失更低。

**分块量化（Block-wise Quantization）**：不是对整个权重矩阵做全局量化，而是把矩阵切成小块（通常每 64 个元素一组），每块独立计算量化参数（缩放因子和零点）。这样做是因为大矩阵里的个别异常大值（outlier）会拉偏全局量化范围，让正常值损失精度。分块处理可以把异常值的影响限制在局部。

**双重量化（Double Quantization）**：分块量化本身产生了一批量化参数（每块一个 float32 缩放因子），这批参数也会占显存。QLoRA 对这些量化参数本身也做一次量化（8-bit），进一步压缩存储开销。对 65B 参数的模型，双重量化额外节省约 3.5 GB 显存。

**分页优化器（Paged Optimizer）**：微调过程中 GPU 显存会偶尔超额（比如处理特别长的序列时）。QLoRA 使用 NVIDIA CUDA 的统一内存（Unified Memory）机制，在 GPU 显存不够时把优化器状态分页到 CPU 内存，避免因一时溢出而 OOM 崩溃，训练恢复时再调回 GPU。

精度上的关键细节：虽然基础模型权重是 4-bit 存储，但前向传播时会临时反量化回 bfloat16 做矩阵运算，LoRA 的可训练参数（B 和 A）也是 bfloat16。梯度计算完全在 bfloat16 精度下进行，参数更新完成后只需要把 LoRA 权重本身存起来（4-bit 量化不变），不影响训练质量。

QLoRA 的代价是训练速度比不量化的 LoRA 慢约 30-40%，因为量化和反量化有额外运算开销。但在 70B 量级上，这个代价完全值得——它把"能不能跑"的问题解决掉了。

## 微调数据：质量决定效果上限

LoRA 和 QLoRA 解决了计算效率问题，但微调效果的上限由数据质量决定。

**格式要和推理时一致**。如果最终应用是通过聊天接口使用模型，微调数据也要用聊天格式（system/user/assistant 轮次），不能用裸文本格式。格式不一致会让模型在角色切换上产生混乱：它不知道什么时候应该"在接受训练"，什么时候"在回答问题"。

**质量远比数量重要**。InstructGPT 用约 13000 条人工标注样本就显著提升了 GPT-3 的指令遵循能力。在专业领域的微调任务里，500 条高质量样本通常比 5000 条低质量样本效果更好，而且更快收敛。

高质量数据意味着：回答是你希望模型学会的行为的真实示范；指令和回答是真正对齐的；没有错误事实；格式和风格在整个数据集里一致。如果数据里有一批"正确"示范和一批"不太对"的示范混在一起，模型会在两种行为之间拉锯，效果差而且难以调试。

**测试集要提前留出来**。在微调前，把 10-20% 的数据留作验证集，不参与训练。在每个 epoch 结束后同时评估训练集和验证集的 loss。如果验证集 loss 在训练集 loss 继续下降时开始上升，说明过拟合开始了，应该停止训练或回滚到上一个检查点。

## 过拟合的信号和应对

微调数据量通常不大，过拟合是常见问题。几个可观察到的信号：

- 验证集 loss 在训练集 loss 继续下降时开始上升
- 模型在验证集上的输出开始出现训练数据里的特定措辞（逐字"照抄"训练样本而不是泛化）
- 在稍微不同的 Prompt 下，行为变得不稳定，比如同义改写一下问题，回答质量骤降

应对方式：

- 减少 epoch 数量（从 3 epoch 降到 1 或 2）
- 降低 rank（减少可训练参数，增强正则化效果）
- 增加 dropout（在 LoRA 层加 0.05-0.1 的 dropout）
- 增加数据量或数据多样性

欠拟合的信号则相反：训练集和验证集的 loss 都还在下降，模型输出的风格和格式还没有完全对齐目标。这时通常是需要增加 epoch、提高 learning rate 或者增大 rank。

## 推理时怎么用训练好的 LoRA

LoRA 训练完之后，使用上有两种方式：

**合并权重（Merge and Unload）**：把 ΔW = B×A 加回到原始 W 上，得到一个普通的完整权重矩阵。推理时和普通模型完全一样，没有任何额外开销，也不需要额外的 adapter 管理逻辑。这是大多数生产部署的选择。

```python
# PEFT 合并 LoRA 权重到基础模型
from peft import PeftModel

model = PeftModel.from_pretrained(base_model, "path/to/lora")
model = model.merge_and_unload()
# 现在 model 是一个普通的 transformer 模型，可以直接保存和推理
```

**保持分离（Keep Adapter）**：基础模型和 LoRA 权重保持独立，推理时动态加载 adapter。好处是一个基础模型可以配多个不同的 LoRA adapter，针对不同任务按需切换，基础权重只需要加载一份，节省显存。代价是推理时有额外的矩阵运算，以及需要管理 adapter 的加载和卸载。vLLM 从 0.4 版本开始支持动态 LoRA 加载，可以在同一个推理服务实例上为不同请求动态切换 adapter，适合多租户推理场景。

## 参考资料

- [LoRA: Low-Rank Adaptation of Large Language Models（Hu et al., 2021）](https://arxiv.org/abs/2106.09685)
- [QLoRA: Efficient Finetuning of Quantized LLMs（Dettmers et al., 2023）](https://arxiv.org/abs/2305.14314)
- [Intrinsic Dimensionality Explains the Effectiveness of Language Model Fine-Tuning（Aghajanyan et al., 2020）](https://arxiv.org/abs/2012.13255)
- [Hugging Face PEFT 文档](https://huggingface.co/docs/peft)
- [Unsloth（高效 LoRA/QLoRA 训练库）](https://github.com/unslothai/unsloth)
