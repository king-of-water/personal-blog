---
title: OpenClaw 架构拆解：从多渠道 Gateway 到长期在线的个人 Agent
description: 从 Gateway 控制面、确定性路由、Agent Runtime、共享会话、工具权限、Sandbox、Heartbeat 与 Automations 出发，拆解 OpenClaw 如何把一个 Agent 变成跨聊天渠道持续运行的自托管系统。
category: Agent
subcategory: Agent 产品与架构
articleClass: flagship
featured: false
publishedAt: 2026-10-02
updatedAt: 2026-10-02
tags: [OpenClaw, Agent Gateway, Personal Agent, Agent Runtime, Automation, Sandbox]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

聊天窗口里的 Agent 很容易给人一种错觉：只要模型能调用工具，再接上 Telegram、Slack 或 WhatsApp，一个长期在线的私人助手就完成了。真正开始运行后，困难会从模型迅速转移到系统层：同一个人的多条私信是否应该共享上下文，群聊该落到哪个 session，一条运行中的新消息是排队还是打断，定时任务失败后谁负责重试，浏览器和 shell 又能看到哪些主机资源。

[OpenClaw](https://github.com/openclaw/openclaw) 把这些问题收敛到一个长驻 Gateway。聊天渠道、客户端和执行节点通过它连接；Gateway 保存路由、会话、运行状态和自动化任务；嵌入式 Agent Runtime 负责 Prompt、模型、工具与交付。它更像个人 Agent 的操作系统和控制平面，而不是套在模型外的一层聊天 UI。

这篇文章沿一条消息的完整生命周期拆解 OpenClaw：消息怎样被渠道接纳，binding 如何选择 Agent，session key 如何决定上下文，运行中的消息怎样 steer，工具在哪里执行，回复又如何返回原渠道。后半部分会讨论长期记忆、Heartbeat、Automations、多 Agent 与安全边界，并用一个跨渠道值守案例说明配置和验收该怎样落地。

![OpenClaw 以 Gateway 为核心连接渠道、会话、Agent Runtime、模型和执行节点](/images/posts/openclaw-gateway-architecture.svg)

## 一、OpenClaw 的核心对象不是 Bot，而是 Gateway

Bot 通常围绕一个渠道组织：接收平台 webhook，调用模型，再回复同一平台。OpenClaw 的[官方架构](https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md)把 Gateway 放在中心，Telegram、Discord、Slack、Signal、WhatsApp 等渠道只是接入面。WebChat、CLI 和其他控制客户端也连接同一个 Gateway，远程节点则提供设备或执行能力。

Gateway 是长驻进程，也是会话与路由的事实来源。默认监听本机 `127.0.0.1:18789`，通过 WebSocket 暴露控制协议，并在同一端口承载部分 HTTP 能力。这个默认值透露了安全假设：先把控制面留在本机，需要远程访问时再显式增加认证和网络边界。

把 Gateway 设为唯一事实来源，可以解决多个客户端同时操作时的分叉。手机消息、桌面 WebChat 和 CLI 若各自维护本地历史，就会得到三份不同的“当前任务”。都附着到 Gateway session 后，它们看到的是同一份运行状态、转录和路由信息。

代价是 Gateway 变成关键状态节点。它的配置、SQLite、工作区与凭证需要备份，升级需要迁移验证，网络暴露需要审计。自托管把数据和控制权留给用户，同时把可用性、安全更新与故障恢复责任一并交给用户。

## 二、先分清四个平面，故障才不会找错地方

理解 OpenClaw 最实用的方式，是把系统分成四个平面。

接入平面负责与聊天平台连接，接收消息、下载附件、发送回复，并执行平台级配对、允许列表和群组规则。它决定“这条消息能不能进系统”。

控制平面由 Gateway 提供，维护 Agent roster、bindings、session、运行、节点、审批、自动化和状态订阅。它决定“由谁处理、落到哪段历史、当前运行处于什么状态”。

推理平面是 OpenClaw 内嵌的 Agent Runtime，负责发现模型、装配 Prompt、注册工具、管理一轮 Agent Loop、压缩上下文并产生流式事件。它决定“模型看到什么，以及下一步调用什么”。

执行平面包含宿主工具、Sandbox、浏览器、节点和外部服务。它把工具请求变成真实动作，决定“动作在哪里发生、能影响哪些资源”。

| 平面 | 典型对象 | 常见故障 | 应检查的证据 |
| --- | --- | --- | --- |
| 接入 | channel、account、pairing、allowFrom | 收不到消息、回复发错账号 | 渠道状态、发送者 ID、平台回执 |
| 控制 | Gateway、binding、session、run、automation | 路由错 Agent、历史串线、任务没调度 | binding 命中、session key、run 记录 |
| 推理 | prompt、model、skills、compaction | 遗忘约束、工具选择错误 | 实际 Prompt、模型事件、压缩记录 |
| 执行 | tools、sandbox、node、browser | 权限拒绝、越界、命令失败 | 有效策略、运行环境、工具结果 |

例如 Agent 没回复，不一定是模型故障。消息可能被 allowlist 拒绝，binding 可能找不到 Agent，当前 session 可能已有运行占用队列，模型也可能成功生成但渠道投递失败。分层后才能先问消息走到哪一站，而不是直接换模型或加 Prompt。

## 三、Gateway 协议让 UI 和 Agent 共用同一套状态

OpenClaw 的 [Gateway Protocol](https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md) 通过 WebSocket 暴露类型化 API，覆盖状态、渠道、模型、聊天、Agent、session、节点和审批。客户端连上后先声明角色与 scope，后续请求和事件都在这条控制通道上传输。

“客户端”和“节点”不是同一种角色。客户端面向操作者，用来发送消息、查看状态和管理配置；节点提供设备能力或执行目标，例如另一台机器上的命令环境。权限 scope 决定连接可以做什么，不能把能看状态的连接自然视为能执行所有工具。

Agent 在 Gateway 内部调用某些控制能力时，可以直接经过路由器分发，不必绕一次真实网络。直接调用减少延迟，却没有绕开权限、截止时间和取消语义。这个细节很重要：内部调用优化了传输路径，不应改变安全契约。

协议还承担实时事件。模型 Token、工具开始与结束、session 变化、审批请求和渠道状态会推送给客户端。一个可靠 UI 不应只把流式文本拼起来，还要根据 run ID 和事件类型维护状态。如果连接重连，需要回到 Gateway 查询事实，而不是把本地最后一帧当成最终结果。

## 四、一条入站消息先过准入，再做 Agent Binding

渠道收到消息后，第一道门是平台配置：账号是否已连接，发送者是否经过 pairing，`dmPolicy`、群组策略和 `allowFrom` 是否允许它进入。只有已被接纳的消息才进入 Agent 路由。

[Agent bindings](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-bindings.md) 用 `agentId` 加一组匹配条件，把消息交给某个 Agent。条件可以包含 channel、account、具体 peer、guild、team 或 Discord role。匹配优先级按具体程度排序：具体会话优先于 guild、team、account 和整个 channel 的兜底；同一层级再按配置顺序选择。

这个顺序避免“广泛规则吞掉窄规则”。例如一个 Discord 账号大部分消息由 `main` 处理，但某个支持频道应进入 `support`，就要让具体 peer binding 命中在先，再用 account 或 channel 规则兜底。

binding 只选择 Agent，不授予访问权。一个被平台策略拒绝的发送者，不会因为配置了 binding 就获准进入；一个获准进入的消息，也不会因为被路由到高权限 Agent 就自动获得该 Agent 的全部管理权限。准入和路由是两套独立控制，配置审计要分别检查。

多 Agent 环境没有匹配项时，系统不会随便拿列表第一项处理，而会报告需要选择 Agent。显式失败比静默落到错误工作区安全得多。工作邮件误入私人 Agent，或者客户群消息落进拥有主机权限的 Agent，后果都比一次未回复严重。

## 五、Agent 选择之后，还要决定它属于哪个 Session

同一个 Agent 可以有许多 session。路由确定工作区、模型和工具策略，session key 则确定这条消息与哪段历史共享上下文。两者经常被混淆：绑定到同一 Agent，不表示所有对话必须共享一份历史。

OpenClaw 默认可以让不同渠道的直接消息汇入 main session，于是用户在 Telegram 说到一半，回到 WebChat 仍能继续。这是个人助手很自然的体验，也带来隐私边界问题：若多个发送者都能向同一 main session 发私信，他们可能间接影响彼此看到的上下文和后续行为。

官方[主会话文档](https://github.com/openclaw/openclaw/blob/main/docs/concepts/main-session.md)建议，多发送者环境使用 `dmScope: per-channel-peer` 等隔离策略。群组也可以按 main 或 per-group 划分。选择 session scope 时，需要回答的是“哪些参与者可以共享历史和当前运行”，而不只是“想让聊天连续吗”。

路由还维护 `lastRoute`，让系统知道主动消息和后台结果应该送到哪里。若 main session 被非所有者的私信覆盖最后路由，定时报告可能发错对象。OpenClaw 会在能从 allowlist 推断唯一所有者时固定 owner route，但最稳妥的方式仍是显式设置 owner、发送目标和 session 范围。

## 六、Session Store 是运行事实，不是简单聊天文件

每个 Agent 的 session 行和 transcript 默认存入 `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`，旧式或归档 JSONL 位于 sessions 目录。SQLite 中除了消息，还包括 token 用量、最后路由和运行元数据。不同 Agent 应使用不同 agentDir，避免状态与凭证交叉。

Gateway 在模型开始流式输出前，会先准备 session transcript 目标和写入所有权。压缩、截断与写入处在同一事务围栏里，目的是避免两个并发运行同时改写一份历史，或者客户端看到输出却没有可恢复记录。

磁盘也不是无限的。主会话文档描述了每 Agent 默认 10GB 一类的存储控制，达到上限时优先归档最老且未被引用的历史，不会动当前路由、活跃或正在执行的 session。具体默认值可能随版本调整，但淘汰原则值得保留：按可达性和活跃度处理，而不是按文件日期盲删。

删除 session 与删除记忆不是同一操作。CLI 删除可以保留带校验的归档，incognito 才倾向于不保留；工作区里的 `MEMORY.md` 和日记仍是独立文件。用户说“忘掉这件事”时，系统需要明确范围：停止当前 Context、删除转录、清理长期记忆，还是连外部工具产生的副本也删除。

## 七、Agent Runtime 怎样装配一次运行

OpenClaw 只维护一个自有嵌入式 Agent Runtime，而不是为每个渠道实现一套模型循环。[Agent Runtime 文档](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent.md)列出它负责的核心工作：模型发现、工具接线、Prompt 装配、session 管理和渠道交付。

每个 Agent 有独立 workspace。`AGENTS.md` 放操作规则，`SOUL.md` 定义语气和价值取向，`IDENTITY.md` 描述身份，`USER.md` 保存用户信息，`MEMORY.md` 保存长期记忆，`BOOTSTRAP.md` 用于初始化。文件名代表不同生命周期，也让使用者能用普通版本控制审查系统行为。

Skills 可以来自 workspace、workspace 下 `.agents/skills`、用户级目录、OpenClaw 目录、内置包和额外路径，并按优先级合并。高优先级覆盖使单个 Agent 能定制公共 Skill，也意味着排查时要查看“最终生效的 Skill”，不能只打开某个同名文件。

一次运行的 Prompt 包括基础系统提示、有效 Skills 提示、bootstrap 文件、会话历史和本轮覆盖项。模型上下文有限，Runtime 会根据模型窗口和压缩预留计算预算。文件存在不代表全文永远进入每一轮，工具存在也不代表当前策略允许使用。

## 八、Agent Loop 的困难在运行中途，而不在第一轮

用户消息进入已经有活动 run 的 session 时，系统必须决定新消息怎么办。OpenClaw 支持 steer、followup、collect、interrupt 等 queue mode。默认 steer 允许新消息影响当前运行，而不是永远排到旧任务之后。

[Agent Loop 文档](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)描述了 steer 的细节：已经开始的工具调用会继续；尚未开始的顺序工具调用可以跳过；已经作为并行批次发出的调用会越过 steer 检查点继续执行。Runtime 在下一次把状态交给模型前，会为被跳过的调用补成对的合成结果，保持消息协议有效。

这比“立即打断所有东西”复杂，因为真实工具可能已经产生副作用。命令已启动、邮件已发送、浏览器已提交表单时，取消模型输出不能倒转外部世界。系统只能停止未开始的动作，尝试取消可取消的执行，并把已经发生的结果写回状态。

不同 queue mode 适合不同交互。steer 适合用户补充条件；followup 适合让当前工作先结束再做新任务；collect 适合短时间聚合多条输入；interrupt 适合明确停止风险动作。客户端应让用户知道当前模式，否则“别发了”可能只排在长任务后面，失去停止意义。

![OpenClaw 从入站消息、确定性路由到 Agent Loop、工具执行和原渠道交付的运行链](/images/posts/openclaw-message-runtime-flow.svg)

## 九、压缩、重置与记忆分别解决不同问题

长 session 需要 compaction，把旧历史概括为继续工作所需的状态。`/compact` 可以显式触发并附带关注点。压缩减少当前模型输入，不等于删除底层 transcript，也不应该被当作隐私清除。

`/new` 或 `/reset` 创建新的 session。单独发送时可以只确认重置，不调用模型。重置前后，OpenClaw 能把尾部内容整理进当天日记，新会话再加载近期记录。这样既切断膨胀历史，又保留跨会话需要的线索。

长期记忆采用两层：`MEMORY.md` 保存经过整理的稳定信息，`memory/YYYY-MM-DD.md` 保存按日记录。前者像索引和常驻事实，后者像可回查的工作日志。把每条聊天都抄进 `MEMORY.md` 会让启动 Context 膨胀；只写日记而不整理，又会让关键偏好很难被及时取回。

系统在即将压缩时可以先 flush durable facts。这个动作仍需防止模型把不可靠推断写成事实。适合的记忆应标注主体、范围和时间，例如“2026-10-02，personal-blog 仓库发布由用户授权直接 push”，而不是“所有项目都自动推送”。

Session、transcript、daily memory 和 curated memory 构成不同保留层。设计清理策略时要分别覆盖它们，还要考虑外部渠道、工具日志和第三方服务的副本。删除一个 SQLite 行不能完成端到端遗忘。

## 十、Tool Policy、Sandbox 和 Elevated 是三道不同的门

OpenClaw 的[安全说明](https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandbox-vs-tool-policy-vs-elevated.md)把三个容易混淆的控制分开。Sandbox 决定工具在哪里运行；Tool Policy 决定哪些工具可见和允许；Elevated 是 exec 从普通 sandbox 提升到 Gateway 主机或节点的受控出口。

Sandbox 可以设为 off、non-main 或 all，scope 可以围绕 session 或其他边界复用，workspaceAccess 决定无挂载、只读还是读写。Gateway 始终留在宿主，只有工具执行移动到 Sandbox。它降低文件系统和进程爆炸半径，不是绝对安全边界。

Tool Policy 即使在没有 Sandbox 时也有用。一个研究 Agent 可以只开放网页和只读文件，一个运维 Agent 可以开放有限命令，一个公开群聊 Agent 应禁止 session 管理和跨 Agent 工具。减少工具面同时降低误调用、Prompt injection 和权限升级风险。

Elevated 不应成为日常方便开关。它只解决明确需要宿主能力的 exec，而且不能越过创建者角色要求的强制 sandbox。若 Agent 经常请求 elevated，通常说明工作区挂载、工具设计或任务归属不合理，应先调整系统边界。

`openclaw sandbox explain` 能显示某个 session 或 Agent 的有效 mode、scope、workspace access、工具规则和 elevated gate。安全排查应看有效配置，而不是猜哪一层 JSON 覆盖了哪一层默认值。

## 十一、OpenClaw 的安全模型是一座房子，不是一栋写字楼

官方[安全指南](https://github.com/openclaw/openclaw/blob/main/docs/gateway/security/index.md)明确指出，一个 Gateway 对应一个信任边界。它适合一个个人或一个互相信任的团队，不是为彼此敌对的多租户提供强隔离的边界。

原因不只在 session。Gateway 管理共享配置、插件、凭证、节点和管理 API；有控制权限的参与者可能改变其他 Agent 的路由或工具策略。即使每个 Agent 有独立工作区，也不能假设它们像云平台租户一样互不可见。

如果家庭成员共享一个 Gateway，通常是共同信任下的便利选择。若接入客户、外包人员或公开社区，应拆成不同 OS 用户、主机或 Gateway，并使用不同凭证和网络策略。拆分之后再通过最小化的 webhook 或消息接口交换必要结果。

Prompt injection 也需要现实地看待。允许 Agent 阅读网页、邮件和群聊，就等于允许不可信文本进入模型 Context。系统提示不能提供强隔离。高风险动作要由工具策略、审批、接收方白名单、沙箱和外部 API 权限共同限制。

![OpenClaw 一个 Gateway 的信任域，以及需要为不互信参与者拆分的边界](/images/posts/openclaw-trust-boundaries.svg)

## 十二、跨 Session 工具会把可见性问题放大

OpenClaw 提供 session 工具，让 Agent 列举、读取或向其他 session 发送消息。可见性可以限制在 self、tree、agent 或 all。默认较宽的可见性在个人系统里很方便，能让主 Agent 跟踪子任务；多用户场景却可能暴露其他人的 transcript。

跨 Agent 访问还有独立的 `tools.agentToAgent` 控制。两个 Agent 即使属于同一 Gateway，也不该自动互读全部历史。支持 Agent 可能需要向部署 Agent 发一个受限请求，不需要读取私人 main session 的聊天内容。

incognito session 会从常规发现中隐藏，适合不希望进入普通历史列表的短任务，但它不是魔法隐私模式。工具调用仍可能在外部系统留下记录，Gateway 日志和渠道平台也可能保存元数据。安全说明必须讲清系统承诺的范围。

“能发现谁、能读取什么、能向哪里发消息、能否代表对方执行”是四种权限。把它们压成一个 all access 开关，会让协作方便，也让审计失去粒度。跨 session 接口应尽量返回最小摘要，并为外部动作保留目标确认。

## 十三、多 Agent 的价值在稳定分权，不在数量

OpenClaw 的[多 Agent 文档](https://github.com/openclaw/openclaw/blob/main/docs/concepts/multi-agent.md)给每个 Agent 独立 workspace、state、auth、model 和 session store，再通过 binding 把渠道账号或具体会话映射过去。这种结构适合建立长期角色：私人助手、代码 Agent、家庭自动化 Agent、公开支持 Agent。

长期角色有清楚的资产边界和权限差异，比临时把所有任务交给一个万能 Agent 更容易审计。代码 Agent 读取仓库但不碰家庭设备；家庭 Agent 控制灯光却看不到工作邮件；公开支持 Agent 只使用知识库和工单工具。

数量本身不会提升智能。多个 Agent 共享相同工具、凭证和 main session，只是增加路由复杂度。划分 Agent 的依据应是信任、数据、模型成本和工作区生命周期，而不是给每个业务名词都建一个角色。

Binding 也适合做渐进迁移。先让所有渠道进入 main，再把一个账号或具体 peer 路由到新 Agent，观察 session、工具和投递是否正确，最后扩大范围。由于 bindings 支持配置热加载，变更仍应配一组路由表测试，防止宽泛规则抢占流量。

## 十四、Heartbeat 是主动意识的节拍，不是万能定时器

OpenClaw 的 [Heartbeat](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md) 是系统拥有的 monitor automation。它按周期在 main session 触发一次 Agent turn，默认节拍当前为 30 分钟；当使用某些 Anthropic OAuth 配置时默认可能更长。具体时间可配置，短周期会直接增加模型成本。

Heartbeat 的默认提示很克制：读取 monitor scratch，只在有需要时提醒，没有行动就返回静默标记。它不会从旧聊天中猜测用户曾经随口承诺的事项，也不会自动把每段对话变成提醒。这条限制避免一个长期 Agent 不断翻旧账和制造通知噪声。

计划性的日报、提醒和轮询应创建独立 Automation；Heartbeat 更适合环境感知和后台完成后的轻量唤醒。它本身不创建 detached task 记录，也不是耐久工作队列。把耗时任务直接塞进 heartbeat 会让 main session 变脏，还会在每次周期重复消耗 Context。

调度器会在 main 队列繁忙、同 Agent 已有运行或目标 session 有活动工作时延后 monitor turn，避免并发踩踏。设置 `every: "0m"` 只停用周期节拍，事件驱动 wake 仍可能触发一次运行。若不希望后台 exec 完成时唤醒模型，还要关闭相应 notifyOnExit。

主动系统的质量不由“检查得多频繁”决定，而由信号和打扰的比例决定。Monitor scratch 应短小、具体、有阈值，并明确什么情况保持安静。

## 十五、Automations、Tasks、Hooks 与 Standing Orders 各管一件事

OpenClaw 的[自动化总览](https://github.com/openclaw/openclaw/blob/main/docs/automation/index.md)把后台能力拆成多个概念。Automations 是持久调度器，支持一次、间隔、cron 和 webhook 触发，并把输出投递到渠道、webhook 或静默保存。Heartbeat 也由同一调度器维护，只是属于系统管理的监控任务。

Tasks 是 detached work 的账本，记录 ACP、子 Agent、隔离自动化和 CLI 操作。它告诉你后台有什么工作、处于什么状态，但不负责决定何时运行。Task Flow 在其上协调多步骤耐久流程和修订。

Hooks 响应生命周期事件，例如 `/new`、`/reset`、`/stop`、压缩和 Gateway 启动。Plugin hooks 在进程内拦截工具、Prompt、消息或生命周期。外部服务触发 Agent 则使用带认证的 HTTP webhook。三者触发来源和安全位置不同。

Standing Orders 是持续注入 session 的长期指令，适合合规检查和固定责任。它们提供行为上下文，不提供时间调度。若要求“每天 9 点检查”，Standing Order 说明如何检查，Automation 决定何时运行。

选择机制时可以问四个问题：是否需要准确时间；是否需要独立 session；是否需要可查询 task 记录；输出送到哪里。用 Heartbeat 承担所有后台工作，或者用一堆 Hooks 模拟调度，都会让失败恢复和审计变得模糊。

## 十六、一个完整案例：跨渠道的代码仓库值守 Agent

假设要运行一个个人代码值守 Agent：在 Telegram 接收临时指令，每天检查仓库构建与依赖状态，长任务在隔离容器执行，完成后把结果发回最初渠道；公开 Discord 只能咨询文档，不能运行命令。

第一步，划分两个 Agent。`code-ops` 有独立 workspace、仓库只读或按需读写挂载、构建工具和私有模型凭证；`docs-help` 只开放网页与知识库工具，不拥有 shell。两个 Agent 使用不同 agentDir 和 session store。

第二步，配置准入和 binding。Telegram 账号只允许 owner ID，并绑定 `code-ops`；Discord 公开频道经过群组规则后绑定 `docs-help`。binding 负责选择角色，allowlist 负责阻止陌生 Telegram 用户，不能互相替代。

第三步，设计 session scope。owner 在 Telegram 与 WebChat 的直接消息可以汇入 main，方便接续工作；Discord 按群组 session 隔离。后台日报使用命名或隔离 session，避免每天把完整输出堆入 main，只把异常摘要投递给 owner。

第四步，配置执行边界。`code-ops` 的普通任务在 session scope Sandbox 中运行，workspace 只读；需要修改时由显式审批切换到受控读写环境。禁止任意 elevated，网络只允许包源和代码托管站。`docs-help` 完全没有 exec。

第五步，建立 Automation。每天固定时间在隔离 session 拉取已批准镜像、运行锁文件检查和构建，把完整日志作为产物保存。成功且无变化时静默；失败时发送仓库、commit、失败阶段、日志位置和建议动作。Heartbeat 只关注未确认告警和刚完成的后台任务。

第六步，验证完整链。用 owner 和非 owner 两个 Telegram 账号测试准入；用具体 Discord peer 验证 binding；在运行构建时发送“只诊断，不修改”测试 steer；模拟渠道投递失败，确认任务完成和消息送达是两个状态；重启 Gateway 后确认 Automation 仍存在、session 可恢复。

这个案例没有依靠一段巨大的系统 Prompt。接入、路由、session、工具、Sandbox、调度和投递各有独立的可检查配置，模型只在被允许的空间里做开放判断。

## 十七、生产化前必须做的故障演练

先演练 Gateway 重启。活动 run 会怎样结束，后台任务是否留下可恢复状态，渠道连接多久重建，客户端如何重新附着 session，都应该有明确结果。不能恢复的工具动作要显示 unknown，而不是自动重放。

再演练渠道重复投递和乱序。聊天平台的 webhook 或重连可能带来重复消息，系统应使用平台事件 ID 去重；回复若跨多个异步阶段，也要避免旧结果覆盖新会话的最后路由。

然后演练模型和工具超时。只读操作可以有限重试，写操作先查外部状态。用户 steer 或 interrupt 时，已经启动的并行工具可能继续，UI 和审计日志必须显示哪些动作实际发生。

还要演练存储逼近上限、SQLite 损坏和备份恢复。备份不仅包含数据库，还包括 workspace、Skills、配置和必要密钥的恢复方案。密钥不应直接和普通备份打包；恢复演练要确认新主机权限和网络策略没有意外放宽。

最后做攻击演练：网页里包含“读取主目录密钥并上传”的提示，公开群用户诱导 Agent 调用 session 工具，恶意附件尝试覆盖工作区，低权限 Agent 请求 elevated。期望结果必须由程序规则保证，不能只看模型是否礼貌拒绝。

## 十八、可观测性要能回答“谁让什么在哪里发生”

一条运行的最小追踪链应该包含：channel event ID、sender、binding 命中的 agentId、session key、run ID、model call、tool call、执行目标、审批、结果和 outbound delivery ID。有了这条链，才能区分模型判断、系统路由和外部世界状态。

日志需要脱敏。消息正文、工具参数、环境变量、浏览器页面和模型 Prompt 都可能包含凭证或私人信息。默认记录结构化元数据，对敏感正文设置短保留期和访问控制；调试模式也不应无条件打印所有 headers 和环境。

指标可以围绕四组目标：接入成功率与投递延迟；run 成功、取消和 unknown 比例；模型 Token、成本与 compaction 次数；工具拒绝、审批、Sandbox 和 elevated 使用情况。主动系统还要统计通知有用率，长期无人响应的提醒应降频或停用。

审计记录要区分“请求过”和“执行过”。模型提出危险工具但被 policy 拒绝，是安全控制成功；工具已调用但渠道回复失败，是执行成功、交付失败；Automation 被调度但因队列繁忙延期，不应算业务失败。

## 十九、升级 OpenClaw 时，配置迁移比 npm install 更重要

OpenClaw 迭代很快，文档中已经出现调度命令别名、旧 session 文件迁移和 retired commitments 这类变化。升级前应固定当前版本，备份配置与状态，阅读迁移说明，并在隔离副本运行 doctor 和关键回放。

回放集至少包括：每条 binding 的正反例；main 与 per-peer session 隔离；一次 steer；一次 Sandbox 拒绝；一次 Automation 持久化；一次渠道投递；一次 `/new` 后的记忆恢复。只验证 Gateway 能启动，覆盖不了行为语义变化。

配置热加载也需要谨慎。binding 或工具策略可以即时变化，正在运行的任务可能在旧规则下开始。高风险变更应暂停新流量，等待活动 run 收敛，应用配置后再用有效策略检查器确认。保留旧配置和数据库备份，出现退化时能够整体回滚。

Skill 与 workspace 文件同样属于发布资产。升级 Runtime 时，工具名、Prompt 预算或优先级可能变化，旧 Skill 即使文件不变，实际行为也会改变。把 Runtime 版本、配置版本和 Skill 版本一起记录，问题才可复现。

## 二十、OpenClaw 适合什么，不适合什么

OpenClaw 适合想要自托管个人 Agent 控制面的用户：多个聊天渠道需要统一到一份长期状态，任务既有即时对话也有定时和后台运行，还希望自己掌握工作区、模型、工具和设备节点。它把容易各自为政的组件收束到 Gateway，使路由和 session 成为显式系统对象。

如果只需要网站上的一次性问答，完整 Gateway 过重；如果流程完全固定，传统队列和 Workflow 引擎更容易证明行为；如果面对大量互不信任客户，一个共享 Gateway 也不是合适的租户隔离层。此时应在更外层建立账户、资源和数据边界，或为不同信任域运行独立实例。

评估是否采用它，可以从三个问题开始：你是否真的需要跨渠道共享状态；是否愿意长期维护一台拥有真实工具权限的服务；是否能为自动化与主动通知建立清楚验收。三个答案都为“是”，OpenClaw 的架构价值才会超过部署与安全成本。

它最值得借鉴的设计，是让消息路由和模型推理分离。模型不用猜回复发到哪里，binding 不负责决定任务怎样完成，session 也不等于权限。每个层次只承担自己的责任，长期在线 Agent 才能在行为越来越丰富时仍然可解释。

## 二十一、从一份最小配置开始验证路由

下面这段 JSON5 展示一个双 Agent 的结构。它省略了渠道密钥和模型凭证，重点是所有权、工作区、binding 与 session 范围。配置字段会随版本演进，落地时应以当前版本 schema 和 `openclaw doctor` 输出为准。

```json5
{
  agents: {
    ownership: "explicit",
    entries: {
      main: { workspace: "~/.openclaw/workspace" },
      support: {
        workspace: "~/.openclaw/workspace-support",
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "ro",
        },
      },
    },
  },
  bindings: [
    {
      agentId: "support",
      match: {
        channel: "discord",
        accountId: "support",
        peer: { kind: "channel", id: "123456789012345678" },
      },
      session: { groupScope: "per-group" },
    },
    {
      agentId: "main",
      match: { channel: "telegram", accountId: "owner" },
      session: { dmScope: "main" },
    },
  ],
}
```

第一条 binding 具体到 Discord account 和 peer，优先于更宽泛的 channel 规则；第二条把 owner Telegram 账号路由到 main。这里仍然没有写谁可以向账号发消息，准入要在 channel 的 pairing、allowFrom 和群组策略中单独配置。若把 binding 当 allowlist，恶意消息可能被准确送到本来只为 owner 准备的 Agent。

应用配置后，不要直接开始日常使用。先列出有效 Agent 与 bindings，再探测渠道状态和 Sandbox：

```bash
openclaw agents list --bindings
openclaw channels status --probe
openclaw sandbox explain --agent support
openclaw sandbox explain --session agent:main:main
```

随后做一张路由测试表。每个具体 peer、account 兜底、channel 兜底和未匹配输入各准备一个样本。记录预期的准入结果、agentId、session key、workspace、工具策略和回复渠道。自动化程度可以很低，关键是配置变化后能重复执行。

| 输入 | 预期 Agent | 预期 Session | 预期权限 | 预期交付 |
| --- | --- | --- | --- | --- |
| owner Telegram 私信 | main | main | 私人工具集 | 原 Telegram 对话 |
| Discord 支持频道 | support | per-group | 只读 Sandbox | 原频道 |
| 其他 Discord 频道 | 无匹配或明确兜底 | 不应创建错误 session | 无 | 明确拒绝 |
| 陌生 Telegram 私信 | 不进入 binding | 不创建 | 无 | pairing 或拒绝提示 |

路由检查还要覆盖配置顺序。同一优先级的 binding 按顺序决定结果，窄规则应放在宽规则前。省略 `accountId` 只表示默认账号，不等于所有账号；匹配整个渠道要显式使用 `"*"`。这类细节很适合写成配置 lint 或测试，不应依赖维护者长期记忆。

## 二十二、浏览器是工具，也是另一条高风险网络出口

长期在线 Agent 经常需要登录网页、阅读邮件或操作控制台。浏览器比简单 HTTP fetch 拥有更丰富状态：Cookie、Local Storage、已登录 session、下载文件和剪贴板都可能承载敏感信息。让模型“只看一个页面”，实际可能给了它代表用户访问整个站点的能力。

首先应把浏览器 profile 按信任域拆分。公开内容研究使用无登录、可丢弃的 profile；私人服务使用专用 profile，只登录任务所需账号；高风险管理后台不要和日常浏览共享 Cookie。不同 Agent 若需要不同身份，也不应指向同一个浏览器状态目录。

其次要控制网络可达范围。浏览工具可能被不可信页面诱导请求内网地址、云元数据端点或 Gateway 自身管理接口，形成 SSRF。网络层应阻断 loopback、链路本地、私有网段和不需要的域名，确有内网需求时通过精确 allowlist 开放。URL 重定向和 DNS 解析后的最终地址也必须重新检查。

下载内容按不可信输入处理。文档、压缩包和脚本先落在隔离目录，限制大小和类型，扫描后再交给其他工具。不要让浏览器下载目录直接映射到自动执行路径，也不要因为页面声称“这是安全更新”就让 Agent 运行安装命令。

网页登录与动作授权要分离。读取账单和提交付款不应共用无确认工具；查看邮件和代表用户发信也应是两种能力。对转账、删除、发布和外发信息，运行时要显示目标、关键参数和身份，让操作者批准实际动作，而不是批准一句模糊的“继续完成任务”。

最后考虑审计与退出。浏览器自动化应记录访问域、下载和提交动作，但对表单值、Cookie 和页面正文脱敏。任务结束后关闭临时 profile，清理下载，撤销短期凭证。Browser Sandbox 若存在，也要验证它与 exec Sandbox 的边界；两者可能是不同容器和不同网络策略，不能从一个生效推断另一个也安全。

## 二十三、把“长期在线”设计成可以安全停下

主动 Agent 容易把可用性理解成永不停止。可靠系统反而需要许多清楚的停止点：渠道准入失败时不创建 session；binding 不明确时要求配置；预算耗尽时保存进度；高风险工具等待审批；外部结果未知时停止重试；通知没有新信息时保持安静。

每个后台机制都应有暂停方法。Automation 可以单独停用，Heartbeat 可以关闭周期节拍，活动 task 可以取消，渠道账号可以断开，某个 Agent 的工具可以降为只读。紧急处置不应只剩“杀掉 Gateway”，因为粗暴停机可能丢失正在写入的状态，也无法区分哪些外部动作已经发生。

建议准备三档运行模式。正常模式开放经批准的自动化与写工具；观察模式保留消息和只读检查，暂停主动外发与写操作；维护模式只允许本机管理员访问，停止渠道和调度，用于迁移或恢复。模式切换要能从有效配置和日志中确认，避免界面显示暂停而调度器仍持有旧任务。

成本也是停止条件。为每个 Agent 和 Automation 设置模型、Token、工具调用、执行时长和通知频率预算。Heartbeat 频率越高不代表越及时，如果大多数轮次都没有行动，只是在持续消耗模型配额。把“每次都检查”改成外部事件触发或更便宜的确定性探针，常常更可靠。

异常停机后的第一条原则是核对状态。先读取 Gateway session、task ledger、Automation run 和外部系统回执，列出已完成、未开始与结果未知的动作；再决定恢复或补偿。对发布、付款、发信等副作用设置业务幂等键，避免重启脚本把同一个意图再执行一次。

“能安全停下”还包括用户退出。关闭渠道、撤销平台 token、停止 Gateway 之外，还要处理模型凭证、浏览器 session、远程节点、Sandbox 卷、Automation、transcript、memory、备份和日志。提供一份资产清单，比一句卸载命令更接近真实的数据控制权。

## 二十四、一份上线前检查清单

在第一条真实消息进入前，可以按下面顺序做最后核对：

1. 为每个渠道确认账号、owner、pairing、allowlist 和群组策略，使用平台真实 sender ID，不用昵称猜测。
2. 为每条 binding 准备正例、近似反例和无匹配输入，确认 agentId、session key 与 lastRoute。
3. 检查每个 Agent 的 workspace、agentDir、模型凭证和 Skills 来源，没有复用不该共享的目录。
4. 用 `sandbox explain` 读取有效策略，分别验证文件、进程、网络、浏览器和 elevated，而不只看配置原文。
5. 对写操作设置审批、接收方 allowlist、幂等或状态查询；模拟超时，确认不会盲目重放。
6. 把固定计划放进 Automation，把环境感知留给 Heartbeat，空闲时应该静默。
7. 演练 steer、interrupt 和 Gateway 重启，核对已开始工具、跳过工具与合成结果的记录。
8. 备份数据库、workspace 和配置，密钥独立保管；在另一目录做一次恢复验证。
9. 设置日志脱敏、保留期、磁盘上限和告警，能从 channel event 追到 outbound receipt。
10. 写清观察模式、维护模式和完全退出步骤，并让它们不依赖 Agent 自己执行。

这份清单的目的不是让系统永远不出错，而是让错误停在已知边界内，并留下足够证据恢复。OpenClaw 提供了路由、session、Sandbox 与调度的机制，最终边界仍由部署者选择。默认配置适合起步，不会自动理解你的用户关系、数据等级和可接受风险。

模型选择也应进入检查。main session 可以使用擅长长任务的模型，Heartbeat 和格式固定的 Automation 可以使用成本更低的模型；涉及图像或复杂工具时再按能力切换。降级链要在固定任务上验证，不能假设所有提供商对工具协议、并行调用和长上下文有相同行为。备用模型若缺少必要能力，应明确失败并等待处理，而不是在权限不变的情况下用更弱判断继续执行高风险动作。

凭证同样按用途拆分。渠道 token 只供接入，模型 key 只供推理，代码托管和云平台使用最小权限的独立身份。不要把一份万能环境文件挂到所有 Agent 与 Sandbox。轮换密钥时，用渠道连接、模型调用、只读工具和写工具分别验证，避免只看到 Gateway 在线就误以为整条链已经恢复。

## 参考资料

- [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)
- [Gateway Architecture](https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md)
- [Gateway Protocol](https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md)
- [Agent Runtime](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent.md)
- [Agent Loop](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md)
- [Agent Bindings](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-bindings.md)
- [Main Session](https://github.com/openclaw/openclaw/blob/main/docs/concepts/main-session.md)
- [Multi-Agent](https://github.com/openclaw/openclaw/blob/main/docs/concepts/multi-agent.md)
- [Sandboxing](https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandboxing.md)
- [Security](https://github.com/openclaw/openclaw/blob/main/docs/gateway/security/index.md)
- [Automation](https://github.com/openclaw/openclaw/blob/main/docs/automation/index.md)
- [Heartbeat](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md)
