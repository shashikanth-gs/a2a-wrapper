import Link from 'next/link';
import type { Metadata } from 'next';
import { JsonLd } from '@/components/json-ld';
import { appName, repoUrl, siteDescription, siteUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: { absolute: 'a2a-wrapper: Claude Code, Codex & Copilot as A2A agents' },
  description: siteDescription,
  alternates: { canonical: '/' },
};

const agents = [
  { name: 'GitHub Copilot', pkg: 'a2a-copilot', note: 'Bring your own model: Ollama, OpenAI, Anthropic, Azure, vLLM.' },
  { name: 'Claude Code', pkg: 'a2a-claude', note: 'Permission modes, background tasks, rate-limit handling.' },
  { name: 'OpenAI Codex', pkg: 'a2a-codex', note: 'Repository sandboxing and approval policy.' },
  { name: 'OpenCode', pkg: 'a2a-opencode', note: 'Multi-provider out of the box.' },
  { name: 'Google Antigravity', pkg: 'a2a-antigravity', note: 'Gemini-backed, through a managed Python bridge.' },
];

const features = [
  { title: 'Config in, server out', body: 'Write a JSON file. Get a spec-compliant A2A server with an agent card, JSON-RPC and REST routes.' },
  { title: 'Discover and delegate', body: 'Agents publish a card, track tasks through their lifecycle, and can call other A2A agents as tools.' },
  { title: 'Multi-turn sessions', body: 'Each A2A contextId maps to a persistent backend session, so conversations keep their memory.' },
  { title: 'Streaming and artifacts', body: 'Blocking or streamed calls, buffered or incremental artifacts, and task cancellation.' },
  { title: 'A2A v1.0 and v0.3', body: 'Native v1.0, with older v0.3.x clients still working. Negotiated per request, no configuration.' },
  { title: 'Observable', body: 'Sideband events for tool calls, reasoning, file changes and usage, to A2A artifacts, HTTP or your own sink.' },
];

const faqs = [
  { q: 'What is a2a-wrapper?', a: 'A set of Node.js packages that expose Claude Code, OpenAI Codex, GitHub Copilot, OpenCode and Google Antigravity as standalone agents over the A2A protocol, configured with a JSON file.' },
  { q: 'How is A2A different from MCP?', a: 'MCP connects an agent to tools and data. A2A connects agents to each other. They are complementary.' },
  { q: 'Is it safe to expose an agent?', a: 'Not by default. The endpoint has no built-in authentication, so bind to 127.0.0.1, run in a container, and put an authenticating proxy in front of anything shared.' },
  { q: 'Which A2A versions are supported?', a: 'A2A v1.0 natively, with backward compatibility for v0.3.x clients, negotiated per request.' },
];

export default function HomePage() {
  return (
    <main className="flex-1">
      <JsonLd
        data={[
          {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: appName,
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Node.js 20+',
            url: siteUrl,
            description: siteDescription,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            license: 'https://opensource.org/licenses/MIT',
          },
          {
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: faqs.map((f) => ({
              '@type': 'Question',
              name: f.q,
              acceptedAnswer: { '@type': 'Answer', text: f.a },
            })),
          },
        ]}
      />

      <section className="mx-auto max-w-5xl px-6 pt-20 pb-14 text-center">
        <p className="mb-4 text-sm font-medium text-fd-primary">Open source · MIT · Node.js 20+</p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          Turn Claude Code, Codex &amp; Copilot into <span className="text-fd-primary">A2A agents</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-fd-muted-foreground">
          Drop in a JSON config, get a fully compliant A2A server. Build multi-agent software engineering teams that can
          discover, delegate, and collaborate.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/docs/getting-started/quickstart" className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground">
            Get started in 60 seconds
          </Link>
          <Link href="/docs/getting-started/multi-agent-crew" className="rounded-lg border border-fd-border px-5 py-2.5 font-medium hover:bg-fd-accent">
            See the multi-agent demo
          </Link>
          <a href={repoUrl} className="rounded-lg border border-fd-border px-5 py-2.5 font-medium hover:bg-fd-accent">
            GitHub
          </a>
        </div>
        <p className="mt-6 text-sm italic text-fd-muted-foreground">
          A2A is the horizontal rail. These wrappers put your best coding agents on it.
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <div className="overflow-hidden rounded-xl border border-fd-border bg-fd-card text-left">
          <div className="border-b border-fd-border px-4 py-2 text-xs text-fd-muted-foreground">terminal</div>
          <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
            <code>{`npm install -g a2a-copilot
gh auth login
a2a-copilot --config ./config.json

# any A2A client can now discover it
curl localhost:3000/.well-known/agent-card.json`}</code>
          </pre>
        </div>
        <p className="mt-3 text-center text-sm text-fd-muted-foreground">
          Full walkthrough in the <Link className="underline" href="/docs/getting-started/quickstart">quick start</Link>.
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 className="mb-2 text-2xl font-semibold tracking-tight">Why this exists</h2>
        <p className="mb-8 max-w-3xl text-fd-muted-foreground">
          Coding agents are powerful but isolated. You cannot cleanly hand a task from one to another, track long-running
          work, or compose them into a team without custom glue. a2a-wrapper puts each of them behind the same open
          protocol, so you can treat them as interoperable teammates instead of siloed tools.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border border-fd-border bg-fd-card p-5">
              <h3 className="mb-1 font-semibold">{f.title}</h3>
              <p className="text-sm text-fd-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight">Supported agents</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Link key={a.pkg} href={`/docs/reference/packages/${a.pkg}`} className="rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:bg-fd-accent">
              <h3 className="font-semibold">{a.name}</h3>
              <p className="mt-0.5 font-mono text-xs text-fd-primary">{a.pkg}</p>
              <p className="mt-2 text-sm text-fd-muted-foreground">{a.note}</p>
            </Link>
          ))}
        </div>
        <p className="mt-4 text-sm text-fd-muted-foreground">
          Not sure which to pick? See <Link className="underline" href="/docs/guides/choosing-a-wrapper">choosing a wrapper</Link>.
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <div className="rounded-xl border border-fd-border bg-fd-card p-6">
          <h2 className="mb-2 text-xl font-semibold tracking-tight">AI-ready documentation</h2>
          <p className="text-fd-muted-foreground">
            Every page is available as Markdown, the whole site ships as <Link className="underline" href="/llms.txt">llms.txt</Link>,
            and a docs <Link className="underline" href="/docs/ai/mcp-server">MCP server</Link> lets your coding agent search and read
            the docs itself. <Link className="underline" href="/docs/ai">Learn more</Link>.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight">FAQ</h2>
        <dl className="space-y-5">
          {faqs.map((f) => (
            <div key={f.q}>
              <dt className="font-medium">{f.q}</dt>
              <dd className="mt-1 text-sm text-fd-muted-foreground">{f.a}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-sm">
          <Link className="underline" href="/docs/reference/faq">More questions</Link>
        </p>
      </section>

      <footer className="border-t border-fd-border px-6 py-8 text-center text-sm text-fd-muted-foreground">
        <p>
          MIT licensed. a2a-wrapper is an independent project and is not affiliated with or endorsed by Anthropic, OpenAI,
          GitHub, or Google.
        </p>
        <p className="mt-2">
          <a className="underline" href={repoUrl}>GitHub</a> · <Link className="underline" href="/docs/guides/security">Security</Link> ·{' '}
          <Link className="underline" href="/docs/community/contributing">Contributing</Link>
        </p>
      </footer>
    </main>
  );
}
