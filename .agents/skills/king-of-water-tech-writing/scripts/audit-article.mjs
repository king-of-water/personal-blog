#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node audit-article.mjs <article.md> [--class=flagship|focused|field-note]');
  process.exit(2);
}

const articleClass = process.argv
  .slice(3)
  .find((arg) => arg.startsWith('--class='))
  ?.slice('--class='.length) ?? 'flagship';
const minimumWords = { flagship: 12000, focused: 8000, 'field-note': 3000 }[articleClass];
if (!minimumWords) {
  console.error(`Unknown article class: ${articleClass}`);
  process.exit(2);
}

const source = fs.readFileSync(file, 'utf8');
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
  articleClass,
  minimumWords,
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
if (words < minimumWords) warnings.push(`Below ${articleClass} minimum (${minimumWords.toLocaleString('en-US')} site-counted words).`);
if (h2 < 6) warnings.push('Fewer than 6 H2 sections; confirm the topic is intentionally narrow.');
if (images < 1) warnings.push('No article image found.');
if (fences < 2) warnings.push('Fewer than 2 code/protocol/example blocks.');
if (links < 3) warnings.push('Fewer than 3 external primary-source links.');

for (const warning of warnings) console.warn(`WARN: ${warning}`);
process.exitCode = warnings.length ? 1 : 0;
