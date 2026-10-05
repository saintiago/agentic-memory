/**
 * File I/O for the private baseline evidence: small JSON/JSONL readers and writers, content
 * hashes and byte sizes. Every artifact is written once into a fresh directory, so a second
 * capture cannot silently overwrite earlier evidence.
 *
 * See docs/evaluation.md#quality-maintenance-procedure.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** A private evidence directory is created once and never reused. */
export class EvidenceDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceDirectoryError";
  }
}

/** Create one evidence directory; an existing directory is refused instead of overwritten. */
export const createEvidenceDirectory = async (
  directory: string,
): Promise<void> => {
  try {
    await mkdir(directory);
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null
        ? (cause as { code?: unknown }).code
        : undefined;
    if (code === "EEXIST") {
      throw new EvidenceDirectoryError(
        `The evidence directory ${directory} already exists; baseline evidence is never ` +
          "overwritten. Choose a new directory for a new capture.",
      );
    }
    if (code === "ENOENT") {
      // The parent chain may itself be missing; create it and retry once.
      await mkdir(path.dirname(directory), { recursive: true });
      try {
        await mkdir(directory);
      } catch (retry) {
        if (
          typeof retry === "object" &&
          retry !== null &&
          (retry as { code?: unknown }).code === "EEXIST"
        ) {
          throw new EvidenceDirectoryError(
            `The evidence directory ${directory} already exists; baseline evidence is never ` +
              "overwritten. Choose a new directory for a new capture.",
          );
        }
        throw retry;
      }
      return;
    }
    throw new EvidenceDirectoryError(
      `The evidence directory ${directory} cannot be created: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
};

/** Read one JSON file, or fail naming the file without quoting private content. */
export const readJsonFile = async (file: string): Promise<unknown> => {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new EvidenceDirectoryError(
      `The evidence file ${file} cannot be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EvidenceDirectoryError(
      `The evidence file ${file} is not valid JSON.`,
    );
  }
};

/** Write one JSON file with a trailing newline; the caller owns the directory layout. */
export const writeJsonFile = async (
  file: string,
  value: unknown,
): Promise<void> => {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/** Read one JSONL file into its nonempty lines, failing by position on malformed JSON. */
export const readJsonl = async <Value>(file: string): Promise<Value[]> => {
  const text = await readFile(file, "utf8");
  const values: Value[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    try {
      values.push(JSON.parse(line) as Value);
    } catch {
      throw new EvidenceDirectoryError(
        `The evidence file ${file} has invalid JSON on line ${String(index + 1)}.`,
      );
    }
  }
  return values;
};

/** Write one JSON value per line, preserving order. */
export const writeJsonl = async (
  file: string,
  values: readonly unknown[],
): Promise<void> => {
  const text = values.map((value) => `${JSON.stringify(value)}\n`).join("");
  await writeFile(file, text, "utf8");
};

/** The `sha256:<hex>` content identity the evaluation artifacts use. */
export const sha256Text = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** Hash one file's bytes. */
export const sha256File = async (file: string): Promise<string> => {
  const bytes = await readFile(file);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};

/** One file's byte size. */
export const fileBytes = async (file: string): Promise<number> => {
  const info = await stat(file);
  return info.size;
};

/** Join a path under an evidence root. */
export const under = (root: string, relative: string): string =>
  path.join(root, relative);
