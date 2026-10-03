---
title: AGENTS.md：让 AI Coding Agent 真正能用一个仓库
description: AGENTS.md 是给 AI 看的项目指令，但写好它不是往里塞规则。本文从仓库聚合、环境统一、验证闭环、自动化检查和参考项目引入五个实践出发，分析怎样让 Agent 打开项目就能理解、改完代码就能验证。
category: Agent
subcategory: AI 应用与思考
articleClass: focused
seriesOrder: 35
featured: false
publishedAt: 2026-10-03T23:00:00+08:00
updatedAt: 2026-10-03
tags: [AGENTS.md, AI Coding, Coding Agent, Context Engineering, 验证闭环, 仓库聚合]
tools:
  - name: humanizer
    href: /toolbox/#humanizer
  - name: documd-visuals
    href: /toolbox/#documd-visuals
---

在仓库里放一份上下文文件，让 AI 工具打开项目时就知道它面对的是什么——这个做法现在有了通用的名字：AGENTS.md。格式上它只是一份 Markdown 文件，没有任何强制约束。真正影响 Agent 表现的，不是文件名，而是里面写了什么、以及仓库为它做了哪些配套。

本文从五个具体实践出发，讨论怎样让 Agent 在一个真实工程项目里真正有用——不是演示层面的"能生成代码"，而是"改完代码能自主验证"。案例背景是一个 Spring Boot + React 的全栈项目，但每个实践背后的逻辑可以迁移到任何技术栈。

这篇文章与站内的《[企业级 AI Coding 为什么还没发生质变：从工具提效到知识供给链](/posts/enterprise-ai-coding-knowledge-supply-chain/)》互补：知识供给链讲的是组织层面的知识体系建设，这里处理的是一个具体仓库怎样为 Agent 准备好可用的上下文。

## AGENTS.md 的前世今生

这个概念最早由 Anthropic 通过 Claude Code 的 CLAUDE.md 普及：Agent 运行时自动读取当前目录下的上下文文件，把内容注入到发给模型的请求中。效果很直接——维护好一份项目指令，Agent 的输出质量就会明显变好。随后各工具跟进了自己的版本，一度各自为政：Cursor 用 `.cursorrules`、Copilot 用 `.github/copilot-instructions.md`、OpenAI Codex 用 `AGENTS.md`（复数）。

碎片化意味着同一份规则要维护多个副本。2025 年 5 月，各工具逐步向 `AGENTS.md` 对齐，由 Linux Foundation 下属的 Agentic AI Foundation 托管格式规范。Cursor、Kiro、灵码等主流工具均已支持；Claude Code 仍用 CLAUDE.md，但一个软链接即可兼容：`ln -s AGENTS.md CLAUDE.md`。

## 核心原则：地图，不是手册

AGENTS.md 最容易犯的错误是写得太多。每次遇到 AI 犯了错，就往里补一条规则，几轮下来文件涨到两三千行。规则越密，模型的注意力就越分散，真正关键的约束反而被淹没。

OpenAI 在 Harness Engineering 实践里把这个原则叫做"Map, not Manual"：AGENTS.md 应该是约 200 行的导航地图，告诉 Agent 去哪里找什么，详细内容放在链接指向的文档里。Anthropic 的官方说明里也有同样的表述：入口保持短小，事实靠版本化工件承载，详细内容按需展开。

判断一条信息该写进 AGENTS.md 还是放到 `docs/` 下有一个简单的测试：**AI 不知道这条信息就会写出错误的代码** → 写进 AGENTS.md；**只是写得不够好** → 放详细文档，AGENTS.md 里放链接。

![AGENTS.md 的结构：地图而非手册](/images/posts/agents-md-map-not-manual.svg)

直接写进 AGENTS.md 的只有两类：理解项目全貌的必要信息（技术栈、仓库结构、核心模块、分层架构）和违反会直接导致问题的硬性规则（禁止跨层依赖、统一异常处理方式、禁止手动构造响应体）。其余细节通过链接引向 `docs/architecture.md`、`docs/design-docs/*.md`、参考项目源码。这样的 AGENTS.md 是一张有效的地图，而不是一本没人读完的手册。

## 五个让 Agent 工作闭环的实践

理解了地图原则之后，真正决定 Agent 产出质量的是仓库本身的工程化程度：Agent 能不能看到足够的上下文、能不能启动项目、能不能自主验证它改的代码是否正确。下面五个实践分别补上 Agent 工作闭环里的一个断点。

![补全 AI 的工作闭环](/images/posts/agents-md-five-practices.svg)

### 实践一：仓库聚合——解决上下文割裂

前后端分属不同 Git 仓库是最常见的上下文割裂来源。AI 工具在同一个会话里只能看到一个仓库，改一个涉及前后端联动的功能——比如后端新增接口、前端同步调用——需要在两个窗口之间来回切换。切换时 Agent 丢失上下文，你需要重新描述背景。

解决方式有两种。**脚本聚合**：用一个 `setup-repos.sh` 脚本把前端仓库克隆到后端项目的子目录下，`frontend/` 加入 `.gitignore`，不影响后端 CI/CD，不使用 AI 工具时完全无感。**Monorepo**：直接把前后端代码放进同一个仓库，是新项目或有重构机会时的更简洁方案。

```
# 脚本聚合的目录结构
project-root/         # 后端（主仓库）
  frontend/
    component-lib/    # 前端组件库（独立 Git 历史，gitignore 中）
    web-app/          # 前端主应用（同上）
  AGENTS.md
```

仓库聚合之后，还可以把用户手册也纳进来。Agent 在修改功能代码时能顺手把对应的用户文档也更新掉，不需要单独维护文档。两件事在同一个上下文里完成，是文档总比代码滞后这个问题的直接解法。

### 实践二：统一环境配置——让 Agent 能启动项目

Agent 改完代码之后，如果它不知道怎么构建、怎么启动、怎么健康检查，工作闭环就在这里断开：它只能把代码写完就停下来，等人手动跑一遍。

环境配置统一有两个要求。第一，**本地环境变量有固定的存放位置**。统一放在 `~/.<project>_env`（纯 `KEY=VALUE` 格式），启动脚本自动 `source`。放在家目录下而不是项目目录，是为了避免意外提交到 Git。AGENTS.md 里明确写出"先查 `~/.<project>_env`，不存在时回退到 `application.yml` 的缺省值"，Agent 就知道去哪里找配置，不需要猜。

第二，**启动操作封装成一条命令**。脚本内部可以很复杂——JDK 版本检测、优雅关闭旧进程、等待健康检查端口——但对外暴露的接口只有一条：

```bash
./scripts/start-server.sh              # 构建 + 启动 + 等待健康检查
./scripts/start-server.sh --quick      # 服务已健康则秒返回
./scripts/start-server.sh --skip-build # 跳过构建直接重启
```

Agent 不需要理解这些细节，只需要知道调哪条命令。这是 AGENTS.md 里"快速命令"章节的核心价值：把复杂的环境操作收敛成可以机械执行的指令。

### 实践三：验证闭环——改完代码不算完

"代码写完了"和"功能跑通了"是两件事。前者是 Agent 很容易完成的，后者才是真正有用的交付。建立验证闭环的目的是让 Agent 能自主走完"改 → 构建 → 启动 → 验证"这条链，而不需要人在每一步之间手动接力。

后端验证主要靠 bash + curl。AGENTS.md 里维护一套 curl 验证规范，核心原则是：**每个 curl 独立执行，用临时文件传递数据**：

```bash
# Step 1: 登录，结果写文件
curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' > /tmp/login.json

# Step 2: 提取 token（独立命令）
python3 -c "import json; print(json.load(open('/tmp/login.json'))['data']['token'])" \
  > /tmp/token.txt

# Step 3: 业务接口调用
TOKEN=$(cat /tmp/token.txt)
curl -s -X POST http://localhost:8080/api/items/list \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"page":0,"size":10}' > /tmp/result.json
```

用临时文件中转看起来多了一步，但稳定性明显更高。Agent 在 shell 里执行命令时容易遇到 shell 兼容性问题——zsh 下管道加方括号的 glob 展开、不同版本的 `grep -P`——临时文件把数据生产和数据消费拆成了两条独立命令，消除了大多数兼容性地雷。

前端验证光靠 curl 是不够的：接口返回正确不代表页面渲染正确、交互正确、布局没有问题。遇到前端问题时可以使用 Agent Browser 能力，让 Agent 打开浏览器、操作页面、截屏，获取真实的视觉上下文来定位问题，而不是靠猜测 CSS 原因。

验证闭环的价值在夜间自主执行的场景下最明显：睡前把任务设计好，让 Agent 自主跑完，第二天早上看结果。没有验证闭环的话，Agent 在改完代码后不知道下一步做什么，自主执行就成了空话。

### 实践四：自动化检查——规则要有执行力

AGENTS.md 里写"禁止跨层依赖"，如果没有配套的检查脚本，AI 和人都会违反这条规则。规则有多少执行力，取决于违反时能不能被自动发现。

分层架构检查可以用一个 shell 脚本扫描所有 Java 文件的 import 语句，按包路径判断所属层级，检查是否违反了依赖方向。关键是错误信息的格式：不只输出"哪里出问题了"，还要输出"为什么不允许"和"怎么修"：

```
✗ service/client/impl/SomeService.java 导入了 entity.SomeEntity
  原因: 客户端实现禁止直接依赖业务 Entity，须通过 DTO 传递数据
  修复: 在编排层完成 Entity→DTO 转换，客户端只接收 DTO
```

这个格式不只是给人看的，更是给 Agent 看的。Agent 读到这条错误之后，能按照"修复"那行的指引直接处理，不需要额外的上下文。错误信息的质量直接决定 Agent 能否自主完成"改 → 检 → 修"循环，不需要人介入。

把这些检查收进 Makefile 统一管理：`make lint-arch`、`make lint-format`、`make build`、`make test`。Agent 不需要记住每个脚本的路径和参数，只需要知道这几条 make target。在 AGENTS.md 里写清楚"改完代码后先跑 `make lint-arch`，再跑 `make build`"，Agent 就有了明确的验证路径。

规则的优先级可以用一句话表达：**能自动化检查的 > 写在 AGENTS.md 中的 > 口头约定的**。第一类违反会被立刻发现；第二类 Agent 会尽力遵守，但没有强制保障；第三类对 Agent 而言等于不存在。

### 实践五：参考项目引入——给 Agent 喂够上下文

AI 工具的训练数据里没有你们的私域组件库、没有内部的 Go 微服务实现、没有那个对接了四个内部系统的 Spring 模块的架构细节。靠写文档来补全这些上下文，文档总会滞后于实现，而且很难覆盖所有边界情况。

更直接的方案是把源码放进来。在项目里创建 `reference-projects/` 目录，通过 git submodule 引入需要参考的项目：

```bash
# .gitmodules 配置示例
[submodule "reference-projects/pro-components"]
  path = reference-projects/pro-components
  url = git@内部代码托管/pro-components.git
  ignore = all   # 不让 CI/CD 追踪子模块状态

# 本地开发时按需拉取
git submodule update --init reference-projects/pro-components
```

`ignore = all` 是关键配置：它让 CI/CD 完全忽略子模块，不影响构建流水线，同时又能让本地开发环境按需拉取源码。

源码永远不会过时。Agent 遇到不会写的私域组件时，可以直接读源码里的 TypeScript 类型定义和使用示例；需要对接内部网关时，可以直接查看路由插件的实际实现。这比查一份三个月前写的文档，准确得多。

为每个参考项目维护一份架构说明文档（`docs/design-docs/ref-*.md`）作为"地图"——介绍这个参考项目的目录结构、核心模块在哪、什么时候应该来查它。ref 文档帮 Agent 快速定位，源码提供真实细节。这两者是配套的：光有 ref 文档容易不够准确，光有源码 Agent 每次都要从零探索。

关于担心"加了这么多仓库 Agent 会不会迷失"：不会。通过 AGENTS.md 的渐进式披露设计——每个目录标注了用途，ref 文档提供了架构概览，AGENTS.md 里写明了什么时候该去参考什么项目——模型有足够的导航信息知道该往哪里查，不会在大量源码里绕圈。

## 把这些实践放进 AGENTS.md

五个实践都到位之后，AGENTS.md 本身就有了清晰的结构：

```markdown
## 1. 项目概述
技术栈、仓库结构（前后端同仓）、核心模块一句话说明

## 2. 快速命令
./scripts/start-server.sh  # 构建 + 启动 + 健康检查
make lint-arch             # 分层依赖检查
make build                 # 构建
~/.<project>_env           # 本地环境变量（启动脚本自动 source）

## 3. 后端架构
包结构树 + 每个包的用途注释
分层规则（entity/repository/service/controller，禁止跨层）
→ 详见 docs/architecture.md

## 4. 前端架构
技术栈、组件库说明
→ 详见 docs/design-docs/frontend-architecture.md

## 5. 关键约定（5-10 条，违反即出错）
- 异常统一通过 BusinessException 抛出
- 响应体由框架统一包装，禁止手动构造
- 分层架构禁止跨层依赖（make lint-arch 自动检查）
→ 每条附详细文档链接

## 6. 本地开发与验证流程
改 → 构建 → 启动 → curl 验证的完整路径
curl 验证模板（见 docs/design-docs/api-verification.md）

## 7. 参考项目
reference-projects/ 下各项目的用途和什么时候该去查

## 8. 文档导航
所有详细文档的索引表
```

控制在 200 行以内。细节进 `docs/`，AGENTS.md 里只放链接。

## 从 Bad Case 驱动迭代

AGENTS.md 不是一次写完就锁定的文档。最有效的迭代方式是 bad case 驱动：AI 犯了一个错误，判断"如果 AGENTS.md 里多一条 XX 规则，它是不是不会犯"，再判断这条规则属于全局约定（→ AGENTS.md）还是模块细节（→ `docs/` 里对应文档）。

团队多人使用时，鼓励每个人遇到 bad case 都来补规则，但要守住"地图原则"：全局架构约定进 AGENTS.md，某个 Service 的调用细节进它对应的 `docs/` 文档，私域组件的 prop 用法进 `ref-*.md`。如果什么都往 AGENTS.md 塞，上下文膨胀，重要规则反而被淹没。

一个有意思的副作用：为 AI 维护 AGENTS.md 的过程本身就是在做知识梳理。过去散落在 Wiki 页面、聊天记录、口头约定里的"潜规则"，被迫整理成了结构化的文档。初衷是给 AI 看的，结果新加入的工程师也受益了。

## 参考资料

- [AGENTS.md 格式规范（Agentic AI Foundation）](https://agents.md)
- [Anthropic：Claude Code 项目上下文文件指南](https://docs.anthropic.com/en/docs/claude-code/memory)
- [OpenAI：Harness Engineering（含 AGENTS.md 实践）](https://openai.com/index/harness-engineering/)
- [Anthropic：Context Engineering for Agents](https://www.anthropic.com/engineering/context-engineering)
