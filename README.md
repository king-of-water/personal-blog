# king-of-water Blog

个人博客，使用 Astro 构建，面向 Cloudflare Pages 静态部署。

## 本地开发

```sh
npm install
npm run dev
```

## 新增文章

在 `src/content/posts` 中新建 Markdown 文件，并填写标题、描述、发布日期和标签。

```md
---
title: 文章标题
description: 一句话摘要
publishedAt: 2026-09-29
tags: [Astro, 博客]
---

文章正文。
```

## 生产构建

```sh
npm run build
```

Cloudflare Pages 配置：

- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: `22`

## 浏览量统计

首页副标题下展示总浏览量，通过 `/api/site-stats` 从现有 Cloudflare D1 `DB` 绑定读取。总数包含 `post_stats` 中已有文章浏览数，以及上线此功能后的首页、栏目、归档等页面访问。非文章访问使用保留行 `@site-pages` 原子累加，不需要数据库迁移，文章仍由原接口计数，避免重复累计。

计数沿用文章页的浏览器本地去重方式：同一浏览器、同一页面每天（UTC 日期）计一次；不是独立访客数或严格 PV。清理浏览器存储、并发标签或直接调用接口仍可能重复计数，不作为业务分析或防刷依据。禁用存储时非文章页只查询，不增加计数。历史未记录的非文章访问无法补回。

纯 Astro 开发服务不运行 Pages Functions，未接入 D1 时显示“暂不可用”，不伪造数字。接口与客户端测试（Node 22.13+）：`node --test scripts/tests/site-stats*.test.mjs`。
