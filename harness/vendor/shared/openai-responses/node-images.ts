import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import {
  OpenAIProtocolError,
  type OpenAIImageMimeType,
  type OpenAIMessageItem,
  type OpenAIStoredImageReference,
} from "./index";

export const OPENAI_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OPENAI_IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const OPENAI_IMAGE_MAX_COUNT = 16;
export const OPENAI_IMAGE_TIMEOUT_MS = 10_000;
export const OPENAI_IMAGE_MAX_REDIRECTS = 3;

const STORED_IMAGE_URL_PREFIX = "workflow-openai-file:";
const BLOCKED_IPV6 = new BlockList();
BLOCKED_IPV6.addAddress("::", "ipv6");
BLOCKED_IPV6.addAddress("::1", "ipv6");
BLOCKED_IPV6.addSubnet("::", 96, "ipv6");
BLOCKED_IPV6.addSubnet("::ffff:0:0", 96, "ipv6");
BLOCKED_IPV6.addSubnet("64:ff9b::", 96, "ipv6");
BLOCKED_IPV6.addSubnet("64:ff9b:1::", 48, "ipv6");
BLOCKED_IPV6.addSubnet("100::", 64, "ipv6");
BLOCKED_IPV6.addSubnet("fc00::", 7, "ipv6");
BLOCKED_IPV6.addSubnet("fec0::", 10, "ipv6");
BLOCKED_IPV6.addSubnet("fe80::", 10, "ipv6");
BLOCKED_IPV6.addSubnet("ff00::", 8, "ipv6");
BLOCKED_IPV6.addSubnet("2001::", 23, "ipv6");
BLOCKED_IPV6.addSubnet("2001:db8::", 32, "ipv6");
BLOCKED_IPV6.addSubnet("2002::", 16, "ipv6");

export interface OpenAIImageFileStorage {
  saveImages(options: {
    projectId: string;
    files: Array<{ name: string; mimeType: OpenAIImageMimeType; buffer: Buffer }>;
  }): Promise<Array<{ id: string }>>;
  getImage(fileId: string): Promise<{
    projectId: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  deleteImage(fileId: string): Promise<void>;
}

interface MaterializedImage {
  itemId: string;
  contentIndex: number;
  buffer: Buffer;
  mimeType: OpenAIImageMimeType;
  reference?: OpenAIStoredImageReference;
}

export interface MaterializedOpenAIImages {
  hostMessages: OpenAIMessageItem[];
  storedMessages: OpenAIMessageItem[];
  imageReferences: OpenAIStoredImageReference[];
  newImageReferences: OpenAIStoredImageReference[];
  newFileIds: string[];
}

export async function materializeOpenAIMessageImages(options: {
  storage: OpenAIImageFileStorage;
  projectId: string;
  messages: OpenAIMessageItem[];
  existingReferences?: OpenAIStoredImageReference[];
}): Promise<MaterializedOpenAIImages> {
  const existing = new Map(
    (options.existingReferences ?? []).map((reference) => [
      imageLocationKey(reference.itemId, reference.contentIndex),
      reference,
    ]),
  );
  const images: MaterializedImage[] = [];

  for (const item of options.messages) {
    if (!item.id) throw new Error("OpenAI image messages must have ids before materialization.");
    for (const [contentIndex, part] of item.content.entries()) {
      if (part.type !== "input_image") continue;
      if (images.length >= OPENAI_IMAGE_MAX_COUNT) {
        throw invalidImage(`A request may contain at most ${OPENAI_IMAGE_MAX_COUNT} images.`);
      }
      const reference = existing.get(imageLocationKey(item.id, contentIndex));
      if (reference) {
        const file = await options.storage.getImage(reference.fileId);
        if (file.projectId !== options.projectId || file.mimeType !== reference.mimeType) {
          throw invalidImage("A stored input image is unavailable for this project.");
        }
        const mimeType = validateOpenAIImage(file.buffer, reference.mimeType);
        images.push({ itemId: item.id, contentIndex, buffer: file.buffer, mimeType, reference });
        continue;
      }
      if (part.image_url.startsWith(STORED_IMAGE_URL_PREFIX)) {
        throw invalidImage("A stored input image reference is missing or no longer available.");
      }
      const downloaded = part.image_url.startsWith("data:")
        ? decodeOpenAIImageDataUrl(part.image_url)
        : await downloadOpenAIImage(part.image_url);
      images.push({ itemId: item.id, contentIndex, ...downloaded });
    }
  }

  const totalBytes = images.reduce((total, image) => total + image.buffer.byteLength, 0);
  if (totalBytes > OPENAI_IMAGE_MAX_TOTAL_BYTES) {
    throw invalidImage(`Input images exceed the ${formatBytes(OPENAI_IMAGE_MAX_TOTAL_BYTES)} combined limit.`);
  }

  const pending = images.filter((image) => !image.reference);
  const saved = pending.length === 0
    ? []
    : await options.storage.saveImages({
        projectId: options.projectId,
        files: pending.map((image, index) => ({
          name: `openai-image-${index + 1}.${extensionForMimeType(image.mimeType)}`,
          mimeType: image.mimeType,
          buffer: image.buffer,
        })),
      });
  if (saved.length !== pending.length) {
    await deleteOpenAIManagedFiles(
      options.storage,
      saved.map((file) => file.id),
    );
    throw new Error("OpenAI image storage returned an unexpected file count.");
  }
  const newImageReferences: OpenAIStoredImageReference[] = pending.map((image, index) => ({
    itemId: image.itemId,
    contentIndex: image.contentIndex,
    fileId: saved[index]!.id,
    mimeType: image.mimeType,
  }));
  const newByLocation = new Map(
    newImageReferences.map((reference) => [
      imageLocationKey(reference.itemId, reference.contentIndex),
      reference,
    ]),
  );
  const imageReferences = images.map((image) => image.reference
    ?? newByLocation.get(imageLocationKey(image.itemId, image.contentIndex))!);
  const imageByLocation = new Map(
    images.map((image) => [imageLocationKey(image.itemId, image.contentIndex), image]),
  );
  const referenceByLocation = new Map(
    imageReferences.map((reference) => [
      imageLocationKey(reference.itemId, reference.contentIndex),
      reference,
    ]),
  );

  return {
    hostMessages: mapImageParts(options.messages, (itemId, contentIndex) => {
      const image = imageByLocation.get(imageLocationKey(itemId, contentIndex))!;
      return `data:${image.mimeType};base64,${image.buffer.toString("base64")}`;
    }),
    storedMessages: mapImageParts(options.messages, (itemId, contentIndex) => {
      const reference = referenceByLocation.get(imageLocationKey(itemId, contentIndex))!;
      return `${STORED_IMAGE_URL_PREFIX}${reference.fileId}`;
    }),
    imageReferences,
    newImageReferences,
    newFileIds: newImageReferences.map((reference) => reference.fileId),
  };
}

export async function hydrateStoredOpenAIMessageImages(options: {
  storage: OpenAIImageFileStorage;
  projectId: string;
  messages: OpenAIMessageItem[];
  imageReferences?: OpenAIStoredImageReference[];
}): Promise<OpenAIMessageItem[]> {
  if (!options.imageReferences?.length) return options.messages;
  const materialized = await materializeOpenAIMessageImages({
    storage: options.storage,
    projectId: options.projectId,
    messages: options.messages,
    existingReferences: options.imageReferences,
  });
  return materialized.hostMessages;
}

export async function deleteOpenAIManagedFiles(
  storage: OpenAIImageFileStorage,
  fileIds: string[],
): Promise<void> {
  await Promise.all([...new Set(fileIds)].map(async (fileId) => {
    try {
      await storage.deleteImage(fileId);
    } catch {
      // Resource deletion is idempotent when a managed file was already removed.
    }
  }));
}

export function decodeOpenAIImageDataUrl(value: string): {
  buffer: Buffer;
  mimeType: OpenAIImageMimeType;
} {
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/iu.exec(value);
  if (!match) throw invalidImage("The image data URL is malformed or uses an unsupported image type.");
  const encoded = match[2]!.replace(/\s/gu, "");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.byteLength === 0 || buffer.byteLength > OPENAI_IMAGE_MAX_BYTES) {
    throw invalidImage(`Each input image must be between 1 byte and ${formatBytes(OPENAI_IMAGE_MAX_BYTES)}.`);
  }
  const mimeType = validateOpenAIImage(buffer, match[1]!.toLowerCase() as OpenAIImageMimeType);
  return { buffer, mimeType };
}

export async function downloadOpenAIImage(value: string): Promise<{
  buffer: Buffer;
  mimeType: OpenAIImageMimeType;
}> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidImage("The input image URL is invalid.");
  }
  for (let redirect = 0; redirect <= OPENAI_IMAGE_MAX_REDIRECTS; redirect += 1) {
    assertDownloadUrl(url);
    const address = await resolvePublicAddress(url.hostname);
    const response = await requestImage(url, address);
    if (isRedirect(response.statusCode)) {
      response.resume();
      const location = response.headers.location;
      if (!location || redirect === OPENAI_IMAGE_MAX_REDIRECTS) {
        throw invalidImage("The input image URL exceeded the redirect limit.");
      }
      url = new URL(location, url);
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw invalidImage(`The input image URL returned HTTP ${response.statusCode ?? 0}.`);
    }
    const contentEncoding = headerValue(response.headers["content-encoding"]);
    if (contentEncoding && contentEncoding !== "identity") {
      response.resume();
      throw invalidImage("Compressed input image responses are not accepted.");
    }
    const contentLength = Number(headerValue(response.headers["content-length"]));
    if (Number.isFinite(contentLength) && contentLength > OPENAI_IMAGE_MAX_BYTES) {
      response.resume();
      throw invalidImage(`Each input image may be at most ${formatBytes(OPENAI_IMAGE_MAX_BYTES)}.`);
    }
    const buffer = await readLimitedResponse(response);
    const declaredMime = normalizeDeclaredMimeType(headerValue(response.headers["content-type"]));
    const mimeType = validateOpenAIImage(buffer, declaredMime);
    return { buffer, mimeType };
  }
  throw invalidImage("The input image URL could not be downloaded.");
}

export function assertPublicOpenAIImageAddress(address: string): void {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
  if (mapped) return assertPublicOpenAIImageAddress(mapped);
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    const blocked = a === 0
      || a === 10
      || a === 127
      || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a! >= 224;
    if (!blocked) return;
  } else if (family === 6 && !BLOCKED_IPV6.check(address, "ipv6")) {
    return;
  }
  throw invalidImage("Input image URLs must resolve only to public network addresses.");
}

export function validateOpenAIImage(
  buffer: Buffer,
  declaredMimeType?: OpenAIImageMimeType,
): OpenAIImageMimeType {
  if (buffer.byteLength === 0 || buffer.byteLength > OPENAI_IMAGE_MAX_BYTES) {
    throw invalidImage(`Each input image must be between 1 byte and ${formatBytes(OPENAI_IMAGE_MAX_BYTES)}.`);
  }
  const detected = detectImageMimeType(buffer);
  if (!detected) throw invalidImage("The input image content is not a supported JPEG, PNG, WebP, or GIF file.");
  if (declaredMimeType && declaredMimeType !== detected) {
    throw invalidImage("The input image MIME type does not match its file content.");
  }
  return detected;
}

function detectImageMimeType(buffer: Buffer): OpenAIImageMimeType | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw invalidImage("The input image host did not resolve.");
  for (const result of addresses) assertPublicOpenAIImageAddress(result.address);
  return { address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6 };
}

function requestImage(url: URL, address: { address: string; family: 4 | 6 }): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: {
        accept: "image/jpeg,image/png,image/webp,image/gif",
        "accept-encoding": "identity",
        "user-agent": "SteamHarness-OpenAI-Gateway/1.0",
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, resolve);
    const timeout = setTimeout(
      () => request.destroy(invalidImage("The input image download timed out.")),
      OPENAI_IMAGE_TIMEOUT_MS,
    );
    request.once("error", (error) => reject(
      error instanceof OpenAIProtocolError
        ? error
        : invalidImage("The input image could not be downloaded."),
    ));
    request.once("close", () => clearTimeout(timeout));
    request.end();
  });
}

async function readLimitedResponse(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > OPENAI_IMAGE_MAX_BYTES) {
      response.destroy();
      throw invalidImage(`Each input image may be at most ${formatBytes(OPENAI_IMAGE_MAX_BYTES)}.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function mapImageParts(
  messages: OpenAIMessageItem[],
  resolveUrl: (itemId: string, contentIndex: number) => string,
): OpenAIMessageItem[] {
  return messages.map((item) => ({
    ...item,
    content: item.content.map((part, contentIndex) => part.type === "input_image"
      ? { ...part, image_url: resolveUrl(item.id!, contentIndex) }
      : part),
  }));
}

function assertDownloadUrl(url: URL): void {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw invalidImage("Input image URLs must use HTTP(S) without embedded credentials.");
  }
}

function normalizeDeclaredMimeType(value: string | undefined): OpenAIImageMimeType | undefined {
  if (!value) return undefined;
  const normalized = value.split(";", 1)[0]!.trim().toLowerCase();
  if (
    normalized === "image/jpeg"
    || normalized === "image/png"
    || normalized === "image/webp"
    || normalized === "image/gif"
  ) {
    return normalized;
  }
  throw invalidImage("The input image response has an unsupported MIME type.");
}

function imageLocationKey(itemId: string, contentIndex: number): string {
  return `${itemId}:${contentIndex}`;
}

function isRedirect(status: number | undefined): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function extensionForMimeType(mimeType: OpenAIImageMimeType): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType.slice("image/".length);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function invalidImage(message: string): OpenAIProtocolError {
  return new OpenAIProtocolError({
    message,
    param: "input",
    code: "invalid_image",
  });
}
