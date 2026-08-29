import { randomUUID } from "node:crypto";
import {
  mkdir as makeDirectory,
  open as openFile,
  rename as renameFile,
  unlink as unlinkFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteFileHandle {
  writeFile(contents: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicWriteFileSystem {
  mkdir(path: string): Promise<void>;
  open(path: string): Promise<AtomicWriteFileHandle>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: AtomicWriteFileSystem = {
  mkdir: async (path) => {
    await makeDirectory(path, { recursive: true });
  },
  open: async (path) => {
    const handle = await openFile(path, "wx", 0o600);
    return {
      writeFile: async (contents) => {
        await handle.writeFile(contents, "utf8");
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename: renameFile,
  unlink: unlinkFile,
};

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function atomicWriteJson(
  targetPath: string,
  data: unknown,
  fileSystem: AtomicWriteFileSystem = nodeFileSystem,
): Promise<void> {
  const parentDirectory = dirname(targetPath);
  const serialized = JSON.stringify(data, null, 2);

  if (serialized === undefined) {
    throw new TypeError("JSON data must be serializable");
  }

  await fileSystem.mkdir(parentDirectory);

  const temporaryPath = join(
    parentDirectory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryFileCreated = false;

  try {
    const handle = await fileSystem.open(temporaryPath);
    temporaryFileCreated = true;

    try {
      await handle.writeFile(`${serialized}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    if (temporaryFileCreated) {
      try {
        await fileSystem.unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isNotFoundError(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            "Atomic write failed and its temporary file could not be removed",
          );
        }
      }
    }

    throw error;
  }
}
