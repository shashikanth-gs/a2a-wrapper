import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, repoUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-semibold tracking-tight">
          <span className="text-fd-primary">a2a</span>-wrapper
        </span>
      ),
    },
    githubUrl: repoUrl,
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Quick start', url: '/docs/getting-started/quickstart' },
      { text: 'Security', url: '/docs/guides/security' },
    ],
  };
}

export { appName };
