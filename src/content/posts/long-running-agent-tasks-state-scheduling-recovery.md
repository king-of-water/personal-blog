---
title: 长任务运行：状态、调度、恢复与收口
description: 从一个跨天代码升级任务出发，拆解 Agent 怎样保存状态、等待外部事件、处理结果未知、恢复执行，并以可验证证据结束任务。
category: Agent
subcategory: Agent 开发
articleClass: focused
seriesOrder: 120
featured: false
publishedAt: 2026-10-03T09:00:00+08:00
updatedAt: 2026-10-03
tags: [Agent, Long-running Task, Durable Execution, Scheduler, Idempotency, Recovery]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

一个 Agent 接到依赖升级任务：修改三个服务，等待 CI，失败后定位原因，等负责人批准，再创建合并请求。模型实际思考的时间可能只有几分钟，任务却会跨过数小时，甚至第二天才继续。

如果整个任务只存在于一个进程、一段对话和一个 HTTP 连接里，任何一次重启、超时或人工等待都可能让它失忆。重新运行也不安全，因为上一次创建分支、发送通知或触发流水线的结果未必已知。

这篇文章回答一个工程问题：怎样让 Agent 在时间、进程和模型调用都不连续的情况下，仍然知道自己做到哪里、还能做什么，并且最终可靠地停下来。

讨论范围是 Agent 外部的运行时。OpenAI 的 Background mode 可以让单次 Response 在断开连接后继续生成，Temporal 一类 Durable Execution 系统可以保存 Workflow 历史并在 Worker 故障后重放。这两者都很有用，但它们不会替业务定义任务状态、外部动作的幂等语义和完成条件。

![长任务从事件、状态到恢复和收口的运行闭环](/images/posts/long-running-agent-lifecycle.svg?v=20261003)

## 一、长任务不等于长模型调用

先区分三种常被混在一起的时间。

| 时间 | 例子 | 谁负责 |
| --- | --- | --- |
| 单次推理时间 | 模型生成计划或分析日志 | 模型 API 与调用方 |
| 一次 Agent Run | 多轮模型与工具循环 | Agent Harness |
| 业务任务生命周期 | 等 CI、审批、定时器和外部回执 | 持久化任务系统 |

一个模型请求可以运行很久，却仍然不是 Durable Task。反过来，一个跨三天的业务任务也不需要让模型持续运行。大多数时间里，它应该处于等待状态，不消耗模型 Token，也不占用 Worker。

[OpenAI Background mode](https://developers.openai.com/api/docs/guides/background) 把一次 Response 异步执行，调用方可以轮询 `queued`、`in_progress` 和终态，也可以在流中断后按事件序号续接。它解决的是模型请求与客户端连接解耦。Agent 若要等待 GitHub webhook、人工批准和次日定时检查，还需要自己的任务记录与调度入口。

因此长任务的最小结构是一个可以反复被唤醒的状态机：读取持久化状态，推进一小段，记录新事实，然后结束当前执行。下一次由外部事件、定时器或用户操作再次唤醒。

## 二、把任务状态从聊天记录里拿出来

消息历史适合给模型看，不适合作为唯一状态源。历史里会混入解释、猜测、工具输出和过期计划；压缩后还可能丢掉字段。运行时需要一份模型之外的结构化状态。

```yaml
task_id: upgrade-payment-sdk-20261003
status: WAITING_CI
goal: 将 payment-sdk 从 4.x 升级到 5.x
revision: 18
owner: user_42
workspace:
  repo: payments
  branch: agent/payment-sdk-v5
pending:
  kind: webhook
  key: ci/run/98127
last_action:
  type: trigger_ci
  idempotency_key: upgrade-payment-sdk-20261003:ci:1
evidence:
  changed_files: [pom.xml, PaymentClient.java, PaymentClientTest.java]
  test_run: 98127
budget:
  model_calls: 14
  tool_calls: 39
  cost_usd: 1.82
```

这份状态回答程序问题：任务是否还能推进，当前在等什么，哪些动作已经提交，恢复时从哪里继续。给模型的 Context 可以从中派生，却不能反过来覆盖它。

状态至少要分四层。任务层保存目标、身份、权限和终态；步骤层记录当前阶段、尝试次数和等待条件；动作层记录每次有副作用的请求与回执；证据层保存测试、Diff、审批和外部对象 ID。把四层揉成一个 `messages` 数组，后续很难安全重试，也无法查询“有哪些任务卡在审批超过两天”。

### 状态机要允许等待和结果未知

只设计 `RUNNING / SUCCESS / FAILED` 三个状态不够。真实任务至少会遇到：

- `WAITING_EVENT`：等待 CI、Webhook 或其他系统回调；
- `WAITING_USER`：需要补充信息或人工批准；
- `RETRY_SCHEDULED`：已知可以重试，但尚未到下一次执行时间；
- `ACTION_UNKNOWN`：请求超时，外部动作可能已经发生；
- `CANCELLING`：已经收到取消请求，正在停止或补偿；
- `NEEDS_ATTENTION`：运行时无法自动决定，交给人处理。

`ACTION_UNKNOWN` 尤其重要。创建合并请求时连接超时，不能直接判断失败，也不能无条件再创建一次。任务要先用幂等键或业务查询确认外部状态，再决定补发、等待还是人工介入。

## 三、快照负责读，事件负责解释

只存一份最新状态，读取很快，却无法回答它为什么变成这样。只存事件，审计完整，但每次恢复都从头回放，历史长后成本会上升。工程上常把二者结合：追加不可变事件，并定期生成快照。

```json
{"seq": 41, "type": "tool.requested", "tool": "trigger_ci", "key": "task-7:ci:1"}
{"seq": 42, "type": "tool.unknown", "reason": "client_timeout"}
{"seq": 43, "type": "ci.discovered", "run_id": "98127", "source": "reconcile"}
{"seq": 44, "type": "task.waiting", "condition": "ci/run/98127"}
```

事件需要单调递增的序号或版本号。Worker 读取 revision 18，推进后只能写 revision 19；如果另一个 Worker 已经写入 19，当前提交必须冲突，而不是静默覆盖。这个乐观并发控制可以阻止重复唤醒同时推进同一任务。

[Temporal Workflow Execution](https://docs.temporal.io/workflow-execution) 展示了更完整的 Event History 与 Replay 模型：Worker 重新执行 Workflow 代码，并检查生成的命令是否与历史一致，从最近已记录事件恢复。它要求 Workflow 逻辑保持确定性，把网络和外部副作用放进 Activity。自建系统不一定需要复刻 Temporal，但“决策可重放，副作用独立记录”的边界值得保留。

### 哪些信息进入快照

快照保存恢复必需的当前事实：任务状态、版本、待处理条件、动作回执、预算、工作区引用和必要证据。大段日志、仓库文件和模型原始输出应该放在对象存储或专门的 Trace 中，快照只保存引用与摘要。

快照也要有 Schema 版本。任务跨过一次部署后，新代码可能读到旧状态。新增可选字段通常容易兼容；重命名状态、改变工具结果含义或删除字段则需要迁移。长任务系统发布前要用旧快照做恢复测试，不能只验证新任务。

## 四、调度器只决定何时获得一次推进机会

调度器不应该直接“运行到完成”。它负责把可运行任务放进队列，Worker 获得租约后推进有限步数，然后释放资源。

典型唤醒来源有四类：

1. 用户创建任务或补充消息；
2. 工具、CI 和外部系统通过 Webhook 回传事件；
3. Timer 到期，例如退避重试或定时检查；
4. 运维操作，例如恢复、取消或重新入队。

所有入口最后都归一成任务事件。Webhook 接口先验签、去重、落库，快速返回成功，再由 Worker 异步处理。OpenAI 的 [Webhook 文档](https://developers.openai.com/api/docs/guides/webhooks) 明确说明事件可能重复投递，并建议用 `webhook-id` 去重；非平凡处理应交给后台 Worker，以免接收端超时导致继续重试。这也是通用 Webhook 消费方式。

### 租约、防重与公平性

队列的“至少一次投递”意味着同一消息可能被多个 Worker 看见。任务表需要租约字段，例如 `leased_by` 和 `lease_until`。Worker 定期续租；进程崩溃后，租约过期，其他 Worker 才能接管。

租约不能替代幂等。旧 Worker 可能在网络隔离期间继续运行，新 Worker 也已接管。每个有副作用的动作仍要使用业务幂等键，并在提交前检查任务 revision。

多租户环境还需要公平调度。一个用户创建一百个深度研究任务，不应占满所有并发。可以按租户设置运行槽、Token 预算和工具并发，再用优先级队列区分交互任务与批处理任务。优先级必须带老化机制，否则低优先级任务可能永久饥饿。

## 五、副作用要有自己的执行账本

模型调用失败可以重新生成，有副作用的工具不能按同一规则重试。发送邮件、发布版本、退款和创建工单都需要动作账本。

```sql
actions(
  task_id,
  logical_action,
  idempotency_key,
  request_hash,
  status,
  external_id,
  receipt,
  created_at,
  updated_at
)
```

`idempotency_key` 绑定业务动作，不绑定一次模型生成的 `call_id`。同一个键只能对应同一组参数；如果参数变了，系统应拒绝复用，防止“重试”变成另一笔操作。

工具执行分为准备、提交和确认。准备阶段做权限、参数和预算检查；提交阶段调用外部系统；确认阶段保存回执。如果提交后进程崩溃，恢复逻辑从确认开始，通过幂等键或外部查询寻找结果。没有查询接口且动作不可重复时，只能进入 `NEEDS_ATTENTION`，让人核对。

所谓 exactly-once 往往是业务效果上的目标，不是网络传输保证。可靠实现通常由至少一次投递、幂等处理、唯一约束和对账共同组成。把“工具超时”统一映射成失败，会在这一步埋下重复执行事故。

## 六、等待、取消与恢复是三套协议

等待意味着任务仍然开放，但当前没有可执行动作。记录等待类型、关联键和截止时间后，Worker 就应退出。轮询只能作为没有事件接口时的退路，并使用指数退避与抖动，避免成千上万个任务同一秒醒来。

取消是协作协议，不是一条 `kill -9`。运行时先把状态改为 `CANCELLING`，阻止新动作，再通知正在运行的模型请求和工具。可中断动作尽快停止，不可中断动作等待回执。已经完成的外部副作用是否补偿，由业务定义。

终止用于安全事故或失控任务，可以跳过正常清理，但必须记录操作者、原因和当时状态。暂停则保留任务，禁止调度，之后可以恢复。四个词在界面上看起来相近，语义不能混用。

[Temporal 的状态模型](https://docs.temporal.io/workflow-execution#status) 也区分 Running、Paused、Cancelled、Completed、Failed、Terminated 和 Timed Out。它还提醒了一个常见陷阱：长 Workflow 通常不应靠一个总超时表达业务期限，内部 Timer 更适合触发提醒、升级或分支处理。

## 七、恢复时不要把整段历史重新塞给模型

运行时恢复和模型恢复不是同一件事。程序先从快照与事件恢复确定状态，再为下一轮模型调用组装 Context。

一份恢复摘要应该包含：原始目标、当前阶段、已确认事实、已完成动作及回执、未解决问题、允许的下一步、剩余预算。原始日志和旧消息按需检索，不必全部重放。

```text
目标：升级 payment-sdk 到 5.x，保持 API 行为兼容
当前：CI 98127 失败，失败测试 PaymentClientTest#retryOnTimeout
已完成：依赖升级、编译修复、单元测试新增；分支 agent/payment-sdk-v5
禁止：修改 payments 模块以外文件；未经批准不得创建 PR
下一步：读取失败日志与相关实现，提出最小修复
预算：最多 6 次工具调用，完成后重新触发 CI
```

恢复摘要必须来自结构化状态与证据，不能让模型凭旧对话“回忆”。Context 压缩可以重写表达，不能改动工具回执、审批状态和权限边界。对高风险字段可附带哈希或引用 ID，让运行时在执行前再次校验。

## 八、收口需要独立于模型的完成条件

模型说“已经完成”只是候选判断。任务系统要检查契约中的完成条件，然后才能进入 `COMPLETED`。

代码升级任务的收口可能要求：

- 允许范围内的文件 Diff 已生成；
- 指定测试与构建通过；
- CI 对应当前提交，而不是旧 Commit；
- 人工批准已绑定同一个 Diff；
- 合并请求已创建，并保存 URL；
- 没有状态未知的工具动作；
- 最终摘要列出改动、验证和剩余风险。

结束还要关闭资源：释放工作区与租约，取消无用 Timer，撤销临时凭证，标记未消费事件，并冻结最终证据。清理失败不应把已完成的业务结果改成失败，可以记录为独立的 cleanup 告警并重试。

无法满足条件时，也要产生明确终态。预算耗尽、外部依赖长期不可用、权限永久拒绝和用户取消不是同一种失败。终态分类决定后续能否重开、是否计入 Agent 质量指标，以及用户看到什么操作入口。

## 九、把升级任务完整跑一遍

任务创建后，系统写入目标、仓库范围和预算，状态为 `READY`。调度器投递第一次推进，Agent 制定计划并修改工作区。工具执行器记录文件 Diff 与测试结果，Harness 触发 CI，动作账本保存幂等键和 run ID，任务转为 `WAITING_EVENT`。

Webhook 到达两次。接收端用事件 ID 去重，写入 `ci.failed`。Worker 恢复任务，读取失败步骤与日志摘要，给模型组装新的 Context。模型修复测试，再次触发 CI。第二次 CI 成功后，状态转为 `WAITING_USER`，页面显示 Diff、测试和成本，请负责人批准。

审批发生在第二天。恢复前系统检查批准所指向的 Commit 与当前工作区一致，然后创建合并请求。客户端在响应前超时，动作进入 `ACTION_UNKNOWN`。对账过程用幂等键查询，找到已经创建的 PR，于是补写回执，没有重复创建。

验收器检查 CI、审批、PR 和未知动作均符合契约，将任务标记为 `COMPLETED`。最终摘要来自已保存证据。无论期间有多少次 Worker 重启，模型都不会负责记住业务事实。

## 十、什么时候需要 Durable Execution 平台

数据库任务表、队列和定时器足以支持第一版，前提是团队愿意自己处理租约、去重、状态迁移、重试、可见性和运维工具。任务数量少、生命周期短、外部动作有限时，这个方案容易理解。

当任务频繁跨天、拥有大量 Timer 和事件、恢复语义复杂，或团队已经在使用 Temporal、AWS Step Functions 等工作流系统时，可以让它承担持久化调度。Agent Loop 作为一个或多个 Activity 运行，模型之外的审批、等待、重试和补偿进入 Workflow。

不能把所有模型循环逐 Token 写进工作流历史。细粒度流式事件放 Trace 或对象存储，工作流只记录会影响恢复的状态转换。否则历史迅速膨胀，Replay 和调试成本都会增加。

Cron 也不是长任务运行时。Cron 能按时间启动一次工作，却不保存某个任务的阶段、外部回执和取消语义。它适合产生事件，例如“每天扫描需要提醒的任务”，不适合充当任务本身。

## 十一、怎样验证恢复真的可靠

正常路径跑通不能证明 Durable。测试要主动在边界处制造故障：

| 故障注入 | 期望结果 |
| --- | --- |
| 工具提交后、保存回执前杀掉 Worker | 恢复后对账，不重复副作用 |
| 同一 Webhook 投递三次 | 只产生一次有效状态转换 |
| 两个 Worker 同时获得唤醒 | revision 冲突阻止双重推进 |
| 等待审批时升级状态 Schema | 旧任务仍能恢复或完成迁移 |
| Context 压缩后继续 | 目标、权限和未决动作不变 |
| 用户在工具运行中取消 | 不再启动新动作，现有动作有确定去向 |
| 任务达到预算 | 进入可解释终态，不继续消耗 |

线上至少监控可运行队列延迟、任务各状态停留时间、租约超时数、重复事件数、未知动作数、恢复成功率和终态分布。平均完成时长容易掩盖卡死任务，分位数与年龄分桶更有用。

比明确失败更危险的是任务长期保持 `RUNNING`，没有新事件也没人负责。为每个开放状态定义最大静默时间和责任人，系统才能发现“还活着但不会再前进”的任务。

## 十二、一份落地顺序

第一版先实现结构化任务状态、动作账本、幂等键和明确终态。随后接入事件去重、Timer、租约和取消。任务真的跨版本运行后，再补 Schema 迁移、事件历史与自动对账。不要在还没有一条真实长任务时，先造通用工作流平台。

设计评审时逐项回答：事实存在哪里，谁能推进状态，重复事件会怎样，工具超时后如何确认，等待如何唤醒，取消影响哪些动作，恢复 Context 从哪里生成，完成由哪些证据判定。任何一项只有“模型会处理”，都说明责任仍未落地。

长任务能够暂停、恢复和结束，靠的是普通分布式系统能力：持久化状态、消息、租约、幂等、对账和状态机。模型负责开放判断，运行时负责让这些判断跨过时间和故障后仍然有效。

## 参考资料

- [Temporal：Workflow Execution overview](https://docs.temporal.io/workflow-execution)
- [Temporal：Detecting Workflow failures](https://docs.temporal.io/encyclopedia/detecting-workflow-failures)
- [OpenAI API：Background mode](https://developers.openai.com/api/docs/guides/background)
- [OpenAI API：Webhooks](https://developers.openai.com/api/docs/guides/webhooks)
