# dsh-openrouter-imagen-v2

> **Compatibility: DeepSeek Harness 0.2.x** (developed and tested on 0.2.0-rc.2)

A DSH plugin that generates and edits images through the OpenRouter Image API. It provides a standalone workspace (sidebar entry + main view) and a tool that agents can call directly.

[中文](./README.md) · [Development & troubleshooting notes](./NOTES.md)

## Features

- **Standalone workspace**: two-pane layout (image area + conversation), draggable divider
- **Two ways to generate**: manually in the workspace, or via the agent tool
- **Prompts**: write directly, or have a text model write them (default `google/gemini-2.5-flash`)
- **Reference images**: up to 4, via file picker, paste, or drag-and-drop; sent with the request
- **Model management**: a list of up to 16 models with a default; override per generation
- **Seed write-back**: the seed actually used is filled in after each generation, for reproduction
- **Generation history**: last 60 records, survives restart, regenerate with the same settings
- **Bundled skill**: teaches the model to derive style and prompts from the request

## Requirements

| Dependency | Version |
| --- | --- |
| DeepSeek Harness | 0.2.x |
| Node.js | `^22.19.0` or `>=24.0.0` |
| OpenRouter API key | required |

## Installation

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
dsh plugin --profile desktop add X:\github\dsh-openrouter-imagen-v2
```

Then **restart DSH** and reload the page; **图像生成 / Image** appears under the "Plugins" group in the sidebar.

<details>
<summary>Manual mounting (without the CLI)</summary>

1. Create a junction pointing at the package directory (a junction, not a symbolic link):

   ```powershell
   $link = 'C:\Users\WR\.dsh\profiles\desktop\node_modules\dsh-openrouter-imagen-v2'
   New-Item -ItemType Junction -Path $link -Target 'X:\github\dsh-openrouter-imagen-v2'
   ```

2. Add to `~/.dsh/profiles/desktop/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: openrouter-imagen-v2
         name: 'dsh-openrouter-imagen-v2'
   ```

3. Run `npm install` inside the package directory, then **restart DSH**.

Do not use both channels at once: routes with the same `(kind, path)` are registered twice and the plugin tree fails at startup.

</details>

## Usage

### Workspace

Open **图像生成 / Image** from the "Plugins" group in the sidebar.

| Pane | Contents |
| --- | --- |
| Left | current image, history thumbnails (last 5), parameters |
| Right | conversation (request → prompt → image) and input box |

Defaults: count `1`, quality `medium`, background `auto`, aspect `16:9`, resolution `1K`. Aspect ratios: 12 options plus `auto`.

- **Prompt modes**: `Write prompt directly` (the typed text is the final prompt) or `Let AI write the prompt` (default).
- **Confirm switch**: "Confirm the prompt before generating" is off by default; when on, the prompt must be confirmed before generating.
- **Model picker**: below the input box, applies to that generation only; a one-click affordance returns to the default.
- **Reference images**: sent with that request only; they are not written to the history. Re-attach them to regenerate.
- **Seed**: filled in automatically with the seed actually used; generating again reproduces the same image, `Random` clears it.

### Settings

The **Settings** button at the top right opens a dialog:

| Tab | Contents |
| --- | --- |
| Key | enter and validate the OpenRouter key (on-the-spot check with credit) |
| Models | model list and default model; pull from the online catalogue |
| Advanced | prompt model, save directory, provider ordering, extra request-body JSON |

- A stored key is shown only as prefix plus last four digits; an empty input keeps the stored key.
- Clearing the key is a separate action; emptying the field never deletes it.
- Malformed keys are rejected by a local check at save time, with no network request.
- `Validate` and the model catalogue accept an unsaved key, used for that request only and never written to settings.

The save directory `saveDir` is relative to the current session working directory, default `generated-images`.

### Agent tool

The tool `openrouter_generate_imagen_v2` can be called directly by the agent, for cases where a deliverable is missing an image (web page artwork, document illustration, cover, etc.).

| Parameter | Required | Description |
| --- | --- | --- |
| `prompt` | yes | what the picture should show |
| `save_dir` | no | save directory, relative to the session working directory; out-of-bounds paths error |
| `file_name` | no | filename stem; the extension is always `.png` |
| `aspect_ratio` | no | aspect ratio, chosen for the use case (e.g. 16:9 hero, 1:1 avatar) |
| `resolution` | no | resolution tier |
| `quality` / `background` / `model` / `seed` | no | fall back to the workspace settings when omitted |

Fixed behaviour: one call produces one image, in PNG format.

## Notes

- The `resolution` values `512 / 1K / 2K / 4K` are tier names, not fixed pixel sizes. The tool result reports the dimensions actually delivered, and warns when the ratio does not match the request; it does not regenerate automatically.
- "Let AI write the prompt" is a separate text-model call and shares no conversation context.
- Reference images apply to that request only.
- The workspace's conversation column is independent of the DSH session message stream.
- The key is never returned in full by any endpoint; reference images and the save directory are confined to the session working directory; undeclared tool parameters are rejected.

## Uninstall

Remove the junction from the profile (or uninstall the package via the CLI) and drop the `insert` line from `~/.dsh/profiles/desktop/cordis.patch.yml`, then **restart DSH**.

The `openrouter-imagen-v2` section of `~/.dsh/settings.yaml` and the `~/.dsh/openrouter-imagen-v2/` directory can be deleted as well. Images already written to disk are not affected.

## License

MIT