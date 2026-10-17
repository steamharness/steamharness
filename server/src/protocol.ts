import type { Response } from "express";
import { readSteamHarnessI18nDescriptor } from "@steamharness/i18n";

export interface ApiSuccess<T> {
  errCode: 0;
  errMessage: "";
  data: T;
}

export interface ApiFailure {
  errCode: number;
  errMessage: string;
  data?: unknown;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export class HttpError extends Error {
  readonly statusCode: number;
  readonly errCode: number;
  readonly data?: unknown;
  readonly messageKey?: string;
  readonly params?: Record<string, unknown>;

  constructor(
    statusCode: number,
    errCode: number,
    message: string,
    data?: unknown,
    opts?: { messageKey?: string; params?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.errCode = errCode;
    this.data = data;
    this.messageKey = opts?.messageKey;
    this.params = opts?.params;
  }
}

export function ok<T>(data: T): ApiSuccess<T> {
  return { errCode: 0, errMessage: "", data };
}

export function fail(errCode: number, errMessage: string, data?: unknown): ApiFailure {
  return data === undefined ? { errCode, errMessage } : { errCode, errMessage, data };
}

export function sendJson(
  response: Response,
  statusCode: number,
  payload: ApiResponse<unknown>,
): void {
  response.status(statusCode).json(payload);
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (
    error instanceof Error &&
    "status" in error &&
    error.status === 413
  ) {
    return new HttpError(413, 413, "Request body is too large.", undefined, {
      messageKey: "server:requestBodyTooLarge",
    });
  }
  if (error instanceof Error) return new HttpError(500, 500, error.message);
  return new HttpError(500, 500, String(error));
}

export function toHttpErrorWithStatus(
  error: unknown,
  statusCode: number,
  errCode: number,
  fallback: string,
): HttpError {
  if (error instanceof HttpError) return error;
  const descriptor = readSteamHarnessI18nDescriptor(error);
  const message = error instanceof Error && error.message.trim() !== ""
    ? error.message
    : fallback;
  return new HttpError(
    statusCode,
    errCode,
    message,
    descriptor === undefined ? undefined : { steamHarnessI18n: descriptor },
    descriptor === undefined
      ? undefined
      : {
          messageKey: `${descriptor.namespace}:${descriptor.key}`,
          params: descriptor.values,
        },
  );
}
