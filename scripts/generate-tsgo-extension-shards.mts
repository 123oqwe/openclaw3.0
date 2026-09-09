#!/usr/bin/env node
/** Generate deterministic extension test projects from the canonical tsconfig. */
import fs from "node:fs";
import path from "node:path";
import { readGraphConfig } from "./check-tsgo-core-boundary.mts";
import { findTsgoCoreTestShardViolations } from "./lib/tsgo-core-test-shards.mts";

const root = process.cwd();
const canonical = "test/tsconfig/tsconfig.extensions.test.json";
const outDir = path.join(root, "test/tsconfig/generated-extensions");
const count = Number(process.env.OPENCLAW_EXTENSION_SHARD_COUNT ?? "5");

if (!Number.isInteger(count) || count < 1) {
  throw new Error("shard count must be positive");
}
const config = await readGraphConfig(canonical);
const roots = (config.files ?? [])
  .map((file) =>
    path
      .relative(root, path.resolve(path.dirname(path.join(root, canonical)), file))
      .replaceAll(path.sep, "/"),
  )
  .filter((file) => /^extensions\/.+\.test\.tsx?$/u.test(file))
  .toSorted();
if (roots.length === 0) {
  throw new Error("canonical extension config produced no test roots");
}
const generatedShards: { name: string; roots: string[] }[] = [];
const cacheFiles = new Set<string>();
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (let index = 0; index < count; index++) {
  const shardRoots = roots.filter((_, rootIndex) => rootIndex % count === index);
  if (shardRoots.length === 0) {
    continue;
  }
  generatedShards.push({ name: `extensions-${index + 1}`, roots: shardRoots });
  const file = path.join(outDir, `tsconfig.extensions.test.${index + 1}.json`);
  const rel = (target: string) =>
    path.relative(path.dirname(file), path.join(root, target)).replaceAll(path.sep, "/");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        extends: "../tsconfig.extensions.test.json",
        compilerOptions: {
          tsBuildInfoFile: rel(`.artifacts/tsgo-cache/extensions-test-${index + 1}.tsbuildinfo`),
        },
        include: [
          rel("src/**/*.d.ts"),
          rel("ui/**/*.d.ts"),
          rel("extensions/**/*.d.ts"),
          ...shardRoots.map((entry) => rel(entry)),
          rel("packages/**/*.d.ts"),
        ],
      },
      null,
      2,
    )}\n`,
  );
  const cache = rel(`.artifacts/tsgo-cache/extensions-test-${index + 1}.tsbuildinfo`);
  if (cacheFiles.has(cache)) {
    throw new Error(`duplicate tsBuildInfoFile: ${cache}`);
  }
  cacheFiles.add(cache);
}
const violations = findTsgoCoreTestShardViolations({
  canonicalRoots: roots,
  maxRoots: 720,
  shards: generatedShards,
});
if (violations.length > 0) {
  throw new Error(`generated extension shard validation failed\n${violations.join("\n")}`);
}
console.log(
  JSON.stringify({
    canonical,
    roots: roots.length,
    shards: count,
    outDir: path.relative(root, outDir),
  }),
);
