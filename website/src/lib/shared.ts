import { createGetUrl } from 'fumadocs-core/source';
import generatedSources from './generated-sources.json';

export const appName = 'a2a-wrapper';
export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://a2a-wrapper.allsrc.dev';
export const siteDescription =
  'Turn Claude Code, OpenAI Codex, GitHub Copilot, OpenCode and Google Antigravity into standalone A2A agents that can discover, delegate to, and work with each other. Drop in a JSON config, get a spec-compliant A2A server.';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'shashikanth-gs',
  repo: 'a2a-wrapper',
  branch: 'main',
};

export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** GitHub URL to edit a docs page: hand-written pages live under website/, generated ones map back to their source. */
export function getEditUrl(pagePath: string) {
  const generated = (generatedSources as Record<string, string>)[pagePath];
  const repoPath = generated ?? `website/content/docs/${pagePath}`;
  return `${repoUrl}/blob/${gitConfig.branch}/${repoPath}`;
}

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
