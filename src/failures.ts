import { redactCredentials } from "./git";

/** Returned failures keep semantic codes without exposing diagnostic objects. */
export function describeFailure(error: unknown): { code: string; message: string } {
  return {
    code:
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "FAILED",
    message: redactCredentials(error instanceof Error ? error.message : String(error)),
  };
}
