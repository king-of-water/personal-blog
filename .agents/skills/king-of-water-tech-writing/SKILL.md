---
name: king-of-water-tech-writing
description: Research, write, expand, or review long-form Chinese technical articles for the king-of-water Astro blog. Use for substantial posts in Agent, AI Coding, RAG, backend engineering, or project analysis; not for short status updates or minor typo fixes.
---

# king-of-water technical writing

Produce an article that can teach an engineer how the system works, where it fails, and how to verify it. Use `src/content/posts/agent-harness-engineering.md` as the local quality reference. Match its depth and evidence discipline without copying its outline or phrases.

## Start with a research question

Turn the topic into one question the article must answer. A product name alone is not a question. Examples:

- Pi: what is the smallest useful Agent Harness, and which responsibilities remain outside it?
- Jev: when can a typed decision model replace a generative call inside an Agent?
- Self-evolution: what state changes across tasks, and who decides that the change is an improvement?

Define the neighboring concepts that readers are likely to confuse. State the article's evidence boundary early: source code, official docs, papers, reproduced experiments, or informed inference.

## Research before drafting

For current or emerging technology, browse and prefer primary sources. Use official repositories and documentation for implementation claims, and original papers for research claims. Record exact links in the article near the relevant claim and again in a short reference section when useful.

Do not inflate a vendor statement into an independent fact. Label paper results as results from that experiment, preserve dataset and baseline context, and include negative findings or limitations. Do not infer unpublished internals from a product UI.

Read the relevant existing blog posts so the new article adds a new layer instead of re-explaining material already covered.

## Choose the article class by scope

Length follows how much of the system the article has to explain, not the category alone. The numbers describe how much the topic deserves, not quotas to reach. A draft that only clears the floor is usually under-developed: add mechanisms, worked examples, failure modes, comparisons, and sources until the topic is genuinely covered. Never add filler to hit a number, and never lower the class just to make an AI topic easier to finish.

- **Flagship (12,000 to 20,000+):** the article explains a whole architecture, ecosystem, technology map, cross-cutting method, or a single technique that still needs its context, mechanism, failure modes, and an end-to-end example. Everything in the AI sections defaults here: an Agent harness, a RAG technology map, a coding-agent source walkthrough, RAG/FastCode/Repo Map/LLM Wiki, a new control layer.
- **Focused (6,000 to 12,000):** a deliberately narrow topic outside the AI core, such as one backend subsystem or one engineering workflow. A broad topic narrowed to a single question can belong here.
- **Field note (2,000 to 6,000):** one specific question, one bug, or one narrow behavior, such as a single Redis eviction problem or one configuration trap.

Defaults by section:

- Agent 开发 / RAG 与知识库 / AI Coding / Agent 前沿 / Agent 算法: flagship. AI and knowledge-base topics are expected to be substantial, even when the title names one technique, because the technique still needs its context, mechanism, failure modes, and a worked example.
- 后端 (Java, Redis, MySQL, 消息队列, 分布式): focused for a subsystem; field-note for a single issue or one reproduction.
- 项目: focused for a build log; field-note for a short announcement or note.

Declare the intended class in frontmatter with `articleClass: flagship | focused | field-note`. When an article does not declare one, the audit infers it from the section. The site counts each Han character and each Latin token as one word. Treat the class minimum as a floor and the middle-to-upper end of the range as the real target when the topic supports it; if the material genuinely cannot support the range, narrow the title instead of padding.

## Build the article around five jobs

The outline may vary, but a flagship article must perform all five jobs:

1. Establish the problem and conceptual boundary.
2. Explain the mechanism from a minimal model to the real architecture.
3. Walk through one concrete task, request, failure, or code path end to end.
4. Analyze failure modes, trade-offs, alternatives, and where the idea does not apply.
5. Show how to implement, observe, evaluate, or verify the mechanism.

Include a short conclusion near the beginning only when it gives the reader a usable map. Do not write a summary that substitutes for the article.

For detailed structure, evidence, visual, and prose requirements, read [references/article-standard.md](references/article-standard.md).

## Use artifacts as evidence

Code blocks, tables, state diagrams, and architecture figures must answer a specific question. Prefer executable or source-shaped examples over decorative pseudo-code. Every large diagram needs surrounding prose that tells the reader how to read it and what decision it supports.

For flagship articles, normally include:

- two to four purposeful diagrams;
- implementation or protocol examples at the points where prose becomes ambiguous;
- comparison tables only for repeated fields or real trade-offs;
- one end-to-end walkthrough;
- one failure-mode or counterargument section.

These are defaults, not quotas. A source-code analysis may need more code and fewer diagrams; an algorithm comparison may need the reverse.

## Write in the blog's voice

Write in clear Chinese for an engineer who knows basic software development. Use English technical terms where translation would be less precise. Explain the term on first use.

Prefer specific claims and concrete failure cases. Keep first-person judgment when it is genuinely the author's judgment. Avoid staged openings, slogan-like closers, repetitive “不是 X，而是 Y”, forced triads, marketing language, and decorative bold labels. Do not make every section the same length.

Use the `humanizer` skill for the final prose pass without changing code, data, links, frontmatter, or supported claims.

## Integrate with this repository

Follow the existing content schema. Use a valid category and subcategory, add `tools` only for tools actually used, and place article images under `public/images/posts/`.

Use the `documd-visuals` skill when a relationship, sequence, or comparison materially benefits from a figure. Match the blog's established editorial palette and SVG style. Give every SVG a `<title>` and `<desc>`.

Before committing:

1. Run `node .agents/skills/king-of-water-tech-writing/scripts/audit-article.mjs <article.md> --class=auto`. Use an explicit `--class=flagship|focused|field-note` only when overriding the declared or inferred class.
2. Review every warning. Do not pad the article merely to silence a length warning.
3. Run `xmllint --noout` for new SVG files.
4. Run `npm run build` and `git diff --check`.
5. Open the rendered article and verify the hero, both sidebars, headings, code overflow, tables, and images.

Report the article's approximate site-counted length and verification results in the handoff.
