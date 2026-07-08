import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import {
  CodexSessionImportError,
  type CodexSessionImportInput,
  type CodexSessionImportResult,
  CommandId,
  DEFAULT_MODEL,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const DEFAULT_MODEL_SELECTION: ModelSelection = {
  instanceId: CODEX_INSTANCE,
  model: DEFAULT_MODEL,
};
const decodeCodexSessionJsonLine = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

interface CodexSessionMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
}

interface ParsedCodexSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly messages: ReadonlyArray<CodexSessionMessage>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (isRecord(entry) && typeof entry.text === "string") return entry.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeUserText(text: string): string {
  return text
    .replace(/^\s*## My request for Codex:\s*/i, "")
    .replace(/^\s*# AGENTS\.md instructions for .*?\n\n/is, "")
    .trim();
}

function isEnvironmentContext(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") && trimmed.endsWith("</environment_context>");
}

function extractMessage(entry: unknown, timestamp: string): CodexSessionMessage | null {
  if (!isRecord(entry) || entry.type !== "response_item" || !isRecord(entry.payload)) {
    return null;
  }
  const payload = entry.payload;
  if (payload.type !== "message") {
    return null;
  }
  const role =
    payload.role === "user" || payload.role === "assistant" || payload.role === "system"
      ? payload.role
      : null;
  if (role === null) {
    return null;
  }
  const rawText = textFromContent(payload.content);
  const text = role === "user" ? normalizeUserText(rawText) : rawText.trim();
  if (text.length === 0 || isEnvironmentContext(text)) {
    return null;
  }
  return { role, text, createdAt: timestamp };
}

function titleFromSession(session: ParsedCodexSession): string {
  const firstUserMessage = session.messages.find((message) => message.role === "user")?.text;
  const seed = firstUserMessage ?? `Codex session ${session.sessionId.slice(0, 8)}`;
  const title = seed.replace(/\s+/g, " ").trim().slice(0, 80);
  return title.length > 0 ? title : `Codex session ${session.sessionId.slice(0, 8)}`;
}

function fallbackWorkspaceRoot(): string {
  return NodeOS.homedir();
}

function pathExists(fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> {
  return fs.exists(path).pipe(Effect.orElseSucceed(() => false));
}

function collectJsonlFiles(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<ReadonlyArray<string>> {
  const visit = (dir: string): Effect.Effect<ReadonlyArray<string>> =>
    fs.readDirectory(dir).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, (entry) => {
          const fullPath = path.join(dir, entry);
          return fs.stat(fullPath).pipe(
            Effect.flatMap((info) =>
              info.type === "Directory"
                ? visit(fullPath)
                : Effect.succeed(
                    info.type === "File" && entry.endsWith(".jsonl") ? [fullPath] : [],
                  ),
            ),
            Effect.orElseSucceed(() => []),
          );
        }),
      ),
      Effect.map((groups) => groups.flat()),
      Effect.orElseSucceed(() => []),
    );
  return visit(root);
}

function parseCodexSessionFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
): Effect.Effect<ParsedCodexSession | null, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const raw = yield* fs.readFileString(filePath);
    const messages: CodexSessionMessage[] = [];
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let model: string | null = null;

    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const decoded = decodeCodexSessionJsonLine(line);
      if (Option.isNone(decoded)) continue;
      const entry = decoded.value;
      if (!isRecord(entry) || typeof entry.timestamp !== "string") {
        continue;
      }
      updatedAt = entry.timestamp;
      if (createdAt === null) {
        createdAt = entry.timestamp;
      }
      if (entry.type === "session_meta" && isRecord(entry.payload)) {
        if (typeof entry.payload.id === "string") sessionId = entry.payload.id;
        if (typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
        if (typeof entry.payload.timestamp === "string") createdAt = entry.payload.timestamp;
      }
      if (entry.type === "turn_context" && isRecord(entry.payload)) {
        if (typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
        if (typeof entry.payload.model === "string") model = entry.payload.model;
      }
      const message = extractMessage(entry, entry.timestamp);
      if (message) {
        messages.push(message);
      }
    }

    const fallbackSessionId = path
      .basename(filePath)
      .match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1];
    const resolvedSessionId = sessionId ?? fallbackSessionId ?? null;
    if (resolvedSessionId === null || createdAt === null || messages.length === 0) {
      return null;
    }

    return {
      sessionId: resolvedSessionId,
      cwd: cwd ?? fallbackWorkspaceRoot(),
      createdAt,
      updatedAt: updatedAt ?? createdAt,
      model,
      messages,
    };
  });
}

function commandId(sessionId: string, part: string): CommandId {
  return CommandId.make(`codex-import-${sessionId}-${part}`);
}

function modelSelection(session: ParsedCodexSession): ModelSelection {
  return {
    ...DEFAULT_MODEL_SELECTION,
    model: session.model ?? DEFAULT_MODEL_SELECTION.model,
  };
}

export const importCodexSessions = Effect.fn("CodexSessionImport.importCodexSessions")(function* (
  input: CodexSessionImportInput,
) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sessionsRoot = path.join(NodeOS.homedir(), ".codex", "sessions");
  const files = yield* collectJsonlFiles(fs, path, sessionsRoot).pipe(
    Effect.mapError(
      (cause) =>
        new CodexSessionImportError({
          message: "Failed to scan ~/.codex/sessions.",
          cause,
        }),
    ),
  );
  const limitedFiles = files
    .toSorted((left, right) => right.localeCompare(left))
    .slice(0, input.limit ?? files.length);

  const projectIdsByWorkspaceRoot = new Map<string, ProjectId>();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of limitedFiles) {
    const parsed = yield* parseCodexSessionFile(fs, path, file).pipe(
      Effect.mapError(
        (cause) =>
          new CodexSessionImportError({
            message: `Failed to parse Codex session '${file}'.`,
            cause,
          }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Skipping unreadable Codex session file.", { file, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
    if (parsed === null) {
      skipped += 1;
      continue;
    }

    const threadId = ThreadId.make(`codex-import-${parsed.sessionId}`);
    const existingThread = yield* snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(
        (cause) =>
          new CodexSessionImportError({
            message: `Failed to check imported Codex session '${parsed.sessionId}'.`,
            cause,
          }),
      ),
    );
    if (existingThread !== null) {
      skipped += 1;
      continue;
    }

    const cwdExists = yield* pathExists(fs, parsed.cwd);
    const workspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(cwdExists ? parsed.cwd : fallbackWorkspaceRoot())
      .pipe(
        Effect.mapError(
          (cause) =>
            new CodexSessionImportError({
              message: `Failed to normalize workspace root for Codex session '${parsed.sessionId}'.`,
              cause,
            }),
        ),
      );

    let projectId = projectIdsByWorkspaceRoot.get(workspaceRoot);
    const commands: OrchestrationCommand[] = [];
    if (projectId === undefined) {
      const existingProject = yield* snapshots.getActiveProjectByWorkspaceRoot(workspaceRoot).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError(
          (cause) =>
            new CodexSessionImportError({
              message: `Failed to find project for Codex session '${parsed.sessionId}'.`,
              cause,
            }),
        ),
      );
      projectId =
        existingProject?.id ?? ProjectId.make(stableId("codex-import-project", workspaceRoot));
      projectIdsByWorkspaceRoot.set(workspaceRoot, projectId);
      if (existingProject === null) {
        commands.push({
          type: "project.create",
          commandId: commandId(parsed.sessionId, "project"),
          projectId,
          title: path.basename(workspaceRoot) || "Codex imports",
          workspaceRoot,
          defaultModelSelection: DEFAULT_MODEL_SELECTION,
          createdAt: parsed.createdAt,
        });
      }
    }

    commands.push({
      type: "thread.create",
      commandId: commandId(parsed.sessionId, "thread"),
      threadId,
      projectId,
      title: titleFromSession(parsed),
      modelSelection: modelSelection(parsed),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: parsed.createdAt,
    });
    parsed.messages.forEach((message: CodexSessionMessage, index: number) => {
      commands.push({
        type: "thread.message.append",
        commandId: commandId(parsed.sessionId, `message-${index}`),
        threadId,
        messageId: MessageId.make(`codex-import-${parsed.sessionId}-${index}`),
        role: message.role,
        text: message.text,
        turnId: null,
        streaming: false,
        createdAt: message.createdAt,
      });
    });
    commands.push({
      type: "thread.session.set",
      commandId: commandId(parsed.sessionId, "session"),
      threadId,
      session: {
        threadId,
        status: "stopped",
        providerName: CODEX_PROVIDER,
        providerInstanceId: CODEX_INSTANCE,
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: parsed.updatedAt,
      },
      createdAt: parsed.updatedAt,
    });

    const result = yield* Effect.forEach(commands, (command) => engine.dispatch(command), {
      concurrency: 1,
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
        onSuccess: () => ({ _tag: "Success" as const }),
      }),
    );
    if (result._tag === "Failure") {
      failed += 1;
      yield* Effect.logWarning("Failed to import Codex session.", {
        sessionId: parsed.sessionId,
        file,
        cause: result.cause,
      });
      continue;
    }
    imported += 1;
  }

  return {
    scanned: limitedFiles.length,
    imported,
    skipped,
    failed,
  } satisfies CodexSessionImportResult;
});
