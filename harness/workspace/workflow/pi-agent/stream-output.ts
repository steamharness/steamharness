import type { PiAgentSessionEvent, PiAgentToolEvent } from "./interface";
import {
  createAnswerItemStartChunk,
  createToolEndChunks,
  createToolStartChunk,
  type OutputItemChunk,
} from "./output-items";

export async function* runPiAgentStream(
  events: AsyncIterable<PiAgentSessionEvent>,
): AsyncGenerator<OutputItemChunk> {
  let answerItemId: string | undefined;
  let answerSegmentIndex = 0;
  const startedToolCalls = new Set<string>();

  const closeAnswerSegment = function* (): Generator<OutputItemChunk> {
    if (answerItemId === undefined) {
      return;
    }
    yield { type: "output_item_end", itemId: answerItemId };
    answerItemId = undefined;
  };

  for await (const event of events) {
    if (event.type === "text_delta") {
      if (event.delta === "") {
        continue;
      }
      if (answerItemId === undefined) {
        answerSegmentIndex += 1;
        answerItemId = createAnswerItemId(answerSegmentIndex);
        yield createAnswerItemStartChunk(answerItemId);
      }
      yield {
        type: "output_item_delta",
        itemId: answerItemId,
        delta: event.delta,
      };
      continue;
    }

    if (event.type === "output_chunk") {
      yield* closeAnswerSegment();
      yield event.chunk;
      continue;
    }

    // Close the inline answer before tool rows so final reports keep the event order.
    yield* closeAnswerSegment();
    for (const chunk of createToolChunks(event, startedToolCalls)) {
      yield chunk;
    }
  }

  yield* closeAnswerSegment();
}

function createToolChunks(event: PiAgentToolEvent, startedToolCalls: Set<string>) {
  if (event.phase === "start") {
    startedToolCalls.add(event.toolCallId);
    return [createToolStartChunk(event)];
  }

  if (event.phase === "end") {
    if (!startedToolCalls.has(event.toolCallId)) {
      startedToolCalls.add(event.toolCallId);
      return [createToolStartChunk(event), ...createToolEndChunks(event)];
    }
    return createToolEndChunks(event);
  }

  return [];
}

function createAnswerItemId(segmentIndex: number): string {
  return `pi-agent-answer-${segmentIndex}`;
}
