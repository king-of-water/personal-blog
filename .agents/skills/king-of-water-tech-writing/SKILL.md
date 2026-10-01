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

## Choose the article class by scope, not by category

Pick the class by asking how much the topic must cover to be explained well. The category does not decide it: a narrow AI behavior can be a field note, and a whole backend protocol design can be flagship. The question is whether the length is proportionate to what the topic actually needs.

- **Flagship (12,000 to 20,000+, aim 15,000+):** a system, architecture, technology map, methodology, or a technique that must be explained together with its ecosystem. Doing it justice needs several components or concepts, their relationships, failure modes, and an end-to-end example.
- **Focused (6,000 to 12,000, aim 8,000+):** one component, module, subsystem, or single mechanism, explained on its own with its own context and one worked example.
- **Field note (2,000 to 6,000, aim 3,500+):** one specific question, one bug, or one narrow behavior with a single cause, fix, or observation.

A practical test is to count what the article must contain:

- whole system + neighboring ideas + failure modes + end-to-end example → flagship
- one mechanism + one example → focused
- one question + one answer → field note

The floor is a floor; treat the middle-to-upper part of the range as the target. A draft that only clears the floor is usually under-developed: add mechanisms, examples, failure modes, comparisons, and sources until the topic is genuinely covered. Never add filler to hit a number, and never lower the class to finish sooner.

Examples by scope, across categories:

- System / map / methodology → flagship: Agent Harness, RAG 技术地图, Codex 源码拆解, FastCode, Repo Map, LLM Wiki, SDD; a backend 「分布式一致性全景」 would also be flagship.
- One subsystem / module → focused: a RAG reranking module, a Redis cluster design, MySQL index internals.
- One question / bug → field note: why a specific Redis key is evicted on read, why one configuration does not take effect.

Declare the class in frontmatter with `articleClass: flagship | focused | field-note`. When it is missing, the audit defaults to `focused` and notes that the class was not declared. The site counts each Han character and each Latin token as one word.

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
