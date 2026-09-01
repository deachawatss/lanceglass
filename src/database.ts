import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlainDatabase } from "./database.plain";
import { VectorDatabase } from "./database.vector";
import {
  ACTIVE_EVENT_VECTOR_CONTRACT,
  EMBEDDING_SPACE_ID,
  type EventVectorSpaceContract,
} from "./schemas";

export {
  EventRepository,
  EventSourceRepository,
  PlainDatabase,
  SourceFileRepository,
  sql,
} from "./database.plain";
export { EventVectorRepository, VectorDatabase } from "./database.vector";

// Keep the existing path as the plain-store default so upgrading this lab does
// not make already imported JSONL disappear. The optional vector store is a
// sibling and is never opened by imports.
export const DEFAULT_PLAIN_DB_DIR = fileURLToPath(
  new URL("../.data/lancedb", import.meta.url),
);
export const DEFAULT_DB_DIR = DEFAULT_PLAIN_DB_DIR;
export const DEFAULT_VECTOR_DB_DIR = `${DEFAULT_PLAIN_DB_DIR}.vector`;

export function defaultVectorDirectory(plainDirectory: string) {
  return `${plainDirectory}.vector`;
}

export function defaultVectorDirectoryForSpace(
  plainDirectory: string,
  vectorStoreKey: string,
) {
  const base = defaultVectorDirectory(plainDirectory);
  return vectorStoreKey === EMBEDDING_SPACE_ID ? base : `${base}.${vectorStoreKey}`;
}

function isMissingPath(error: unknown) {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Resolve an existing target when possible, including a symlinked parent.
 * For a not-yet-created store, resolve the nearest existing ancestor instead
 * so `foo`, `foo/.`, and sibling aliases still compare deterministically.
 */
async function canonicalDirectory(directory: string) {
  const missing: string[] = [];
  let cursor = resolve(directory);
  for (;;) {
    try {
      return join(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(directory);
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertSeparateDirectories(plainDirectory: string, vectorDirectory: string) {
  const [plain, vector] = await Promise.all([
    canonicalDirectory(plainDirectory),
    canonicalDirectory(vectorDirectory),
  ]);
  if (plain === vector) {
    throw new Error(
      `plain and vector database directories must be different (both resolve to ${plain})`,
    );
  }
}

/**
 * A deliberately thin container for two physical LanceDB stores.
 *
 * `plain` is the ordinary importer/UI database. `vector` is optional and
 * stays untouched until an explicit embedding or retrieval operation asks for
 * it. Callers must select their store explicitly; there are no forwarding
 * methods such as `database.events()` that could blur this boundary.
 */
export class Database {
  private constructor(
    readonly plain: PlainDatabase,
    readonly vector: VectorDatabase,
  ) {}

  static async open(
    plainDirectory = process.env.PLAIN_DB_DIR ?? process.env.DB_DIR ?? DEFAULT_PLAIN_DB_DIR,
    vectorDirectory = process.env.VECTOR_DB_DIR ?? defaultVectorDirectory(plainDirectory),
    vectorSpace: EventVectorSpaceContract = ACTIVE_EVENT_VECTOR_CONTRACT,
  ) {
    await assertSeparateDirectories(plainDirectory, vectorDirectory);
    return new Database(
      await PlainDatabase.open(plainDirectory),
      new VectorDatabase(vectorDirectory, vectorSpace),
    );
  }
}
