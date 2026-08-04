#!/usr/bin/env node
/**
 * Course maintenance script.
 *
 * Keeps documentation and chapter structure in sync. It is designed to be run
 * by a cron job as well as manually. It will:
 *
 * 1. Scan chapters/ for actual chapter directories.
 * 2. Extract chapter titles from each README.md.
 * 3. Ensure docs/TOC.md has every chapter and a status table.
 * 4. Ensure README.md has a TOC table matching the chapters.
 * 5. Run `npm run verify`.
 * 6. Report what changed and whether verification passed.
 *
 * The script is intentionally conservative: it fixes structural sync
 * (TOC/README) but does not auto-edit chapter prose or source code. Any
 * deeper mismatches it cannot fix are printed as warnings.
 */

import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';

interface Chapter {
  number: number;
  slug: string;
  title: string;
  dir: string;
}

const ROOT = process.env.COURSE_ROOT ?? process.cwd();
const CHAPTERS_DIR = join(ROOT, 'chapters');
const DOCS_TOC_PATH = join(ROOT, 'docs', 'TOC.md');
const README_PATH = join(ROOT, 'README.md');

async function discoverChapters(): Promise<Chapter[]> {
  const entries = await fs.readdir(CHAPTERS_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const chapters: Chapter[] = [];
  for (const dir of dirs) {
    const match = dir.match(/^(\d+)-(.+)$/);
    if (!match) continue;

    const number = parseInt(match[1], 10);
    const slug = match[2];
    const readmePath = join(CHAPTERS_DIR, dir, 'README.md');
    let title = slug.replace(/-/g, ' ');

    try {
      const content = await fs.readFile(readmePath, 'utf-8');
      const headingMatch = content.match(/^#\s+Chapter\s+\d+:\s+(.+)$/m);
      if (headingMatch) {
        title = headingMatch[1].trim();
      }
    } catch {
      // Leave title as slug fallback.
    }

    chapters.push({ number, slug, title, dir });
  }

  return chapters.sort((a, b) => a.number - b.number);
}

function formatDocsToc(chapters: Chapter[]): string {
  // Keep the existing part grouping. New chapters are appended to Part 4.
  const part1 = chapters.filter((c) => c.number >= 1 && c.number <= 6);
  const part2 = chapters.filter((c) => c.number >= 7 && c.number <= 13);
  const part3 = chapters.filter((c) => c.number >= 14 && c.number <= 20);
  const part4 = chapters.filter((c) => c.number >= 21);

  const tocLink = (c: Chapter) =>
    `- [${String(c.number).padStart(2, '0')} - ${c.title}](../chapters/${c.dir}/)`;

  const statusRow = (c: Chapter) =>
    `| ${String(c.number).padStart(2, '0')} | published |`;

  return `# Table of Contents

- [Course overview](../README.md)
- [System architecture](ARCHITECTURE.md)

## Part 1 — Foundations

${part1.map(tocLink).join('\n')}

## Part 2 — Loop Engineering

${part2.map(tocLink).join('\n')}

## Part 3 — Production Cell

${part3.map(tocLink).join('\n')}

## Part 4 — Surface and Deployment

${part4.map(tocLink).join('\n')}

## Status

| Chapter | Status |
|---------|--------|
${chapters.map(statusRow).join('\n')}
`;
}

function formatReadmeToc(chapters: Chapter[]): string {
  const rows = chapters.map(
    (c) =>
      `| ${String(c.number).padStart(2, '0')} | ${c.title} |`
  );

  return `## Course layout

| Chapter | Topic |
|--------|-------|
${rows.join('\n')}
`;
}

async function updateDocsToc(chapters: Chapter[]): Promise<boolean> {
  const desired = formatDocsToc(chapters);
  let current = '';
  try {
    current = await fs.readFile(DOCS_TOC_PATH, 'utf-8');
  } catch {
    // File does not exist; will be created.
  }

  if (current === desired) return false;
  await fs.writeFile(DOCS_TOC_PATH, desired, 'utf-8');
  return true;
}

async function updateReadmeToc(chapters: Chapter[]): Promise<boolean> {
  let current = '';
  try {
    current = await fs.readFile(README_PATH, 'utf-8');
  } catch {
    throw new Error(`README.md not found at ${README_PATH}`);
  }

  const desiredToc = formatReadmeToc(chapters);
  const tocRegex = /## Course layout\s*\n\n\| Chapter \| Topic \|\s*\n\|[-]+\|[-]+\|\s*\n(?:\|\s*\d+\s*\|[^\n]+\|\s*\n)*/;

  let updated: string;
  if (tocRegex.test(current)) {
    updated = current.replace(tocRegex, desiredToc.trim());
  } else {
    // Append TOC before Quick start if present.
    const quickStartIndex = current.indexOf('## Quick start');
    if (quickStartIndex >= 0) {
      updated =
        current.slice(0, quickStartIndex) +
        desiredToc.trim() +
        '\n\n' +
        current.slice(quickStartIndex);
    } else {
      updated = current + '\n\n' + desiredToc.trim();
    }
  }

  if (updated === current) return false;
  await fs.writeFile(README_PATH, updated, 'utf-8');
  return true;
}

async function runVerify(): Promise<{ ok: boolean; output: string }> {
  try {
    const output = execSync('npm run verify', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
    });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stdout ?? err.message ?? 'verify failed' };
  }
}

async function main(): Promise<void> {
  const chapters = await discoverChapters();
  if (chapters.length === 0) {
    console.error(`No chapters found in ${CHAPTERS_DIR}`);
    process.exit(1);
  }

  console.log(`Discovered ${chapters.length} chapters (max ${chapters[chapters.length - 1].number}).`);

  const docsTocChanged = await updateDocsToc(chapters);
  const readmeChanged = await updateReadmeToc(chapters);

  if (docsTocChanged) console.log('✅ Updated docs/TOC.md');
  else console.log('ℹ️  docs/TOC.md already in sync');

  if (readmeChanged) console.log('✅ Updated README.md TOC');
  else console.log('ℹ️  README.md TOC already in sync');

  const { ok, output } = await runVerify();
  const tail = output.split('\n').slice(-15).join('\n');
  console.log('\n--- verify output ---');
  console.log(tail);

  if (!ok) {
    console.error('\n❌ Verification failed. Fix before committing.');
    process.exit(1);
  }

  console.log('\n✅ Course sync complete and verification passed.');
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
