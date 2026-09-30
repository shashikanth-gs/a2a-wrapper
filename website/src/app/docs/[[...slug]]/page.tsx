import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { appName, getEditUrl, getPageImageUrl, getPageMarkdownUrl, siteUrl } from '@/lib/shared';
import { JsonLd } from '@/components/json-ld';

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const editUrl = getEditUrl(page.path);
  const url = `${siteUrl}${page.url}`;

  // Breadcrumbs only link to pages that exist (folders without an index page are skipped).
  const crumbs = [{ name: 'Docs', url: `${siteUrl}/docs` }];
  for (let i = 1; i < page.slugs.length; i++) {
    const ancestor = source.getPage(page.slugs.slice(0, i));
    if (ancestor) crumbs.push({ name: ancestor.data.title, url: `${siteUrl}${ancestor.url}` });
  }
  if (page.slugs.length > 0) crumbs.push({ name: page.data.title, url });

  const jsonLd: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: page.data.title,
      description: page.data.description,
      url,
      image: `${siteUrl}${getPageImageUrl(page).url}`,
      inLanguage: 'en',
      author: { '@type': 'Person', name: 'Shashikanth GS' },
      publisher: { '@type': 'Organization', name: appName, url: siteUrl },
      mainEntityOfPage: url,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
    },
  ];

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <JsonLd data={jsonLd} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={editUrl} />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
      <p className="mt-10 text-sm text-fd-muted-foreground">
        <a className="underline" href={editUrl} rel="noopener">
          Edit this page on GitHub
        </a>
      </p>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const image = getPageImageUrl(page).url;
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: { 'text/markdown': getPageMarkdownUrl(page).url },
    },
    openGraph: {
      type: 'article',
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: page.data.title,
      description: page.data.description,
      images: [image],
    },
  };
}
