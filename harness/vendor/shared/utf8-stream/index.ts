import { StringDecoder } from "node:string_decoder";

export interface Utf8StreamDecoder {
  write(chunk: Uint8Array): string;
  end(): string;
}

export function createUtf8StreamDecoder(): Utf8StreamDecoder {
  const decoder = new StringDecoder("utf8");
  let ended = false;

  return {
    write(chunk) {
      if (ended) {
        throw new Error("Cannot decode UTF-8 data after the stream has ended.");
      }
      return decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end() {
      if (ended) {
        return "";
      }
      ended = true;
      return decoder.end();
    },
  };
}
