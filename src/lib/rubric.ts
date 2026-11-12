import { env } from "./env";

/**
 * The evaluation rubric.
 *
 * Six dimensions, each scored 0–100 by the AI and weighted into a single
 * overall score. Weights come from RUBRIC_WEIGHTS (comma separated, in the
 * order below) so an institution can re-balance the rubric without a code
 * change. The overall score is always computed server-side from the weights —
 * we never let the model state the final number.
 */

export type RubricDimensionKey =
  | "topic_relevance"
  | "communication"
  | "knowledge"
  | "participation"
  | "reasoning"
  | "listening";

export type RubricDimension = {
  key: RubricDimensionKey;
  label: string;
  weight: number;
  description: string;
};

type RubricDefinition = Omit<RubricDimension, "weight">;

/** Order matches RUBRIC_WEIGHTS in .env. */
const DEFINITIONS: RubricDefinition[] = [
  {
    key: "topic_relevance",
    label: "Topic relevance",
    description: "How consistently contributions address the set topic and push it forward.",
  },
  {
    key: "communication",
    label: "Communication",
    description: "Clarity, concision and structure of what was said, judged on substance not accent.",
  },
  {
    key: "knowledge",
    label: "Content & knowledge",
    description: "Accuracy, depth and use of relevant examples or evidence.",
  },
  {
    key: "participation",
    label: "Participation",
    description: "Willingness to contribute and to keep the discussion moving.",
  },
  {
    key: "reasoning",
    label: "Reasoning",
    description: "Quality of argument: causes, consequences, trade-offs and logical links.",
  },
  {
    key: "listening",
    label: "Listening & teamwork",
    description: "Building on, acknowledging or constructively challenging others' points.",
  },
];

/** The rubric with weights applied from the environment. */
export const RUBRIC_DIMENSIONS: RubricDimension[] = DEFINITIONS.map((definition, index) => ({
  ...definition,
  weight: env.rubricWeights[index] ?? 0,
}));

export const RUBRIC_TOTAL_WEIGHT = RUBRIC_DIMENSIONS.reduce((sum, d) => sum + d.weight, 0);

/** A single dimension's scored result, as stored on Evaluation.dimensions. */
export type DimensionScore = {
  key: string;
  label: string;
  weight: number;
  score: number;
  rationale: string;
};

/**
 * Weighted overall score, 0–100, rounded to one decimal.
 * Missing dimensions contribute 0, so a partial result cannot inflate a score.
 */
export function weightedOverall(scores: Record<string, number>): number {
  if (RUBRIC_TOTAL_WEIGHT === 0) return 0;
  const total = RUBRIC_DIMENSIONS.reduce((sum, dimension) => {
    const score = Number(scores[dimension.key]);
    return sum + (Number.isFinite(score) ? clampScore(score) : 0) * dimension.weight;
  }, 0);
  return Math.round((total / RUBRIC_TOTAL_WEIGHT) * 10) / 10;
}

export function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Human-readable banding used in the UI and in reports. */
export function scoreBand(score: number): { label: string; tone: "good" | "ok" | "weak" } {
  if (score >= 80) return { label: "Excellent", tone: "good" };
  if (score >= 65) return { label: "Strong", tone: "good" };
  if (score >= 50) return { label: "Developing", tone: "ok" };
  return { label: "Needs work", tone: "weak" };
}
