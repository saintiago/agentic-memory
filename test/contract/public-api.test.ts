import { describe, expect, expectTypeOf, it } from "vitest";
import * as packageExports from "../../src/index.js";
import * as embeddings from "../../src/embeddings/index.js";
import * as ingestionQueue from "../../src/ingestion-queue/index.js";
import * as languageModel from "../../src/language-model/index.js";
import * as memory from "../../src/memory/index.js";
import * as noteStore from "../../src/note-store/index.js";
import { noteSchema } from "../../src/note-store/index.js";
import type {
  AddInput,
  AgenticMemory,
  Attributes,
  ConstructionResponse,
  ConstructionSource,
  ContextCorrectionInput,
  ContextCorrectionPreparation,
  ContextCorrectionPreparer,
  Cursor,
  Embedder,
  EmbeddingSpace,
  EmbeddedNote,
  EmbeddedPage,
  EvolutionResponse,
  EvolutionSource,
  EvolutionUpdate,
  IngestionQueue,
  InsertionPlan,
  JsonValue,
  LanguageModel,
  LegacyReceipt,
  MemoryError,
  MemoryOperation,
  MemoryOptions,
  MemoryPreparer,
  MemoryPrompts,
  MemoryStage,
  ModelFailureCategory,
  ModelRequest,
  ModelRequestError,
  Note,
  NoteStore,
  Page,
  PrepareInput,
  QueueObservation,
  QueueReceipt,
  QueueReceiptStatus,
  QueueSubmission,
  QueueStatus,
  ReconcileOutcome,
  ReferenceEmbedder,
  ReferenceEmbedderOptions,
  ReferenceEncoderSettings,
  SearchOptions,
  SearchResult,
} from "../../src/index.js";

/** docs/development.md#repository-layout-and-public-boundaries */

describe("package root exports", () => {
  it("re-exports the NoteStore contract through the same modules as its component index", () => {
    const exportedNames = [
      "attributesSchema",
      "cursorSchema",
      "embeddedNoteSchema",
      "embeddedPageSchema",
      "jsonValueSchema",
      "matchSchema",
      "noteIdSchema",
      "noteSchema",
      "pageSchema",
      "vectorSchema",
    ] as const;

    expect(Object.keys(packageExports)).toEqual(
      expect.arrayContaining([...exportedNames]),
    );
    for (const name of exportedNames) {
      expect(packageExports[name]).toBe(noteStore[name]);
    }
  });

  it("keeps the documented contract types usable through the package root", () => {
    expectTypeOf<EmbeddingSpace>().toMatchTypeOf<{
      readonly id: string;
      readonly dimensions: number;
      readonly distance: "Cosine";
    }>();
    expectTypeOf<Embedder["embed"]>().returns.toEqualTypeOf<
      Promise<number[]>
    >();
    expectTypeOf<LanguageModel["generate"]>()
      .parameter(0)
      .toEqualTypeOf<ModelRequest>();
    expectTypeOf<ModelRequest["stage"]>().toEqualTypeOf<
      "construct" | "evolve"
    >();
    expectTypeOf<NoteStore["nearest"]>().parameter(1).toEqualTypeOf<number>();
    expectTypeOf<NoteStore["page"]>().returns.toEqualTypeOf<Promise<Page>>();
    expectTypeOf<NoteStore["pageEmbedded"]>().returns.toEqualTypeOf<
      Promise<EmbeddedPage>
    >();
    expectTypeOf<NoteStore["pageEmbedded"]>()
      .parameter(1)
      .toEqualTypeOf<Cursor | undefined>();
    expectTypeOf<EmbeddedPage["records"]>().toEqualTypeOf<EmbeddedNote[]>();
    expectTypeOf<Note["updatedAt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AddInput["timestamp"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MemoryOptions["neighbors"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<SearchOptions["linkedLimit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<SearchResult>().toMatchTypeOf<
      { note: Note; via: "match"; score: number } | { note: Note; via: "link" }
    >();
  });

  it("keeps the documented memory operations usable through the package root", () => {
    expectTypeOf<AgenticMemory["add"]>().returns.toEqualTypeOf<Promise<Note>>();
    expectTypeOf<AgenticMemory["get"]>().returns.toEqualTypeOf<
      Promise<Note | undefined>
    >();
    expectTypeOf<AgenticMemory["page"]>().returns.toEqualTypeOf<
      Promise<Page>
    >();
    expectTypeOf<AgenticMemory["page"]>()
      .parameter(1)
      .toEqualTypeOf<Cursor | undefined>();
    expectTypeOf<AgenticMemory["search"]>().returns.toEqualTypeOf<
      Promise<SearchResult[]>
    >();
    expectTypeOf<AgenticMemory["search"]>()
      .parameter(1)
      .toEqualTypeOf<SearchOptions | undefined>();
  });

  it("re-exports the prompt and response contracts through the memory component index", () => {
    const exportedNames = [
      "ModelResponseError",
      "assembleConstructionPrompt",
      "assembleEvolutionPrompt",
      "constructionResponseSchema",
      "defaultPrompts",
      "evolutionResponseSchema",
      "evolutionUpdateSchema",
      "readConstructionResponse",
      "readEvolutionResponse",
    ] as const;

    for (const name of exportedNames) {
      expect(packageExports[name]).toBe(memory[name]);
    }
  });

  it("re-exports the memory implementation through the memory component index", () => {
    const exportedNames = [
      "AgenticMemory",
      "MemoryError",
      "embeddingText",
    ] as const;

    for (const name of exportedNames) {
      expect(packageExports[name]).toBe(memory[name]);
    }
  });

  it("re-exports the model failure contract through the language-model index", () => {
    expect(packageExports["ModelRequestError"]).toBe(
      languageModel["ModelRequestError"],
    );
    // The queue classifies by this machine-readable category, not by provider text.
    expectTypeOf<ModelFailureCategory>().toEqualTypeOf<
      "authentication" | "resource" | "unavailable" | "output"
    >();
    expectTypeOf<
      ModelRequestError["category"]
    >().toEqualTypeOf<ModelFailureCategory>();
    expectTypeOf<ModelRequestError["stage"]>().toEqualTypeOf<
      ModelRequest["stage"]
    >();
  });

  it("keeps the documented memory failure fields usable through the package root", () => {
    expectTypeOf<MemoryError["operation"]>().toEqualTypeOf<MemoryOperation>();
    expectTypeOf<MemoryError["stage"]>().toEqualTypeOf<MemoryStage>();
    expectTypeOf<MemoryError["persistence"]>().toEqualTypeOf<
      "unchanged" | "uncertain"
    >();
    expectTypeOf<MemoryError["noteId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MemoryError["affectedNoteIds"]>().toEqualTypeOf<
      readonly string[] | undefined
    >();
    expectTypeOf<AddInput["metadata"]>().toEqualTypeOf<
      Record<string, JsonValue> | undefined
    >();
    expectTypeOf<
      ReturnType<typeof packageExports.embeddingText>
    >().toEqualTypeOf<string>();
    expectTypeOf<MemoryError["reason"]>().toEqualTypeOf<string>();
    expectTypeOf<MemoryOperation>().toEqualTypeOf<
      | "add"
      | "get"
      | "page"
      | "search"
      | "prepare"
      | "prepareContextCorrection"
      | "apply"
    >();
  });

  it("keeps the reviewed context correction contract usable through the package root", () => {
    expect(packageExports.contextCorrectionInputSchema).toBe(
      memory.contextCorrectionInputSchema,
    );
    expectTypeOf<AgenticMemory["prepareContextCorrection"]>()
      .parameter(0)
      .toEqualTypeOf<ContextCorrectionInput>();
    expectTypeOf<
      AgenticMemory["prepareContextCorrection"]
    >().returns.toEqualTypeOf<Promise<ContextCorrectionPreparation>>();
    expectTypeOf<ContextCorrectionInput>().toEqualTypeOf<{
      expected: Note;
      attributes: Attributes;
    }>();
    expectTypeOf<ContextCorrectionPreparation["note"]>().toEqualTypeOf<Note>();
    expectTypeOf<ContextCorrectionPreparation["plan"]>().toEqualTypeOf<
      InsertionPlan | undefined
    >();
    expectTypeOf<ContextCorrectionPreparer["prepareContextCorrection"]>()
      .parameter(0)
      .toEqualTypeOf<ContextCorrectionInput>();
    expectTypeOf<
      ContextCorrectionPreparer["prepareContextCorrection"]
    >().returns.toEqualTypeOf<Promise<ContextCorrectionPreparation>>();
  });

  it("keeps the durable insertion contracts usable through the package root", () => {
    expect(packageExports.representationVersion).toBe("amem-note-v1");
    expect(packageExports.insertionPlanVersion).toBe(1);
    expectTypeOf<AgenticMemory["prepare"]>()
      .parameter(0)
      .toEqualTypeOf<PrepareInput>();
    expectTypeOf<AgenticMemory["prepare"]>().returns.toEqualTypeOf<
      Promise<InsertionPlan>
    >();
    expectTypeOf<AgenticMemory["apply"]>()
      .parameter(0)
      .toEqualTypeOf<InsertionPlan>();
    expectTypeOf<AgenticMemory["apply"]>().returns.toEqualTypeOf<
      Promise<Note>
    >();
    expectTypeOf<PrepareInput["noteId"]>().toEqualTypeOf<string>();
    expectTypeOf<PrepareInput["timestamp"]>().toEqualTypeOf<string>();
    expectTypeOf<InsertionPlan["version"]>().toEqualTypeOf<1>();
    expectTypeOf<
      InsertionPlan["representation"]
    >().toEqualTypeOf<"amem-note-v1">();
    expectTypeOf<
      InsertionPlan["embeddingSpace"]
    >().toEqualTypeOf<EmbeddingSpace>();
    expectTypeOf<InsertionPlan["records"]>().toEqualTypeOf<EmbeddedNote[]>();
  });

  it("re-exports the ingestion queue through the same modules as its component index", () => {
    const exportedNames = [
      "QueueBindingError",
      "QueueClosedError",
      "QueueConflictError",
      "QueueRequestError",
      "QueueWorkerLockedError",
      "legacyImportResultSchema",
      "legacyReceiptSchema",
      "openIngestionQueue",
      "queueBindingSchema",
      "queueObservationSchema",
      "queueReceiptSchema",
      "queueReceiptStatuses",
      "queueStatusSchema",
      "reconcileOutcomeSchema",
    ] as const;

    for (const name of exportedNames) {
      expect(packageExports[name]).toBe(ingestionQueue[name]);
    }
  });

  it("keeps the ingestion queue contract types usable through the package root", () => {
    expectTypeOf<QueueReceiptStatus>().toEqualTypeOf<
      "queued" | "processing" | "retrying" | "stored" | "failed" | "blocked"
    >();
    expectTypeOf<QueueObservation["sourceKey"]>().toEqualTypeOf<string>();
    expectTypeOf<QueueObservation["timestamp"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<QueueReceipt["attemptCount"]>().toEqualTypeOf<number>();
    expectTypeOf<QueueReceipt["noteId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<QueueStatus["counts"]["blocked"]>().toEqualTypeOf<number>();
    expectTypeOf<LegacyReceipt["status"]>().toEqualTypeOf<
      "pending" | "stored" | "uncertain"
    >();
    expectTypeOf<ReconcileOutcome>().toMatchTypeOf<
      { outcome: "stored"; noteId: string } | { outcome: "not-written" }
    >();
    expectTypeOf<MemoryPreparer["prepare"]>().returns.toEqualTypeOf<
      Promise<InsertionPlan>
    >();
    expectTypeOf<MemoryPreparer["apply"]>()
      .parameter(0)
      .toEqualTypeOf<InsertionPlan>();
    expectTypeOf<IngestionQueue["submit"]>()
      .parameter(0)
      .toEqualTypeOf<QueueObservation>();
    expectTypeOf<IngestionQueue["submit"]>().returns.toEqualTypeOf<
      Promise<QueueSubmission>
    >();
    expectTypeOf<IngestionQueue["receipt"]>().returns.toEqualTypeOf<
      Promise<QueueReceipt | undefined>
    >();
    expectTypeOf<IngestionQueue["status"]>().returns.toEqualTypeOf<
      Promise<QueueStatus>
    >();
    expectTypeOf<IngestionQueue["reconcile"]>()
      .parameter(1)
      .toEqualTypeOf<ReconcileOutcome>();
  });

  it("keeps the documented prompt and response types usable through the package root", () => {
    expectTypeOf<MemoryPrompts["evolution"]>().toEqualTypeOf<string>();
    expectTypeOf<ConstructionSource["timestamp"]>().toEqualTypeOf<string>();
    expectTypeOf<EvolutionSource["neighbors"]>().toEqualTypeOf<
      readonly Note[]
    >();
    expectTypeOf<ConstructionResponse>().toEqualTypeOf<{
      context: string;
      keywords: string[];
      tags: string[];
    }>();
    expectTypeOf<EvolutionResponse["links"]>().toEqualTypeOf<string[]>();
    expectTypeOf<EvolutionUpdate["id"]>().toEqualTypeOf<string>();
  });

  it("re-exports the reference encoder through the same modules as its component index", () => {
    const exportedNames = [
      "embeddingSpaceId",
      "openReferenceEmbedder",
      "referenceEncoderSettings",
    ] as const;

    for (const name of exportedNames) {
      expect(packageExports[name]).toBe(embeddings[name]);
    }
  });

  it("keeps the reference encoder's documented contract types usable", () => {
    expectTypeOf<
      ReferenceEncoderSettings["model"]
    >().toEqualTypeOf<"Xenova/bge-m3">();
    expectTypeOf<ReferenceEncoderSettings["maxLength"]>().toEqualTypeOf<8192>();
    expectTypeOf<
      ReferenceEncoderSettings["runtimeVersion"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      ReferenceEmbedder["settings"]
    >().toMatchTypeOf<ReferenceEncoderSettings>();
    expectTypeOf<
      ReferenceEmbedderOptions["allowDownloads"]
    >().toEqualTypeOf<boolean>();
  });

  it("uses note records that satisfy both the exported type and the runtime schema", () => {
    const note = {
      id: "b3c1d2e3-4f50-4610-8899-0a1b2c3d4e5f",
      content: "An observed result.",
      timestamp: "2026-09-27T15:44:27Z",
      context: "An observed result reported by a host.",
      keywords: ["result"],
      tags: ["observation"],
      links: [],
      updatedAt: "2026-09-27T15:45:00.000Z",
      metadata: { origin: "host", nested: { count: 1 } },
    } satisfies Note;
    const results: SearchResult[] = [
      { note, via: "match", score: 0.9 },
      { note, via: "link" },
    ];

    expect(noteSchema.safeParse(note).success).toBe(true);
    expect(
      noteSchema.safeParse({ ...note, updatedAt: undefined }).success,
    ).toBe(true);
    expect(results.map((result) => result.via)).toEqual(["match", "link"]);
  });
});
