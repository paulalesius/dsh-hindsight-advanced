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
