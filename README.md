# dsh-plugin-hindsight-advanced

<p align="center"><img src="./misc/banner.jpg" alt="dsh-plugin-hindsight-advanced banner"/></p>

Long-term memory for your DeepSeek Harness (dsh) agent. An agent's
conversation ends when the session does — this plugin gives the agent
memory that doesn't: it stores what is worth remembering, and brings the
right things back at the right time.

What your agent gets:

- a **`hindsight` tool** — it stores what is worth remembering (`retain`,
  including when the thing happened, not just when it was stored), finds it
  again when it is needed (`recall`), and can ask the memory a question and
  get an answer grounded in it (`reflect`);
- **automatic recall** — at the start of every turn, the memories that
  matter to the current conversation are placed in front of the agent, so
  nothing relevant is ever asked for twice. When a memory is an inference
  the bank drew from stored facts, the facts it was drawn from are shown
  right under it, so you can always see what a belief rests on;
- **standing rules** — "always do this" and "never do that" rules that are
  applied on every turn until you change them, even when nothing else in
  the memory matches;
- **visibility you choose per memory** — every memory is visible to
  everything in the bank (`global`), to one agent preset (`preset`), or to
  a single session (`session`); a memory never appears outside its scope.

The memories live in your own Hindsight server, not in the plugin.
Uninstalling the plugin never touches them.

## Installation

You need a running Hindsight server (`hindsight-api` — any local port
works; the config below points at it) and a DeepSeek Harness checkout.

**1. Install the plugin.** One command does both halves — it links the
plugin into your profile and registers the mounting row for it:

```bash
dsh plugin --profile web add /path/to/dsh-hindsight-advanced
```

(Use a plain path, not a `file:` URL — a plain path links the source, so
edits are picked up without reinstalling. Without the `dsh` binary on your
PATH, run `node --import tsx/esm apps/cli/src/bin.ts plugin …` from inside
the DSH checkout.)

If you checked this repo out fresh, recreate the one machine-local link the
source needs first: `ln -s /path/to/deepseek-harness/apps/cli/node_modules node_modules`
inside this repo.

**2. Restart `dsh web` once.**

**3. Tell it which bank and server to use** — one small block in your own
config, below. Then restart `dsh web` again, and the agent remembers.

The install ships **switched off on purpose**: until you add that block,
the agent gets nothing. What you enable, and where, is your call.

**To uninstall later:** `dsh plugin --profile web remove
dsh-plugin-hindsight-advanced`, remove your config block, restart `dsh
web`. Your memories stay on the Hindsight server.

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
| `autoContext` | `true` | Set `false` to turn off the automatic per-turn recall (the `hindsight` tool stays). |
| `retainScope` | `preset` | Where a stored memory lands when the agent doesn't say: `global` (everything in the bank), `preset` (this agent preset), or `session` (this session only). |
| `maxRecallTokens` | `1024` | How much memory to bring back per recall. |
| `autoContextTimeoutMs` | `2500` | How long a turn may wait on the memory server before moving on without it. A slow or stopped server never blocks the agent. |
| `retainAsync` | `false` | `false` (the default): storing waits until the bank has processed the memory, so the next turn already sees it. `true`: store acknowledges fast and the bank processes it in the background. |
| `bankConfig` | — | Optional instructions for the *server's* own memory extraction — for example `retain_mission: "Focus on decisions and durable project facts."` tells the Hindsight server what to pull out of what the agent stores. |

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

(Or export `HINDSIGHT_API_KEY` in the environment that starts `dsh web`.)
Because the lookup happens on every call, editing the file — or rotating
the token in place — takes effect immediately, with no restart.
