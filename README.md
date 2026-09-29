# King of Water Blog

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
