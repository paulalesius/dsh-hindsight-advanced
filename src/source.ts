/**
 * The `hindsight` producer kind, registered on the LLM message-source map.
 *
 * DSH V4 removed the generic `plugin` source from the base `MessageSource`
 * union: a plugin now contributes its own named kind through a module
 * augmentation of `MessageSourceMap`, exactly the seam the harness's
 * `time-context` package uses for `time-context`. This plugin registers
 * `hindsight`, so every auto-recall snapshot and failure-lesson row it
 * commits carries `kind: 'hindsight'` as its attribution — no `plugin`
 * field and no per-message `label`.
 *
 * The kind is consumed for its shape alone. A `snapshot` carries its
 * sections (`{ name, text }` pairs — the collapsed context row renders
 * `sections[0].name`, e.g. `recall - 12ms`); a `notice` carries its
 * `summary`. Every commit additionally records `bank`, the name of the
 * bank the commit was made FOR (mount attribution): the `recallPreserve:
 * false` retirement machinery is scoped by it, so a second mount on the
 * same session (two banks, one shared surface) retires only its own
 * bank's cards. No runtime value lives in this file: it exists only for
 * this augmentation, which applies program-wide once `autorecall.ts`
 * imports it for its side effect.
 *
 * @module dsh-plugin-hindsight-advanced/source
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The bank a hindsight commit was made for (mount attribution);
     *  `recallPreserve: false` retires cards per bank. */
    'hindsight': { kind: 'hindsight'; bank?: string } & ContextFormed
  }
}
