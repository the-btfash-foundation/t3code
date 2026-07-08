import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CodexSessionImportInput = Schema.Struct({
  limit: Schema.optional(NonNegativeInt),
});
export type CodexSessionImportInput = typeof CodexSessionImportInput.Type;

export const CodexSessionImportResult = Schema.Struct({
  scanned: NonNegativeInt,
  imported: NonNegativeInt,
  skipped: NonNegativeInt,
  failed: NonNegativeInt,
});
export type CodexSessionImportResult = typeof CodexSessionImportResult.Type;

export class CodexSessionImportError extends Schema.TaggedErrorClass<CodexSessionImportError>()(
  "CodexSessionImportError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
