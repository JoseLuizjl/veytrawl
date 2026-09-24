import type { SemanticDocument, SemanticNode } from '../dom/index.js';
import { score } from '../dom/ranking.js';
export interface ExtractOptions {
  query?: string;
  role?: string;
  scope?: string;
  limit?: number;
}
export interface ExtractedItem {
  id: string;
  text: string;
  tag: string;
  role: string;
  semanticRole?: string;
  context: string;
  href?: string;
  score?: number;
}
export interface ExtractResult {
  url: string;
  title: string;
  capturedAt: string;
  source: SemanticDocument['source'];
  totalMatches: number;
  truncated: boolean;
  items: ExtractedItem[];
  warnings: string[];
}
export function extractDocument(
  document: SemanticDocument,
  options: ExtractOptions = {},
): ExtractResult {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    throw new Error('Extract limit must be an integer from 1 to 10000');
  for (const field of ['query', 'role', 'scope'] as const)
    if (options[field] !== undefined && !options[field]!.trim())
      throw new Error(`Extract ${field} must not be empty`);
  const query = options.query?.trim(),
    role = options.role?.trim().toLowerCase();
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const text = (node: SemanticNode) => (node.interactive ? node.name : node.text || node.name);
  const href = (node: SemanticNode) => {
    if (node.href) return node.href;
    const links = node.children
      .map((id) => byId.get(id))
      .filter((child) => child?.role === 'link' && child.name === text(node));
    return links.length === 1 ? links[0]!.href : undefined;
  };
  const selected = document.nodes.filter(
    (node) =>
      text(node).trim() &&
      (node.interactive ||
        node.role === 'heading' ||
        !node.children.length ||
        /^(p|li|pre|blockquote|td|th)$/.test(node.tag)) &&
      (!role || node.role === role || node.semanticRole === role) &&
      (!options.scope || score(options.scope, `${node.entity ?? ''} ${node.context}`) >= 0.5) &&
      (!query || score(query, `${text(node)} ${node.context} ${node.semanticRole ?? ''}`) > 0),
  );
  const selectedIds = new Set(selected.map((node) => node.id));
  const items: ExtractedItem[] = selected
    .filter((node) => {
      let parent = node.parentId;
      const seen = new Set<string>([node.id]);
      while (parent && !seen.has(parent)) {
        if (selectedIds.has(parent)) return false;
        seen.add(parent);
        parent = byId.get(parent)?.parentId;
      }
      return true;
    })
    .map((node) => ({
      id: node.id,
      text: text(node),
      tag: node.tag,
      role: node.role,
      semanticRole: node.semanticRole,
      context: node.entity || node.context,
      href: href(node),
      ...(query
        ? { score: score(query, `${text(node)} ${node.context} ${node.semanticRole ?? ''}`) }
        : {}),
    }));
  if (query) items.sort((a, b) => b.score! - a.score!);
  const warnings = [...(document.warnings ?? [])];
  if (!items.length)
    warnings.push(
      'No readable content matches the filters. Try a broader query, remove filters, or use browser rendering.',
    );
  if (items.length > limit)
    warnings.push(
      `Showing ${limit} of ${items.length} matching blocks; increase --limit to include more.`,
    );
  return {
    url: document.url,
    title: document.title,
    capturedAt: document.capturedAt,
    source: document.source,
    totalMatches: items.length,
    truncated: items.length > limit,
    items: items.slice(0, limit),
    warnings,
  };
}
function markdown(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}
function safeLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol)
      ? parsed.href.replace(/[<>\s()\\]/g, (c) =>
          encodeURIComponent(c).replace(/\(/g, '%28').replace(/\)/g, '%29'),
        )
      : undefined;
  } catch {
    return undefined;
  }
}
export function renderExtract(
  result: ExtractResult,
  format: 'markdown' | 'text' = 'markdown',
): string {
  if (!['markdown', 'text'].includes(format))
    throw new Error('Extract rendering format must be markdown or text');
  if (format === 'text')
    return (
      [
        result.title,
        result.url,
        ...result.items.map((item) => (item.href ? `${item.text} (${item.href})` : item.text)),
        ...result.warnings.map((w) => `Note: ${w}`),
      ].join('\n\n') + '\n'
    );
  const blocks = result.items
    .filter(
      (item, index) => !(index === 0 && item.role === 'heading' && item.text === result.title),
    )
    .map((item) => {
      const value = markdown(item.text);
      if (item.role === 'heading')
        return `${'#'.repeat(/^h[1-6]$/.test(item.tag) ? Number(item.tag[1]) : 2)} ${value}`;
      const href = item.href && safeLink(item.href);
      if (href) return `[${value}](<${href}>)`;
      return item.tag === 'li' ? `- ${value}` : value;
    });
  return (
    [
      `# ${markdown(result.title || 'Untitled page')}`,
      `Source: ${safeLink(result.url) ? `<${safeLink(result.url)}>` : markdown(result.url)}`,
      ...blocks,
      ...result.warnings.map((w) => `> ${markdown(w)}`),
    ].join('\n\n') + '\n'
  );
}
