import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata, Viewport } from 'next';
import { JsonLd } from '@/components/json-ld';
import { appName, repoUrl, siteDescription, siteUrl } from '@/lib/shared';

const inter = Inter({
  subsets: ['latin'],
});

const title = 'a2a-wrapper: Claude Code, Codex & Copilot as A2A agents';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: title, template: `%s | ${appName}` },
  description: siteDescription,
  applicationName: appName,
  keywords: [
    'A2A', 'Agent2Agent', 'A2A protocol', 'agent-to-agent', 'Claude Code', 'OpenAI Codex', 'GitHub Copilot',
    'OpenCode', 'Google Antigravity', 'multi-agent', 'AI agents', 'MCP', 'coding agents', 'agent interoperability',
  ],
  authors: [{ name: 'Shashikanth GS', url: 'https://github.com/shashikanth-gs' }],
  creator: 'Shashikanth GS',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: appName,
    title,
    description: siteDescription,
    url: siteUrl,
    images: [{ url: '/media/social-preview.png', width: 1280, height: 640, alt: 'a2a-wrapper' }],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description: siteDescription,
    images: ['/media/social-preview.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        <JsonLd
          data={[
            {
              '@context': 'https://schema.org',
              '@type': 'WebSite',
              name: appName,
              url: siteUrl,
              description: siteDescription,
            },
            {
              '@context': 'https://schema.org',
              '@type': 'SoftwareSourceCode',
              name: appName,
              codeRepository: repoUrl,
              programmingLanguage: 'TypeScript',
              runtimePlatform: 'Node.js',
              license: 'https://opensource.org/licenses/MIT',
              description: siteDescription,
            },
          ]}
        />
        <link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt" />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
