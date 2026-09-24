import { statePath } from '../core/paths.js';
import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import type { Candidate } from './index.js';
export interface SemanticRanker {
  rank(
    goal: string,
    candidates: Candidate[],
  ): Promise<
    {
      id: string;
      score: number;
    }[]
  >;
}
export async function rerank(
  ranker: SemanticRanker | undefined,
  goal: string,
  candidates: Candidate[],
) {
  if (!ranker || !candidates.length) return candidates;
  const scores = z
    .array(z.object({ id: z.string(), score: z.number().finite().min(0).max(1) }))
    .parse(await ranker.rank(goal, candidates));
  const ids = new Set(candidates.map((c) => c.id));
  if (new Set(scores.map((c) => c.id)).size !== scores.length || scores.some((c) => !ids.has(c.id)))
    throw new Error('Ranker returned unknown or duplicate candidates');
  const byId = new Map(scores.map((c) => [c.id, c.score]));
  return candidates
    .map((c) => ({ ...c, score: Math.max(c.score, byId.get(c.id) ?? 0) }))
    .sort((a, b) => b.score - a.score);
}
export interface EmbeddingOptions {
  model?: string;
  cacheDir?: string;
  localFilesOnly?: boolean;
  maxCacheEntries?: number;
}
export class EmbeddingRanker implements SemanticRanker {
  private vectors = new Map<string, number[]>();
  private pipeline?: Promise<(texts: string[]) => Promise<number[][]>>;
  constructor(private options: EmbeddingOptions = {}) {
    if (
      options.maxCacheEntries !== undefined &&
      (!Number.isInteger(options.maxCacheEntries) || options.maxCacheEntries < 0)
    )
      throw new Error('maxCacheEntries must be a non-negative integer');
  }
  private async embed(texts: string[]) {
    this.pipeline ??= (async () => {
      const moduleName = '@huggingface/transformers';
      const { pipeline } = (await import(moduleName)) as {
        pipeline(
          task: string,
          model: string,
          options: Record<string, unknown>,
        ): Promise<
          (
            input: string[],
            options: Record<string, unknown>,
          ) => Promise<{
            tolist(): unknown;
          }>
        >;
      };
      let model = this.options.model ?? 'Xenova/all-MiniLM-L6-v2';
      const options = {
        dtype: 'q8',
        device: 'cpu',
        cache_dir: this.options.cacheDir ?? statePath('models'),
        local_files_only: this.options.localFilesOnly ?? false,
      };
      if (options.local_files_only)
        model =
          isAbsolute(model) || model.startsWith('.')
            ? resolve(model)
            : resolve(options.cache_dir, model);
      const extractor = await pipeline('feature-extraction', model, options);
      return async (input: string[]): Promise<number[][]> =>
        (await extractor(input, { pooling: 'mean', normalize: true })).tolist() as number[][];
    })();
    const available = new Map(
      texts.filter((t) => this.vectors.has(t)).map((t) => [t, this.vectors.get(t)!]),
    );
    const missing = [...new Set(texts.filter((t) => !available.has(t)))];
    if (missing.length) {
      const encode = await this.pipeline;
      for (let offset = 0; offset < missing.length; offset += 16) {
        const batch = missing.slice(offset, offset + 16),
          values = await encode(batch);
        batch.forEach((t, i) => {
          available.set(t, values[i]!);
          this.vectors.set(t, values[i]!);
        });
      }
    }
    const result = texts.map((t) => available.get(t)!);
    while (this.vectors.size > (this.options.maxCacheEntries ?? 2000))
      this.vectors.delete(this.vectors.keys().next().value!);
    return result;
  }
  async rank(goal: string, candidates: Candidate[]) {
    if (!candidates.length) return [];
    const vectors = await this.embed([goal, ...candidates.map((c) => c.text.slice(0, 1500))]);
    const query = vectors[0]!;
    return candidates
      .map((c, i) => ({
        id: c.id,
        score: Math.max(
          0,
          Math.min(
            1,
            query.reduce((sum, v, j) => sum + v * vectors[i + 1]![j]!, 0),
          ),
        ),
      }))
      .sort((a, b) => b.score - a.score);
  }
}
