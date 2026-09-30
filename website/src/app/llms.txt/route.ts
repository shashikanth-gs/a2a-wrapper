import { docsLlms } from '@/lib/source';
import { appName, siteDescription, siteUrl } from '@/lib/shared';

export const revalidate = false;

// llms.txt convention: H1 title, blockquote summary, then links. Links are made absolute so
// the file is usable when fetched on its own.
export async function GET() {
  const index = (await docsLlms.index()).replace(/^# .*\n+/, '').replace(/\]\(\//g, `](${siteUrl}/`);
  const body = [
    `# ${appName}`,
    '',
    `> ${siteDescription}`,
    '',
    `Full documentation as one file: ${siteUrl}/llms-full.txt. Any docs page is available as Markdown by appending .md to its URL. A read-only docs MCP server is at ${siteUrl}/mcp.`,
    '',
    index,
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
