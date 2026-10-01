---
title: SDD：把模糊需求编译成 Coding Agent 能执行的开发流程
description: Spec-Driven Development 用 Spec、Plan、Tasks 和 Converge 管理 AI 编程中的意图、技术方案与验收证据。本文通过一个博客搜索功能，完整演示从需求澄清到实现收敛的流程。
category: Agent
subcategory: AI Coding
articleClass: flagship
featured: false
publishedAt: 2026-10-01
updatedAt: 2026-10-01
tags: [SDD, Spec-Driven Development, AI Coding, Spec Kit, Codex, 开发流程]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

我以前使用 Coding Agent 时，经常直接给一句需求：给博客加搜索、把登录改成 JWT、给接口补缓存。模型很快开始读代码，也很快给出修改。麻烦通常出现在后半段。它做到一半才发现搜索范围没有定义，缓存一致性没有约定，或者登录方案与现有权限模型冲突。

人类开发者面对模糊需求也会犯错，Coding Agent 只是把这个过程加速了。它擅长生成代码，却无法替我们决定产品边界。信息缺失时，模型会根据训练数据和当前仓库补全空白。每个补全都可能合理，组合起来未必是我们要的系统。

Spec-Driven Development，简称 SDD，试图在 Agent 动手前把这些空白显式化。需求先写成可验证的规格，再转成技术方案和任务列表。实现过程中产生的新发现会回写到相应文档，最后用代码、测试和运行结果检查规格是否兑现。

[GitHub Spec Kit](https://github.com/github/spec-kit)把核心过程组织为 `Specify → Plan → Tasks → Implement → Converge`。这套命令很有代表性，文章会借它解释流程，但重点不在某个工具。只要团队保存了同等含义的工件，用 Markdown、Issue 或自己的 Skill 都能运行 SDD。

![SDD 从开发意图到实现收敛的完整循环](/images/posts/sdd-development-loop.svg)

## 一、SDD 管理的是开发意图

一次代码修改至少包含四种信息：

```text
需求：用户最终能够做什么
约束：哪些边界不能突破
方案：准备怎样修改系统
证据：怎样证明实现已经完成
```

聊天记录也能保存这些信息，只是它不够稳定。对话越长，早期决定越容易被压缩；中途切换会话，新 Agent 需要重新理解；多人协作时，每个人看到的上下文可能不同。

SDD 把意图保存在版本库里。典型目录类似：

```text
specs/
└── 001-blog-search/
    ├── spec.md
    ├── plan.md
    ├── tasks.md
    ├── contracts/
    └── checklists/

.specify/
└── memory/
    └── constitution.md
```

这些文件承担不同职责。`spec.md` 说明要交付的行为，`plan.md` 记录技术路径，`tasks.md` 保存执行顺序，测试和检查记录提供证据。它们共同构成 Agent 的开发上下文。

开发过程中最常见的失败不是模型不会写某段代码，而是它在错误目标上写出了正确代码。SDD 优先控制这个风险。

## 二、Constitution：项目长期遵守的原则

Feature Spec 只约束一个功能，项目还需要一组长期规则。Spec Kit 将这类规则保存在 Constitution 中，可以理解成项目宪章。

我们的 Astro 博客可以有下面这些原则：

```markdown
# 项目原则

1. 所有页面必须支持桌面端和移动端。
2. 内容分类统一来自 src/config/sections.ts。
3. 不在客户端代码中保存密钥和敏感配置。
4. 新页面保持现有排版与颜色体系。
5. 提交前必须运行 npm run build。
6. 用户可见交互必须支持键盘操作。
```

Constitution 适合保存跨任务不变的决定：技术栈、目录边界、安全要求、测试底线、兼容范围和提交规范。它不应该包含“本次搜索支持标题和标签”这样的功能细节。

项目原则越多不一定越好。过期规则会让 Agent 在错误约束下工作，相互冲突的规则则会把决定重新推给模型。每条原则最好附带原因或验证方式，并且有人负责维护。

## 三、Specify：先定义用户能够观察到的结果

现在给博客增加搜索功能。原始需求只有一句：

> 给博客增加搜索。

Agent 无法从中确定搜索范围、交互方式和完成条件。Specify 阶段把这句话展开成 `spec.md`：

```markdown
# 博客文章搜索

## 目标

读者可以在博客中搜索已经发布的文章，
并从结果直接进入文章页面。

## 用户故事

作为博客读者，
我希望用标题、摘要或标签查找文章，
以便快速找到某个技术主题。

## 功能要求

1. 顶部导航提供搜索入口。
2. 搜索范围包含标题、摘要和标签。
3. 结果展示标题、摘要与所属专栏。
4. 搜索支持中文和英文关键词。
5. 没有匹配内容时显示空状态。
6. 草稿文章不能进入搜索结果。

## 范围之外

- 暂不搜索文章正文；
- 不保存用户搜索历史；
- 不接入外部搜索服务；
- 不提供拼写纠正和搜索推荐。

## 验收场景

- 搜索“RAG”可以找到 RAG 相关文章；
- 搜索不存在的词时显示空状态；
- 键盘可以打开、选择和关闭搜索框；
- 手机端可以完成输入与跳转。
```

Spec 关注外部行为，尽量避免提前规定技术实现。这里没有要求使用 Fuse.js，也没有决定索引生成文件放在哪里。技术选择将在 Plan 阶段完成。

一份可用的 Spec 通常包含：

- 目标和使用者；
- 用户故事或使用场景；
- 功能要求；
- 非功能约束；
- 明确排除的范围；
- 可验证的验收条件。

“搜索体验良好”“页面性能足够快”不能直接验收。需要进一步写成可观察的行为或量化条件。暂时无法决定的内容也要标出来，避免模型悄悄选择一个答案。

## 四、Clarify：把隐藏问题提到编码之前

完成初稿后，Agent 应当检查模糊项，而不是马上设计方案。

搜索功能还有一批未决问题：

```text
结果按照相关度还是发布日期排序？
英文搜索是否区分大小写？
多个关键词使用 AND 还是 OR？
搜索状态是否写入 URL？
弹窗是否允许点击遮罩关闭？
文章数增加后是否需要分页？
```

这些问题并非全部需要用户逐项决定。Agent 可以读取现有产品和代码，给出带依据的默认建议。会改变用户体验、数据模型、兼容性或者工作量的问题，应该在进入 Plan 前确认。

Clarify 的输出应当回到 Spec，而不是单独留在聊天记录中。例如确认“结果优先按匹配分排序，同分时按发布日期倒序”，就把这条规则写入功能要求或验收场景。

[Spec Kit 的 Agentic SDD 流程](https://github.github.com/spec-kit/reference/agentic-sdd.html)把 Clarify 作为推荐的可选步骤，位置在 Specify 和 Plan 之间。是否单独执行命令并不重要，重要的是方案设计前处理那些会引发多种实现的空白。

## 五、Plan：把规格映射到现有系统

Plan 回答技术问题。Agent 要先检查仓库结构、现有约定、依赖和测试方式，再决定怎样实现 Spec。

博客搜索的 `plan.md` 可以写成：

```markdown
# 技术方案

## 当前系统

- Astro 静态站点；
- 文章来自 content collection；
- 没有运行时后端和数据库；
- 顶部导航由 BaseLayout 渲染。

## 方案

构建时读取已发布文章，生成静态 JSON 索引。
浏览器按需加载索引并在本地完成匹配。

## 数据结构

SearchDocument {
  title: string
  description: string
  tags: string[]
  category: string
  subcategory?: string
  publishedAt: string
  url: string
}

## 修改范围

- 新增搜索索引端点；
- 新增搜索匹配函数；
- 新增搜索弹窗组件；
- 修改顶部导航；
- 增加移动端和键盘交互样式；
- 增加搜索逻辑测试。

## 约束

- 索引排除 draft；
- 不增加服务端运行时；
- 搜索组件初始不下载索引；
- 复用现有颜色和排版变量。

## 验证

- 单元测试覆盖匹配、排序和草稿过滤；
- npm run build；
- 桌面端与移动端手动检查；
- 键盘操作检查。
```

Plan 应该显示它如何利用现有系统。脱离仓库生成的通用方案没有多少价值。一个已有项目还需要记录复用点、受影响模块、迁移方式和回滚策略。

接口、事件和数据结构可以作为 `contracts/` 下的独立工件。多服务协作时，先确定提供方和消费方共同遵守的契约，再分别实现。Spec Kit 的[契约驱动开发指南](https://github.com/github/spec-kit/blob/main/docs/guides/contract-driven-development.md)也强调，提供方与消费方应引用同一份权威契约，并为双方安排验证。

## 六、Tasks：把方案切成可交付的增量

一份写得很详细的 Plan 仍然可能让 Agent 一口气修改十几个文件。Tasks 将方案拆成可执行单元，并明确依赖关系与验收方法。

```markdown
# 任务列表

- [ ] T01 定义 SearchDocument 类型
  - 文件：src/lib/search.ts
  - 验证：类型检查通过

- [ ] T02 生成已发布文章索引
  - 依赖：T01
  - 文件：src/pages/search-index.json.ts
  - 验证：索引不包含 draft

- [ ] T03 实现关键词匹配与排序
  - 依赖：T01
  - 文件：src/lib/search.ts
  - 验证：运行搜索单元测试

- [ ] T04 实现搜索弹窗
  - 依赖：T02、T03
  - 验证：鼠标和键盘均可操作

- [ ] T05 接入顶部导航并适配移动端
  - 依赖：T04
  - 验证：检查两种断点

- [ ] T06 执行全量验证
  - 依赖：T01-T05
  - 验证：测试、构建、页面检查
```

好的任务有清楚的完成边界。它可以独立执行，完成后能验证，并且不会让 Agent 在实现过程中重新设计整个功能。

任务也不必机械地按文件拆分。一个垂直切片可以同时修改数据、逻辑和界面，只要它能形成可验证的增量。按照技术层批量完成“所有后端任务”再做“所有前端任务”，很容易把集成问题拖到最后。

## 七、Checklist 与 Analyze：实现前再做一次静态检查

进入代码阶段前，可以对文档本身做检查。

Checklist 检查规格质量：

```text
每条需求是否可以验证？
空状态和失败状态是否定义？
权限、兼容性和性能边界是否覆盖？
范围外内容是否明确？
```

Analyze 检查工件之间的一致性：

```text
每条 Spec 是否有 Plan 对应？
每项 Plan 是否被 Tasks 覆盖？
Tasks 是否包含验证工作？
Constitution 与 Plan 是否冲突？
接口契约是否被提供方和消费方共同引用？
```

这一步很像对自然语言做静态分析。它无法证明方案正确，却能提前发现遗漏、重复和矛盾。Spec Kit 将 Checklist 和 Analyze 都设计为可选步骤，大功能和跨团队变更更值得使用。

## 八、Implement：按任务推进，也允许证据改变计划

Implement 阶段才开始修改代码。Agent 每次领取一个或一组相邻任务，读取相关 Spec 与 Plan，检查真实代码后完成实现和验证。

一个稳妥的执行循环是：

```text
选择未完成任务
  ↓
读取需求、方案和相关代码
  ↓
实现最小改动
  ↓
运行该任务的局部验证
  ↓
记录结果并更新任务状态
  ↓
进入下一任务
```

实现会暴露计划阶段无法知道的信息。比如浏览器端加载搜索索引后体积过大，或者 Astro 的路由行为与方案假设不同。此时应先判断这是实现细节还是方案变化。

实现细节可以直接记录在任务中。影响数据结构、用户行为或验收标准的发现，需要更新 Plan 或 Spec，再继续编码。否则仓库会出现两套事实：文档描述一种系统，代码运行另一种系统。

SDD 给 Agent 提供了稳定计划，也必须允许工程证据修正计划。把初稿视为不可修改的合同，只会让错误更有秩序地执行下去。

## 九、Converge：代码完成后检查意图是否兑现

所有任务打勾，只能说明任务列表执行完了。Converge 会回到最初意图，对比五类材料：

```text
Spec       承诺了什么行为
Plan       选择了什么方案
Tasks      安排了哪些工作
Code       实际实现了什么
Evidence   测试和运行结果证明了什么
```

搜索功能完成后，可以逐项检查：

- Spec 要求搜索标题、摘要和标签，匹配逻辑是否全部覆盖；
- Spec 排除了草稿，索引生成和测试是否共同保证；
- Plan 要求按需加载，页面首次加载是否真的没有下载索引；
- Constitution 要求键盘可用，焦点移动和 Escape 关闭是否验证；
- Tasks 要求移动端检查，是否留下了检查结果。

发现缺口后不要只写一段总结。把剩余工作追加回 Tasks，继续实现并验证，直到没有影响验收的差异。Spec Kit 当前将 `converge` 放在核心流程末端，用它评估代码库与 Spec、Plan、Tasks 的差异并补充任务。

这一步为 SDD 闭环。没有 Converge，流程容易退化成“开发前多写几份文档”。

![SDD 各类工件分别约束什么](/images/posts/sdd-artifact-stack.svg)

## 十、规格应该保留多久

功能上线后，团队还要决定这些文件的生命周期。[Spec Kit 的 Spec Persistence 文档](https://github.com/github/spec-kit/blob/main/docs/concepts/spec-persistence.md)列出了几种常见选择。

### Spec-first

Spec 用于本次开发，完成后可以归档。它适合一次性功能或低维护成本项目。优点是负担小，缺点是下一次修改可能重新从代码推断意图。

### Spec-anchored

Spec 在实现后继续保留，后续修改需要参考它。旧 Spec 记录功能为何这样设计，新需求可以创建新的变更规格。这种方式适合希望保留决策历史的团队。

### Spec-as-source

Spec 成为长期权威来源，Plan、Tasks 甚至部分实现都由它派生。需求变化先修改 Spec，再同步下游工件。它提供更强一致性，也要求团队投入持续维护。

还有一个实际问题：实现发现是否反向更新已有工件。小团队常采用 Flow-back，允许 Spec、Plan、Tasks 和代码互相修正，最后人工对齐。重视审计的团队可能采用 Flow-forward，保留已经完成的工件，通过新目录记录下一次变更。

没有一种模式适合所有项目。重要的是明确哪份材料在冲突时拥有更高权威，以及谁负责消除漂移。

## 十一、大功能需要拆成多个 Spec

如果一个 Spec 需要 Agent 连续执行几十个任务，模型仍然会在中途失去重点。大功能可以先建立 Roadmap，再把每个切片运行一遍完整 SDD 流程。

```text
R1 生成搜索索引
R2 完成搜索交互
R3 增加正文搜索
R4 增加搜索分析
```

每个切片拥有独立的 `spec.md`、`plan.md` 和 `tasks.md`，Roadmap 只保存边界、依赖和进度。GitHub 将这种方法称为 [Spec of Specs](https://github.com/github/spec-kit/blob/main/docs/concepts/spec-of-specs.md)。它适合单个 Feature 已经超过上下文和审查能力的情况。

切分时要保证每一部分能够独立验收。只把一个大任务按代码层拆成数据库、后端、前端三个 Spec，会让每个 Spec 都缺少可见结果。按照用户能力或完整业务路径切分通常更容易收敛。

## 十二、SDD 与 TDD、BDD、Skills 的关系

它们处理不同层次的问题，可以组合使用。

| 方法 | 主要管理什么 | 常见产物 |
| --- | --- | --- |
| SDD | 需求、边界、技术方案和任务一致性 | Spec、Plan、Tasks、验证记录 |
| BDD | 用户可观察的业务行为 | Given / When / Then 场景 |
| TDD | 小步实现和代码设计反馈 | 先失败再通过的自动化测试 |
| Skills | Agent 完成某类任务时遵守的操作方法 | 触发条件、步骤、工具和验收规则 |

一个项目可以用 SDD 确定“博客搜索应该提供哪些行为”，用 BDD 写出搜索与空状态场景，用 TDD 实现匹配和排序，再用 Skill 要求 Agent 每次修改搜索功能都运行指定测试与页面检查。

Skills 还可以把 SDD 流程本身封装起来。例如一个 `feature-development` Skill 规定：先检查 Constitution，再生成 Spec，列出未决问题，得到确认后生成 Plan 与 Tasks，完成实现后运行 Converge。这样流程从团队约定变成 Agent 可以重复执行的操作。

## 十三、SDD 与知识库的关系

知识库告诉 Agent 项目里有什么，SDD 告诉它这次准备改变什么。

开发一个已有系统时，Plan 阶段需要查询代码知识库：现有入口在哪、哪些接口可以复用、调用链经过哪些模块。Repo Map 和 FastCode 帮助定位代码，LLM Wiki 提供架构与业务说明，RAG 找到历史决策和故障记录。

检索到的知识进入 Plan 后，会变成本次开发的明确约束。例如知识库找到“优惠券返还必须幂等”，Plan 就应该写出幂等方案，Tasks 则需要安排重复消息测试。

两套系统可以这样配合：

```text
知识库提供项目事实
        ↓
SDD 把事实与新需求整理成开发计划
        ↓
Coding Agent 按计划修改并验证
        ↓
实现结果和新决策回到知识库
```

这也是我们从“RAG 与知识库”转向“AI Coding”后很自然的一步。前者管理模型能够获得的知识，后者管理人怎样利用这些知识驱动 Agent 开发。

## 十四、哪些任务值得使用完整 SDD

完整流程适合：

- 跨越多个文件和模块的功能；
- 会改变 API、数据结构或用户行为的修改；
- 有多种技术方案，需要先做取舍；
- 需要多人或多个 Agent 交接；
- 实现周期超过一次对话；
- 上线前需要明确审计和验收证据。

改错别字、调整一个确定的 CSS 值、修复原因明确且影响局部的 Bug，没有必要生成完整工件。可以使用缩短版：

```text
目标与边界
  → 修改计划
  → 实现
  → 验证
```

流程长度应当与不确定性匹配。任务越小、相关代码越明确，前置工件越轻；需求越模糊、影响面越大，越需要先固定意图。

## 十五、几个常见失败方式

### 1. 把 Spec 写成愿望清单

“体验流畅”“架构合理”“保证高性能”很难验证。每条要求都应该能够被测试、观察或评审。

### 2. 在 Spec 中提前写死实现

Spec 规定用户行为，Plan 选择实现方式。过早指定框架、类名和目录，会让后续调研失去意义，也会把技术细节误当成产品要求。

### 3. 一次生成全部文档，不做人工确认

Agent 可以连续生成 Spec、Plan 和 Tasks，也能把同一个错误复制三遍。关键边界和技术取舍需要在阶段之间确认。

### 4. Tasks 只有动作，没有验证

“实现搜索组件”没有明确终点。任务需要写清对应需求、修改范围和完成证据。

### 5. 实现变化没有回写

代码因为工程现实改变，Plan 仍保留旧方案。后续 Agent 会把旧文档当成事实。Converge 必须处理这类漂移。

### 6. 把流程当成固定仪式

所有任务都走同样长度的流程，会产生大量无人维护的 Markdown。SDD 的价值来自减少不确定性，不来自文件数量。

## 十六、一套适合个人项目的最小流程

个人项目不需要一开始就安装完整工具。可以在仓库里创建：

```text
docs/features/<feature-name>/
├── spec.md
├── plan.md
└── tasks.md
```

然后给 Coding Agent 一份稳定指令：

```markdown
处理新功能时：

1. 阅读项目规则和相关代码。
2. 先生成 spec.md，只写行为、边界和验收条件。
3. 列出需要用户确认的问题。
4. 确认后生成 plan.md，说明影响范围、方案和验证方法。
5. 将计划拆成带依赖和验证步骤的 tasks.md。
6. 每次只执行少量任务，并更新状态。
7. 完成后对照 Spec、Plan、Tasks 和测试结果检查差异。
8. 有缺口就追加任务，全部验收后再提交。
```

这套最小流程已经具备 SDD 的主要价值。等项目和协作规模扩大，再引入 Spec Kit 的 Constitution、Checklist、Analyze、Converge、扩展和预设机制。

## 十七、我对 SDD 的理解

SDD 可以看成开发意图的编译过程。

自然语言需求含有大量省略。Specify 把它整理成外部行为，Plan 将行为映射到当前系统，Tasks 把方案切成可执行增量，Implement 产生代码与测试，Converge 再用证据检查实现是否兑现意图。

模型生成代码的速度越快，这层约束越重要。以前需求模糊可能让开发者浪费几天，现在 Agent 可以在半小时内生成一套方向错误却结构完整的实现。SDD 没有让模型变得确定，它只是把关键决定从模型的临时推断中拿出来，放进可以检查、修改和追踪的工件里。

对于个人开发者，我认为它最实用的价值是跨会话连续性。一次会话把需求澄清并完成 Plan，下一次会话读取 Tasks 继续实现，几天后仍能知道某个决定从哪里来。聊天不再承担项目记忆，代码也不再是唯一能够解释系统的材料。

## 参考资料

- GitHub，[Spec Kit](https://github.com/github/spec-kit)
- GitHub Spec Kit，[Agentic SDD](https://github.github.com/spec-kit/reference/agentic-sdd.html)
- GitHub Blog，[Spec-driven development with AI](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)
- GitHub Spec Kit，[Spec Persistence Models](https://github.com/github/spec-kit/blob/main/docs/concepts/spec-persistence.md)
- GitHub Spec Kit，[Contract-Driven Development](https://github.com/github/spec-kit/blob/main/docs/guides/contract-driven-development.md)
- GitHub Spec Kit，[Spec of Specs](https://github.com/github/spec-kit/blob/main/docs/concepts/spec-of-specs.md)
