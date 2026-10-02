# dsh-openrouter-imagen-v2

> **兼容版本：DeepSeek Harness 0.2.x**（在 0.2.0-rc.2 上开发并测试）

一个 DSH 插件：通过 OpenRouter Image API 生成与编辑图片。提供独立工作台（侧栏入口 + 中央主视图），并提供可供 agent 调用的工具。

[English](./README.en.md) · [开发笔记与排错](./NOTES.md)

## 功能

- **独立工作台**：双栏布局（图片区 + 对话区），分隔条可拖动
- **两种出图方式**：工作台手动生成，或 agent 调用工具
- **提示词**：直接出图，或由文本模型生成（默认 `google/gemini-2.5-flash`）
- **参考图**：最多 4 张，支持文件选择、粘贴、拖放，随请求直接发送
- **模型管理**：清单最多 16 个，可指定默认模型；单次出图可临时覆盖
- **种子回填**：生成后自动写入实际使用的种子，便于复现
- **生成记录**：最近 60 条，重启保留，支持按相同参数重新生成
- **随包 skill**：指导模型按需求推导画风与提示词

## 要求

| 依赖 | 版本 |
| --- | --- |
| DeepSeek Harness | 0.2.x |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| OpenRouter API Key | 必需 |

## 安装

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
dsh plugin --profile desktop add X:\github\dsh-openrouter-imagen-v2
```

安装后**重启 DSH** 并刷新页面，侧栏「插件」组下出现 **图像生成**。

<details>
<summary>手动挂载（不通过 CLI）</summary>

1. 创建指向包目录的 junction（必须用 junction，不能用符号链接）：

   ```powershell
   $link = 'C:\Users\WR\.dsh\profiles\desktop\node_modules\dsh-openrouter-imagen-v2'
   New-Item -ItemType Junction -Path $link -Target 'X:\github\dsh-openrouter-imagen-v2'
   ```

2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中加入：

   ```yaml
   - insert:
       - id: openrouter-imagen-v2
         name: 'dsh-openrouter-imagen-v2'
   ```

3. 在包目录执行 `npm install`，然后**重启 DSH**。

两种方式不要同时使用，否则同一路由会被注册两次，插件树启动失败。

</details>

## 使用

### 工作台

从侧栏「插件」组进入 **图像生成**。

| 区域 | 内容 |
| --- | --- |
| 左栏 | 当前图片、历史缩略图（最近 5 张）、参数区 |
| 右栏 | 对话（要求 → 提示词 → 出图）与输入框 |

默认参数：数量 `1`、质量 `medium`、背景 `auto`、宽高比 `16:9`、分辨率 `1K`。画幅支持 12 个比例 + `auto`。

- **提示词模式**：`直接出图`（输入即最终提示词）或 `让 AI 写提示词`（默认）。
- **确认开关**：「写提示词后先确认再出图」默认关闭；开启后提示词需手动确认才会出图。
- **模型选择器**：位于输入框下方，仅作用于本次出图，选择后可一键回到默认。
- **参考图**：随当次请求发送，不写入生成记录；重新生成需重新添加。
- **种子**：生成后自动回填实际使用的种子；再次生成即复现同一张图，`随机` 按钮清空。

### 设置

右上角 **设置** 打开弹窗：

| 页签 | 内容 |
| --- | --- |
| 密钥 | OpenRouter 密钥的填写与校验（当场验证并显示额度） |
| 模型 | 模型清单、默认模型，可从线上目录拉取 |
| 高级 | 提示词模型、保存目录、Provider 排序、附加请求体 JSON |

- 已存密钥只显示前缀与末四位；输入框留空表示保留现有密钥。
- 清除密钥是独立操作，清空输入框不会删除已存密钥。
- 格式不正确的密钥在保存时被本地校验拒绝，不发网络请求。
- 「校验」与模型目录拉取可使用尚未保存的密钥，仅当次有效、不写入设置。

保存目录 `saveDir` 相对当前会话工作目录，默认 `generated-images`。

### agent 调用

工具 `openrouter_generate_imagen_v2` 可由 agent 直接调用，适用于「产物缺一张图」的场景（网页配图、文档插图、封面等）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 画面描述 |
| `save_dir` | 否 | 保存目录，相对会话工作目录；越界报错 |
| `file_name` | 否 | 文件名主干，扩展名固定 `.png` |
| `aspect_ratio` | 否 | 画幅，按用途确定（如网页头图 16:9、头像 1:1） |
| `resolution` | 否 | 分辨率档位 |
| `quality` / `background` / `model` / `seed` | 否 | 未指定时使用工作台设置 |

固定行为：单次调用生成一张图，输出格式 PNG。

## 说明

- `resolution` 的 `512 / 1K / 2K / 4K` 是档位名，不对应固定像素。工具结果会报告实际交付的宽高；与请求画幅不符时给出警告，但不会自动重新生成。
- 「让 AI 写提示词」是一次独立的文本模型调用，不共享对话上下文。
- 参考图仅当次有效。
- 工作台的对话栏独立于 DSH 会话消息流。
- 密钥不会通过任何接口返回原文；参考图与保存目录均限制在会话工作目录内；未声明的工具参数会被拒绝。

## 卸载

删除 profile 中的 junction（或通过 CLI 卸载包），并从 `~/.dsh/profiles/desktop/cordis.patch.yml` 移除对应的 `insert` 行，然后**重启 DSH**。

`~/.dsh/settings.yaml` 中的 `openrouter-imagen-v2` 段与 `~/.dsh/openrouter-imagen-v2/` 目录可一并删除。已生成到磁盘的图片不受影响。

## License

MIT