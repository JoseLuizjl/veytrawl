import { redactSensitiveText } from '../core/privacy.js';
import { z } from 'zod';
export interface Candidate {
  id: string;
  text: string;
  score: number;
}
export interface DecisionProvider {
  choose(
    goal: string,
    candidates: Candidate[],
  ): Promise<{
    id: string;
  } | null>;
}
export async function decide(
  provider: DecisionProvider,
  goal: string,
  candidates: Candidate[],
): Promise<string | undefined> {
  const response = z
    .object({ id: z.string() })
    .nullable()
    .parse(
      await provider.choose(
        redactSensitiveText(goal),
        candidates.map((candidate) => ({
          ...candidate,
          text: redactSensitiveText(candidate.text),
        })),
      ),
    );
  if (!response) return undefined;
  if (!candidates.some((c) => c.id === response.id))
    throw new Error('Provider returned an unknown candidate');
  return response.id;
}
