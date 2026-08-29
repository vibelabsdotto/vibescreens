import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  atomicWriteJson,
  type AtomicWriteFileSystem,
} from "../atomic-write";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vibescreens-atomic-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("atomicWriteJson", () => {
  it("creates parent directories and atomically writes formatted JSON", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "nested", "project.json");
    const data = { schemaVersion: 1, projects: [{ id: "prj_demo" }] };

    await atomicWriteJson(target, data);

    expect(await readFile(target, "utf8")).toBe(
      `${JSON.stringify(data, null, 2)}\n`,
    );
    expect(await readdir(join(directory, "nested"))).toEqual(["project.json"]);
  });

  it("preserves the prior target and removes its temp file after interruption", async () => {
    const directory = await createTemporaryDirectory();
    const target = join(directory, "project.json");
    const previousContents = '{"schemaVersion":1}\n';
    await writeFile(target, previousContents, "utf8");

    const interruptingFileSystem: AtomicWriteFileSystem = {
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      open: async (path) => {
        const handle = await open(path, "wx", 0o600);
        return {
          writeFile: async (contents) => {
            await handle.writeFile(contents.slice(0, 8), "utf8");
            throw new Error("simulated write interruption");
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      rename,
      unlink,
    };

    await expect(
      atomicWriteJson(target, { schemaVersion: 2 }, interruptingFileSystem),
    ).rejects.toThrow("simulated write interruption");

    expect(await readFile(target, "utf8")).toBe(previousContents);
    expect(await readdir(directory)).toEqual(["project.json"]);
  });
});
