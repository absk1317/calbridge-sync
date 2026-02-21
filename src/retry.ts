import type pino from "pino";
import { HttpError, getRetryDelayMs, isRetriableStatus, wait } from "./http.js";

export async function withRetry<T>(
  logger: pino.Logger,
  operationName: string,
  fn: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const isHttpError = error instanceof HttpError;
      const canRetry =
        isHttpError && isRetriableStatus(error.status) && attempt < maxAttempts;

      if (!canRetry) {
        throw error;
      }

      const delayMs = getRetryDelayMs(error, attempt);
      logger.warn(
        {
          operationName,
          attempt,
          maxAttempts,
          delayMs,
          status: error.status,
        },
        "Transient API error, retrying",
      );
      await wait(delayMs);
    }
  }
}
