// Incremental course publisher.
// Reads docs/TOC.md to find the first chapter marked 'planned',
// writes a starter README for that chapter, marks it 'published',
// and commits + pushes the result.
// Run manually: node scripts/node_modules/.bin/tsx scripts/publish-chapter.ts
// Or via cron: 0 */4 * * * cd ~/Downloads/projects/build-long-running-cell && node scripts/node_modules/.bin/tsx scripts/publish-chapter.ts
import { promises as fs } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const TOC_PATH = join(ROOT, 'docs', 'TOC.md');

interface Chapter {
  num: string;
  title: string;
  folder: string;
  status: 'planned' | 'published' | 'written';
}

function parseToc(text: string): { chapters: Chapter[]; tableLines: string[] } {
  const lines = text.split('\n');
  const chapters: Chapter[] = [];
  const tableLines: string[] = [];
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('| Chapter | Status |')) {
      inTable = true;
      tableLines.push(line);
      continue;
    }
    if (inTable) {
      if (line.trim().startsWith('|') && line.includes('|')) {
        tableLines.push(line);
        const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
        if (parts.length === 2 && /^\d+$/.test(parts[0])) {
          chapters.push({
            num: parts[0],
            title: '',
            folder: `chapters/${String(parts[0]).padStart(2, '0')}-...`,
            status: parts[1] as Chapter['status'],
          });
        }
      } else {
        inTable = false;
      }
    }
  }

  // Match chapter titles from the bullet list above
  for (const line of lines) {
    const m = line.match(/\[?(\d+)\]?\.?\s*[-–]\s*(.+)/);
    if (m) {
      const ch = chapters.find((c) => c.num === m[1].replace(/^0+/, ''));
      if (ch) {
        ch.title = m[2].replace(/\]\(.+\)/, '').replace(/\[|\]/g, '').trim();
      }
    }
  }

  return { chapters, tableLines };
}

function chapterFolder(num: string): string {
  return `chapters/${String(num).padStart(2, '0')}-...`;
}

function updateTableLine(line: string, chapter: Chapter): string {
  const parts = line.split('|').map((p) => p.trim());
  if (parts.length >= 3 && parts[1] === chapter.num) {
    parts[2] = chapter.status;
  }
  return parts.join(' | ');
}

function starterReadme(chapter: Chapter): string {
  return `# Chapter ${chapter.num}: ${chapter.title}

## Learning goals

- Understand the core idea behind this chapter.
- Add one durable feature to the cell.
- Verify it with tests.

## Outline

1. Recap
2. Concept
3. Implementation
4. Verification
5. Exercises

## Next chapter

See [TOC](../../docs/TOC.md).
`;
}

async function main() {
  const toc = await fs.readFile(TOC_PATH, 'utf-8');
  const { chapters } = parseToc(toc);
  const next = chapters.find((c) => c.status === 'planned');

  if (!next) {
    console.log('All chapters are already published.');
    return;
  }

  // Resolve real folder name by scanning chapters/
  const entries = await fs.readdir(join(ROOT, 'chapters'));
  const folder = entries.find((e) => e.startsWith(`${String(next.num).padStart(2, '0')}-`));
  if (!folder) {
    throw new Error(`Folder for chapter ${next.num} not found`);
  }

  const readmePath = join(ROOT, 'chapters', folder, 'README.md');
  await fs.mkdir(join(ROOT, 'chapters', folder), { recursive: true });
  await fs.writeFile(readmePath, starterReadme(next), 'utf-8');

  next.status = 'published';
  const updatedToc = toc.replace(
    new RegExp(`\\|\\s*${next.num}\\s*\\|\\s*planned\\s*\\|`, 'g'),
    `| ${String(next.num).padStart(2, '0')} | published |`
  );
  await fs.writeFile(TOC_PATH, updatedToc, 'utf-8');

  // Commit
  try {
    execSync('git add .', { cwd: ROOT, stdio: 'inherit' });
    execSync(`git commit -m "Publish chapter ${next.num}: ${next.title}"`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    execSync('git push', { cwd: ROOT, stdio: 'inherit' });
    console.log(`Published chapter ${next.num}: ${next.title}`);
  } catch (err) {
    console.error('Git commit/push failed. You may need to set a remote origin.', err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
