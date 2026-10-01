#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

// Length follows scope, not category. AI and system-level topics are expected to
// be substantial; a narrow single-issue note is not padded to flagship length.
const WIDTHS = {
  flagship: { min: 12000, target: 15000, minH2: 6, minImages: 2, minCode: 2, minLinks: 3, label: '旗舰长文' },
  focused: { min: 6000, target: 8000, minH2: 4, minImages: 1, minCode: 1, minLinks: 2, label: '专题深潜' },
  'field-note': { min: 2000, target: 3500, minH2: 2, minImages: 0, minCode: 0, minLinks: 0, label: '问题笔记' },
};

const file = process.argv[2];
if (!file) {
  console.error('Usage: node audit-article.mjs <article.md> [--class=flagship|focused|field-note|auto] [--min=N]');
  process.exit(2);
}

const args = process.argv.slice(3);
const explicitClass = args.find((arg) => arg.startsWith('--class='))?.slice('--class='.length);
const explicitMinArg = args.find((arg) => arg.startsWith('--min='))?.slice('--min='.length);
const explicitMin = explicitMinArg === undefined ? undefined : Number(explicitMinArg);
if (explicitMin !== undefined && !Number.isFinite(explicitMin)) {
  console.error(`Invalid --min value: ${explicitMinArg}`);
  process.exit(2);
}

const source = fs.readFileSync(file, 'utf8');
const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? '';
const declaredClass = frontmatter.match(/^articleClass:\s*(\S+)/m)?.[1];
// Precedence: explicit --class, then the article's own declaration, then a
// neutral focused default. The class is a scope judgement, so articles should
// declare it rather than inherit one from their category.
function inferClass() {
  if (declaredClass && WIDTHS[declaredClass]) return declaredClass;
  return 'focused';
}

const requestedClass = explicitClass && explicitClass !== 'auto' ? explicitClass : inferClass();
const width = WIDTHS[requestedClass];
if (!width) {
  console.error(`Unknown article class: ${requestedClass}`);
  process.exit(2);
}

const classSource = explicitClass && explicitClass !== 'auto'
  ? 'flag'
  : declaredClass && WIDTHS[declaredClass]
    ? 'frontmatter'
    : 'inferred';
const minimumWords = explicitMin ?? width.min;

const body = source.replace(/^---[\s\S]*?---\s*/, '');
const prose = body
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[`#>*_|~]/g, ' ');

const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
const latin = prose
  .replace(/\p{Script=Han}/gu, ' ')
  .match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
const words = han + latin;
const h2 = (body.match(/^## /gm) ?? []).length;
const h3 = (body.match(/^### /gm) ?? []).length;
const images = (body.match(/^!\[[^\]]*\]\([^)]+\)/gm) ?? []).length;
const fences = Math.floor((body.match(/^```/gm) ?? []).length / 2);
const links = (body.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g) ?? []).length;
const tableSeparators = (body.match(/^\|(?:\s*:?-+:?\s*\|)+\s*$/gm) ?? []).length;

const result = {
  file: path.relative(process.cwd(), file),
  articleClass: requestedClass,
  classLabel: width.label,
  classSource,
  minimumWords,
  targetWords: width.target,
  siteCountedWords: words,
  estimatedMinutes: Math.max(1, Math.ceil(words / 500)),
  h2,
  h3,
  images,
  codeBlocks: fences,
  tables: tableSeparators,
  externalLinks: links,
};

console.log(JSON.stringify(result, null, 2));

const warnings = [];
if (words < minimumWords) {
  warnings.push(`Below ${width.label} minimum (${minimumWords.toLocaleString('en-US')} site-counted words).`);
}
if (h2 < width.minH2) warnings.push(`Fewer than ${width.minH2} H2 sections for a ${width.label}.`);
if (images < width.minImages) warnings.push(`Expect at least ${width.minImages} figure(s) for a ${width.label}.`);
if (fences < width.minCode) warnings.push(`Expect at least ${width.minCode} code/example block(s) for a ${width.label}.`);

for (const warning of warnings) console.warn(`WARN: ${warning}`);
// Links are a hint, not a hard requirement: conceptual pieces may cite nothing
// external, while research notes should prefer primary sources.
if (links < width.minLinks) {
  console.warn(`NOTE: ${links} external link(s); ${width.minLinks}+ expected when the article makes external implementation or research claims.`);
}
if (words >= minimumWords && words < width.target) {
  console.warn(`NOTE: ${words.toLocaleString('en-US')} words clears the floor but is below the ${width.target.toLocaleString('en-US')} target for a ${width.label}. Deepen the topic instead of stopping at the minimum.`);
}
process.exitCode = warnings.length ? 1 : 0;
