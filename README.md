# dsh-openrouter-imagen-v2

> **v2 与 v1 并存。** 这个包在仓库的 `v2/` 目录下，包名 `dsh-openrouter-imagen-v2`，
> 用的是自己的插件 id、设置命名空间、路由前缀和工具名。**装 v2 不会影响 v1**，两个可以同时装。

v1 把生图能力挂在 DSH 的对话界面上（设置页 + 输入框上方的参数条 + 对话里的图片卡片）。
v2 换了个思路：**一个独立的工作台**，从左侧边栏进入，占据中央主视图，**不套用对话界面**。

- **Host 半边**：注册 `openrouter_generate_imagen_v2` 工具、`/openrouter-imagen-v2/api/*` 同源路由，
  以及一份**生成记录**（v1 没有这东西 —— 图片只以附件和文件形式存在，所以「最近 5 张」和「用同样参数再出」都无从读起）。
- **Client 半边**：两个注册 —— `sidebar.panellist`（侧栏全局面板图标，就在「插件」组下面）和
  `main`（键控中央主视图，key = `imagen`）。点侧栏入口，中央区域整块变成工作台。
- **自带 skill**：`skills/openrouter-imagen-v2/SKILL.md` 随包安装，教模型「推导画风，不要查表」。

## 界面

两栏，中间的分隔条**可以拖动**调宽度（默认 60/40，双击复位）。

| | |
| --- | --- |
| **左栏** | 图片区：当前大图 + 下面一条历史小图（保留最近 5 张）+ 参数区（高度也能拖，默认 236px） |
| **右栏** | 对话：要求 → 提示词 → 出图，全过程可见可改；输入框在这一栏底部 |

- **画幅**给的是插件真实支持的 12 个比例 + `auto`，**每个都印出数字** —— 方块本身分不出 4:5 和 5:4。
- **默认值**：数量 1、质量 `medium`、背景 `auto`、宽高比 `16:9`、分辨率 `1K`。
- **「写提示词后先确认再出图」默认关**。关着就是点一次「生成」直接出图（提示词仍显示在对话里）；
  打开会在提示词卡片上停一下，等你点「就这样出图」。
- **提示词双模式**：`直接出图`（输入框文字即最终提示词，零额外延迟）与 `让 AI 写提示词`（默认）。

## 设置弹窗

右上角的 **设置** 按钮打开一个弹窗，三个页签。**这是配置密钥的唯一入口** —— 工作台是自己的视图，
够不到 DSH 自带的设置页，所以没有它就没法把密钥填进去（首次运行时头部那颗红色「密钥 未配置」说的就是这个）。
密钥没配时，这颗按钮是**主色**的。

| 页签 | 内容 |
| --- | --- |
| **密钥** | 填 / 换 / 清除 OpenRouter 密钥，`校验` 按钮当场验证并报额度 |
| **模型** | 图像模型下拉、模型清单（最多 16 个）、从线上目录挑选 |
| **高级** | 写提示词的文本模型、保存目录、Provider 排序、附加请求体 JSON |

**两个模型不是一回事**，弹窗里分开写清楚了：**图像模型**画图，**提示词模型**写提示词 —— 后者填成图像模型会失败。

### 密钥是怎么被对待的

- **已存的密钥永远不会被读回页面。** `/config` 只回报一个**形状**：前缀 `sk-or-v1-` 加末四位
  （`已配置 sk-or-v1-…cdef`）。够用来认出「存的是哪一把」，对读到它的人没用。
- **输入框留空 = 保留已存的密钥**，输入了才替换。所以「已经配好密钥」时留空是**正常状态**，不是遗漏。
- **保存是显式的**：参数区是实时面板（改完即存），但弹窗是个表单 —— 密钥边打边存是更糟的体验，
  所以只有按 `保存` 才写。
- **形态不对的密钥在保存时就被挡下**（不以 `sk-or-v1-` 开头、或短得明显不完整），
  而不是等出图时 401 —— 那会白费一次写提示词的调用。这是**纯本地检查**，不发网络请求，离线也能存。
- **清除是独立动作**：`POST /config` 会**忽略空白的 apiKey**（防止误清），所以它表达不了「删掉」。
  忘记一把密钥必须是明确的操作，因此单给了一个 `DELETE /config/key`。

### 校验与拉取用「候选密钥」

`GET /test?key=…` 与 `GET /models?key=…` 接受一个**还没保存**的密钥，只用于这一次请求、绝不落盘。
这正是「先测再存」能成立的原因 —— 否则想验证一把密钥就必须先把它存进去。

## 安装

标准通道是官方 CLI：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
cd X:\github\dsh-openrouter-imagen-v2
dsh plugin --profile desktop add X:\github\dsh-openrouter-imagen-v2
```

装完**重启 DSH**，刷新页面，侧栏「插件」组下面会出现 **图像生成**。

### 手动挂载（不走 CLI）

两步缺一不可：

1. 建一个指向包目录的 junction（**必须用 junction 而不是符号链接**：ESM 按真实路径解析依赖，符号链接会让包内的
   `import '@deepseek-ai/...'` 找不到）：

   ```powershell
   $link = 'C:\Users\WR\.dsh\profiles\desktop\node_modules\dsh-openrouter-imagen-v2'
   New-Item -ItemType Junction -Path $link -Target 'X:\github\dsh-openrouter-imagen-v2'
   ```

2. 在 **`~/.dsh/profiles/desktop/cordis.patch.yml`** 里插入挂载行：

   ```yaml
   - insert:
       - id: openrouter-imagen-v2
         name: 'dsh-openrouter-imagen-v2'
   ```

3. 在 `v2/` 里跑一次 `npm install` —— `@deepseek-ai/*` 由宿主拦截解析，但 `undici` 走普通解析，
   必须能在包内找到（这是 v1 踩过的坑：app 升级后 junction 链断掉，插件整个挂不上）。

4. **重启 DSH**。插件的挂载只在启动期发生。

**不要同时用两条通道**：同一个 `(kind, path)` 的路由会被注册两次，整个插件树在启动时失败。

## 配置

写进 `~/.dsh/settings.yaml` 的 `openrouter-imagen-v2` 命名空间。多数项在工作台里直接改，改完即存。

| 字段 | 在哪改 | 说明 |
| --- | --- | --- |
| `apiKey` | **设置弹窗 → 密钥** | OpenRouter 密钥，`role('secret')`，服务端从不回传（只给头尾预览） |
| `model` | 设置弹窗 → 模型 / 工作台「参数」 | 默认图像模型 id |
| `models` | 设置弹窗 → 模型 | 图像模型清单，最多 16 个；工作台的下拉读的就是它 |
| `promptModel` | **设置弹窗 → 高级** | 「让 AI 写提示词」用的**文本**模型（默认 `google/gemini-2.5-flash`）；指向图像模型会失败 |
| `resolution` / `aspectRatio` / `quality` / `outputFormat` / `count` / `background` / `seed` | 工作台「参数」 | 逐次调整的生成参数 |
| `confirmPrompt` | 工作台「参数」 | 写提示词后是否先确认，**默认 false** |
| `splitRatio` | 拖动分隔条 | 左栏宽度占比，默认 0.6 |
| `paramsHeight` | 拖动参数区分隔条 | 参数区高度 px，默认 236 |
| `saveDir` | 设置弹窗 → 高级 | 生成文件的存放目录，默认 `generated-images` |
| `providerSort` / `extraJson` | 设置弹窗 → 高级 | Provider 排序 / 附加请求体字段 |
| `skills` | settings.yaml | 是否安装随包 skill，默认开 |

## 生成记录

**这是 v2 相对 v1 新增的东西**，也是「历史」和「用同样参数再出」的前提。

v1 的图片只存在于两处：durable attachment 与 `saveDir` 里的文件。**没有任何索引** —— 不知道哪张图是哪次生成的、
用的什么提示词和参数。所以 v2 在 Host 侧加了一份记录：

- 存**元数据，不存像素**（提示词、实际发出的参数、种子、路径、附件 id）。记录里复制一份字节会让每张图的磁盘占用翻倍。
- 写在 `~/.dsh/openrouter-imagen-v2/history.json`，**重启后仍在**。写入是「临时文件 + rename」，写坏也不会留下半截文件。
- **最多 60 条**，最新的在前；读坏或读不到都当作空历史 —— 一份索引不值得让整个插件起不来。
- 写入失败**只记 warning、不让这次生成失败**：丢历史可以，丢图片不行。

## API（同源 JSON，工作台自己用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/config` | 当前设置（**不含密钥**，只回报 `hasKey` 与头尾预览） |
| POST | `/config` | 写设置；**空白 `apiKey` 会被忽略**（不会清掉已存的 Key）；形态不对的密钥被拒 |
| DELETE | `/config/key` | 清除已存的密钥（唯一能表达「删掉」的动作） |
| GET | `/history?limit=N` | 生成记录，最新在前 |
| DELETE | `/history?id=X` | 删一条；不带 `id` 清空 |
| GET | `/image?id=X&name=Y` | 取某条记录里某张图的字节 |
| POST | `/prompt` | 把口语要求写成专业提示词；`generate: true` 则连出图一起做 |
| GET | `/models?key=…` | 拉取线上图像模型目录；`key` 是**未保存的候选密钥** |
| GET | `/test?key=…` | 校验 Key 与额度；同样接受候选密钥 |
| POST | `/generate` | 直接出图 |

每个请求先过 `connection.requestRejection` —— 也就是 DSH 自带路由用的同一道闸（Host/Origin 不匹配 403，
没有浏览器鉴权 cookie 401）。`/generate` 是花钱接口，这是它唯一的门禁。

**`/image` 不是通用文件读取器**：`id` 必须在记录里存在，`name` 必须是那条记录里的某张图，
路径来自插件自己写下的记录。越界请求一律 404。

## 安全

- **密钥不外泄**：`apiKey` 是 `role('secret')`，任何设置读取接口都不返回它 —— `/config` 只给
  前缀加末四位的**预览**，用来认出是哪一把，不足以使用。
- **候选密钥不落盘**：`/test` 与 `/models` 的 `key` 参数只用于那一次请求。
- **本机参考图限制在会话工作目录内**：`reference_files` 由模型给出，而这些字节会发往第三方；
  `dsh-fs-local` 能解析任意绝对路径、文件沙箱只管写不管读，所以越界路径会被直接拒绝。
- **工具参数是封闭的**：未声明的键会被拒绝，而不是展开进请求体。
- **`extraJson` 不能越权**：不能覆盖 `model` / `prompt` / `input_references`。
- **取消会被观测**：`exec.signal` 与 10 分钟上限合并传给请求，取消一轮对话会真的放弃这次付费请求。

## 排错

### 接口返回 404 / 405 / 非 JSON

**`GET` 404 加 `POST` 405，同时出现在 `/openrouter-imagen-v2/api/*` 上 —— 这是「插件没挂载」。**

不是请求写错了，而是 DSH 的前端静态兜底在应答：它接住所有没被路由匹配的请求，未知路径回 404、
非 GET 回 405。**你自己的接口不该由兜底来回答**，所以这两个状态码等价于「这一行没加载」。

原因几乎总是同一个：**插件行只在 DSH 启动时加载**。装完不重启，路由就不存在。

还有一种更隐蔽的情况：如果那一行在**包还没写完的时候**被读到过，它的 fiber 会停在 `failed`，
而且**这个进程活多久就失败多久** —— 之后把文件改对了也没用，因为模块不会被再次导入，
热重载也不会重试。判断依据是「模块加载期的日志一行都没出现」，那就说明 `apply()` 压根没跑。

判断当前状态：

```powershell
# 404 = 没挂载（或 fiber failed）；401 = 挂载了，闸门在工作
Invoke-WebRequest http://127.0.0.1:19387/openrouter-imagen-v2/api/config -UseBasicParsing
```

工作台现在会直接说「接口没有挂载…请重启 DSH」，而不是报一个用户无法处置的状态码。

### 怎么确认一行到底加载了没有

`plugin_manager` 的 `list_plugins` 给出每一行的 `fiberPhase`：

| `fiberPhase` | 含义 |
| --- | --- |
| `active` | 加载成功，路由已注册 |
| `failed` | 加载过并抛错了 —— 在当前进程里不会自行恢复 |
| `null` | 未启用 |

v1 与 v2 都应当是 `active`。只有 v2 是 `failed` 时，问题在 v2 这一行，与 v1 无关。

### 密钥保存时报错

- **「这看起来不是 OpenRouter 密钥」** —— 保存时就挡下（不以 `sk-or-v1-` 开头，或短得明显不完整）。
  这是**纯本地检查**、不发网络请求，用来避免把一次写提示词的调用浪费在注定 401 的密钥上。
- **「未配置 API Key」** —— 密钥是空的。点右上角 **设置** 填进去。

## 已知限制

- **「让 AI 写提示词」走的是插件自己的文本模型调用，不是对话模型。** 设计上这条路要经过对话模型
  （自带 skill 教的正是提示词推导），但客户端 `sessions` 服务面只有生命周期方法，**没有「往会话里发一条消息」**，
  而 Host 也没有驱动另一个 agent 回合的服务。所以 `/prompt` 用 `promptModel` 直接问一个文本模型，
  把 skill 的推导规则作为指令 —— 这是**真实的模型调用**，不是模板拼接；但它**不共享对话上下文**。
  如果你已经在对话里聊了半天这张图，那些上下文不会进入这次调用。
- **工作台的对话栏是它自己的记录**，不读也不写 DSH 的会话消息流。这是刻意的：工作台要能独立于对话存在。
- **参考图上传还没接**（UI 里的 `+` 是占位）：参考图目前只能通过工具参数给。
- 图片显示尺寸由工作台自己决定（大图自适应、历史小图 54px）。

## 开发

```powershell
cd X:\github\dsh-openrouter-imagen-v2
npm install
npm run check     # 四个文件的语法
npm run smoke     # Host 半边真跑（桩 Context，不发网络请求、不花钱）
npm run preview   # Client 半边真挂载 + 生成 preview/workspace.html 与 preview/settings.html
npm run all       # 以上全部
```

`smoke.mjs`（**62 项**）断言的是契约而不是实现细节：记录能跨重启读回、上限生效、**驱逐的是最旧的**、
`/image` 拒绝一切不在记录里的 id、**空白 apiKey 不会被写掉**、**形态不对的密钥在保存时被拒且不落盘**、
`/config` 只给密钥头尾预览而不给原文、`DELETE /config/key` 才真正清空、**候选密钥不会被写进设置**、
`auto` 值是**省略**而不是发送字符串、越界参考图被拒、`extraJson` 不能换模型。

`preview.mjs`（**44 项**）加载**真实的** `lib/client.js`，用一个小 React 替身真跑 `useState` / `useEffect` / `useRef`，
挂载真组件，然后从这些组件生成 HTML —— 所以两张 preview 页面都是**代码渲染出来的**，不是手画的稿子。
它同时断言：只注册了 `sidebar.panellist` 与 `main`（**没有碰 `conversation.*`**）、
12 个比例都在且带数字、确认开关默认关、输入框下方没有说明段落、
**设置弹窗在未打开时不进 DOM**、密钥字段默认掩码、已存密钥只显示头尾预览。

> 断言 DOM 时先剥掉 `<style>`：弹窗自己的 CSS 里就含 `dsh-iv-modal` / `data-open="1"` 这些选择器，
> 不剥的话 `includes` 会命中样式表，无论组件渲染与否都通过。

> `preview/*.html` 是静态 HTML，`<select>` 的**静态 `value` 属性不生效**（浏览器只在解析时看 `<option selected>`）。
> 所以截图里分辨率显示 `auto` 而不是 `1K` —— 组件本身是对的（React 设的是 `.value` **属性**，实测生效），
> 这是预览渲染器的局限，不是插件的缺陷。

## 卸载

删掉 profile 里的 junction、从 `cordis.patch.yml` 移除那条 `insert` 行，重启即可。
`~/.dsh/settings.yaml` 里的 `openrouter-imagen-v2` 段与 `~/.dsh/openrouter-imagen-v2/` 目录可一并删除。
