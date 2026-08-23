// Resolve bare @deepseek-ai/* specifiers against the DSH checkout's
// apps/cli package context, so the workspace copy of the plugin imports the
// same package instances a real preset mount would. The anchor is the repo's
// own machine-local node_modules symlink (into the checkout's
// apps/cli/node_modules) — the same one the runtime imports need — so no
// absolute path is baked in.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromCli = createRequire(new URL('../node_modules/anchor.js', import.meta.url))

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    try {
      const file = requireFromCli.resolve(specifier)
      return { url: pathToFileURL(file).href, shortCircuit: true }
    } catch {
      // fall through to the default resolver for a precise failure
    }
  }
  return nextResolve(specifier, context)
}
