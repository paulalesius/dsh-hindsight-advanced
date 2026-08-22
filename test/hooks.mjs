// Resolve bare @deepseek-ai/* specifiers against the DSH checkout's
// apps/cli package context, so the workspace copy of the plugin imports the
// same package instances a real preset mount would.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const requireFromCli = createRequire('/src/misc/harness/deepseek-harness/apps/cli/package.json')

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
