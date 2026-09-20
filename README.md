# dsh-plugin-hindsight-advanced

<p align="center"><img src="./misc/banner.jpg" alt="dsh-plugin-hindsight-advanced banner"/></p>

A plugin for DeepSeek Harness (dsh) that integrates the Hindsight memory
system: your agent stores memories in your own Hindsight server and brings
the relevant ones back into the conversation.

## Installation

With the `dsh` command:

```bash
dsh plugin --profile web add /path/to/hindsight-advanced
```

When running dsh from source:

```bash
pnpm dsh plugin --profile web add /path/to/hindsight-advanced
```

Then restart the server.

## Configuration

The configuration is one `hindsight` row in your own DSH config — never an
edit to the plugin's files. You place it in one of two spots (pick **one**,
never both):

**Every session.** In your profile's patch layer
(`~/.dsh/profiles/web/cordis.patch.yml`, append to your existing file):

```yaml
- id: hindsight
  disabled: false
  config:
    bank: my-bank
    baseUrl: http://127.0.0.1:9177
    apiKeyRef: HINDSIGHT_API_KEY
```

**One preset only.** In that preset's own file
(`~/.dsh/.agent-presets/<preset>/agent.cordis.yml`, append):

```yaml
- id: hindsight
  name: dsh-plugin-hindsight-advanced
  config:
    bank: my-bank
    baseUrl: http://127.0.0.1:9177
    apiKeyRef: HINDSIGHT_API_KEY
```

Presets that point at the same bank don't need separate banks — the
`preset` scope already keeps each preset's memories apart.

Two things to know about the row:

- the `config` block **replaces** the plugin's defaults wholesale — list
  every key you want; only `bank` is strictly required, the rest fall back
  to the defaults in the table below (but `baseUrl` and `apiKeyRef` are
  worth repeating, since their defaults point at port 8888 and carry no
  key);
- to switch the plugin off again, set `disabled: true` on the row (or
  remove the preset row) and restart.

### The configuration keys

| key | default | what it does |
| --- | --- | --- |
| `bank` | — | **Required.** The name of the Hindsight bank to use (the server creates it on first use). |
| `baseUrl` | `http://127.0.0.1:8888` | Your Hindsight server's address. |
| `apiKeyRef` | — | **The way to give the plugin its key** — a *name* for the secret, not the secret itself. The value is looked up on every call (environment → `~/.dsh/.credentials.yaml` → `.env` files), so rotating the key needs no restart and the key never sits in a config file. See below. |
| `apiKey` | — | A plain key in the config, instead of a reference. Prefer `apiKeyRef`. |
| `autoContext` | `true` | Set `false` to turn off the automatic recall (each turn's first step, any human intervention claimed mid-turn, and the mid-step agent-output recall; the `hindsight` tool stays). |
| `prefetch` | `true` | `true` (default): the recall starts as the *previous* turn ends, so from the second turn on it targets the previous message. `false`: every turn queries the message you just sent and waits on the server for it — the memory is always relevant to what you just said, at the cost of the server's latency on every first model call. |
| `recallContextTurns` | `5` | How many of your recent turns ride along in the recall's query, so the bank can match memories against what the conversation was about, not just the last message. The query is the anchor message under a `Prior context:` block of the recent prior turns (one line per user/assistant message), capped at 1000 characters with the oldest lines dropped first. `1` (what the reference integrations ship) is the plain single-message query. |
| `recallPreserve` | `true` | `true` (the default): the model context is append-only — every committed recall snapshot stays in the conversation, so later turns see the memories that were recalled earlier. `false`: the model context carries only the *latest* full snapshot — each new one retires the previous full card in place (a one-line tombstone marker stays where that turn's recall fired, its full tokens metered out of the pricing) and lands as a fresh card at its own turn, while the durable session log keeps every full snapshot for replay and audit. The naming matches llama-server's `--no-reasoning-preserve`: with it off, a turn's snapshot, like its reasoning, lives for that turn only. |
| `recallAfterText` | `false` | `true`: a step past the first whose claim carries no human message recalls the bank anchored on the previous step's committed **text** - the words the agent wrote. Bounded by `autoContextTimeoutMs`, at most one recall per step; a human message in the claim takes the intervention path instead. |
| `recallAfterReasoning` | `false` | Like `recallAfterText`, but anchored on the previous step's committed **reasoning**. With both keys on, the two anchors are combined into ONE recall (the reasoning first, then the text) - never two lookups. |
| `retainScope` | `preset` | Where a stored memory lands when the agent doesn't say: `global` (everything in the bank), `preset` (this agent preset), or `session` (this session only). |
| `maxRecallTokens` | `4096` | How much memory to bring back per recall. |
| `autoContextTimeoutMs` | `2500` | How long a turn may wait on the memory server before moving on without it. Because the lookup runs ahead (below), most turns never pay this; a slow or stopped server never blocks the agent. |
| `retainAsync` | `false` | `false` (the default): storing waits until the bank has processed the memory, so the next turn already sees it. `true`: store acknowledges fast and the bank processes it in the background. |
| `bankConfig` | — | Optional instructions for the *server's* own memory extraction — for example `retain_mission: "Focus on decisions and durable project facts."` tells the Hindsight server what to pull out of what the agent stores. |

### How the automatic recall works

At the start of each turn the agent gets a small note: the memories that
match your latest message, plus any standing rules you stored. The lookup
starts in the background as soon as the *previous* turn ends — while you
are reading or typing — so by the time the agent starts the next turn the
memory is usually already there and the turn does not wait on the memory
server at all. The first turn of a conversation has nothing to read ahead
of, so it waits on the server normally (up to `autoContextTimeoutMs`).
Set `prefetch: false` to query the message you just sent instead — at the
cost of that wait on every turn.
If you send a message while the agent is already working, the recall
follows it: when the agent picks the intervention up at its next step it
recalls the bank on the spot (bounded by `autoContextTimeoutMs`),
anchored on the intervention itself, so a mid-turn correction arrives
with the memories about what it corrects. A step that only carries
plugin-injected context recalls nothing.
By default, that last sentence is the whole story: a step without a
human message recalls nothing. Set `recallAfterText: true` and/or
`recallAfterReasoning: true` to change it - at a step past the first
whose claim carries no human message, the plugin recalls the bank
anchored on the previous step's own output: the text it wrote and/or the
reasoning it committed (with both on, one combined anchor, the reasoning
first, then the text). The lookup is bounded by `autoContextTimeoutMs`
like the intervention's and rides the same decision that advances the
step, so memory about what the agent just did is in context before the
next model call. A human message in the claim still wins the precedence
(the intervention path above), and there is at most one recall per step.
Each note's row shows how long its lookup took (for example
`recall - 12ms`) in place of the plugin name — expand the row to see the
producer. A mid-step agent-output note is labeled by what it anchored on:
`recall:text - 12ms` (the text), `recall:think - 12ms` (the reasoning),
or `recall:think+text - 12ms` (the combined anchor).
The query is not just that one message: with the default
`recallContextTurns: 5`, the last few turns of the conversation ride
along under a `Prior context:` block (one line per message, capped at
1000 characters), so a memory about the topic you were discussing a turn
or two back can match — set it to `1` for the plain single-message query.
When a turn's recall matches nothing new, you get a
"no new memories this turn" row instead of a repeated block: it names
the memories still in effect, one line each, so you can see exactly what
was applied without the whole block repeating.
The notes are append-only by default (`recallPreserve: true`): every
turn's snapshot stays in the model context, so the agent keeps seeing
what it recalled earlier. Set `recallPreserve: false` to keep the context
lean — each new note retires the previous full card in place: a one-line
marker stays where that turn's recall fired (so you can always see WHERE
in the conversation a recall happened, without scrolling), while the
full note lands as a fresh card at its own turn — only the latest full
recall stays on the model's surface (the full history of cards remains
in the session log for replay). The naming matches llama-server's
`--no-reasoning-preserve`: with it off, a turn's snapshot, like its
reasoning, lives for that turn only. The price is that a retired card
restarts the model's cached prefix - a mid-step note retires on the same
terms, and an unchanged recall commits nothing at all (no retirement, no
prefix cost), so identical repeated steps stay free.

### Giving the plugin its key

`apiKeyRef: HINDSIGHT_API_KEY` is only a name — the plugin looks up the
value by that name on every call, in this order: the environment, then
`~/.dsh/.credentials.yaml`, then `.env` files. The usual way is one line in
`~/.dsh/.credentials.yaml`, **added alongside your existing entries**
(like the LLM key — don't replace them):

```yaml
version: 1
refs:
  HINDSIGHT_API_KEY: <the Hindsight server's token>
```
