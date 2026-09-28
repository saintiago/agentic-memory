/**
 * Where one queue's journal lives and which identity its handles agree on. A relative path, a
 * directory symlink and a file symlink that name one journal file must resolve to one identity, so
 * worker ownership, the journal thread and the durable file never disagree about which queue is
 * meant.
 *
 * See docs/ingestion-queue.md#writer-lifecycle-and-retries.
 */
import { closeSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";

/** The journal file name inside the queue's durable directory. */
export const journalFileName = "ingestion-queue.sqlite";

/**
 * The canonical path of one existing journal file, with symlinks and relative segments resolved.
 * A path that does not resolve yet keeps its absolute form, which is the identity two handles share
 * until the file exists.
 */
export const canonicalJournalPath = (journalPath: string): string => {
  const absolute = path.resolve(journalPath);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

/**
 * Open one durable queue directory: create it when missing, create the journal file so its
 * canonical identity resolves, and return that identity. Every handle in every process derives the
 * same value, including when a caller names the directory or the file through a symlink.
 */
export const openJournalPath = (directory: string): string => {
  mkdirSync(directory, { recursive: true });
  const located = path.join(directory, journalFileName);
  closeSync(openSync(located, "a"));
  return canonicalJournalPath(located);
};
