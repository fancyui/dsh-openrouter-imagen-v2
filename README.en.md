# dsh-openrouter-imagen-v2

> **Compatibility: DeepSeek Harness 0.2.x** — developed and tested on **0.2.0-rc.2**.
> Declared in `package.json` as `engines.dsh` (`^0.2.0-rc.2`) and as the `@deepseek-ai/dsh`
> `peerDependencies` entry. The two do different jobs: **`engines.dsh` is declarative only** (for
> readers and for a marketplace listing), while **`peerDependencies` is what DSH actually enforces** —
> a host that does not satisfy the range refuses the plugin at startup instead of letting it run with
> unexplained failures.

Image generation for DeepSeek Harness through the OpenRouter Image API, delivered as a **standalone
workspace**.

> **A standalone repository, sitting alongside v1.** It carries its **own** plugin id, settings namespace,
> route prefix and tool name, so both can be installed at the same time without interfering. v1 hangs
> image generation off the chat surface; v2 takes a different route — enter from the sidebar, take over
> the main view, **no chat UI wrapped around it**.

[中文](./README.md) · [Development & troubleshooting notes](./NOTES.md)

---

## Introduction

The plugin has two halves:

- **Host half** registers the tool `openrouter_generate_imagen_v2`, same-origin routes under
  `/openrouter-imagen-v2/api/*`, and maintains a **generation history** — v1 has no such thing, since
  images only ever existed as attachments and files, so "the last 5" and "regenerate with the same
  settings" had nothing to read from.
- **Client half** registers two slots: the sidebar entry `sidebar.panellist` and the main view `main`.
  Clicking the sidebar entry turns the whole central area into the workspace.
- **Settings dialog** — the workspace cannot reach DSH's own settings page, so the key, the models and
  the prompt model are all configured in its own dialog.
- **Bundled skill** `skills/openrouter-imagen-v2/SKILL.md`, which teaches the model to *derive* a style
  rather than look one up in a table.

Besides pressing the button in the chat column, the tool can also be called by the agent on its own
initiative — see [Usage](#usage).

---

## Usage

### The workspace

Click **图像生成 / Image** under the "Plugins" group in the sidebar. Two panes; the divider **can be
dragged** to change the split (double-click to reset).

- **Left pane** the current image, a strip of history thumbnails below it (the last 5), and the
  parameters area (its height is draggable too).
- **Right pane** the conversation: request → prompt → image, all visible and all editable; the input box
  sits at the bottom of this pane.

Aspect ratios are the **12 ratios the plugin really supports, plus `auto`**, and each one is printed as a
number — a square on its own cannot tell 4:5 from 5:4.
Defaults: count `1`, quality `medium`, background `auto`, aspect `16:9`, resolution `1K`.

- **"Confirm the prompt before generating" is off by default.** Off means one click on "Generate"
  produces the image (the prompt is still shown in the conversation); on pauses on the prompt card until
  you click "Generate this".
- **Two prompt modes**: `Write prompt directly` (the text you type is the final prompt, zero extra
  latency) and `Let AI write the prompt` (the default).
- **The model picker sits below the input box** and **applies to that one generation only** — it does not
  change the stored default. Once you pick one, a "back to default" affordance appears and the header
  label reads `Model · this run …`, so the header and the picker can never contradict each other.
  Candidates come from the model list in the settings dialog (up to 16).
- **Reference images** (up to 4): press `+` to pick files, paste into the writing area, or drag them in;
  the `×` on a thumbnail removes it. They go to the image model **as part of this request, with no
  upload step anywhere**. Under `Let AI write the prompt` they also go to the prompt model (same bytes),
  so the prompt actually *references* them. The status bar says `writing prompt · N references` so you
  can tell "didn't see them" from "saw them and ignored them". If the prompt model has **no vision
  capability**, it falls back automatically to writing without them.
- **The seed** sits below the model row, right above the generate button. After a generation it is
  **filled in automatically with the seed actually used** (even when it was drawn at random), so
  "press Generate again" reproduces the same image; "Random" next to it clears it.

### Settings

The **Settings** button at the top right opens a dialog with three tabs. **This is the only place the key
can be entered** — the workspace is its own view and cannot reach DSH's settings page. While no key is
configured, the button is rendered in the primary colour.

- **Key** — set / replace / clear the OpenRouter key; the `Validate` button checks it on the spot and
  reports the remaining credit.
- **Models** — a single list (up to 16) that **does two jobs at once**: which models are selectable, and
  which one is the default; it also lets you pull from the online catalogue. The row marked **default**
  (green) is the one that gets used; every other row offers "set as default". The same list is the
  candidate pool for the picker in the conversation column.
- **Advanced** — the text model used for writing prompts, the save directory, provider ordering and extra
  request-body JSON.

**The two models are not the same thing**: the **image model** draws, the **prompt model** writes prompts
(default `google/gemini-2.5-flash`). Pointing the latter at an image model will fail.

**How the key is treated:**

- **A stored key is never read back into the page.** `/config` reports only a *shape*: the prefix
  `sk-or-v1-` plus the last four digits — enough to recognise *which* key is stored, useless to anyone
  who reads it.
- **An empty input means "keep the stored key"**; only a typed value replaces it. So leaving it blank
  when a key is already configured is a **normal state**, not an omission.
- **Saving is explicit**: the parameters pane is a live panel (changes are stored immediately), but the
  dialog is a form — nothing is written until you press `Save`.
- **A malformed key is rejected at save time** (does not start with `sk-or-v1-`, or is obviously too
  short) instead of producing a 401 at generation time. This is a **purely local check**; no network
  request is made.
- **Clearing is its own action**: there is a dedicated `DELETE /config/key`, because `POST /config`
  deliberately ignores a blank `apiKey` (to prevent accidental erasure) and therefore cannot express
  "delete it".
- `GET /test?key=…` and `GET /models?key=…` accept a **candidate key that has not been saved yet**. It is
  used for that one request and never written to disk — which is what makes "test before you save" work.

### Proactive generation by the agent

The tool could always be called by the agent, but *being callable* and *being used proactively* are
different things. What this section is about is the second one.

The two sentences originally in the tool description — written for the workspace — were exactly the two
that blocked it. What the description carries now is the agent's own contract:

- **The user not saying "make an image" does not mean you may not** — when the deliverable they asked
  for is missing precisely that image, call the tool and use the result in the deliverable;
- **When unsure, ask one question first** — every call spends the user's own credits, and spending money
  silently is worse than asking;
- **Hand back the path in the result** — saying "generated" without a path is of no use to the person you
  just generated it for.

Four parameters were added for this:

| Parameter | Who fills it | What it does |
| --- | --- | --- |
| `save_dir` | Deliverables with a known home | Drops the image into the deliverable's own directory (relative to the session directory) instead of the shared `generated-images/` |
| `file_name` | When the filename is known | Filename stem; the extension is always `.png`, do not include it |
| `aspect_ratio` | **The agent's engineering judgement** | A web hero wants 16:9, an avatar wants 1:1 — a hard constraint a prompt cannot hold against |
| `resolution` | When the image is used as a large one | Same |

**What the agent may set, and what it may not:**

- **May set:** `aspect_ratio`, `resolution`, `background`. It may set `quality` too, but only to `medium`
  or `high`.
- **Fixed:** there is **no `count` parameter — one call produces one image**; the **format is always
  PNG**. For several versions, make several calls with different prompts.
- `model`, the `quality` tier, `background` and `seed` are the user's to choose — **leave them empty
  unless the user names them**, and let the workspace decide.

Those two fixed rules are decisions, not API limitations. Their purpose is to make "generate it, then
use it" a deterministic step: the path the tool returns is the filename the agent chose, not one more
candidate out of a numbered list that still has to be picked from.

**Manual generation in the workspace is entirely unaffected**: count, format and quality remain
selectable there, jpeg/webp stay available, several images per run stay available. All of the above
constrains the tool-call path only.

### Aspect ratio and the pixels you actually get

The values `512 / 1K / 2K / 4K` of `resolution` are **tier names**, not output dimensions. A measured run
of `2K` + `16:9` produced a file that is **1536×864**, not 2048×1152. Inferring the size from the name is
always wrong, and ad slots are a whitelist of exact sizes (1200×628, 300×250, 336×280 and so on for
Google Ads) — being off by an aspect ratio means cropping before you can use it.

So the tool receipt carries a line **`尺寸：1536×864`** — the **pixels actually delivered**, read from the
image's own file header (PNG `IHDR`, JPEG `SOF`, GIF screen descriptor), not an echo of the tier name
from the request. When the ratio does not match what was asked for, the receipt adds an explicit warning
(the receipt text itself is Chinese, and is shown here verbatim):

```
注意：请求画幅 16:9，实际交付 1200×628（1.91:1）比例不符，投放前需自行裁剪或重出。
```

Two boundaries: the plugin **reports, it does not regenerate** (the image has already been paid for, and
re-rolling it on your behalf is not the plugin's decision); **WebP sizes cannot be read** (three container
variants, 14-bit packed fields), so the dimension is left blank rather than guessed. The width and height
are also written into the generation history.

### Generation history

This is what v2 adds over v1, and what makes "history" and "regenerate with the same settings" possible
at all. It stores **metadata, not pixels** (prompt, the parameters actually sent, seed, path, attachment
id, the width and height really delivered). It lives in `~/.dsh/openrouter-imagen-v2/history.json`,
**survives a restart**, and keeps at most **60 records**, newest first.

### Known limitations

- **"Let AI write the prompt" calls the plugin's own text model, not the conversation model.** The client
  `sessions` service surface only offers lifecycle methods — there is **no "post a message into the
  session"** — and the host has no service to drive another agent turn either. So `/prompt` asks
  `promptModel` directly. That is a **real model call**, not template assembly, but it **shares no
  conversation context**: if you have been discussing this image for a while, none of that reaches it.
- **Reference images are one-shot**: they travel with that single request, are not written into the
  history, and are not replayed by "regenerate with the same settings".
- **The workspace's conversation column is its own record.** It neither reads nor writes DSH's session
  message stream — deliberately, since the workspace must be able to exist independently of a chat.
- **Image display size is the workspace's own business** (the large image fits the pane, history
  thumbnails are 54px).

### Security boundaries

- **The key never leaks**: `apiKey` is `role('secret')`; no settings-reading endpoint returns it.
- **Candidate keys are not persisted**: the `key` parameter of `/test` and `/models` is used for that one
  request only.
- **Reference images are confined to the session working directory** — these bytes go to a third party,
  so an out-of-bounds path is rejected outright.
- **The on-disk directory is confined the same way**: a `save_dir` outside the session working directory
  is an **error**, not a silent relocation.
- **Tool parameters are closed**: undeclared keys are rejected, not spread into the request body.
- **`extraJson` cannot overrule**: it may not override `model`, `prompt` or `input_references`.
- **Cancellation is observed**: cancelling a turn really does abandon the paid request.

---

## Installation

The supported path is the official CLI:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
dsh plugin --profile desktop add X:\github\dsh-openrouter-imagen-v2
```

Then **restart DSH** and reload the page; **图像生成 / Image** appears under the "Plugins" group in the
sidebar.

<details>
<summary>Manual mounting (without the CLI)</summary>

Two steps, both required:

1. Create a junction pointing at the package directory (**a junction, not a symbolic link**: ESM
   resolves dependencies by real path, and a symlink makes the package's `import '@deepseek-ai/...'`
   fail to resolve):

   ```powershell
   $link = 'C:\Users\WR\.dsh\profiles\desktop\node_modules\dsh-openrouter-imagen-v2'
   New-Item -ItemType Junction -Path $link -Target 'X:\github\dsh-openrouter-imagen-v2'
   ```

2. Insert the mount line into **`~/.dsh/profiles/desktop/cordis.patch.yml`**:

   ```yaml
   - insert:
       - id: openrouter-imagen-v2
         name: 'dsh-openrouter-imagen-v2'
   ```

3. Run `npm install` once inside the package directory — `@deepseek-ai/*` is intercepted by the host, but
   `undici` resolves normally and must be found inside the package.

4. **Restart DSH.** Plugin mounting only happens at startup.

</details>

**Do not use both channels at once**: routes with the same `(kind, path)` get registered twice and the
whole plugin tree fails at startup.

---

## Uninstall

Remove the junction from the profile (or the package installed via the CLI), drop the `insert` line from
`~/.dsh/profiles/desktop/cordis.patch.yml`, then **restart DSH**.

The `openrouter-imagen-v2` section of `~/.dsh/settings.yaml` (key and settings) and the
`~/.dsh/openrouter-imagen-v2/` directory (generation history) can be deleted along with it — nothing will
read them again. Images already written to disk are not touched; clean those up yourself as needed.

---

## License

MIT