#!/usr/bin/env node
/**
 * Generates the "Package reference" docs from each package's README so the
 * website can never drift from the code. Output is gitignored
 * (see .gitignore); meta.json files are hand-written.
 *
 * Runs automatically before `dev` and `build` (see package.json).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(websiteDir, '..');
const GITHUB = 'https://github.com/shashikanth-gs/a2a-wrapper';
const BRANCH = 'main';

const docsRoot = join(websiteDir, 'content/docs');

/** Every generated page: a repo file -> a docs page. `out` is relative to content/docs. */
const pages = [
  // Package reference (from each package README)
  { out: 'reference/packages/core.md', src: 'packages/core/README.md', title: '@a2a-wrapper/core', description: 'API reference for the shared core: config loading, server factory, sessions, events, memory, and sub-agents.' },
  { out: 'reference/packages/a2a-copilot.md', src: 'a2a-copilot/README.md', title: 'a2a-copilot', description: 'Reference for a2a-copilot: expose GitHub Copilot as an A2A agent, with BYOK providers, MCP tools, and usage telemetry.' },
  { out: 'reference/packages/a2a-claude.md', src: 'a2a-claude/README.md', title: 'a2a-claude', description: 'Reference for a2a-claude: expose Claude Code as an A2A agent, with permission modes, sessions, rate limits, and background tasks.' },
  { out: 'reference/packages/a2a-codex.md', src: 'a2a-codex/README.md', title: 'a2a-codex', description: 'Reference for a2a-codex: expose OpenAI Codex as an A2A agent, with sandbox modes, approval policy, and the context API.' },
  { out: 'reference/packages/a2a-opencode.md', src: 'a2a-opencode/README.md', title: 'a2a-opencode', description: 'Reference for a2a-opencode: expose OpenCode as a multi-provider A2A agent, with MCP transports and OAuth.' },
  { out: 'reference/packages/a2a-antigravity.md', src: 'a2a-antigravity/README.md', title: 'a2a-antigravity', description: 'Reference for a2a-antigravity: expose Google Antigravity as an A2A agent via a managed Python bridge.' },
  // Guides / community
  { out: 'guides/security.md', src: 'docs/security.md', title: 'Security guide', description: 'Deploy a2a-wrapper agents safely: network exposure, permission and sandbox modes, workspace hygiene, and a pre-flight checklist.' },
  { out: 'community/contributing.md', src: 'CONTRIBUTING.md', title: 'Contributing', description: 'How to set up the monorepo, run tests, create changesets, add a new wrapper, and open a pull request.' },
  // Changelogs
  { out: 'community/changelog/core.md', src: 'packages/core/CHANGELOG.md', title: '@a2a-wrapper/core changelog', description: 'Release notes for @a2a-wrapper/core.' },
  { out: 'community/changelog/a2a-copilot.md', src: 'a2a-copilot/CHANGELOG.md', title: 'a2a-copilot changelog', description: 'Release notes for a2a-copilot.' },
  { out: 'community/changelog/a2a-claude.md', src: 'a2a-claude/CHANGELOG.md', title: 'a2a-claude changelog', description: 'Release notes for a2a-claude.' },
  { out: 'community/changelog/a2a-codex.md', src: 'a2a-codex/CHANGELOG.md', title: 'a2a-codex changelog', description: 'Release notes for a2a-codex.' },
  { out: 'community/changelog/a2a-opencode.md', src: 'a2a-opencode/CHANGELOG.md', title: 'a2a-opencode changelog', description: 'Release notes for a2a-opencode.' },
  { out: 'community/changelog/a2a-antigravity.md', src: 'a2a-antigravity/CHANGELOG.md', title: 'a2a-antigravity changelog', description: 'Release notes for a2a-antigravity.' },
];

/** Rewrite repo-relative links so they resolve on GitHub (or to a docs page). */
function rewriteLinks(md, srcPath) {
  const srcDir = posix.dirname(srcPath);
  return md.replace(/\]\(([^)\s]+)\)/g, (whole, href) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return whole;
    const [path, hash = ''] = href.split('#');
    const repoPath = posix.normalize(posix.join(srcDir, path));
    if (repoPath.startsWith('..')) return whole;
    if (repoPath === 'docs/security.md') return '](/docs/guides/security)';
    const kind = /\.[a-z0-9]+$/i.test(repoPath) ? 'blob' : 'tree';
    return `](${GITHUB}/${kind}/${BRANCH}/${repoPath}${hash ? '#' + hash : ''})`;
  });
}

function transform(md, srcPath) {
  let out = md.replace(/^# .*\n/, ''); // title comes from frontmatter
  out = out.replace(/^\[!\[.*\n/gm, ''); // badge lines
  out = out.replace(/<details>\s*<summary><strong>Table of Contents<\/strong><\/summary>[\s\S]*?<\/details>\n*/i, '');
  out = out.replace(/\n## License[\s\S]*$/, '\n'); // license lives on GitHub
  out = rewriteLinks(out, srcPath);
  return out.trim() + '\n';
}

const manifest = {};
for (const p of pages) {
  const src = join(repoRoot, p.src);
  const dest = join(docsRoot, p.out);
  mkdirSync(dirname(dest), { recursive: true });
  const body = transform(readFileSync(src, 'utf8'), p.src);
  const fm = `---\ntitle: ${JSON.stringify(p.title)}\ndescription: ${JSON.stringify(p.description)}\n---\n\n` +
    `> This page is generated from [\`${p.src}\`](${GITHUB}/blob/${BRANCH}/${p.src}) and stays in sync with the repository.\n\n`;
  writeFileSync(dest, fm + body);
  manifest[p.out] = p.src;
  console.log(`synced ${p.src} -> content/docs/${p.out}`);
}

// Demo media used by the docs (recordings, social preview).
const mediaDir = join(websiteDir, 'public/media');
mkdirSync(mediaDir, { recursive: true });
for (const f of ['crew-demo.gif', 'copilot-quickstart.gif', 'social-preview.png']) {
  const from = join(repoRoot, 'docs/assets', f);
  if (existsSync(from)) copyFileSync(from, join(mediaDir, f));
}

// Lets the docs UI link generated pages back to their real source file.
mkdirSync(join(websiteDir, 'src/lib'), { recursive: true });
writeFileSync(join(websiteDir, 'src/lib/generated-sources.json'), JSON.stringify(manifest, null, 2) + '\n');
