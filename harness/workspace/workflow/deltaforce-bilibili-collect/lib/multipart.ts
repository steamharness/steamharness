import { randomUUID } from "node:crypto";

/**
 * Hand-rolled multipart/form-data builder. Used by the MiniMax file upload
 * client so we do not have to depend on `form-data` or similar npm packages
 * inside the workflow runtime.
 *
 *  phase four minimax M3 video understanding requires
 * `purpose=video_understanding` and a raw binary body; the server only
 * accepts multipart for the upload endpoint, so we build the body here.
 */
export interface MultipartField {
  name: string;
  value: string;
}

export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  buffer: Buffer | Uint8Array;
}

export interface MultipartBody {
  body: Buffer;
  contentType: string;
}

const CRLF = "\r\n";

export function buildMultipartBody(fields: MultipartField[], files: MultipartFile[]): MultipartBody {
  const boundary = `----workflow-code-${randomUUID()}`;
  const parts: Buffer[] = [];

  for (const field of fields) {
    const header = [
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="${escapeQuoted(field.name)}"${CRLF}`,
      CRLF,
      field.value,
      CRLF,
    ].join("");
    parts.push(Buffer.from(header, "utf8"));
  }

  for (const file of files) {
    const header = [
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="${escapeQuoted(file.name)}"; filename="${escapeQuoted(file.filename)}"${CRLF}`,
      `Content-Type: ${file.contentType}${CRLF}`,
      CRLF,
    ].join("");
    parts.push(Buffer.from(header, "utf8"));
    parts.push(Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer));
    parts.push(Buffer.from(CRLF, "utf8"));
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`, "utf8"));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeQuoted(value: string): string {
  return value.replace(/[\\"\r\n]/g, (match) => {
    if (match === "\\") return "\\\\";
    if (match === "\"") return "\\\"";
    return " ";
  });
}
