---
title: Tokenization：模型看到的文字为什么和人不一样
description: 从字符级分词的困境出发，拆解 BPE 合并算法的工作机制，解释为什么同样一句话在中文、英文和代码里的 Token 数差异悬殊，以及 Tokenization 的设计决策怎样影响模型能力边界、API 成本和实际使用体验。
category: Agent
subcategory: LLM 原理与训练
articleClass: focused
seriesOrder: 20
featured: false
publishedAt: 2026-08-19T09:35:00+08:00
updatedAt: 2026-08-19T09:35:00+08:00
tags: [LLM, Tokenization, BPE, Token, Tokenizer, 词表, 子词]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

在《[大模型通识：从 Token、Transformer 到训练与推理](/posts/llm-fundamentals-from-token-to-inference/)》里，Tokenization 是这样一句话带过的：Tokenizer 使用固定词表，把常见片段映射到一个 Token，把少见内容拆成多个 Token。

这句话是对的，但它跳过了一个真正有意思的问题：词表是怎么来的，凭什么这些片段会被合并在一起，以及这个设计决策会在什么地方让你踩坑。

这篇文章专门处理 Tokenization 这一层。前置知识只需要"Token 是模型处理文本的基本单位"就够了，其他从头讲。

## 为什么不直接用字符或单词

先说两个显而易见的方案，以及它们为什么都行不通。

**方案一：以单个字符为单位**。每个字母或汉字是一个 Token。好处是词表很小（26 个英文字母加标点，汉字常用的几千个），也不存在未登录词的问题。代价是序列太长。"machine learning"切成字符是 16 个 Token；每一步 Attention 的计算量随序列长度平方增长，序列一长，成本和效果都很差。

**方案二：以完整单词为单位**。英文按空格切，一个单词一个 Token。问题在于词表会爆炸——英文有数十万个单词，加上各种变形、专有名词、代码里的标识符，词表轻松超过百万。更要命的是，"uncharacteristically"这个词你训练时没见过，推理时就完全处理不了，直接变成一个 `<UNK>` 占位符，所有信息丢失。

子词方法（Subword）站在两者中间：让常见的词或片段成为一个 Token，让不常见的词拆成更小的已知片段。这样词表大小可控（一般 32K 到 128K），序列也不会太长，同时几乎不存在完全处理不了的输入——最坏情况是拆成单个字符（或 UTF-8 字节）。

## BPE：从字符出发，一步步合并高频片段

现代 LLM 最常用的子词算法是 BPE（Byte Pair Encoding）。它的逻辑非常直白：从字符级词表出发，找当前语料里相邻出现频率最高的那对符号，把它们合并成一个新符号，写进词表，然后重复。

![BPE 合并规则迭代过程示意](/images/posts/tokenization-bpe-merge.svg)

举一个简化的例子。语料里有 `low`（出现 5 次）、`lower`（出现 2 次）、`newest`（出现 6 次）、`widest`（出现 3 次）。初始词表只有字符：`l o w e r n s t i d`（加上一个词边界符 `</w>`）。

第一轮：统计所有相邻字符对的出现频率。`(l, o)` 出现了 7 次（low 5 次 + lower 2 次），是最高的。合并，词表新增 `lo`，原来所有 `l o` 的位置替换成 `lo`。

第二轮：再统计。`(lo, w)` 出现了 7 次（替换后 `low` 变成了 `lo w`）。合并，词表新增 `low`。

以此类推，若干轮之后词表里会出现 `low`、`lower`、`er`、`new`、`newest`、`est`、`wide`、`widest` 这些片段。高频词直接对应一个 Token，低频词或者新词被拆成已有的片段。

你设定的词表大小决定了合并进行多少轮。32K 词表意味着在初始字符集的基础上做了约 3 万次合并。哪些片段最终进了词表，完全由训练语料决定——这也是为什么同一个词在 GPT-4 的 Tokenizer 和 LLaMA 的 Tokenizer 下会被切成不同的 Token 数。

**字节级 BPE**：GPT 系列使用的 BPE 实现（tiktoken）是字节级的：先把文本转成 UTF-8 字节序列（256 个字节值作为初始词表），在字节上做合并，不在字符上做合并。好处是理论上可以处理任何合法的 UTF-8 文本，不存在 `<UNK>`——最坏情况是拆成字节级单 Token，不会丢信息。代价是中文的 UTF-8 编码通常占 3 个字节，如果该汉字频率不高，可能被拆成 2-3 个 Token，效率比英文低。这是中文 Token 效率低于英文的底层原因之一。

**SentencePiece 和 Unigram 算法**：SentencePiece 是 LLaMA 1/2、Mistral 等模型的常见选择，支持 BPE 和 Unigram 两种子词算法，不依赖预分词，适合中文、日文这类没有明确词边界的语言。Unigram 算法（Kudo, 2018）和 BPE 的方向相反：从一个大词表出发，根据训练语料上的最大似然概率，逐步剔除对总体损失贡献最小的词，直到词表缩减到目标大小。两者实际效果接近，区别更多体现在边缘案例的切分方式。LLaMA 3 切换到了 tiktoken（字节级 BPE），部分原因是提升多语言 Token 效率和对极端 Unicode 输入的鲁棒性。

## 同一句话，Token 数为什么差这么多

这是 Tokenization 最直接影响你日常使用的地方。

![中文、英文与代码的 Token 效率对比](/images/posts/tokenization-language-efficiency.svg)

**英文**：常见单词通常对应 1 个 Token，复杂词被拆成 2–3 个子词。"The function returns a value"大约是 6 个 Token，和单词数接近。

**中文**：常见双字词通常是 1–2 个 Token，信息密度比英文高。同样语义的中文句子，Token 数往往少于英文翻译。但低频汉字会被拆成 UTF-8 字节级的多个 Token。这对实际使用的影响是：用中文写 Prompt 通常比英文省 Token（便宜），但在某些罕见字符上会反过来。

**代码**：空格、缩进、括号、引号、下划线全都占 Token。4 个空格缩进可能是 1 个 Token，也可能是 4 个，取决于具体 Tokenizer 的词表。`dict[key]['val']` 这种符号密集的片段，Token 数远多于字面字符数的印象。长函数名如 `calculateMonthlyRevenue` 通常会被拆成 2–4 个子词。

为什么这些差异对你重要？直接原因是 **Token 数 = 成本和上下文容量**。API 按 Token 计费，上下文窗口也按 Token 计算容量。如果你的应用需要处理大量代码或日志，Token 消耗会远超同等字符数的自然语言文本。

间接原因是**模型对逐字符任务的支持是不稳定的**。比如"这个词有几个字母"、"把这段文字反转"这类任务，模型并没有直接看到字符序列，它看到的是 Token ID 序列。如果"strawberry"被切成 `straw` + `berry`，模型很可能数不对字母数，因为它在计算时并不以字母为单位推理。这是模型被问到"strawberry 有几个 r"时容易出错的直接原因，不是智力问题，是 Tokenization 层的结构特性。

## 词表大小的取舍

词表大小不是越大越好，也不是越小越好。

词表太小（比如 8K）：序列会变长，因为需要更多 Token 来表示同样的内容。长序列让 Attention 计算更贵，也可能更早遇到上下文窗口的限制。

词表太大（比如 512K）：Embedding 矩阵也会变大（词表大小 × 隐藏维度），推理时输出层的 Softmax 要对更多候选打分，显存压力增加。更重要的是，词表里的稀有符号在训练数据里见过的次数很少，对应的 Embedding 可能没训练好。

现代主流模型大多落在 32K 到 128K 之间。GPT-4 使用 cl100k_base，词表 100K；LLaMA 3 使用 128K 词表；较早的 LLaMA 1 是 32K。词表扩大的主要动力是提高多语言和代码的 Token 效率，让中文、阿拉伯文、代码等输入不需要拆成太多片段。

### 词表大小带来的参数成本

词表大小直接决定 Embedding 层的参数量：`vocab_size × d_model`。以 LLaMA 3 8B 为例，128256 × 4096 ≈ 5.25 亿参数，占模型总参数的约 6%。如果词表扩大到 512K，Embedding 会变成约 21 亿参数，占比接近四分之一——对 8B 规模的模型来说是不小的负担。

输出层的计算也会变重。LM Head 要把隐藏向量投影到 vocab_size 维，每个 Token 都要在 512K 个候选上做 Softmax 和采样。虽然这只是一次矩阵乘法，但在 Decode 阶段每个 Token 都要重复一次，词表越大，单步延迟越高。

所以词表大小是一个多目标优化：太大增加参数和延迟，太小降低 Token 效率、拉长序列、增加 Attention 成本。32K 到 128K 是当前实践里找到的平衡区间。

### 多语言的 Token 效率差异

词表大小和训练语料的语言配比对不同语言的 Token 效率影响巨大。一个主要在英文语料上训练的 Tokenizer，处理英文时效率很高，但处理中文、泰文、阿拉伯文时每个字可能被拆成多个 Token。

具体来说：同样一句"人工智能正在改变世界"，在英文优先的 Tokenizer 下可能切成 8-12 个 Token，而在做过中文优化的 Tokenizer 下可能只要 5-7 个 Token。这个差异在长文档处理时会被放大——一本十万字的中文书，Token 数可能相差几十万，直接影响到成本和上下文窗口能装下多少内容。

这也是为什么面向特定语言的模型（比如 Qwen 对中文的优化、DeepSeek 对中英文混排的优化）会专门设计 Tokenizer，把目标语言的高频字词加入词表。对应用开发者来说，如果你的业务有大量中文或特定语言内容，选择一个对该语言 Token 效率高的模型，可能比选择一个通用能力稍强但 Token 效率低的模型更划算。

## 分词怎样影响模型的实际能力

Tokenization 不只是成本和效率问题，它还影响模型能做什么、不能做什么。

**算术和数字处理**：数字的切分方式会影响模型的算术能力。如果 `1234` 被切成 `12` + `34`，模型看到的是两个 Token，而不是四个数字。做多位数的加减法时，模型需要先从 Token 序列"还原"出数字的位结构，这本身就是额外负担。一些研究发现，把数字按单个数字切分（每个数字一个 Token）能改善算术任务的表现，但会牺牲 Token 效率。这就是为什么很多模型在做精确计算时依赖工具（代码解释器）而不是直接推理。

**代码缩进和空格**：代码的 Token 效率对编程助手至关重要。如果缩进（4 个空格）、换行、括号都各自占 Token，一段代码的 Token 数会迅速膨胀。主流模型的 Tokenizer 会把常见的缩进模式（如 4 空格、tab）合并成单个 Token，把常见的代码模式（如 `def `、`() {`、`=>`）加入词表，以提高代码处理的效率。

**稀有词和专业术语**：模型对罕见词和领域术语的处理能力较弱，部分原因是它们被拆成了很多零碎的子词 Token。在医学、法律、生物等领域，专业术语往往很难在通用 Tokenizer 的词表里找到完整对应，导致序列变长、表示变碎。这也是领域适配模型时会考虑词汇表扩展的原因。**

**Token 边界与语义边界不一致**：Token 的切分边界和语言学意义上的词边界、语义边界并不总是一致。比如 "unhappy" 可能被切成 `un` + `happy`（词素边界，很合理），但 "harness" 可能被切成 `har` + `ness`（纯粹因为字符概率，没有语义）。当 Token 边界和语义边界错位时，模型需要额外的层来"跨越"这些边界重建语义，这增加了模型的负担，也可能是某些细粒度语言任务表现不佳的原因。

## 特殊 Token 和聊天模板

除了普通文本片段，词表里还有一类特殊 Token，用来传递结构信息：

- `<|endoftext|>`：文本结束，训练时用来标记文档边界
- `<|im_start|>`、`<|im_end|>`：消息边界，把 system/user/assistant 的轮次分开
- `<|tool_call|>`、`<|tool_result|>`：工具调用协议
- `[CLS]`、`[SEP]`：BERT 类模型的分类和分隔符

这些特殊 Token 不是从语料里训练出来的，是手动加进词表的。它们的 Embedding 通常需要在模型训练过程中单独学习。

聊天模板的作用是把多轮对话编码成一段具体的 Token 序列：

```
<|im_start|>system
你是一个助手。<|im_end|>
<|im_start|>user
帮我解释一下 BPE 算法。<|im_end|>
<|im_start|>assistant
```

同样一段对话，GPT-4 和 LLaMA 的聊天模板不同，生成的 Token 序列就不同。如果你直接调用基础模型 API 但没有按对应的模板格式化输入，模型看到的结构和它训练时的期望不符，输出质量会下降，有时甚至会续写出不该出现的角色标记。

## 词表一旦确定就不能随意换

Tokenizer 和模型权重是强绑定的关系。每个 Token ID 对应 Embedding 矩阵里的一行。如果词表变了，`1024` 这个 ID 对应的语义就变了，但模型权重里 ID 1024 那行的参数还是原来的意思。换词表等于让所有权重都指向了错误的语义。

这个约束带来一个实际限制：如果你想给模型添加新的专业词汇（比如一个行业的产品名称），做法不是直接加进词表，而是通过微调让模型从训练数据里学会把这些词的子词拼合理解成一个整体概念。或者，用 RAG 在推理时把相关信息放进上下文，让模型通过上下文理解，而不是通过词表直接表示。

也有研究在做词表扩展（vocabulary extension），在预训练权重基础上为新语言或新领域添加 Token，然后做针对性训练来初始化新 Token 的 Embedding。但这比换一个 Tokenizer 要复杂得多，普通应用场景不会遇到这个问题。

## 聊天模板：特殊 Token 在实际请求里长什么样

理解聊天模板不只是知道它存在——它直接影响你的 Prompt 怎么写、模型的输出格式会不会跑偏。

不同模型有不同的消息格式约定。以 LLaMA 3 Instruct 为例，一条请求被展开成这样的 Token 序列：

```
<|begin_of_text|>
<|start_header_id|>system<|end_header_id|>

你是一个助手。<|eot_id|>
<|start_header_id|>user<|end_header_id|>

解释 BPE 算法。<|eot_id|>
<|start_header_id|>assistant<|end_header_id|>
```

模型在训练时看到的就是这种带有特殊 Token 的序列。如果你直接把"解释 BPE 算法"的裸文本发给模型，没有按这个格式组织，模型看到的输入结构和训练时的期望不匹配，可能会在回答里额外输出 `<|eot_id|>` 这类不该出现的内容，或者直接把你的问题当做需要"续写"的文本而不是需要"回答"的问题。

大多数 API 封装（OpenAI、Anthropic、Together、Groq）会替你处理这层格式化，你传的是结构化的 messages 数组，SDK 负责转换。但如果你在用 Hugging Face Transformers 直接加载模型做推理，或者在用 llama.cpp 这类本地运行时，就需要注意调用 `tokenizer.apply_chat_template()` 而不是手动拼字符串：

```python
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("meta-llama/Meta-Llama-3-8B-Instruct")

messages = [
    {"role": "system", "content": "你是一个助手。"},
    {"role": "user", "content": "解释 BPE 算法。"},
]

# 正确做法：让 tokenizer 处理模板格式化
input_text = tokenizer.apply_chat_template(
    messages, tokenize=False, add_generation_prompt=True
)
```

`add_generation_prompt=True` 的作用是在序列末尾加上 `<|start_header_id|>assistant<|end_header_id|>`，告诉模型该开始生成了。忘了这个参数，模型可能不知道该生成什么。

GPT-4 系列使用的是 ChatML 格式（`<|im_start|>` / `<|im_end|>`），和 LLaMA 的格式不同。Qwen、Mistral、Gemma 各有自己的模板。所以"换了一个模型"不只是换了推理质量，连 Token 序列的组织方式都变了。

## 两个模型的 Tokenizer 为什么不能互换

这里有一个常见的误解：既然 Tokenizer 只是分词工具，换一个更好的 Tokenizer 不应该让模型更准确吗？

不能换，原因是模型权重和 Tokenizer 是强绑定的。模型的 Embedding 矩阵里，每一行对应一个 Token ID，存储的是这个 Token 在语义空间里的"起点向量"。如果你把 Tokenizer 换成另一个——哪怕只是词表顺序不同——同一个整数 ID 就会对应完全不同的语义。模型用"237"这个 ID 学到的表示是"ing"，你换了 Tokenizer 之后"237"变成了"的"，所有已经训练好的参数全部指向了错误的词。

这个约束在实践里意味着几件事：

**不能用 A 模型的 Token 数估算 B 模型的上下文容量**。GPT-4 的 cl100k_base 词表和 LLaMA 3 的 tiktoken-128k 词表切出来的 Token 数可以差 20–40%，取决于文本内容。

**Prompt 在 A 上测试好了，切换到 B 时需要重测边界行为**。接近上下文窗口的地方，两个模型截断的位置是不同的，因为 Token 数不同。

**微调时必须用原模型配套的 Tokenizer**。有人想用 GPT-2 的 Tokenizer 来微调 LLaMA 模型，结果是每个 Token ID 对应的词都错位了，训练出来的模型输出随机噪声。这不是超参数没调好，是底层数据结构不匹配。

**模型蒸馏和模型融合也要考虑 Tokenizer 对齐**。知识蒸馏通常让学生模型学习教师模型的输出分布（logits），如果两个模型用不同的 Tokenizer，同一段文本会被切成不同的 Token 序列，教师和学生在同一位置看到的"下一个 Token"的候选集合完全不同，直接对齐 logits 就没有意义了。近几年有研究在做跨 Tokenizer 的蒸馏对齐，但这类方法比同 Tokenizer 蒸馏复杂得多，需要额外的映射或重新对齐步骤。模型融合（Model Merging，比如把两个微调模型的权重按比例平均）同样要求两者共享完全相同的 Tokenizer 和 Embedding 维度，否则权重根本没有对应关系，融合没有意义。

## 你在日常使用中能感知到的地方

几个 Tokenization 特性会在实际使用里直接影响你：

**计算 Token 数来估算成本**：OpenAI 提供的 [tokenizer playground](https://platform.openai.com/tokenizer) 可以直接粘贴文本看 Token 数。tiktoken 库可以在 Python 里调用：

```python
import tiktoken

encoding = tiktoken.encoding_for_model("gpt-4o")
text = "函数返回值 returns a value"
tokens = encoding.encode(text)

print(len(tokens))          # Token 数量
print(tokens)                # Token ID 列表
print(encoding.decode(tokens[:3]))  # 把前 3 个 Token 解回文本，直观看切分结果
```

对大批量文本（比如要给 RAG 系统估算文档的 Token 消耗），这比凭感觉用字符数除以 4 的经验公式要准确得多——中英混合内容的实际比例会偏离这个经验值。

**逐字符任务会失败**：数字母数量、字符级反转、统计某个字符出现多少次——这类任务在大多数 LLM 上都不稳定，原因是模型不以字符而以 Token 为单位推理。如果你真的需要精确的字符级操作，用代码做，不要指望模型推理。

**Prompt 长度的真实上限是 Token 数，不是字符数**：一个 128K Token 的上下文窗口，能放多少中文和多少英文代码是不同的。中文信息密度更高，英文代码可能反过来更贵。

**不同模型的 Tokenizer 不兼容**：在 GPT-4 上调好的 Prompt，切换到 LLaMA 3 时 Token 数和切分方式都可能不同，边界行为（接近上下文窗口时）会有差异，需要重新测试。

## 参考资料

- [Sennrich et al., 2016: Neural Machine Translation of Rare Words with Subword Units（BPE 论文）](https://arxiv.org/abs/1508.07909)
- [Kudo & Richardson, 2018: SentencePiece](https://arxiv.org/abs/1808.06226)
- [tiktoken（OpenAI BPE 实现）](https://github.com/openai/tiktoken)
- [OpenAI Tokenizer Playground](https://platform.openai.com/tokenizer)
