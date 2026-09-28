/**
 * The evidence of the latest memory request: the exact returned order, each result's retrieval
 * classification and direct score, and the returned note payloads. It is the single owner of the
 * request state, so a later request always supersedes an earlier one that finishes afterwards.
 *
 * See docs/dashboard.md#memory-requests.
 */
import type { Note } from "../../src/note-store/index.js";
import { searchOutcomeSchema, type SearchOutcome } from "../payloads.js";

export { searchOutcomeSchema };
export type { SearchOutcome };

/** One submitted request; the host validates the query and limits. */
export interface SearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly linkedLimit?: number;
}

/** The request state one dashboard displays. */
export interface SearchState {
  readonly pending: boolean;
  readonly request: SearchRequest | undefined;
  readonly outcome: SearchOutcome | undefined;
  /** A sanitized failure of the latest request; never an empty successful result list. */
  readonly error: string | undefined;
}

/** The current memory request of one dashboard. */
export class SearchResults {
  #nextRequestId = 1;
  #revision = 0;
  #latestRequestId: number | undefined;
  #request: SearchRequest | undefined;
  #outcome: SearchOutcome | undefined;
  #error: string | undefined;
  #pending = false;
  #highlight: ReadonlySet<string> = new Set();
  #kinds = new Map<string, "match" | "link">();
  #notes = new Map<string, Note>();

  /** Register one submitted request; only this request's answer is still current. */
  begin(request: SearchRequest): number {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    this.#revision += 1;
    this.#latestRequestId = id;
    this.#request = request;
    this.#outcome = undefined;
    this.#error = undefined;
    this.#pending = true;
    this.#writeOutcome(undefined);
    return id;
  }

  /** Accept one response when it answers the latest request. */
  accept(id: number, outcome: SearchOutcome): boolean {
    if (id !== this.#latestRequestId) {
      return false;
    }
    this.#revision += 1;
    this.#pending = false;
    this.#outcome = outcome;
    this.#error = undefined;
    this.#writeOutcome(outcome);
    return true;
  }

  /** Record one failed response when it answers the latest request. */
  fail(id: number, message: string): boolean {
    if (id !== this.#latestRequestId) {
      return false;
    }
    this.#revision += 1;
    this.#pending = false;
    this.#outcome = undefined;
    this.#error = message;
    this.#writeOutcome(undefined);
    return true;
  }

  /** Clear the request, its evidence and any pending answer. */
  clear(): void {
    this.#revision += 1;
    this.#latestRequestId = undefined;
    this.#request = undefined;
    this.#outcome = undefined;
    this.#error = undefined;
    this.#pending = false;
    this.#writeOutcome(undefined);
  }

  state(): SearchState {
    return {
      pending: this.#pending,
      request: this.#request,
      outcome: this.#outcome,
      error: this.#error,
    };
  }

  /** A counter that changes whenever the returned evidence changes. */
  revision(): number {
    return this.#revision;
  }

  /** The returned memory IDs, in returned order. */
  resultIds(): string[] {
    return (this.#outcome?.results ?? []).map((result) => result.note.id);
  }

  /** The returned IDs the map highlights; empty after a failure or without a request. */
  get highlightIds(): ReadonlySet<string> {
    return this.#highlight;
  }

  retrievalKind(nodeId: string): "match" | "link" | undefined {
    return this.#kinds.get(nodeId);
  }

  /** The note payload returned by the request, used as the details evidence. */
  noteFor(nodeId: string): Note | undefined {
    return this.#notes.get(nodeId);
  }

  /** The returned IDs the display does not contain yet, in returned order. */
  unmappedIds(hasNode: (nodeId: string) => boolean): string[] {
    return this.resultIds().filter((nodeId) => !hasNode(nodeId));
  }

  #writeOutcome(outcome: SearchOutcome | undefined): void {
    const highlight = new Set<string>();
    const kinds = new Map<string, "match" | "link">();
    const notes = new Map<string, Note>();
    for (const result of outcome?.results ?? []) {
      highlight.add(result.note.id);
      kinds.set(result.note.id, result.via);
      notes.set(result.note.id, result.note);
    }
    this.#highlight = highlight;
    this.#kinds = kinds;
    this.#notes = notes;
  }
}
