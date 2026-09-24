const groups = [
  ['checkout', 'purchase', 'buy', 'complete', 'pay', 'payment'],
  ['search'],
  ['account', 'login', 'signin'],
  ['price', 'pricing', 'prices', 'cost'],
  ['authentication', 'authenticate', 'auth', 'oauth'],
  ['documentation', 'docs'],
  ['button'],
  ['link', 'navigation'],
  ['delete', 'remove', 'erase'],
  ['download', 'export'],
  ['invoice', 'receipt'],
  ['save'],
  ['cancel'],
  ['subscribe', 'subscription'],
  ['email', 'mail'],
  ['password'],
  ['settings', 'preferences'],
];
const stop = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'changes',
  'change',
  'about',
  'please',
  'find',
  'locate',
  'click',
  'press',
  'element',
  'where',
  'is',
  'my',
  'me',
  'i',
  'want',
  'that',
  'lets',
  'can',
  'you',
  'this',
  'on',
  'in',
  'with',
  'and',
  'it',
]);
export function tokens(text: string): string[] {
  return (
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((t) => !stop.has(t)) ?? []
  );
}
export function score(goal: string, evidence: string): number {
  const wanted = [...new Set(tokens(goal))];
  if (!wanted.length) return 0;
  const actual = new Set(tokens(evidence));
  return (
    wanted.reduce(
      (sum, token) =>
        sum +
        (actual.has(token)
          ? 1
          : groups.some((g) => g.includes(token) && g.some((v) => actual.has(v)))
            ? 0.8
            : 0),
      0,
    ) / wanted.length
  );
}
export function elementScore(goal: string, evidence: string, role: string): number {
  const wanted = tokens(goal),
    actual = tokens(evidence);
  if (wanted.some((t) => ['button'].includes(t)) && role !== 'button') return 0;
  if (wanted.includes('link') && role !== 'link') return 0;
  const actionGroups = groups.filter((g) =>
    ['checkout', 'search', 'delete', 'download', 'save', 'cancel', 'subscribe'].includes(g[0]!),
  );
  if (
    actionGroups.some(
      (g) => wanted.some((t) => g.includes(t)) && !actual.some((t) => g.includes(t)),
    )
  )
    return 0;
  const meaningful = wanted.filter(
    (t) => !['button', 'link', 'input', 'field', 'textbox'].includes(t),
  );
  if (meaningful.length && score(meaningful.join(' '), evidence) === 0) return 0;
  return score(goal, evidence);
}
export function semanticRole(text: string, role: string): string | undefined {
  if (/(?:(?:[$€£]|R\$|USD|EUR|BRL|GBP)\s*\d|\d[\d.,]*\s*(?:USD|EUR|BRL|GBP))/i.test(text))
    return 'price';
  if (['button', 'link', 'textbox', 'searchbox'].includes(role)) {
    for (const label of ['checkout', 'search', 'account']) if (score(label, text) > 0) return label;
  }
  return undefined;
}
