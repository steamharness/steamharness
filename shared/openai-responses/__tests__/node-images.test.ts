import { describe, expect, it, vi } from "vitest";
import type { OpenAIMessageItem } from "@workflow-code/openai-responses";
import {
  materializeOpenAIMessageImages,
  type OpenAIImageFileStorage,
} from "@workflow-code/openai-responses/node-images";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

describe("OpenAI image materialization", () => {
  it("deletes files returned by a malformed partial batch result", async () => {
    const deleteImage = vi.fn(async () => undefined);
    const storage: OpenAIImageFileStorage = {
      async saveImages() {
        return [{ id: "wf_partial" }];
      },
      async getImage() {
        throw new Error("not used");
      },
      deleteImage,
    };
    const messages: OpenAIMessageItem[] = [{
      id: "msg_input",
      type: "message",
      role: "user",
      status: "completed",
      content: [
        { type: "input_image", image_url: PNG_DATA_URL },
        { type: "input_image", image_url: PNG_DATA_URL },
      ],
    }];

    await expect(materializeOpenAIMessageImages({
      storage,
      projectId: "conversation-project",
      messages,
    })).rejects.toThrow("unexpected file count");
    expect(deleteImage).toHaveBeenCalledOnce();
    expect(deleteImage).toHaveBeenCalledWith("wf_partial");
  });
});
