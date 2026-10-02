# dsh-openrouter-imagen-v2

> **Compatibility: DeepSeek Harness 0.2.x** — developed and tested on **0.2.0-rc.2**.
> Declared as `engines.dsh` in `package.json`; see [NOTES.md](./NOTES.md) for how DSH enforces it.

Image generation for DeepSeek Harness through the OpenRouter Image API, delivered as a **standalone
workspace**.

> **A standalone repository, sitting alongside v1.** It carries its **own** plugin id, settings namespace,
> route prefix and tool name, so both can be installed at the same time without interfering. v1 hangs
> image generation off the chat surface; v2 is entered from the sidebar and takes over the main view —
> **no chat UI wrapped around it**.

[中文](./README.md) · [Development & troubleshooting notes](./NOTES.md)

---

## Introduction

This is a DSH plugin with two halves:

- **Host half** registers the tool `openrouter_generate_imagen_v2`, same-origin routes under
  `/openrouter-imagen-v2/api/*`, and maintains a **generation history**.
- **Client half** registers two slots: the sidebar entry `sidebar.panellist` and the main view `main`.
  Clicking the sidebar entry turns the whole central area into the workspace.
- **Settings dialog** — the key, the models and the prompt model are configured in the workspace's own
  dialog.
- **Bundled skill** `skills/openrouter-imagen-v2/SKILL.md`, which teaches the model to *derive* a style
  rather than look one up in a table.

There are two ways to get an image: press **Generate** in the workspace, or let the agent call the tool
itself.

---

## Usage

### The workspace

Click **图像生成 / Image** under the "Plugins" group in the sidebar. Two panes; the divider **can be
dragged** to change the split (double-click to reset).

- **Left pane** the current image, a strip of history thumbnails below it (the last 5), and the
  parameters area (its height is draggable too).
- **Right pane** the conversation: request → prompt → image, all visible and all editable; the input box
  sits at the bottom of this pane.

Aspect ratios: **12 ratios plus `auto`**, each printed as a number — a square on its own cannot tell 4:5
from 5:4.
Defaults: count `1`, quality `medium`, background `auto`, aspect `16:9`, resolution `1K`.

- **"Confirm the prompt before generating" is off by default.** Off means one click on "Generate"
  produces the image (the prompt is still shown in the conversation); on pauses on the prompt card until
  you click "Generate this".
- **Two prompt modes**: `Write prompt directly` (the text you type is the final prompt, zero extra
  latency) and `Let AI write the prompt` (the default).
- **The model picker sits below the input box** and **applies to that one generation only** — it does not
  change the stored default. Once you pick one, a "back to default" affordance appears and the header
  marks it as a per-run choice. Candidates come from the model list in the settings dialog (up to 16).
- **Reference images** (up to 4): press `+` to pick files, paste into the writing area, or drag them in;
  the `×` on a thumbnail removes it. They go to the image model **as part of this request, with no upload
  step anywhere**. Under `Let AI write the prompt` they also go to the prompt model, so the prompt
  actually *references* them; the status bar says `writing prompt · N references`. If the prompt model
  has **no vision capability**, it falls back automatically to writing without them.
- **The seed** sits below the model row, right above the generate button. After a generation it is
  **filled in automatically with the seed actually used** (even when it was drawn at random), so
  "press Generate again" reproduces the same image; "Random" next to it clears it.

### Settings

The **Settings** button at the top right opens a dialog with three tabs. **This is the only place the key
can be entered** — the workspace has its own view and cannot reach DSH's settings page. While no key is
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

**How the key is handled:**

- **A stored key is never shown in full.** The dialog shows an abbreviated form (prefix plus last four
  digits) — enough to recognise which key is stored, not enough to use it.
- **An empty input means "keep the stored key"**; only a typed value replaces it. Leaving it blank when a
  key is already configured is a **normal state**.
- **The parameters pane stores immediately; the dialog stores on `Save`** — the key and models are a form,
  the parameters pane is a live panel.
- **A malformed key is rejected at save time** (does not start with `sk-or-v1-`, or is obviously too
  short) instead of producing a 401 at generation time. This is a **purely local check**; no network
  request is made.
- **Clearing is its own button**, so emptying the field by accident never deletes anything.
- **`Validate` and the model picker accept a key that has not been saved yet** — it is used for that one
  request and never written to settings. That is how "test it before you commit to it" works.

### Proactive generation by the agent

Besides the button in the workspace, the agent can call this tool directly. If you ask it for a web page,
a document or a report and a picture is exactly what is missing, it will generate one and use it.

Four parameters let it put the image where it belongs:

| Parameter | When it is filled in | What it does |
| --- | --- | --- |
| `save_dir` | The deliverable has a known home | Drops the image into the deliverable's own directory (relative to the session directory) instead of the shared `generated-images/` |
| `file_name` | The filename is known | Filename stem; the extension is always `.png`, do not include it |
| `aspect_ratio` | **Judged by the agent** | A web hero wants 16:9, an avatar wants 1:1 — a hard constraint a prompt cannot hold against |
| `resolution` | The image is used as a large one | Same |

These stay yours to choose — **they are left empty unless you name them**, so the workspace settings
apply: `model`, the `quality` tier, `background` and `seed`.

Two fixed rules:

- **One call produces one image.** There is no "generate several at once" parameter; for several versions,
  make several calls with different prompts.
- **The format is always PNG**, and that one is not selectable.

The point of both rules is to make "generate it, then use it" a deterministic step: the path you get
back is the filename the agent chose, so there is no picking from a numbered list of candidates.

**Manual generation in the workspace is unaffected**: count, format and quality remain selectable there,
jpeg/webp stay available, several images per run stay available.

### Aspect ratio and the pixels you actually get

The values `512 / 1K / 2K / 4K` of `resolution` are **tier names**, not output dimensions. A measured run
of `2K` + `16:9` produced a file that is **1536×864**, not 2048×1152. Inferring the size from the name
gets it wrong, and ad slots are a whitelist of exact sizes (1200×628, 300×250, 336×280 and so on for
Google Ads) — being off by an aspect ratio means cropping before you can use it.

The tool receipt therefore carries a line **`尺寸：1536×864`** — the **pixels actually delivered**, read
from the image's own file header (PNG `IHDR`, JPEG `SOF`, GIF screen descriptor). When the ratio does not
match what was asked for, the receipt adds an explicit warning (the receipt text itself is Chinese, shown
here verbatim):

```
注意：请求画幅 16:9，实际交付 1200×628（1.91:1）比例不符，投放前需自行裁剪或重出。
```

What you do about a warning is your call — the plugin reports the size and never regenerates for you.
The image has already been paid for. **WebP sizes cannot be read** (three container variants, 14-bit
packed fields), so that line is blank for WebP. The width and height also go into the generation history.

### Generation history

Every generation leaves behind its **metadata**: the prompt, the parameters actually sent, the seed, the
file path, the attachment id and the width and height really delivered (**not the image itself**). It is
kept in `~/.dsh/openrouter-imagen-v2/history.json`, **survives a restart**, and holds at most **60
records**, newest first — which is what the workspace's "last 5" and "regenerate with the same settings"
read.

### Known limitations

- **"Let AI write the prompt" shares no conversation context.** It is a separate text-model call (not
  template assembly), and it does not receive anything you have already discussed in the conversation.
- **Reference images are one-shot**: they travel with that single request, are not written into the
  history, and are not replayed by "regenerate with the same settings". Attach them again to regenerate.
- **The workspace's conversation column is its own record.** It neither reads nor writes DSH's session
  message stream, which is what lets the workspace exist independently of a chat.
- **Image display size is the workspace's own business** (the large image fits the pane, history
  thumbnails are 54px).

### Security boundaries

- **The key never leaks**: no settings-reading endpoint returns it, only an abbreviated form that can be
  recognised but not used.
- **The candidate key used by `Validate` and the model picker is not persisted** — that request only.
- **Reference images are confined to the session working directory** — these bytes go to a third party, so
  an out-of-bounds path is rejected outright.
- **The on-disk directory is confined the same way**: a `save_dir` outside the session working directory
  is an **error**, not a silent relocation.
- **Tool parameters are closed**: undeclared keys are rejected and never mixed into the request body.
- **The extra request-body JSON cannot overrule**: it may not override `model`, `prompt` or
  `input_references`.
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

3. Run `npm install` once inside the package directory.

4. **Restart DSH.**

</details>

**Do not use both channels at once**: routes with the same `(kind, path)` get registered twice and the
whole plugin tree fails at startup.

---

## Uninstall

Remove the junction from the profile (or the package installed via the CLI), drop the `insert` line from
`~/.dsh/profiles/desktop/cordis.patch.yml`, then **restart DSH**.

The `openrouter-imagen-v2` section of `~/.dsh/settings.yaml` (key and settings) and the
`~/.dsh/openrouter-imagen-v2/` directory (generation history) can be deleted along with it. Images
already written to disk are not touched; clean those up yourself as needed.

---

## License

MIT