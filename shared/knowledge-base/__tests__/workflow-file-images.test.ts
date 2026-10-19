import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeKnowledgeImageCache,
  readProjectFileIdFromMarkdownImageSrc,
  resolveKnowledgeImageSrc,
} from "../workflow-file-images";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("knowledge markdown image utilities", () => {
  it("extracts workflow file ids from relative and configured-server markdown URLs", () => {
    expect(readProjectFileIdFromMarkdownImageSrc("/api/projects/files/wf_123?download=1", "http://localhost:7125")).toBe("wf_123");
    expect(readProjectFileIdFromMarkdownImageSrc("http://localhost:7125/api/projects/files/wf_a%2Fb", "http://localhost:7125/api")).toBe("wf_a/b");
    expect(readProjectFileIdFromMarkdownImageSrc("https://example.com/api/projects/files/wf_123", "http://localhost:7125")).toBeNull();
    expect(readProjectFileIdFromMarkdownImageSrc("/embed/api/projects/demo/files/wf_123", "http://localhost:7125")).toBeNull();
  });

  it("fetches authenticated workflow files once and returns cached object URLs", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/wf_123");
    const client = {
      fetchProjectFile: vi.fn().mockResolvedValue(new Blob(["png"], { type: "image/png" })),
    };
    const cache = new Map<string, string>();

    const first = await resolveKnowledgeImageSrc("/api/projects/files/wf_123", { client, cache });
    const second = await resolveKnowledgeImageSrc("/api/projects/files/wf_123", { client, cache });

    expect(first).toBe("blob:http://localhost/wf_123");
    expect(second).toBe("blob:http://localhost/wf_123");
    expect(client.fetchProjectFile).toHaveBeenCalledTimes(1);
    expect(client.fetchProjectFile).toHaveBeenCalledWith("wf_123");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("shares in-flight image work and releases an object URL that resolves after its session ends", async () => {
    const response = createDeferred<Blob>();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/late-image");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const client = {
      fetchProjectFile: vi.fn().mockReturnValue(response.promise),
    };
    const cache = new Map<string, string>();

    const first = resolveKnowledgeImageSrc("/api/projects/files/wf_late", { client, cache });
    const second = resolveKnowledgeImageSrc("/api/projects/files/wf_late", { client, cache });
    expect(client.fetchProjectFile).toHaveBeenCalledTimes(1);

    disposeKnowledgeImageCache(cache);
    response.resolve(new Blob(["png"], { type: "image/png" }));

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/late-image");
    expect(cache.size).toBe(0);
  });
});

function createDeferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T) => resolvePromise(value) };
}
