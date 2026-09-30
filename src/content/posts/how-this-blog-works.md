---
title: 这个博客是如何工作的
description: 用 Astro、GitHub 和 Cloudflare Pages 搭建一个无需维护服务器的个人博客。
category: 项目
featured: true
publishedAt: 2026-09-28
tags: [Astro, Cloudflare]
---

这个博客由 Astro 构建，文章使用 Markdown 保存。

## 发布流程

1. 在 `src/content/posts` 中新增文章。
2. 将修改提交到 GitHub。
3. Cloudflare Pages 自动构建并发布。

访问者看到的是提前生成好的 HTML 页面，因此打开速度快，也不需要单独维护数据库。

## 成本

托管、HTTPS 和基础 CDN 都可以使用免费套餐。绑定独立域名后，主要的长期成本就是域名续费。
