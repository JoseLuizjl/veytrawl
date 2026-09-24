import type { SemanticDocument, SemanticNode } from '../dom/index.js';
import { score, tokens } from '../dom/ranking.js';
import { randomUUID } from 'node:crypto';
import type { WatchEvent } from './index.js';
export interface DiffOptions {
  ignoreTimestamps?: boolean;
  ignoreText?: string[];
  scope?: string;
}
interface Fact {
  node: SemanticNode;
  value: string;
  normalized: string;
  state: string;
  group: string;
  signature: string;
}
export interface WatchDiagnostics {
  source: SemanticDocument['source'];
  capturedAt: string;
  nodes: number;
  facts: number;
  matchedFacts: number;
  priceFacts: number;
  warnings: string[];
}
function watchesAll(watchFor: string): boolean {
  const goal = watchFor.trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    'all',
    '*',
    'content',
    'page changes',
    'website changes',
    'site changes',
    'all changes',
    'content changes',
    'page content',
  ].includes(goal);
}
function relevant(watchFor: string, fact?: Fact): boolean {
  return Boolean(
    fact &&
    (watchesAll(watchFor) ||
      score(watchFor, `${fact.node.semanticRole ?? ''} ${fact.value} ${fact.node.context}`) > 0),
  );
}
const money =
  /(?:R\$|US\$|[$€£]|USD|EUR|BRL|GBP)\s*\d[\d.,]*(?:\s|$)|\d[\d.,]*\s*(?:USD|EUR|BRL|GBP)\b/g;
function numeric(text: string) {
  let value = text.replace(/[^\d.,]/g, '');
  if (value.includes('.') && value.includes(',')) {
    const decimal = value.lastIndexOf('.') > value.lastIndexOf(',') ? '.' : ',';
    value = value.replace(decimal === '.' ? /,/g : /\./g, '').replace(',', '.');
  } else if (/^[\d]+[.,]\d{3}$/.test(value) || (value.match(/[.,]/g)?.length ?? 0) > 1)
    value = value.replace(/[.,]/g, '');
  else value = value.replace(',', '.');
  return String(Number(value));
}
function normalizeValue(value: string, options: DiffOptions) {
  let text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (options.ignoreTimestamps !== false)
    text = text
      .replace(
        /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
        '<time>',
      )
      .replace(
        /\bupdated(?:\s+at)?\s+\d+\s+(?:seconds?|minutes?|hours?)(?:\s+ago)?/gi,
        '<updated>',
      );
  return text
    .replace(money, (match) => {
      const currency = /R\$|BRL/.test(match)
        ? 'BRL'
        : /€|EUR/.test(match)
          ? 'EUR'
          : /£|GBP/.test(match)
            ? 'GBP'
            : 'USD';
      return `${currency}:${numeric(match)} `;
    })
    .trim();
}
function facts(doc: SemanticDocument, options: DiffOptions): Fact[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const aggregatePrice = (n: SemanticNode) =>
    n.semanticRole === 'price' && !n.interactive && n.role === 'text' && n.text.length < 500;
  const covered = (n: SemanticNode) => {
    let p = n.parentId ? byId.get(n.parentId) : undefined;
    while (p) {
      if (p.interactive || aggregatePrice(p)) return true;
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return false;
  };
  return doc.nodes
    .filter((n) => (n.interactive || !n.children.length || aggregatePrice(n)) && !covered(n))
    .filter((n) => options.ignoreTimestamps === false || n.tag !== 'time')
    .filter((n) => !options.scope || score(options.scope, `${n.entity ?? ''} ${n.context}`) >= 0.5)
    .flatMap((node) => {
      const value = node.interactive ? node.name : node.text || node.name;
      if (!value || options.ignoreText?.some((t) => value.toLowerCase().includes(t.toLowerCase())))
        return [];
      const normalized = normalizeValue(value, options);
      if (!normalized || normalized === '<time>' || normalized === '<updated>') return [];
      const entity = node.entity || node.context;
      const category =
        node.semanticRole === 'price'
          ? 'price'
          : node.interactive
            ? node.role
            : node.role === 'heading'
              ? 'heading'
              : 'content';
      const scope = node.framePath?.length
        ? JSON.stringify([node.documentURL, node.framePath])
        : '';
      const signature =
        category === 'price'
          ? normalized.replace(/(USD|EUR|GBP|BRL):\d+(?:\.\d+)?/g, '$1:#')
          : normalized.toLowerCase();
      return [
        {
          node,
          value,
          normalized,
          state: JSON.stringify([node.href, node.disabled, node.checked, node.expanded]),
          group: JSON.stringify([scope, entity, category]),
          signature,
        },
      ];
    });
}
export function diffDocuments(
  before: SemanticDocument,
  after: SemanticDocument,
  watchFor: string,
  options: DiffOptions = {},
): WatchEvent[] {
  const old = facts(before, options),
    next = facts(after, options),
    events: WatchEvent[] = [];
  function emit(a?: Fact, b?: Fact) {
    if (!relevant(watchFor, a) && !relevant(watchFor, b)) return;
    const node = (b ?? a)!.node;
    const stateOnly = a && b && a.normalized === b.normalized;
    events.push({
      id: randomUUID(),
      url: after.url,
      at: after.capturedAt,
      type:
        node.semanticRole === 'price'
          ? 'pricing-change'
          : !a
            ? 'content-added'
            : !b
              ? 'content-removed'
              : stateOnly
                ? 'state-change'
                : 'content-changed',
      important: true,
      context: node.entity || node.context,
      before: a ? a.value + (stateOnly ? ` ${a.state}` : '') : undefined,
      after: b ? b.value + (stateOnly ? ` ${b.state}` : '') : undefined,
    });
  }
  const groups = new Map<
    string,
    {
      left: Fact[];
      right: Fact[];
    }
  >();
  for (const [side, list] of [
    ['left', old],
    ['right', next],
  ] as const)
    for (const fact of list) {
      let group = groups.get(fact.group);
      if (!group) {
        group = { left: [], right: [] };
        groups.set(fact.group, group);
      }
      group[side].push(fact);
    }
  for (const group of groups.values()) {
    const identity = (fact: Fact) => JSON.stringify([fact.normalized, fact.state]);
    const counts = new Map<string, number>();
    for (const fact of group.right) {
      const key = identity(fact);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const matched = new Map<string, number>(),
      left: Fact[] = [];
    for (let i = group.left.length - 1; i >= 0; i--) {
      const fact = group.left[i]!,
        key = identity(fact),
        remaining = counts.get(key) ?? 0;
      if (remaining) {
        counts.set(key, remaining - 1);
        matched.set(key, (matched.get(key) ?? 0) + 1);
      } else left.push(fact);
    }
    left.reverse();
    const right = group.right.filter((fact) => {
      const key = identity(fact),
        remaining = matched.get(key) ?? 0;
      if (!remaining) return true;
      matched.set(key, remaining - 1);
      return false;
    });
    const leftCounts = new Map<string, number>(),
      rightBySignature = new Map<string, Fact[]>();
    for (const fact of left)
      leftCounts.set(fact.signature, (leftCounts.get(fact.signature) ?? 0) + 1);
    for (const fact of right) {
      const bucket = rightBySignature.get(fact.signature) ?? [];
      bucket.push(fact);
      rightBySignature.set(fact.signature, bucket);
    }
    const pairedLeft = new Set<Fact>(),
      pairedRight = new Set<Fact>();
    for (let i = left.length - 1; i >= 0; i--) {
      const a = left[i]!,
        matches = rightBySignature.get(a.signature);
      if (matches?.length === 1 && leftCounts.get(a.signature) === 1) {
        emit(a, matches[0]);
        pairedLeft.add(a);
        pairedRight.add(matches[0]!);
      }
    }
    const remainingLeft = left.filter((fact) => !pairedLeft.has(fact)),
      remainingRight = right.filter((fact) => !pairedRight.has(fact));
    if (remainingLeft.length === 1 && remainingRight.length === 1) {
      const a = remainingLeft[0]!,
        b = remainingRight[0]!;
      const at = new Set(tokens(a.value)),
        bt = new Set(tokens(b.value));
      const similarity =
        [...at].filter((t) => bt.has(t)).length / Math.max(1, new Set([...at, ...bt]).size);
      if (
        similarity >= 0.35 ||
        (a.node.semanticRole === 'price' &&
          b.node.semanticRole === 'price' &&
          Boolean(a.node.entity || a.node.context))
      ) {
        emit(a, b);
        remainingLeft.length = 0;
        remainingRight.length = 0;
      }
    }
    remainingLeft.forEach((a) => emit(a));
    remainingRight.forEach((b) => emit(undefined, b));
  }
  return events;
}
export function watchDiagnostics(
  document: SemanticDocument,
  watchFor: string,
  options: DiffOptions = {},
): WatchDiagnostics {
  const projected = facts(document, options);
  const matchedFacts = projected.filter((fact) => relevant(watchFor, fact)).length;
  return {
    source: document.source,
    capturedAt: document.capturedAt,
    nodes: document.nodes.length,
    facts: projected.length,
    matchedFacts,
    priceFacts: projected.filter((fact) => fact.node.semanticRole === 'price').length,
    warnings: matchedFacts
      ? []
      : [
          'No extracted facts match the watch goal and filters. Check the goal/scope, use --for all, or use --browser if the content requires JavaScript.',
        ],
  };
}
