import type { DeltaforeAgentInput } from "../interface";

export const DEFAULT_QUERY = "我需要配置 M7，操控速度高";
export const DEFAULT_MAX_ROUNDS = 10;

const MIN_MAX_ROUNDS = 1;
const HARD_MAX_ROUNDS = 10;

export function parseInputArgs(
  args: string[],
  options: {
    message?: string;
  } = {},
): DeltaforeAgentInput {
  const defaultMessage = options.message?.trim() ?? "";
  let query = options.message ?? "";
  let maxRounds = DEFAULT_MAX_ROUNDS;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" || args[i] === "-q") {
      const value = args[++i] ?? "";
      if (defaultMessage === "") {
        query = value;
      }
    } else if (args[i] === "--max-rounds") {
      maxRounds = Number(args[++i] ?? DEFAULT_MAX_ROUNDS);
    } else if (defaultMessage === "") {
      positional.push(args[i]);
    }
  }

  return {
    query: (query || positional.join(" ")).trim() || DEFAULT_QUERY,
    maxRounds: clampRoundCount(maxRounds),
  };
}

export function clampRoundCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_ROUNDS;
  }

  return Math.min(HARD_MAX_ROUNDS, Math.max(MIN_MAX_ROUNDS, Math.trunc(value)));
}
