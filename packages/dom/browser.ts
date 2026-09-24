import type { Frame, Page } from 'playwright';
import type { SemanticDocument, SemanticNode } from './types.js';
import { semanticRole } from './ranking.js';
export function inspectBrowser(
  input:
    | Element
    | {
        maxNodes?: number;
        maxDepth?: number;
      },
): SemanticNode[] {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const parentOf = (el: Element): Element | null =>
    ('assignedSlot' in el && el.assignedSlot instanceof HTMLSlotElement ? el.assignedSlot : null) ??
    el.parentElement ??
    (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);
  const editable = (el: Element) =>
    el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false';
  const omitted = (el: Element) =>
    ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TEXTAREA'].includes(el.tagName) ||
    editable(el);
  const hiddenCache = new WeakMap<Element, boolean>();
  const textCache = new WeakMap<Node, string>();
  const hidden = (el: Element) => {
    const cached = hiddenCache.get(el);
    if (cached !== undefined) return cached;
    for (let p: Element | null = el; p; p = parentOf(p)) {
      if (
        p.matches('[hidden], [inert], [aria-hidden="true"]') ||
        getComputedStyle(p).display === 'none'
      ) {
        hiddenCache.set(el, true);
        return true;
      }
    }
    const result = ['hidden', 'collapse'].includes(getComputedStyle(el).visibility);
    hiddenCache.set(el, result);
    return result;
  };
  function textOf(el: Node, allowHidden = false): string {
    if (!allowHidden && textCache.has(el)) return textCache.get(el)!;
    if (el.nodeType === Node.TEXT_NODE) return el.textContent ?? '';
    if (el instanceof Element && (omitted(el) || (!allowHidden && hidden(el)))) return '';
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return '';
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) return assigned.map((n) => textOf(n, allowHidden)).join(' ');
    }
    const root = el instanceof Element && el.shadowRoot ? el.shadowRoot : el;
    const result = [...root.childNodes]
      .map((n) => textOf(n, allowHidden))
      .join(' ')
      .slice(0, 4000);
    if (!allowHidden) textCache.set(el, result);
    return result;
  }
  function pathOf(el: Element): string {
    const parts: string[] = [];
    let current: Element | null = el;
    while (current) {
      const root = current.getRootNode();
      const siblings: Element[] = current.parentElement
        ? [...current.parentElement.children]
        : root instanceof ShadowRoot
          ? [...root.children]
          : [current];
      const index = siblings.filter((s) => s.localName === current!.localName).indexOf(current) + 1;
      parts.unshift(`${CSS.escape(current.localName)}:nth-of-type(${index})`);
      if (!current.parentElement && root instanceof ShadowRoot)
        return `${pathOf(root.host)} >> ${parts.join(' > ')}`;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }
  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role')?.split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (el instanceof HTMLInputElement)
      return (
        {
          button: 'button',
          submit: 'button',
          reset: 'button',
          checkbox: 'checkbox',
          radio: 'radio',
          range: 'slider',
          number: 'spinbutton',
          search: 'searchbox',
        }[el.type] ?? 'textbox'
      );
    if (el instanceof HTMLTextAreaElement || editable(el)) return 'textbox';
    if (el instanceof HTMLSelectElement) return el.multiple ? 'listbox' : 'combobox';
    return (
      (
        {
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
          img: 'img',
          progress: 'progressbar',
        } as Record<string, string>
      )[tag] ?? 'text'
    );
  }
  function nameOf(el: Element, role: string) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const labelled = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => root.getElementById?.(id))
      .filter(Boolean)
      .map((ref) => textOf(ref!, true))
      .join(' ');
    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
        ? [...(el.labels ?? [])].map((l) => textOf(l)).join(' ')
        : '';
    const control = [
      'textbox',
      'searchbox',
      'combobox',
      'listbox',
      'spinbutton',
      'slider',
    ].includes(role);
    return normalize(
      labelled ||
        el.getAttribute('aria-label') ||
        labels ||
        el.getAttribute('alt') ||
        (el instanceof HTMLInputElement && role === 'button' ? el.value : '') ||
        (!control ? textOf(el) : '') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        '',
    ).slice(0, 500);
  }
  function contextOf(el: Element) {
    let context = '',
      entity = '';
    for (let p: Element | null = el; p; p = parentOf(p)) {
      entity ||=
        p.getAttribute('data-veytrawl-entity') ||
        p.getAttribute('data-semweb-entity') ||
        p.getAttribute('itemid') ||
        '';
      if (
        !context &&
        p !== el &&
        p.matches('section, article, main, nav, form, li, div, [role="region"], [role="group"]')
      ) {
        const heading =
          [...p.children].find((c) => /^H[1-6]$/.test(c.tagName)) ??
          [...p.children].flatMap((c) => [...c.children]).find((c) => /^H[1-6]$/.test(c.tagName));
        context = normalize(p.getAttribute('aria-label') || (heading ? textOf(heading) : ''));
      }
      if (context && entity) break;
    }
    return { context, entity: entity || context || undefined };
  }
  function read(el: Element): SemanticNode | undefined {
    if (hidden(el) || (omitted(el) && !(el instanceof HTMLTextAreaElement) && !editable(el)))
      return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || (el instanceof HTMLInputElement && el.type === 'hidden'))
      return;
    const role = roleOf(el),
      name = nameOf(el, role),
      text = normalize(textOf(el)).slice(0, 2000);
    const interactive = [
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'listbox',
      'slider',
      'spinbutton',
      'searchbox',
      'switch',
      'tab',
      'menuitem',
      'option',
      'treeitem',
    ].includes(role);
    const ownText = normalize(
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join(' '),
    );
    if (
      !interactive &&
      role === 'text' &&
      !['p', 'pre', 'code', 'label', 'time', 'dt', 'dd'].includes(el.localName) &&
      !ownText
    )
      return;
    let disabled = el.matches(':disabled');
    for (let p: Element | null = el; p; p = parentOf(p))
      disabled ||= p.getAttribute('aria-disabled') === 'true';
    const node: SemanticNode = {
      id: '',
      tag: el.localName,
      role,
      text: interactive ? name : text,
      name,
      interactive,
      disabled,
      visibility: 'visible',
      geometry: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      aria: Object.fromEntries(
        el
          .getAttributeNames()
          .filter((a) => a.startsWith('aria-') && !['aria-valuetext', 'aria-valuenow'].includes(a))
          .map((a) => [a, el.getAttribute(a)!]),
      ),
      children: [],
      ...contextOf(el),
      documentURL: location.href,
      locator: {
        css: pathOf(el),
        testId: el.getAttribute('data-testid') ?? undefined,
        htmlId: el.id || undefined,
      },
    };
    if (el instanceof HTMLAnchorElement && /^https?:/.test(el.href)) node.href = el.href;
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type))
      node.checked = el.checked;
    else if (el.hasAttribute('aria-checked'))
      node.checked = el.getAttribute('aria-checked') === 'true';
    if (el.hasAttribute('aria-expanded'))
      node.expanded = el.getAttribute('aria-expanded') === 'true';
    return node;
  }
  if (input instanceof Element) {
    const n = read(input);
    return n ? [n] : [];
  }
  const nodes: SemanticNode[] = [],
    seen = new Set<Element>();
  const maxNodes = input.maxNodes ?? 10000,
    maxDepth = input.maxDepth ?? 100;
  function visit(el: Element, parent?: SemanticNode, depth = 0) {
    if (seen.has(el) || nodes.length >= maxNodes || hidden(el)) return;
    if (depth > maxDepth) throw new Error('Semantic DOM depth limit reached');
    seen.add(el);
    const node = read(el);
    if (node) {
      node.id = `n${nodes.length + 1}`;
      node.parentId = parent?.id;
      parent?.children.push(node.id);
      nodes.push(node);
    }
    if (omitted(el)) return;
    const children =
      el instanceof HTMLSlotElement && el.assignedElements().length
        ? el.assignedElements({ flatten: true })
        : el.shadowRoot
          ? [...el.shadowRoot.children]
          : [...el.children];
    for (const child of children) visit(child, node ?? parent, depth + 1);
  }
  visit(document.documentElement);
  return nodes;
}
export interface BrowserDOMOptions {
  includeAccessibility?: boolean;
  includeFrames?: boolean;
  maxNodes?: number;
  maxDepth?: number;
}
export async function browserDocument(
  page: Page,
  options: BrowserDOMOptions = {},
): Promise<SemanticDocument> {
  const nodes: SemanticNode[] = [],
    warnings: string[] = [];
  const limit = options.maxNodes ?? 10000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000)
    throw new Error('maxNodes must be 1-100000');
  if (
    options.maxDepth !== undefined &&
    (!Number.isInteger(options.maxDepth) || options.maxDepth < 1 || options.maxDepth > 1000)
  )
    throw new Error('maxDepth must be 1-1000');
  async function capture(frame: Frame, framePath: string[]) {
    if (framePath.length > 10) {
      warnings.push('Frame depth limit reached');
      return;
    }
    if (nodes.length >= limit) {
      warnings.push('Semantic DOM node limit reached');
      return;
    }
    const found = await frame.evaluate(inspectBrowser, {
      maxNodes: limit - nodes.length,
      maxDepth: options.maxDepth,
    });
    const prefix = `f${framePath.length}-${nodes.length}:`;
    for (const n of found) {
      n.id = prefix + n.id;
      if (n.parentId) n.parentId = prefix + n.parentId;
      n.children = n.children.map((id) => prefix + id);
      n.framePath = framePath;
      n.semanticRole = semanticRole(n.name || n.text, n.role);
      nodes.push(n);
    }
    if (options.includeFrames === false) return;
    for (const child of frame.childFrames()) {
      const handle = await child.frameElement();
      try {
        if (!(await handle.isVisible())) continue;
        if (
          await handle.evaluate((el) =>
            Boolean(el instanceof Element && el.closest('[aria-hidden="true"], [inert]')),
          )
        )
          continue;
        const path = await handle.evaluate((el) => {
          function pathOf(e: Element): string {
            const root = e.getRootNode();
            const siblings = e.parentElement
              ? [...e.parentElement.children]
              : root instanceof ShadowRoot
                ? [...root.children]
                : [e];
            const part = `${CSS.escape(e.localName)}:nth-of-type(${siblings.filter((s) => s.localName === e.localName).indexOf(e) + 1})`;
            return e.parentElement
              ? `${pathOf(e.parentElement)} > ${part}`
              : root instanceof ShadowRoot
                ? `${pathOf(root.host)} >> ${part}`
                : part;
          }
          return pathOf(el as Element);
        });
        await capture(child, [...framePath, path]);
      } finally {
        await handle.dispose();
      }
    }
  }
  await capture(page.mainFrame(), []);
  if (nodes.length >= limit && !warnings.length) warnings.push('Semantic DOM node limit reached');
  return {
    version: 1,
    url: page.url(),
    title: await page.title(),
    capturedAt: new Date().toISOString(),
    source: 'browser',
    nodes,
    warnings: warnings.length ? warnings : undefined,
    accessibility: options.includeAccessibility
      ? await page.locator('body').ariaSnapshot()
      : undefined,
  };
}
