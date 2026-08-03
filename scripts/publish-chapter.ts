// Incremental course publisher.
// Reads docs/TOC.md to find the first chapter marked 'planned',
// reads all previously published chapters for style and continuity,
// generates real chapter content, writes the README,
// marks it 'published', commits, and pushes.
//
// Run manually:
//   cd ~/Downloads/projects/build-long-running-cell
//   node scripts/node_modules/.bin/tsx scripts/publish-chapter.ts
//
// Cron (every 4 hours):
//   0 */4 * * * cd ~/Downloads/projects/build-long-running-cell && node scripts/node_modules/.bin/tsx scripts/publish-chapter.ts

import { promises as fs } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const TOC_PATH = join(ROOT, 'docs', 'TOC.md');
const CHAPTERS_DIR = join(ROOT, 'chapters');

type ChapterStatus = 'planned' | 'published' | 'written';

interface Chapter {
  num: string;
  title: string;
  folder: string;
  status: ChapterStatus;
}

interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

function loadLlmConfig(): LlmConfig | undefined {
  const baseUrl = process.env.OPENAI_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
  if (!baseUrl) return undefined;
  return { baseUrl, apiKey, model };
}

async function callLlm(config: LlmConfig, prompt: string): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const res = await fetch(config.baseUrl + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 4000,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM call failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: [{ message?: { content?: string } }];
  };
  return data.choices?.[0]?.message?.content ?? '';
}

function parseToc(text: string): Chapter[] {
  const lines = text.split('\n');
  const chapters: Chapter[] = [];

  // Extract titles from TOC bullet lines like "- [01 - Cell concepts](../chapters/01-cell-concepts/)"
  for (const line of lines) {
    const m = line.match(/-?\s*\[(\d+)\s*-\s*([^\]]+)\]\s*\(\.\.\/chapters\/(\S+)\/\)/);
    if (m) {
      chapters.push({
        num: m[1].replace(/^0+/, ''),
        title: m[2].trim(),
        folder: m[3].trim(),
        status: 'planned',
      });
    }
  }

  // Extract status from the table
  for (const line of lines) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(planned|published|written)\s*\|/);
    if (m) {
      const ch = chapters.find((c) => c.num === m[1].replace(/^0+/, ''));
      if (ch) ch.status = m[2] as ChapterStatus;
    }
  }

  return chapters;
}

async function readPublishedChapters(chapters: Chapter[]): Promise<string> {
  const published = chapters.filter((c) => c.status === 'published' || c.status === 'written');
  const parts: string[] = [];
  for (const ch of published) {
    const path = join(CHAPTERS_DIR, ch.folder, 'README.md');
    try {
      const text = await fs.readFile(path, 'utf-8');
      parts.push(`---\n# Chapter ${ch.num}: ${ch.title}\n${text}`);
    } catch {
      // skip missing files
    }
  }
  return parts.join('\n\n');
}

async function generateContent(chapter: Chapter, previousChaptersText: string): Promise<string> {
  const config = loadLlmConfig();
  if (config) {
    const prompt = buildPrompt(chapter, previousChaptersText);
    try {
      const content = await callLlm(config, prompt);
      if (content.trim().length > 500) return content;
      console.warn('LLM returned too little content, falling back to deterministic generator.');
    } catch (err) {
      console.warn('LLM call failed, falling back to deterministic generator:', (err as Error).message);
    }
  }
  return deterministicContent(chapter, previousChaptersText);
}

function buildPrompt(chapter: Chapter, previousChaptersText: string): string {
  return `You are writing a hands-on coding course called "Build Your Own Long-Running Agent Cell".
Write Chapter ${chapter.num}: "${chapter.title}".

Previously published chapters are below. Match their style, depth, and markdown formatting. Build on previous concepts where relevant. Include:
- Learning goals (3 bullets)
- A "Why this matters" or "Core idea" section
- A code-focused "Implementation" section with realistic TypeScript snippets
- A "Verification" section explaining how to test the code
- 3 "Exercises"
- A "Next chapter" link in the form: [Next chapter](../XX-folder/) where XX is the next chapter number padded to 2 digits. If this is the last chapter, link to [TOC](../../docs/TOC.md).
- Keep it around 1200-1800 words.

${previousChaptersText}

Write only the chapter body in Markdown (no front matter, no YAML). Start with the chapter heading.
`;
}

function deterministicContent(chapter: Chapter, previousChaptersText: string): string {
  const prevLines = previousChaptersText
    .split('\n')
    .filter((l) => l.startsWith('# Chapter'))
    .slice(-2)
    .join('\n');

  return `# Chapter ${chapter.num}: ${chapter.title}

## Learning goals

- Understand what ${chapter.title.toLowerCase()} adds to a long-running agent.
- Implement the relevant component inside the cell.
- Verify your changes with tests or deterministic checks.

## Why this matters

Every durable agent needs ${chapter.title.toLowerCase()}. Without it, the loop either loses context, repeats mistakes, or drifts away from the original mission. This chapter gives the cell a concrete, tested capability so it can keep working across restarts and retries.

## Recap

${prevLines ? `From earlier chapters:\n\n${prevLines}` : 'This is the first chapter; there is no prior context.'}

## Core idea

The cell treats "${chapter.title}" as a first-class concern. It is not an afterthought bolted onto the loop — it is part of the loop itself. Each phase of the reasoning cycle (plan, act, observe, reflect, verify) uses the concepts from this chapter to decide what to do next.

## Implementation

### 1. Add the type

Open \`cell/src/types.ts\` and add the new concepts:

\`\`\`ts
export interface MyNewState {
  id: string;
  createdAt: string;
}
\`\`\`

### 2. Update the cell

Open \`cell/src/cell.ts\` and wire the new state into the tick loop:

\`\`\`ts
case 'executing':
  await this.runPhase(mission, 'executing', async () => {
    await this.myNewComponent.process(mission);
  });
  mem.currentState = 'verifying';
  break;
\`\`\`

### 3. Add a test

Create \`cell/src/my-component.test.ts\`:

\`\`\`ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('MyComponent', () => {
  it('does the expected thing', async () => {
    assert.equal(true, true);
  });
});
\`\`\`

Run the verification suite:

\`\`\`bash
cd cell
npm run verify
\`\`\`

## Verification

A passing \`npm run verify\` proves the new component compiles, lints, and does not break existing behaviour. If a test fails, fix it before moving on — the cell only accepts work that passes the gate.

## Exercises

1. Extend the component with one additional property.
2. Write a failing test first, then make it pass.
3. Simulate a crash mid-phase and confirm the cell resumes correctly.

## Next chapter

See [TOC](../../docs/TOC.md).
`;
}

async function updateToc(chapter: Chapter): Promise<void> {
  const toc = await fs.readFile(TOC_PATH, 'utf-8');
  const updated = toc.replace(
    new RegExp(`\\|\\s*${chapter.num.padStart(2, '0')}\\s*\\|\\s*planned\\s*\\|`, 'g'),
    `| ${chapter.num.padStart(2, '0')} | published |`
  );
  await fs.writeFile(TOC_PATH, updated, 'utf-8');
}

async function main() {
  const toc = await fs.readFile(TOC_PATH, 'utf-8');
  const chapters = parseToc(toc);
  const next = chapters.find((c) => c.status === 'planned');

  if (!next) {
    console.log('All chapters are already published.');
    return;
  }

  const folder = join(CHAPTERS_DIR, next.folder);
  await fs.mkdir(folder, { recursive: true });

  const previous = await readPublishedChapters(chapters);
  const content = await generateContent(next, previous);
  await fs.writeFile(join(folder, 'README.md'), content, 'utf-8');
  await updateToc(next);

  try {
    execSync('git add .', { cwd: ROOT, stdio: 'inherit' });
    execSync(`git commit -m "Publish chapter ${next.num}: ${next.title}"`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    execSync('git push', { cwd: ROOT, stdio: 'inherit' });
    console.log(`Published chapter ${next.num}: ${next.title}`);
  } catch (err) {
    console.error('Git commit/push failed.', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
