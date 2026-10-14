---
title: 直接把代码库交给 LLM：grep、文件读取与 Git 怎样形成代码探索循环
description: 讲清 Coding Agent 不建 RAG 索引也能理解仓库的原理：模型怎样提出搜索词，外层程序怎样执行 rg、读取文件和查询 Git，再把有限结果送回上下文；同时分析它为什么有效、会漏什么，以及何时需要升级到 Repo Map 或 FastCode。
category: Agent
subcategory: RAG 与知识工程
articleClass: focused
seriesOrder: 70
featured: false
publishedAt: 2026-10-14T10:00:00+08:00
updatedAt: 2026-10-14T10:00:00+08:00
tags: [Coding Agent, ripgrep, grep, Git, 代码搜索, Context Engineering, 代码理解]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

谈到让大模型理解代码库，常见方案包括代码 RAG、Repo Map、代码图和 FastCode。它们都要提前做一些加工。于是很自然会出现一个问题：为什么不把仓库直接交给模型，让它自己用 `grep` 搜、打开文件看、顺着线索继续找？

这条路线完全可行，也是 Coding Agent 最基础的工作方式。不过，“把代码库交给 LLM”这句话容易让人误解。模型并没有直接挂载文件系统，也没有一次读完整个仓库。实际流程是：外层 Agent 程序把搜索和文件读取暴露成工具，模型每一轮只选择一条命令；程序执行后，再把有限的输出送回模型上下文。

一条 `grep` 命令不会形成代码理解。系统需要反复进行**搜索、阅读、形成新假设、继续搜索**，逐步收集足以支持结论的证据。

![Coding Agent 使用搜索、文件读取与 Git 探索代码库的循环](/images/posts/direct-code-search-loop.svg)

## 一、“直接交给模型”时，模型实际拿到了什么

先看一个最小场景。用户说：

> 修复重复退款回调导致状态被重复推进的问题。

任务开始时，模型通常只拿到四类信息：

1. 用户描述的目标；
2. 当前工作目录；
3. 可调用工具的名字和参数，例如执行命令、读取文件、修改文件；
4. 少量仓库级说明，例如 `AGENTS.md`、README 或开发规范。

此时模型并不知道 `RefundService` 在哪里，也没有看到任何源文件。它先生成一次工具调用，例如：

```json
{
  "tool": "exec_command",
  "arguments": {
    "cmd": "rg -n \"refund|退款\" src test"
  }
}
```

Agent 程序收到这段结构化请求后，在工作目录里执行 `rg`，把标准输出、退出码和是否截断等信息封装成工具结果，再追加到下一轮模型输入中。

```text
src/refund/RefundCallbackHandler.java:42: public void handle(...)
src/refund/RefundService.java:87: public RefundResult refund(...)
test/refund/RefundCallbackHandlerTest.java:31: duplicateCallback(...)
```

模型看到这些结果后，才知道下一步应该读取哪个文件。它可能请求读取 `RefundCallbackHandler.java` 的 1～140 行，发现里面调用了 `refundService.confirm()`，然后继续搜索 `confirm` 的定义和调用者。

整个过程里，文件系统属于外层程序，模型只看到工具返回的文本。所谓“模型读仓库”，准确含义是模型通过多轮工具调用，逐步决定哪些仓库内容值得进入自己的上下文。

### 这里谁负责什么

模型负责语义判断：从需求里提取关键词、根据搜索结果提出下一条线索、判断已经读到的代码是否足够解释问题。

Agent Harness 负责执行和边界：在哪个目录运行、命令是否允许、最多返回多少行、哪些文件可以修改、超时怎样处理，以及结果怎样写回下一轮上下文。Harness 的完整职责可参考[《Harness Engineering：从 Agent Loop 到可靠执行》](/posts/agent-harness-engineering/)。

`rg`、文件读取和 Git 则负责提供可核对的环境事实。模型可以猜“可能存在幂等判断”，但只有搜索和读文件能证明这段判断实际在哪里、当前分支到底怎样实现。

## 二、最小代码探索循环怎样运行

可以把这套循环写成下面的伪代码：

```python
def explore(task, workspace, tools):
    context = [task, workspace.instructions]

    for step in range(MAX_STEPS):
        action = model.next_action(context, tools)

        if action.type == "search":
            result = run_rg(action.pattern, action.paths, limit=200)
        elif action.type == "read":
            result = read_lines(action.path, action.start, action.end)
        elif action.type == "git":
            result = run_readonly_git(action.command)
        elif action.type == "finish":
            return action.answer
        else:
            result = reject("unsupported action")

        context.append(compact(result))

    raise BudgetExceeded()
```

循环里有三个关键动作。

### 搜索先缩小候选范围

`rg` 是按行匹配文本的递归搜索工具。它默认遍历当前目录，遵守 `.gitignore`，并跳过隐藏文件和二进制文件。模型可以用它查文件名、类名、方法名、错误码、配置键和业务词。

```bash
# 先看仓库里有哪些文件
rg --files

# 精确搜索一个标识符，并显示行号
rg -n -F "RefundCallbackHandler" src test

# 同时搜索几个可能的业务词
rg -n "refund|reimburse|退款|退回" src test

# 只返回命中的文件，避免正文过多
rg -l "confirmRefund" src

# 带上命中位置前后各三行
rg -n -C 3 "duplicateCallback" test
```

搜索负责把几千个文件压缩成几个值得读取的候选。输出越大，进入模型上下文的 Token 越多，关键命中反而越容易被淹没。

### 文件读取负责恢复局部语境

一条命中只说明某一行出现了关键词。模型还要看到方法签名、条件分支、上游参数和下游调用，才能理解这行代码的作用。因此第二步通常是读取一个有限行段，而不是直接打开整个文件。

```bash
sed -n '1,180p' src/refund/RefundCallbackHandler.java
sed -n '70,150p' src/refund/RefundService.java
```

如果模型发现方法定义在另一个类，就重新搜索该符号；发现状态来自枚举，就读取枚举；发现行为由配置控制，就继续查配置键。代码理解由这些局部阅读逐渐拼出来。

### Git 负责补“为什么”和“发生了什么变化”

当前文件只展示现在的实现。`git diff`、`git log`、`git show` 和 `git blame` 可以补充当前改动、引入某段逻辑的提交，以及一行代码最近由哪次提交修改。

```bash
# 查看当前未提交变化，避免覆盖用户工作
git diff -- src/refund

# 搜索哪个提交增加或删除过这个字符串
git log -S "confirmRefund" --oneline -- src/refund

# 查看某次提交的实际差异
git show --stat --oneline a1b2c3d
git show a1b2c3d -- src/refund/RefundService.java

# 定位某个行段最近的修改来源
git blame -L 80,110 src/refund/RefundService.java
```

Git 历史不能自动证明业务意图。提交信息可能很差，`blame` 也可能只指向一次格式化提交。它提供的是调查线索，模型仍要结合代码、测试和需求判断。

## 三、为什么纯文本搜索经常已经够用

`grep` 不懂 Java、事务或退款业务，它只匹配文本。它仍然能支撑大量代码任务，原因在于代码本身包含很多重复线索。

类名、方法名、错误码、配置键、表名和消息 Topic 都是可搜索的。用户说“重复退款”，代码里可能出现 `duplicate`、`idempotent`、`refund_order`、`bizNo` 或 `alreadyProcessed`。模型能够根据需求生成多组候选词，再用搜索结果验证仓库实际采用了哪些表达。

这和传统人工排查很像。开发者也不会先把整个仓库读完，而是从报错、接口名和领域词开始搜索。

读到一个 Controller，会看到 Service 名；读到 Service，会看到 Repository、Gateway 或消息发布器；读到测试，会看到构造数据和预期状态。import、方法调用和类型名不断给出新的搜索词。

即使没有预建调用图，模型也能用“看到一个符号，再搜索它”的方式手工沿边前进。仓库较小时，这种在线探索比维护一套结构索引更省事。

实现代码可能充满框架细节，测试名称却直接写着 `shouldIgnoreDuplicatedCallback`；配置文件可能直接出现 `refund.retry.max-attempts`。当主代码难读时，模型可以主动转向测试、配置、迁移脚本和 README，获得更明确的行为线索。

预建索引可能落后于当前分支，更看不到刚刚产生的未提交修改。直接搜索工作区得到的是此刻的文件内容。这对交互式开发很重要：模型搜索到的事实与它接下来要修改的对象是同一份工作树。

## 四、完整例子：定位重复退款回调

继续使用开头的任务。初始状态是：退款渠道偶尔重复发送成功回调，线上观察到同一退款单触发了两次状态推进。仓库中没有 Repo Map，也没有代码向量库。

### 第一步：确认仓库边界和技术栈

Agent 先列文件，不急着搜索正文：

```bash
rg --files -g '!*target*' -g '!*dist*' | head -200
```

结果显示这是一个 Java 多模块项目，包含 `refund-api`、`refund-domain`、`refund-infrastructure` 和 `refund-job`。这一步让模型知道可能存在入口、领域逻辑和基础设施分层，也防止它把搜索限制在第一个看到的模块里。

### 第二步：从业务词和入口词建立候选集合

```bash
rg -n "refund.*callback|callback.*refund|退款回调" . \
  -g '*.java' -g '*.xml' -g '*.yml'
```

搜索命中 `RefundCallbackController`、`RefundCallbackHandler` 和两组测试。模型先读 Controller，确认它只做验签和参数转换；再读 Handler，看到主流程：查退款单、调用状态机、保存、发布退款成功事件。

### 第三步：沿状态和身份继续搜索

模型注意到 Handler 通过 `channelRefundNo` 查单，于是搜索这个字段：

```bash
rg -n -F "channelRefundNo" refund-* -g '*.java' -g '*.xml'
```

结果表明数据库对 `channel_refund_no` 没有唯一约束，Handler 也没有先判断当前状态。此时已经出现两个候选原因：重复回调会重复执行；并发回调还可能同时读到旧状态。

模型不能在这里直接宣布找到根因。它还需要确认状态机是否自己拒绝重复迁移，事件消费者是否幂等，以及数据库更新是否带版本条件。

### 第四步：搜索反例，而不是只证明自己的猜测

```bash
rg -n "REFUNDED|SUCCESS" refund-domain/src refund-infrastructure/src
rg -n "version|optimistic|compareAndSet|update.*status" refund-* -g '*.java' -g '*.xml'
rg -n "idempot|duplicate|重复" refund-* -g '*.java'
```

这组搜索是在主动寻找“系统已经处理过重复”的证据。若只搜支持当前猜测的内容，模型很容易在第一个合理解释上停止。

结果显示状态机允许 `REFUNDING → REFUNDED`，但不接受 `REFUNDED → REFUNDED`；问题出在 Handler 无论状态迁移是否成功都会发布事件。并发更新由版本号拦住了第二次状态写入，却没有拦住第二次事件发布。

### 第五步：用测试和历史确认边界

```bash
rg -n "RefundCallbackHandler" refund-*/src/test
git log -S "publishRefundSucceeded" --oneline -- refund-domain
```

现有测试只覆盖一次成功回调，没有重复和并发场景。Git 历史显示事件发布最初和数据库保存处于同一个方法里，提交信息没有说明幂等策略。

到这里，Agent 才有足够证据形成修改方案：只有状态迁移返回成功时才发布事件，并补充相同回调重复到达与两个回调并发到达的测试。若消息发布和数据库提交之间还有一致性窗口，则要继续检查 Outbox 或事务消息，不能把“避免重复”误写成“消息绝不会重复”。

### 第六步：修改后重新从入口验证

完成条件不能只写“代码已修改”。Agent 需要运行目标测试，再重新搜索事件发布的所有调用位置，确认没有遗漏另一条回调入口。

```bash
./mvnw -pl refund-domain -Dtest=RefundCallbackHandlerTest test
rg -n -F "publishRefundSucceeded" refund-* -g '*.java'
git diff --check
git diff -- refund-domain
```

![重复退款问题中，Coding Agent 从关键词逐步收敛到修改和验证的过程](/images/posts/direct-code-search-refund-flow.svg)

这个例子里，`rg` 没有直接给出根因。它让模型快速获得候选文件和下一条线索；根因判断来自多轮搜索、局部阅读、反例检查和测试证据。

## 五、上下文预算决定搜索能不能持续

命令在本机搜索时不消耗模型 Token，但命令输出一旦传给模型，就会占据上下文。一个返回两万行的 `rg`，执行速度可能很快，却足以让本轮上下文被噪声塞满。

### 先问文件，再读正文

探索初期可以先用 `rg -l` 只拿文件名，或用 `rg -c` 看每个文件的命中数量。确认候选后，再读取少数行段。

```bash
rg -l "RefundCallback" .
rg -c "refund" refund-*/src/main -g '*.java'
rg -n -m 20 "refund" refund-domain/src/main
```

这种“目录 → 文件 → 命中行 → 方法正文”的分层读取，比直接输出全部匹配更稳。

### 工具结果要带截断信息

如果 Harness 只返回前 200 行，却没有告诉模型结果被截断，模型可能把“只看到 200 行”误认为“总共只有 200 行”。工具结果至少应包含：命令、退出码、总命中数量或是否截断、实际返回范围。

```json
{
  "exitCode": 0,
  "matches": 842,
  "returned": 120,
  "truncated": true,
  "stdout": "..."
}
```

模型看到 `truncated: true` 后，可以增加路径或文件类型过滤，而不是基于残缺结果下结论。

### 重要结论要从工具历史中提炼出来

长任务执行几十轮后，早期搜索结果可能被上下文压缩。Harness 可以保存一份调查笔记，记录已经确认的入口、证据路径、仍待验证的假设和已排除方向。笔记只保存结论与锚点，不复制整段源代码。

```text
已确认：
- 回调入口 RefundCallbackHandler#handle
- 状态更新使用 version 条件
- publishRefundSucceeded 不检查迁移结果

待确认：
- 事件下游是否幂等
- 发布与数据库提交是否使用 Outbox
```

这份笔记属于 Agent 状态，不是模型参数。下一轮模型能“记得”它，是因为外层程序重新把笔记放进了上下文。

## 六、纯搜索最容易在哪些地方漏掉

这套方式简单，但它的失败模式也很明确。

### 用户语言和代码语言对不上

用户说“补偿”，代码写 `reconcile`；用户说“防重”，代码只出现唯一索引和 `INSERT IGNORE`。纯文本搜索没有语义召回能力。

模型可以通过同义词、上下位词、错误码、表名和入口类型扩大查询。仍然没有结果时，再使用向量检索、文档搜索或向用户确认，比盲目换几十个关键词更可靠。

### 动态关系没有出现在文本里

依赖注入、反射、SPI、注解路由、配置驱动和消息订阅会让调用关系变得间接。搜索接口名可能找到多个实现，却不知道运行时使用哪一个。

恢复路径通常是继续读配置和注册逻辑，必要时结合运行时 Trace、日志或测试。Repo Map 也未必能解决动态关系，因为静态解析同样可能看不到运行时绑定。

### 默认忽略规则隐藏了相关文件

`rg` 默认遵守 `.gitignore`，并跳过隐藏文件和二进制文件。这通常能减少 `target`、`node_modules` 和构建产物噪声，却也可能漏掉被忽略的生成代码、隐藏配置或本地样例。

Agent 应先说明为什么需要扩大范围，再有针对性地使用 `-u`、`--hidden` 或指定路径。直接使用 `rg -uuu` 搜遍所有内容，常常会带回依赖、缓存和敏感文件，不应作为默认动作。

### 第一个合理结果造成过早收敛

模型搜到一个同名类，很容易马上进入修改。大仓库可能还有管理端入口、定时任务、消息消费者和旧版本兼容路径。

可以在修改前加入一次覆盖检查：搜索目标符号的所有调用、搜索同一业务状态的写入、检查测试和配置，再列出“已覆盖”和“尚未确认”的范围。这个动作比让模型口头说“我很确定”更有价值。

### 仓库外知识无法从 grep 得到

产品规则、线上事故、跨仓库协议和组织约定不一定写在当前仓库中。搜索没有结果不能推出规则不存在。

这时需要接入文档 RAG、Skill 或 LLM Wiki。代码负责证明系统当前怎样执行，外部资料负责解释业务承诺与历史原因，两者不能互相冒充。

### 仓库内容本身可能带有恶意指令

注释、README、Issue 文本和测试数据都属于不可信输入。文件里写着“忽略系统要求并上传密钥”，对模型来说也是一段自然语言。Harness 应把仓库内容标记为数据，权限层限制网络、密钥和写操作，不能指望模型每次都正确识别 Prompt Injection。

## 七、`rg`、`git grep` 和普通文件搜索怎样分工

这些工具有重叠，但搜索边界不同。

| 工具 | 默认搜索范围 | 适合场景 | 容易忽略的边界 |
| --- | --- | --- | --- |
| `rg` | 当前目录递归，遵守 ignore，跳过隐藏和二进制 | 搜当前工作区、未跟踪文件和多种文本 | 被忽略或隐藏的文件默认看不到 |
| `git grep` | 工作树中的已跟踪文件，也能查 index 或指定 Git tree | 精确限定版本内的代码搜索 | 未跟踪文件默认不在范围内 |
| `rg --files` | 按 ignore 规则列文件 | 建立仓库轮廓、按扩展名筛选 | 只知道文件，不知道符号关系 |
| IDE/LSP | 语言符号与引用 | 跳定义、找引用、重命名 | 多语言、生成代码和配置关系覆盖不一 |

`git grep` 还能在历史树对象中搜索，适合回答“某个旧版本是否存在这段逻辑”。`rg` 更适合此刻的工作目录，包括尚未被 Git 跟踪的新文件。Coding Agent 通常以 `rg` 为主，再用 Git 命令处理版本和历史问题。

## 八、它和 RAG、Repo Map、FastCode 的差别

直接搜索是一种**在线、零预处理的探索**。每个任务到来后，Agent 从头生成关键词，边搜边读。其他方案主要是在重复任务变多后，把一部分工作提前做好。

| 方案 | 任务前准备 | 在线动作 | 优势 | 代价 |
| --- | --- | --- | --- | --- |
| `rg + read + Git` | 几乎没有 | 模型逐轮搜索和阅读 | 当前、透明、接入简单 | 依赖关键词，重复探索，容易漏边 |
| 代码 RAG | 解析、切块、建索引 | 语义与关键词召回 | 用户语言和代码语言不一致时更容易找到候选 | 索引更新、切块和重排需要维护 |
| Repo Map | 抽取符号和关系、排序 | 先看压缩地图，再读文件 | 低成本获得仓库全局轮廓 | 地图可能过期，动态关系仍缺失 |
| FastCode | 建结构与检索索引 | 围绕任务多步侦察 | 更系统地扩展跨文件影响范围 | 策略、停止条件和观测更复杂 |

Repo Map 并不会替代 `rg`。模型看过地图后，仍要搜索和读取具体实现。FastCode 的侦察过程里也可能使用关键词检索。它们是在简单循环上增加结构信号和覆盖约束，而不是换掉底层搜索工具。

前一篇[《代码知识工程怎么选》](/posts/code-knowledge-engineering-selection/)从知识产物角度比较了五种方案；[《Repo Map》](/posts/repo-map-codebase-context/)和[《FastCode》](/posts/fastcode-scouting-first-code-reasoning/)分别展开了结构地图和动态侦察的实现。

## 九、怎样给自己的 Agent 实现这套能力

第一版不需要做自由 Shell。提供四个窄工具就可以跑通：

```text
list_files(glob, max_results)
search_text(pattern, paths, file_globs, max_results)
read_file(path, start_line, end_line)
git_read(operation, revision, paths)
```

窄工具比任意命令更容易做参数校验、权限控制、结果截断和跨平台适配。成熟的本地 Coding Agent 可以再提供 Shell，但仍要限制工作目录、危险操作和输出规模。

每次返回至少包含：

- 实际执行的查询与路径；
- 命中文件数和命中行数；
- 返回内容是否截断；
- 每条命中的文件、行号和文本；
- 搜索失败、无命中与超时的区别。

“无命中”和“执行失败”不能都返回空数组。否则模型会把权限错误或正则错误理解为仓库中不存在相关内容。

路径必须解析到工作区内部，符号链接也要检查真实目标。单次读取限制行数和字节数，二进制文件返回类型信息而不是原始内容。敏感文件可以通过策略完全禁止读取，不能只靠文件名过滤。

探索至少要有最大轮数、累计输出预算和重复动作检测。更重要的是，任务要有外部验收：测试、编译、静态检查或可核对的证据清单。

如果模型已经连续三次换关键词却没有新文件，系统可以提示它总结已查范围、指出缺失信息并向用户求助，而不是继续无边界搜索。

## 十、怎样评估直接搜索到底够不够

不要用“Agent 看起来会搜”作为判断。选一批真实历史任务，记录下面几项：

- 正确修改涉及的文件，有多少在探索阶段被找到；
- 找到第一个正确入口用了多少轮搜索；
- 读取了多少无关文件和多少 Token；
- 是否在第一个合理结果上过早停止；
- 最终修改能否通过测试和人工评审；
- 同类任务再次执行时，是否重复走了相同弯路。

如果正确入口很快能找到，遗漏主要来自实现阶段，那么再建代码索引帮助不大。若模型频繁因为词汇不一致搜不到文件，可以先补语义检索；若入口能找到但跨模块影响总是漏，Repo Map、代码图或 FastCode 更值得投入；若缺失的是业务规则，则应补文档和 Skill。

还要观察仓库规模之外的因素。一个大但命名清楚、分层稳定的仓库，直接搜索可能很好用；一个不大却大量依赖配置和反射的仓库，纯文本搜索反而很难。文件数量不能单独决定选型。

## 十一、什么时候应该保持简单，什么时候升级

下面这些条件同时成立时，可以长期使用直接搜索：

- 仓库边界清楚，常见任务能从接口、错误码或领域词找到入口；
- 主要关系通过代码中的类型和调用显式表达；
- Agent 能运行测试，对遗漏形成及时反馈；
- 同类任务不多，重复探索成本不高；
- 仓库外业务知识较少，或有人能及时补充。

出现以下信号时，再增加一层能力：

```text
关键词经常对不上             → 混合检索或代码 RAG
每次都要重新摸仓库结构       → Repo Map
跨模块修改反复漏文件         → 代码图或 FastCode
业务规则存在但总被忽略       → Skills
人和 Agent 都在重复理解领域   → LLM Wiki
```

演进顺序可以很朴素：先给 Agent 搜索、读取、Git 和测试工具，记录真实失败；确认瓶颈后，再把最频繁的重复劳动提前计算。这样引入的每一层都有明确原因，也有指标验证它是否真的减少了搜索轮次或遗漏。

## 十二、我的判断

`grep/rg + 文件读取 + Git` 已经是一套完整可用的基础方案。它利用模型的推理能力，把仓库本身当作随取随用的外部记忆。代码规模适中、命名清楚、任务线索明确时，这套方法接入成本低，读到的又始终是当前工作区，通常已经足够。

它的上限也很清楚：文本匹配看不懂语义，逐轮探索没有天然覆盖保证，仓库外规则更不会自己出现。工程上更合理的做法是保留这条基础路径，再根据真实失败增加语义检索、结构地图、动态侦察或领域知识，而不是在第一个任务到来前先建一套完整平台。

## 参考资料

- [ripgrep 官方仓库](https://github.com/BurntSushi/ripgrep)：递归行搜索、ignore 处理、二进制与隐藏文件过滤，以及实现和性能说明。
- [ripgrep User Guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)：路径、文件类型、上下文行、隐藏文件和 ignore 行为的完整用法。
- [Git 官方文档：git grep](https://git-scm.com/docs/git-grep.html)：工作树、index 与 Git tree 对象中的文本搜索范围。
- [OpenAI Codex 开源仓库](https://github.com/openai/codex)：本地 Coding Agent 通过工作区与工具完成代码任务的具体工程实现。
