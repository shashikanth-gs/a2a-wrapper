import { docsLlms, source } from '@/lib/source';
import { appName, siteUrl } from '@/lib/shared';

/**
 * A read-only MCP server (Streamable HTTP, stateless) so coding agents can search
 * and read these docs directly. Connect with: claude mcp add --transport http a2a-wrapper-docs <site>/mcp
 */
export const dynamic = 'force-dynamic';

const PROTOCOL_VERSION = '2025-06-18';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, accept, mcp-protocol-version, mcp-session-id',
};

const tools = [
  {
    name: 'search_docs',
    description: `Search the ${appName} documentation. Returns matching pages with their path and description.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for' },
        limit: { type: 'number', description: 'Maximum results (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_page',
    description: 'Get the full Markdown of one documentation page by its path, for example "getting-started/quickstart".',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Page path relative to /docs, without a leading slash' } },
      required: ['path'],
    },
  },
  {
    name: 'list_pages',
    description: 'List every documentation page with its path, title and description.',
    inputSchema: { type: 'object', properties: {} },
  },
];

type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

function pagePath(page: { slugs: string[] }) {
  return page.slugs.join('/') || 'index';
}

async function searchDocs(query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return text('Provide a non-empty query.');

  const scored: { score: number; line: string }[] = [];
  for (const page of source.getPages()) {
    const body = (await page.data.getText('processed')).toLowerCase();
    const title = page.data.title.toLowerCase();
    const description = (page.data.description ?? '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 10;
      if (description.includes(term)) score += 4;
      const hits = body.split(term).length - 1;
      score += Math.min(hits, 10);
    }
    if (score > 0) {
      scored.push({
        score,
        line: `- ${page.data.title} (path: ${pagePath(page)}): ${page.data.description ?? ''}\n  ${siteUrl}${page.url}`,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return text(`No pages matched "${query}".`);
  return text(scored.slice(0, limit).map((s) => s.line).join('\n'));
}

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'search_docs': {
      const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 20);
      return searchDocs(String(args.query ?? ''), limit);
    }
    case 'get_page': {
      const raw = String(args.path ?? '').replace(/^\/+|\/+$/g, '').replace(/^docs\//, '');
      const slugs = raw === '' || raw === 'index' ? [] : raw.split('/');
      const page = source.getPage(slugs);
      if (!page) return { ...text(`No page at "${raw}". Use list_pages or search_docs to find a valid path.`), isError: true };
      return text(await docsLlms.page(page));
    }
    case 'list_pages':
      return text(
        source
          .getPages()
          .map((p) => `- ${pagePath(p)}: ${p.data.title}. ${p.data.description ?? ''}`)
          .join('\n'),
      );
    default:
      return null;
  }
}

async function handle(req: JsonRpcRequest) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id ?? null, error: { code, message } });

  switch (req.method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${appName}-docs`, version: '1.0.0' },
        instructions: `Read-only documentation for ${appName}. Use search_docs to find pages and get_page to read one.`,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const result = await callTool(name, (req.params?.arguments as Record<string, unknown>) ?? {});
      return result ? ok(result) : fail(-32602, `Unknown tool: ${name}`);
    }
    default:
      return fail(-32601, `Method not found: ${req.method}`);
  }
}

export async function POST(request: Request) {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400, headers: cors });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) {
    // Notifications (no id) get no response.
    if (message.id === undefined) continue;
    responses.push(await handle(message));
  }

  if (responses.length === 0) return new Response(null, { status: 202, headers: cors });
  return Response.json(Array.isArray(body) ? responses : responses[0], { headers: cors });
}

export function GET() {
  return new Response('This endpoint speaks MCP over HTTP POST (Streamable HTTP, stateless).', {
    status: 405,
    headers: { ...cors, Allow: 'POST, OPTIONS' },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}
