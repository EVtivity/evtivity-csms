// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { ImageOff, Link2 } from 'lucide-react';
import { allowedAiLink, buildAiLinkAllowlist } from '@evtivity/lib/ai-markdown-policy';
import { PORTAL_BASE_URL } from '@/lib/config';
import { CodeBlock } from './CodeBlock';

// Model output is untrusted (plan 3.9): links only to the website, this app and the portal.
const LINK_ALLOWLIST = buildAiLinkAllowlist([window.location.origin, PORTAL_BASE_URL]);

interface HastLike {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

function hastText(node: HastLike | undefined): string {
  if (node == null) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function codeLanguage(node: HastLike | undefined): string | null {
  const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  const className = code?.properties?.['className'];
  const classes = Array.isArray(className) ? className : [];
  for (const c of classes) {
    if (typeof c === 'string' && c.startsWith('language-')) return c.slice('language-'.length);
  }
  return null;
}

function ImageChip({ src, alt }: { src: string | undefined; alt: string }): React.JSX.Element {
  const { t } = useTranslation();
  const href = allowedAiLink(src, LINK_ALLOWLIST);
  const label = alt !== '' ? alt : t('ai.image');
  const chip =
    'not-prose inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs';
  // Never an <img>: an injected image URL would load on render and carry data out.
  if (href == null) {
    return (
      <span className={chip} title={t('ai.imageBlocked')}>
        <ImageOff className="h-3 w-3" aria-hidden="true" />
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${chip} text-primary hover:underline`}
    >
      <Link2 className="h-3 w-3" aria-hidden="true" />
      {label}
    </a>
  );
}

const components: Components = {
  a: ({ href, children }) => {
    const safe = allowedAiLink(href, LINK_ALLOWLIST);
    if (safe == null) return <span className="break-all">{children}</span>;
    return (
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline hover:text-primary/80"
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => (
    <ImageChip src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />
  ),
  pre: ({ node }) => {
    const hast = node as HastLike | undefined;
    return <CodeBlock code={hastText(hast).replace(/\n$/, '')} language={codeLanguage(hast)} />;
  },
  table: ({ children }) => (
    <div className="not-prose my-2 overflow-x-auto">
      <table className="w-max border-collapse text-xs [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">
        {children}
      </table>
    </div>
  ),
};

/**
 * Renders an AI answer. Raw HTML is dropped (`skipHtml`) and the tree is
 * sanitized, links are allowlisted, images become chips, code blocks get a
 * copy button and tables scroll in place.
 */
export function AiMarkdown({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-border/50 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-xs [&_:not(pre)>code]:before:content-none [&_:not(pre)>code]:after:content-none">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default AiMarkdown;
