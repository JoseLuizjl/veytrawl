export function validateOptions(command: string, values: Record<string, unknown>) {
  const commands: Record<string, string[]> = {
    goal: ['crawl'],
    query: ['extract', 'locate'],
    for: ['watch', 'history', 'reset'],
    'max-pages': ['crawl'],
    depth: ['crawl'],
    'delay-ms': ['crawl'],
    concurrency: ['crawl'],
    'max-queue': ['crawl'],
    'min-score': ['crawl'],
    'include-path': ['crawl'],
    'exclude-path': ['crawl'],
    progress: ['crawl'],
    db: ['watch', 'locate', 'history', 'reset'],
    interval: ['watch'],
    count: ['watch'],
    'changes-only': ['watch'],
    feed: ['watch'],
    'max-events': ['watch'],
    offset: ['history'],
    jev: ['crawl', 'locate'],
    embeddings: ['crawl', 'locate'],
    'offline-model': ['crawl', 'locate'],
    role: ['extract'],
    limit: ['extract', 'history'],
    browser: ['doctor', 'dom', 'extract', 'crawl', 'watch', 'locate'],
    'wait-for': ['dom', 'extract', 'crawl', 'watch', 'locate'],
    'settle-ms': ['dom', 'extract', 'crawl', 'watch', 'locate'],
    timeout: ['dom', 'extract', 'crawl', 'watch', 'locate'],
    scope: ['extract', 'watch', 'history', 'reset'],
    'ignore-text': ['watch', 'history', 'reset'],
    'keep-timestamps': ['watch', 'history', 'reset'],
  };
  for (const [option, allowed] of Object.entries(commands))
    if (values[option] !== undefined && !allowed.includes(command))
      throw new Error(`--${option} applies to ${allowed.join(', ')}`);
  if (values['offline-model'] && !values.embeddings)
    throw new Error('--offline-model requires --embeddings');
  if (
    (values['wait-for'] !== undefined || values['settle-ms'] !== undefined) &&
    !values.browser &&
    command !== 'locate'
  )
    throw new Error('--wait-for and --settle-ms require --browser');
  for (const option of ['output', 'feed', 'db', 'scope', 'query', 'role', 'wait-for'])
    if (typeof values[option] === 'string' && !values[option].trim())
      throw new Error(`--${option} requires a non-empty value`);
}
