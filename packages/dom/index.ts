import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { browserDocument } from './browser.js';
import type { SemanticDocument, SemanticNode } from './types.js';
import { semanticRole } from './ranking.js';
export type { SemanticDocument, SemanticNode } from './types.js';
export type { BrowserDOMOptions } from './browser.js';
type Tree = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const excluded = new Set(['script', 'style', 'template', 'noscript', 'head', 'textarea']);
const regions: Record<string, string> = {
  main: 'main',
  nav: 'navigation',
  aside: 'complementary',
  header: 'banner',
  footer: 'contentinfo',
  section: 'region',
  article: 'article',
  form: 'form',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
};
function attr(el: Element): Record<string, string> {
  return Object.fromEntries(el.attrs.map((a) => [a.name, a.value]));
}
function hidden(a: Record<string, string>) {
  return (
    'hidden' in a ||
    'inert' in a ||
    a['aria-hidden'] === 'true' ||
    a.type === 'hidden' ||
    /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.style ?? '')
  );
}
function textOf(node: Tree, allowHidden = false, cache?: WeakMap<Tree, string>): string {
  if (!allowHidden && cache?.has(node)) return cache.get(node)!;
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  if (
    'tagName' in node &&
    (excluded.has(node.tagName) || editable(attr(node)) || (!allowHidden && hidden(attr(node))))
  )
    return '';
  const text =
    'childNodes' in node
      ? node.childNodes
          .map((child) => textOf(child, allowHidden, cache))
          .join(' ')
          .slice(0, 4000)
      : '';
  if (!allowHidden) cache?.set(node, text);
  return text;
}
function editable(a: Record<string, string>) {
  return 'contenteditable' in a && a.contenteditable !== 'false';
}
function roleOf(tag: string, a: Record<string, string>): string {
  if (a.role) return a.role.split(' ')[0]!;
  if (editable(a)) return 'textbox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'a' && a.href) return 'link';
  if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset'].includes(a.type ?? '')))
    return 'button';
  if (tag === 'input')
    return (
      { checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox' }[
        a.type ?? ''
      ] ?? 'textbox'
    );
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'img') return 'img';
  return regions[tag] ?? 'text';
}
export function parseSemanticDOM(html: string, url: string): SemanticDocument {
  const tree = parse(html);
  const ids = new Map<string, Element>();
  const labels = new Map<string, string>();
  const textCache = new WeakMap<Tree, string>();
  const text = (node: Tree, allowHidden = false) => textOf(node, allowHidden, textCache);
  let title = '';
  const pending: {
    node: Tree;
    depth: number;
  }[] = [{ node: tree, depth: 0 }];
  const indexed: Element[] = [];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > 100) throw new Error('Semantic DOM depth limit reached');
    if ('tagName' in node) {
      const a = attr(node);
      if (a.id) ids.set(a.id, node);
      indexed.push(node);
    }
    if ('childNodes' in node)
      for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1 });
  }
  for (const node of indexed) {
    const a = attr(node);
    if (node.tagName === 'label' && a.for) labels.set(a.for, clean(text(node)));
    if (node.tagName === 'title') title = clean(text(node));
  }
  const nodes: SemanticNode[] = [];
  function visit(
    el: Element,
    path: string,
    parent?: SemanticNode,
    context = '',
    inheritedDisabled = false,
    wrappingLabel = '',
    inheritedEntity = '',
  ) {
    const a = attr(el),
      tag = el.tagName;
    if ((excluded.has(tag) && tag !== 'textarea') || hidden(a)) return;
    const children = el.childNodes.filter((n): n is Element => 'tagName' in n);
    const content = clean(text(el)).slice(0, 2000);
    const role = roleOf(tag, a);
    const labelled = (a['aria-labelledby'] ?? '')
      .split(/\s+/)
      .map((id) => ids.get(id))
      .filter(Boolean)
      .map((e) => text(e!, true))
      .join(' ');
    const label = tag === 'label' ? content : wrappingLabel;
    const name = clean(
      labelled ||
        a['aria-label'] ||
        labels.get(a.id ?? '') ||
        (['input', 'textarea', 'select'].includes(tag) ? label : '') ||
        a.alt ||
        (tag === 'input' && role === 'button' ? a.value : '') ||
        content ||
        a.placeholder ||
        a.title ||
        '',
    ).slice(0, 500);
    const interactive = [
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'slider',
      'searchbox',
      'switch',
      'tab',
      'menuitem',
    ].includes(role);
    const ownText = clean(
      el.childNodes
        .filter((n) => n.nodeName === '#text')
        .map((n) => text(n))
        .join(' '),
    );
    const meaningful =
      interactive ||
      role !== 'text' ||
      ['p', 'pre', 'code', 'label', 'time', 'dt', 'dd'].includes(tag) ||
      (ownText &&
        (!children.length ||
          !children.some((c) => /^(p|div|section|article|button|a)$/.test(c.tagName))));
    const disabled = inheritedDisabled || 'disabled' in a || a['aria-disabled'] === 'true';
    let current = parent;
    const entity =
      a['data-veytrawl-entity'] || a['data-semweb-entity'] || a.itemid || inheritedEntity;
    let nextContext = context;
    if (['section', 'article', 'main', 'nav', 'form', 'li', 'div'].includes(tag)) {
      const heading =
        children.find((c) => /^h[1-6]$/.test(c.tagName)) ??
        children
          .flatMap((c) => c.childNodes.filter((n): n is Element => 'tagName' in n))
          .find((c) => /^h[1-6]$/.test(c.tagName));
      nextContext = clean(a['aria-label'] || (heading && text(heading)) || context);
    }
    if (meaningful && (name || interactive || role !== 'text')) {
      const n: SemanticNode = {
        id: `n${nodes.length + 1}`,
        tag,
        role,
        text: content,
        name,
        interactive,
        disabled,
        semanticRole: semanticRole(name, role),
        visibility: 'unknown',
        aria: Object.fromEntries(
          Object.entries(a).filter(
            ([k]) => k.startsWith('aria-') && !['aria-valuetext', 'aria-valuenow'].includes(k),
          ),
        ),
        parentId: parent?.id,
        children: [],
        context: nextContext,
        entity: entity || nextContext || undefined,
        documentURL: url,
        locator: { css: path, testId: a['data-testid'], htmlId: a.id },
      };
      if (a.href) {
        try {
          const u = new URL(a.href, url);
          if (['http:', 'https:'].includes(u.protocol)) n.href = u.href;
        } catch {}
      }
      if (['checkbox', 'radio', 'switch'].includes(role))
        n.checked = 'checked' in a || a['aria-checked'] === 'true';
      if (a['aria-expanded']) n.expanded = a['aria-expanded'] === 'true';
      nodes.push(n);
      parent?.children.push(n.id);
      current = n;
    }
    if (editable(a) || tag === 'textarea') return;
    const counts = new Map<string, number>();
    for (const child of children) {
      const count = (counts.get(child.tagName) ?? 0) + 1;
      counts.set(child.tagName, count);
      visit(
        child,
        `${path} > ${child.tagName}:nth-of-type(${count})`,
        current,
        nextContext,
        disabled,
        label,
        entity,
      );
    }
  }
  const root = tree.childNodes.find((n): n is Element => 'tagName' in n && n.tagName === 'html');
  if (root) visit(root, 'html');
  return { version: 1, url, title, capturedAt: new Date().toISOString(), source: 'http', nodes };
}
export const fromPage = browserDocument;
