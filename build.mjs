/**
 * esbuild bundle script.
 *
 * `ws` (and some node builtins it requires) are CommonJS; bundling to ESM needs a
 * `createRequire` shim in the banner, otherwise `require("events")` throws
 * "Dynamic require of ... is not supported".
 */
import { build } from "esbuild";

await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: "dist/server.js",
    logLevel: "info",
    banner: {
        js: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);`,
    },
});
