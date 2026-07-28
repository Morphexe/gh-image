import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import type { UploadFile } from "./files.js";

export interface MultipartPayload {
  body: Buffer | Readable;
  contentLength: number;
  contentType: string;
}

function safeToken(value: string, label: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${label} contains a newline`);
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${safeToken(name, "field name")}"\r\n\r\n${value}\r\n`,
  );
}

function closingPart(boundary: string): Buffer {
  return Buffer.from(`--${boundary}--\r\n`);
}

function boundaryValue(): string {
  return `--------------------------${randomBytes(12).toString("hex")}`;
}

export function multipartFields(fields: ReadonlyArray<readonly [string, string]>): MultipartPayload {
  const boundary = boundaryValue();
  const body = Buffer.concat([
    ...fields.map(([name, value]) => fieldPart(boundary, name, value)),
    closingPart(boundary),
  ]);
  return {
    body,
    contentLength: body.length,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function multipartFile(
  fields: ReadonlyArray<readonly [string, string]>,
  file: UploadFile,
  contentType: string,
): MultipartPayload {
  const boundary = boundaryValue();
  const fieldParts = fields.map(([name, value]) => fieldPart(boundary, name, value));
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeToken(file.name, "file name")}"\r\nContent-Type: ${safeToken(contentType, "content type")}\r\n\r\n`,
  );
  const fileTrailer = Buffer.from("\r\n");
  const close = closingPart(boundary);
  const contentLength =
    fieldParts.reduce((length, part) => length + part.length, 0) +
    fileHeader.length +
    file.size +
    fileTrailer.length +
    close.length;

  async function* parts(): AsyncGenerator<Buffer> {
    yield* fieldParts;
    yield fileHeader;
    for await (const chunk of file.handle.createReadStream({ autoClose: false, start: 0 })) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    yield fileTrailer;
    yield close;
  }

  return {
    body: Readable.from(parts()),
    contentLength,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
