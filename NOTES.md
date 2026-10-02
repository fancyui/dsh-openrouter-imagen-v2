# NOTES · 开发笔记与排错

> 这份文件记录**改这个插件时的经验、踩过的坑和内部约定**，面向维护者。
> 面向使用者的内容在 [README.md](./README.md)（中文）与 [README.en.md](./README.en.md)（英文）——
> **两份是独立的文件**，不是一个文件里中英混排：混排在 GitHub 上没法用。
> 本文件**只有中文**，因为它是调试过程的记录，逐句翻译会稀释「当时为什么这么想」。
> 结论性的规则本身与语言无关，英文读者照着做也不会错。

**目录**

- [开发与验证](#开发与验证)
- [排错](#排错)
- [内部参考](#内部参考)
- [已知的实现瑕疵](#已知的实现瑕疵)

---

## 开发与验证

```powershell
cd X:\github\dsh-openrouter-imagen-v2
npm install
npm run check     # 五个文件的语法
npm run smoke     # Host 半边真跑（桩 Context，不发网络请求、不花钱）
npm run preview   # Client 半边真挂载 + 生成 preview/*.html
npm run load      # 打包与加载面检查
npm run all       # 以上全部
```

四套测试各自的定位：

| 脚本 | 项数 | 断言的是什么 |
| --- | --- | --- |
| `smoke.mjs` | **145** | Host 半边的**契约**：记录能跨重启读回、上限生效、**驱逐的是最旧的**、`/image` 拒绝一切不在记录里的 id、**空白 apiKey 不会被写掉**、**形态不对的密钥在保存时被拒且不落盘**、`/config` 只给密钥头尾预览而不给原文、`DELETE /config/key` 才真正清空、**候选密钥不会被写进设置**、`auto` 值是**省略**而不是发送字符串、越界参考图被拒、`extraJson` 不能换模型 |
| `preview.mjs` | **101** | 加载**真实的** `lib/client.js`，用一个小 React 替身真跑 `useState` / `useEffect` / `useRef`，挂载真组件，然后从这些组件生成 HTML —— 所以 `preview/` 里的页面都是**代码渲染出来的**，不是手画的稿子 |
| `preflight-load.mjs` | **17** | 打包面：包能按裸名解析、`exports["./client"]` 在、patch 在、`undici` 能从包内解析（v1 的失败模式）、`inject` 恰好是 `['tools']` |

`preview.mjs` 额外断言：只注册了 `sidebar.panellist` 与 `main`（**没有碰 `conversation.*`**）、
12 个比例都在且带数字、确认开关默认关、输入框下方没有说明段落、**设置弹窗在未打开时不进 DOM**、
密钥字段默认掩码、已存密钥只显示头尾预览、**侧栏入口渲染出的「图像生成」只有一个**、
参考图的取/贴/拖都接到同一个入口且**真的随请求发出**、`+` 按钮确实会打开文件选择器、
种子的位置与实际使用值会写回。

### 断言要打在会失败的地方

反复出现的教训：**声明存在 ≠ 生效，辅助函数正确 ≠ 它被用上了。**

- 一条只断言「`width:86px` 这条声明存在」的 CSS 测试是绿的，而声明被更高权重的选择器压住了。
- `sessionCwdFrom` 这个辅助函数单独测全绿，删掉路由里那一行调用**也照样全绿**。
- 断言「源文件里出现过「相对会话目录：」这五个字」是绿的，而那行实际黏在了一长串 Windows 绝对路径后面。

所以：断言优先打在**渲染结果**和**真实调用路径**上，而不是源码文本上。

### 变异测试是「断言非空转」的唯一证明

改了逻辑之后，把源码临时改回去跑一遍测试，确认它真的会红，再还原。

```
回执不再打印 尺寸              → 3 FAIL
比例比较永不触发（if(false)）  → 5 FAIL
attachment 宽度退回裸 Number() → 2 FAIL
记录与路由退回读 attachment 宽高 → 1 FAIL
PNG 宽高读反                   → 3 FAIL
JPEG 不再跳过 DHT              → 2 FAIL
容差收紧到 0                  → 2 FAIL
```

> 变异时优先改**语义**而不是**删代码**。删掉三行警告会留下一个孤立的 `}` 变成语法错误 ——
> 那证明的是 `node --check` 有用，不是断言有用。改成 `if (false) {` 才是有效的变异。

**源码正则断言是逃生舱**，只用于 smoke 跑不到的接线（比如「Host 确实调用了这个辅助函数」）。
能用真实调用覆盖的地方，不要用正则。

### smoke 没有 API key、没有网络

这条决定了 smoke 能断言什么：**在没有 key、没有网络的环境下，拿到的是拒绝信息而不是 API 错误，
这句话本身就是「请求没发出去」的证据**。任何需要真发请求才能验证的行为，只能用源码正则兜。

### 预览与断言的几个陷阱

> 涉及界面文字时，断言优先打在**渲染出的 DOM** 上而不是源码上：源码里可能留着已经没用的
> CSS 类（`.dsh-iv-entrytxt` 就是），grep 会命中它而让检查**假绿**。

> 断言 DOM 时先剥掉 `<style>`：弹窗自己的 CSS 里就含 `dsh-iv-modal` / `data-open="1"` 这些选择器，
> 不剥的话 `includes` 会命中样式表，无论组件渲染与否都通过。

> `preview.mjs` 的渲染器会**跳过对象类型的 prop**，所以 `<input type="file">` 不能用内联
> `style={{display:'none'}}` 藏起来 —— 那样预览页里会冒出一个真的「Choose Files」控件。
> 用类名藏（`.dsh-iv-filein`），两种环境下都成立。

> `preview/*.html` 是静态 HTML，`<select>` 的**静态 `value` 属性不生效**（浏览器只在解析时看 `<option selected>`）。
> 所以截图里分辨率显示 `auto` 而不是 `1K` —— 组件本身是对的（React 设的是 `.value` **属性**，实测生效），
> 这是预览渲染器的局限，不是插件的缺陷。

> CSS 注释里**不能出现反引号** —— 样式表是模板字符串，一个反引号就会提前结束它，
> 报成 `SyntaxError: Unexpected identifier`。

> 测滚动条必须用**有头**浏览器，而且要看 `offsetWidth - clientWidth`，不能看截图。
> 详见下面「长提示词只有 260px 高」那节。

### Windows 相关的测量陷阱

- **`rename` 覆盖已有文件会重置 CreationTime**，所以别用 CreationTime 判断 `history.json` 的年龄。
- **PowerShell 受限语言模式**会拒绝 `ConvertFrom-Json`（报“仅允许基本类型”），但它仍然会返回正确的数据 —— 警告不是失败。

---

## 排错

### 接口返回 404 / 405 / 非 JSON

**`GET` 404 加 `POST` 405，同时出现在 `/openrouter-imagen-v2/api/*` 上 —— 这是「插件没挂载」。**

不是请求写错了，而是 DSH 的前端静态兜底在应答：它接住所有没被路由匹配的请求，未知路径回 404、
非 GET 回 405。**你自己的接口不该由兜底来回答**，所以这两个状态码等价于「这一行没加载」。

先看 `plugin_manager` 的 `list_plugins`，取 `include:openrouter-imagen-v2` 那一行：

| `fiberPhase` | 含义 | 怎么办 |
| --- | --- | --- |
| `active` | 加载成功 | —— |
| `failed` | **加载时抛错了**，路由没注册 | 看下面的启动诊断 |
| `null` | 未启用 | 检查 patch 行 |

`failed` 时真正的错误只在**启动诊断**里，界面上看不到。它会打印到启动它的那个进程的 stderr：

```powershell
# 手动跑一次启动，就能拿到 Failed plugins 那一段
$exe = "C:\Users\WR\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$hostJs = "C:\Users\WR\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js"
$env:ELECTRON_RUN_AS_NODE = "1"
& $exe --expose-internals $hostJs `
  "C:\Users\WR\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh" `
  "C:\Users\WR\.dsh\profiles\desktop" `
  "C:\Users\WR\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime" `
  "C:\Users\WR\AppData\Local\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs" `
  "C:\Users\WR\AppData\Local\Programs\DeepSeek Harness\resources\runtime\bin" 2>&1 |
  Select-String "Failed plugins" -Context 0,20
```

**另外要记住：插件行只在 DSH 启动时加载。** 装完不重启，路由就不存在。

### 密钥保存时报错

- **「这看起来不是 OpenRouter 密钥」** —— 保存时就挡下（不以 `sk-or-v1-` 开头，或短得明显不完整）。
  这是**纯本地检查**、不发网络请求，用来避免把一次写提示词的调用浪费在注定 401 的密钥上。
- **「未配置 API Key」** —— 密钥是空的。点右上角 **设置** 填进去。

---

## 踩过的坑

### `ctx.tools` 必须配 `inject`

这个插件第一版就是这么挂的，值得写下来 —— 因为失败**完全静默**：

```js
// lib/index.js 顶部，缺了这一行：
export const inject = ['tools']
```

Cordis 对**属性形式**的服务访问（`ctx.tools`）有门禁：没在 `inject` 里声明，读取就抛
`cannot get property "tools" without inject`。抛在 `apply()` 里 → fiber 变 `failed` →
**路由根本没注册** → 所有请求落到 SPA 兜底 → `GET` 404 / 其它 405。

三个坑叠在一起才让它难查：

1. 抛错发生在 `apply` 内部，界面上只看到 404/405，看不出是插件没加载；
2. **`ctx.get('tools')` 不会抛**（返回 `undefined`），所以只有属性写法才会中招 —— 两种写法混用时很容易漏；
3. 用「桩 Context」写的测试**抓不到它**：桩大方地把 `tools` 递出来，门禁根本不存在。

所以现在 `smoke.mjs` 的桩**复现了这道门禁**（读未声明的服务属性会抛），
`preflight-load.mjs` 也断言 `inject` 恰好是 `['tools']` —— 而它之前断言的**恰恰相反**
（要求 `inject` 为空），正是那条断言把这个 bug 锁了进去。

**其余服务一律用 `ctx.get(...)` 读**：`webServer` / `connection` / `settings` / `attachments`
缺失时只是少一个功能，而不是整个插件挂掉。`tools` 不一样 —— 它就是插件本身，等它是对的。

### 模型看起来「只能用设置里那个」

同一个教训的第二次：客户端出图时**只发了提示词**。

```js
// lib/client.js —— 缺了 model：
body: JSON.stringify({ prompt: promptText, request: draft, model: pickModel() })
```

Host 那边 `buildBody` 的优先级是 `pick(source.model, settings.model) || palette[0]`，
`source.model` 是空的就永远落到设置里那个默认值。所以「别处选模型」不是没生效，而是**根本没有别处** ——
`models` 清单当时只是下拉框的候选，不参与决定本次用哪个。

关键在于**测试也没抓到**：`smoke.mjs` 有一条「per-call override 到达请求体」，
断言的是 `aspect_ratio` / `count` / `quality` —— 唯独漏了 `model`。现在这条补上了，
`preview.mjs` 也断言请求里必须带 `model: pickModel()`（把这一项删掉，测试立刻红）。

教训：一条覆盖了「大部分字段」的测试，看起来很像覆盖了全部。

### `saveDir` 设了，图片却进了附件库

同一个教训的第三次，而且这次是**逻辑对、接线错**：

```js
// lib/index.js —— 路由调用时没有 cwd：
const result = await generate(input, { withDataUrl: true })
```

`generate` 内部是 `projectDirectory(options?.cwd)`，cwd 是 `undefined` 就返回 `null`，
于是落到 `attachments.saveFile(...)` —— 图确实存下来了，只是存在
`C:\Users\…\.dsh\attachments\v1\files\…`，而不是你设的目录。

根因是**两条调用路径不对称**：

| 调用方 | 有 cwd 吗 |
| --- | --- |
| 工具 `openrouter_generate_imagen_v2` | ✅ `exec.agent.session.header.cwd` |
| 工作台的 `/generate` 路由 | ❌ 一条 HTTP 请求不带会话身份 |

测试为什么没抓到：`smoke.mjs` 里**只有工具那条路**被测过，而且带着 `cwd: dir`：

```js
const callTool = async (args) => tool.execute(args, { agent: { session: { header: { cwd: dir } } } })
```

路由那条路**从来没有被跑过一次**。一条测了 A 路径的测试，不能说明 B 路径也对。

现在：客户端把会话工作目录一并发出（`ctx.get('sessions')` 的会话列表里带 `cwd`），
Host 只接受绝对路径（相对路径会被解析到 DSH 进程自己的目录，不是用户的工程）。
断言也补在了**接线**上，而不只是补在纯函数上。

### 校验跑在付费调用之后

`save_dir` / `file_name` 的越界与格式检查原来在 `generate` 里，位于 `await callApi(...)` **之后** ——
一次注定失败的调用会先把钱花掉（本次 $0.0097）再抛错。
现在拆出一个纯函数 `resolveSaveDir`，`execute` 在发请求之前先跑一遍。

对应的 smoke 断言就是那句「**没有 key、没有网络的环境下，拿到的是拒绝信息而不是 API 错误**」。

### 相对路径被粘在绝对路径后面

`render` 里 `文件：` 那行自带换行，`相对会话目录：` 那行不带，于是结果长这样：

```
文件：X:\...\hero.png相对会话目录：generated-images/hero.png
```

多图时只有最后一张会这样，因为前面的都被下一行 `文件：` 救回来了。
要紧的地方在于这条恰恰是整个功能的目的 —— **唯一该被读出来的那串，反而黏在了一长串 Windows 绝对路径后面。**

smoke 当时只断言源文件里出现过「相对会话目录：」这五个字，字是在的，只是贴错了对象 ——
绿色的测试放过了它。现在改成真跑一次 `render`，按行读。

### 多图命名主干各不相同

兜底名的 `stamp()` 写在循环体里，于是 `openrouter-a.png`、`openrouter-b-2.png`、`openrouter-C-3.png` ——
既不是用户要的名字，也不是一个列表。已提到循环外。

### `/prompt` 把参考图整个丢了

而且是丢两次：提示词模型不知道有参考图，出图时也没把参考图发给图像模型
（`让 AI 写提示词` + 「先确认」关着时，**出图和写提示词是同一次调用**，漏传就等于用户挂的图完全没生效）。

现在参考图、**本次选中的模型**和**会话 cwd** 三样都随这次调用走，
提示词模型和图像模型拿到的是**同一份、按同一顺序**的参考图。

### 侧栏文字重复成「图像生成 图像生成」

`sidebar.panellist` 这个插槽**自己会把注册时填的 `label` 画出来**，所以入口组件只要给图标就行：

```js
// 注册时 —— 文字在这里，只写一次
yield ctx.slots.register({ name: 'sidebar.panellist', id: '…', label: '图像生成' }, …)

// 入口组件里 —— 只给图标；再写一遍文字就会显示两遍
h('span', { className: 'dsh-iv-entryicon' }, h('svg', …))
```

断言必须打在**渲染结果**上，不能 grep 源码：那个（现在已经没用的）`.dsh-iv-entrytxt`
CSS 类还留在样式表里，按源码搜索会匹配到这条死规则、照样全绿。

### `+` 按钮点了没反应

它原本**根本没有 `onClick`** —— 一个纯占位符。现在三条路都通向同一个 `addRefFiles`：
点 `+` 开文件选择器、在写作区粘贴、把图片拖进来。

参考图**存在内存里、以 data URL 随请求发出**，没有先上传到哪儿的步骤：OpenRouter 直接吃
图片 URL，所以既没有要上传的地方，也没有留在服务端要清理的暂存文件。

上限 4 张是 OpenRouter 对 `input_references` 的限制 —— 第 5 张会在**提示词都写完之后**才被
API 拒绝，所以在这里就挡掉并给一句话。粘贴时**只认真正的图片文件**，否则粘一段文字也会被
当成参考图。

### 种子出图后是空的

原来那个种子输入框只在 `onBlur` 时保存，于是「填了种子直接点生成」发出去的其实是**旧值**；
而随机抽的那个种子只在状态栏一闪而过，没有任何地方留下它 —— 那个数字是唯一能要回同一张图的
东西，丢了就复现不了。

现在输入框**移到了对话框一侧**（模型下方、生成按钮上方），出图后会把**实际使用的种子**
写回框里并持久化，所以「再点一次生成」就是复现。参数区里那个种子框已经删掉 ——
同一个设置不留两个能改的入口。

**同一个坑还有第二只脚。** 写回种子的代码原本只长在 `直接出图` 那条路上；
`让 AI 写提示词` 在「先确认」关着时（**这是默认组合**）是在 `/prompt` **同一次调用里出图**的，
而那条分支从没读过 `res.seed` —— 也就是说默认模式下种子框**永远是空的**，
尽管 Host 每次都算出了种子、也回给了前端。两条路现在都写回。

### 长提示词只有 260px 高

对话里那张提示词卡片是唯一长度不受限的气泡，所以它自己滚动。原先上限写死 `260px`，
实测一条 2247px 的提示词只能看见 **276px**（约八分之一），于是读起来像「AI 只写了个开头」。

改成 `min(46vh,420px)`：900px 高的窗口能看见 **430px**，窗口矮的时候按比例缩回去，
不会反过来把整栏挤没。滚动条**由插件自己画**（`scrollbar-width:thin` + `scrollbar-color`）
而不是继承系统的 —— 「继承」意味着由操作系统决定：一旦打开覆盖式／自动隐藏滚动条，
一个没有自己滚动条的框就**什么都不显示**。

> 写这段时踩了两个测量上的坑：
> 1. `scrollbar-width:auto` 的对照样式**没有**中和掉 `::-webkit-scrollbar` ——
>    按规范，`scrollbar-width` 不为 `auto` 时浏览器会**忽略**那些伪元素，
>    所以把它改回 `auto` 等于把新规则又请回来，对照组量到的其实是新样式。
> 2. 无头 Chrome 会强制覆盖式滚动条（gutter 量出来是 0），**必须用有头模式测**；
>    而且没有焦点的有头窗口**只排版不绘制**滚动条，截图里是空的 ——
>    所以「有没有滚动条」要看 `offsetWidth - clientWidth`，不能看截图。

### `.dsh-iv-seedin` 写了 `width` 却不生效

种子框本来是整行宽，把「随机」挤到了下一行。加一条 `.dsh-iv-seedin{width:86px}` 之后
**看起来毫无变化** —— 因为共享规则写的是

```css
input.dsh-iv-in,select.dsh-iv-in,textarea.dsh-iv-in{width:100%;…}
```

元素 + 类（0,1,1）**压过**单独的类（0,1,0），跟先后顺序无关。改成 `input.dsh-iv-seedin`
（0,1,1，同分则后者胜）才生效。

更值得记的是**测试当时是绿的**：它只断言「`width:86px` 这条声明存在」，
而声明存在和声明生效是两件事。现在多了一条断言，把两条规则的选择器各自算权重再比大小
（**按逗号分组取最大**，否则 `input.dsh-iv-in,select.dsh-iv-in,…` 会被当成一个超长选择器，
把本来正确的规则判成输）。

---

## 内部参考

### 兼容版本声明在哪里

一共**四个地方**，作用各不相同。查证来源是宿主里那几份包的 README：
`@deepseek-ai/dsh-package-manifest`、`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-plugin-manager`。

| 位置 | 字段 | 谁用 | 会不会拦 |
| --- | --- | --- | --- |
| `package.json` → `engines.dsh` | SemVer range | 人、市场列表 | **不会** |
| `package.json` → `dsh.manifestVersion` | 固定 `1` | 读 `dsh` 块的读者 | **不会** |
| `package.json` → `peerDependencies` 的 `@deepseek-ai/dsh` | SemVer range | **DSH 启动与安装时** | **会** |
| profile 的 `compatibility.json` | `包名@版本` → DSH 版本列表 | 用户豁免 | 只放宽，不收紧 |

三段原文，值得记住：

> `engines.dsh` — Author-declared compatible DSH versions as a SemVer range, including exact prerelease
> versions. This field sits beside `engines.node` and `engines.npm`; an engines object may omit `dsh`.
> —— `dsh-package-manifest`

> Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and
> `@deepseek-ai/dsh-*` against the single runtime version returned by `getDshRuntimeVersion()`. Every
> declared range must match; prereleases participate in range matching. **Missing DSH peers impose no
> constraint; invalid ranges are incompatible. These checks use peer declarations, not `engines.dsh`.**
> —— `dsh-app-boot`

> **Compatibility is declarative.** Current installers and loaders do not enforce `dsh.manifestVersion`
> or `engines.dsh`; declaring a range does not reject incompatible hosts or validate SemVer syntax.
> —— `dsh-package-manifest`（Known Limitations）

所以本包现在的写法是：`engines.dsh: ^0.2.0-rc.2`（声明）+ `peerDependencies` 里
`@deepseek-ai/dsh: ^0.2.0-rc.2`（**真正会被拦的那个**），并标记 `optional: true` 以免 pnpm 去解析它。

注意 `peerDependencies` 是**按名字前缀匹配**的：`@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 都会被检查。
也就是说现有的 `dsh-skill` / `dsh-tools` 两条 peer **早就在被检查了**，它们能通过，
是因为范围 `>=0.2.0-rc.1 <0.3.0` 覆盖了运行时的 `0.2.0-rc.2`。

**被拒时的样子**：不是崩溃，是「这一行没加载」—— 插件行直接 `disabled: true`，
所有路由落到 SPA 兜底，于是看起来像 404/405。诊断见上面的「接口返回 404 / 405」。

豁免走 CLI：`dsh plugin --profile <profile> allow-version <package@version> --dsh-version <runtime> --accept-risk`，
写进 profile 的 `compatibility.json`。**升级不继承豁免**，插件升了或 DSH 升了都要重新批。

### 同源 API（工作台自己用，不是对外接口）

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

### settings.yaml 字段

写在 `~/.dsh/settings.yaml` 的 `openrouter-imagen-v2` 命名空间。多数项在工作台里直接改，改完即存。

| 字段 | 在哪改 | 说明 |
| --- | --- | --- |
| `apiKey` | **设置弹窗 → 密钥** | OpenRouter 密钥，`role('secret')`，服务端从不回传（只给头尾预览） |
| `model` | 设置弹窗 → 模型（某行「设为默认」） | 默认图像模型 id |
| `models` | 设置弹窗 → 模型 | 图像模型清单，最多 16 个；它同时是候选池和默认值的选择处 |
| `promptModel` | **设置弹窗 → 高级** | 「让 AI 写提示词」用的**文本**模型（默认 `google/gemini-2.5-flash`）；指向图像模型会失败 |
| `resolution` / `aspectRatio` / `quality` / `outputFormat` / `count` / `background` / `seed` | 工作台「参数」 | 逐次调整的生成参数 |
| `confirmPrompt` | 工作台「参数」 | 写提示词后是否先确认，**默认 false** |
| `splitRatio` | 拖动分隔条 | 左栏宽度占比，默认 0.6 |
| `paramsHeight` | 拖动参数区分隔条 | 参数区高度 px，默认 236 |
| `saveDir` | 设置弹窗 → 高级 | 生成文件的存放目录，默认 `generated-images` |
| `providerSort` / `extraJson` | 设置弹窗 → 高级 | Provider 排序 / 附加请求体字段 |
| `skills` | settings.yaml | 是否安装随包 skill，默认开 |

**模型的优先级**：输入框下方选择器里选的那个（只这次）→ `model` 设置 → `models` 清单第一条。
Host 端和界面用的是同一套顺序，所以顶栏显示的和真正发出去的永远是同一个。
这个顺序就是 `buildBody` 里的 `pick(source.model, settings.model) || palette[0]`。

**`saveDir` 相对谁**：相对**当前会话的工作目录**，和 `read` / `write` / `edit` 这些工具是同一个根。
填绝对路径就照用；留空则只存进 DSH 附件库，不落盘。

### 生成记录的实现细节

- 存**元数据，不存像素**（提示词、实际发出的参数、种子、路径、附件 id、**真实交付的宽高**）。
  记录里复制一份字节会让每张图的磁盘占用翻倍。
- 写在 `~/.dsh/openrouter-imagen-v2/history.json`，**重启后仍在**。写入是「临时文件 + rename」，
  写坏也不会留下半截文件。
- **最多 60 条**，最新的在前；读坏或读不到都当作空历史 —— 一份索引不值得让整个插件起不来。
- 写入失败**只记 warning、不让这次生成失败**：丢历史可以，丢图片不行。

### 尺寸是怎么读出来的

`lib/image-size.js` 是纯函数、不依赖任何东西、永不抛异常：

- **PNG** 校验 8 字节签名，要求 `12..15` 是 `'IHDR'`，宽高取 `readUInt32BE(16)` / `(20)`；
- **JPEG** 从 SOI 顺着 marker 链走，跳过无载荷段（`0x01` 和 `0xd0..0xd9`），遇到 `0xda`（SOS）返回 `null`；
  帧段是 `0xc0..0xcf` 去掉 `0xc4`/`0xc8`/`0xcc`。**宽在 `pos+5`，高在 `pos+3`** ——
  `pos` 指向 2 字节长度字段，所以宽高是反的，写反了不会有任何报错，只会一直返回错值；
- **GIF** 校验 `'GIF87a'`/`'GIF89a'`，宽高取 `readUInt16LE(6)` / `(8)`；
- **WebP 明确返回 `null`**：它有三种容器变体和 14 位打包字段，猜一个数字比不给更糟。

### 安全实现的理由

- **密钥不外泄**：`apiKey` 是 `role('secret')`，任何设置读取接口都不返回它 —— `/config` 只给
  前缀加末四位的**预览**，用来认出是哪一把，不足以使用。
- **候选密钥不落盘**：`/test` 与 `/models` 的 `key` 参数只用于那一次请求。
- **本机参考图限制在会话工作目录内**：`reference_files` 由模型给出，而这些字节会发往第三方；
  `dsh-fs-local` 能解析任意绝对路径、文件沙箱只管写不管读，所以越界路径会被直接拒绝。
- **本机落盘目录同样受限**：`save_dir` 由模型给出，越出会话工作目录会**报错**而不是换个地方存。
- **工具参数是封闭的**：未声明的键会被拒绝，而不是展开进请求体。
- **`extraJson` 不能越权**：不能覆盖 `model` / `prompt` / `input_references`。
- **取消会被观测**：`exec.signal` 与 10 分钟上限合并传给请求，取消一轮对话会真的放弃这次付费请求。

### `save_dir` 越界为什么报错而不是改写

「静默换个地方存」正是 `saveDir` 那个老 bug 的形态：图生成了、存了、只是不在任何一方要求的位置。
所以相对路径按会话目录解析，绝对路径必须落在会话目录内，否则直接失败。
`file_name` 同理 —— 带路径分隔符或 `..` 的名字被拒绝，而不是拍平成 `public_hero` 塞进错误的目录。

**写进页面的路径是返回值，不是你请求的名字。** 同名文件已存在时 `writeUnique` 会让开成 `hero-2.png`，
返回的 `filePathRelative` 才是真正写出的那个 —— 所以拼 `<img src>` 时要用返回值。

### 手动工作台的出图没有被这些约束影响

数量、格式、质量在工作台里照旧可选、可存 jpeg/webp、可一次出多张。上面这些只约束**工具调用**这一条腿。
实现上它们是以**每次调用的值**传进去的，靠 `buildBody` 的「调用方优先于设置」这条既有优先级生效，
所以不需要、也没有改动面板的行为。

### 侧栏项与主视图必须共用一个 key

侧栏 `sidebar.panellist` 的 `id` 必须等于主视图的 `key`，否则 `layout.selectPanel(id)` 抛
`main panel "…" is not registered`，点图标会报错、整行点不动。

侧栏那一行**由 shell 全权画**：`PanelRow` 是**一个** `<button>`，里面先渲染 `sidebar.panellist` 槽（图标），
再渲染注册时给的 `label`，点整行（含文字）都走 `selectPanel(id)`。所以这个槽**只出 16px 的图标**，
不再自己画按钮、不带 `aria-label`/`title`、不写文字 —— 自己再画一遍会导致**行里套按钮**，
HTML 解析器会把 shell 的行按钮提前闭合、把图标和文字甩到行外，文字既点不到也会重复。

---

## 已知的实现瑕疵

### ⚠️ `npm run smoke` 会清空真实的生成历史

**这是当前最严重的一条，尚未修。**

`smoke.mjs` 里：

```js
const store = provided.openrouterImagenV2.store
await store.add({ id: 'gen-test-image', … })
…
await store.clear()
```

根因在 `lib/index.js` 里数据目录写死：

```js
join(homedir(), '.dsh', 'openrouter-imagen-v2')
```

`stubConfig` 没有任何覆盖入口，所以 smoke 造的每一个插件实例都指向**生产环境那个文件**，
`store.clear()` 跟着就 `persist()`，把用户真实的记录全删了。`npm run all` 里包含 smoke。

已实测确认：只有 `smoke` 会写这个文件，`preview` 和 `load` 不会。
（也正因为如此，一次审计里「history.json 只有 1 条记录」曾被误判成持久化失败 —— 机制找错了。）

**两种修法**：

- **小的（推荐）**：让数据目录可注入，`stubConfig` 传临时目录，从根上切断，顺带让测试不再碰用户数据；
- **保守的**：只把 smoke 里那两行换成临时 store，改动小，但其他测试实例仍共享生产文件。

### `fileStem` 的正则多了一个 `[`

```js
/[[<>:"|?*\u0000-\u001f]/gu
```

两个连续的 `[`。字符类里第一个 `[` 是字面量，所以**行为上没错**，只是意图被写歪了。

### `outputDirRelative` 算了但没打印

`resolveSaveDir` 返回它、`generate` 也返回它，但 `render` 没用它 —— 回执里只有 `文件：`（绝对路径）
和 `相对会话目录：`（相对路径）。曾经有一版想打印目录本身，最后没留。

### 审计里被明确否决的两项

- **对分辨率档位加更多解说**（例如解释为什么 2K 落地 1536）—— 否决。尺寸行已经给出事实。
- **持久化失败时给用户一句提示** —— 否决。目前只记 warning。

---

## 依赖与打包备忘

- **git 安装通道**：`dsh plugin --profile desktop add git+https://github.com/fancyui/dsh-openrouter-imagen-v2.git`
  也是官方支持的安装方式（`parseInstallSpec` 识别 `git+`/`github:`/裸 https 仓库 URL 三种写法）。
  查证过的三个事实：
  - **CLI 只解析自己的子命令，其余参数原样透传给 pnpm**（`runProfilePnpm` 里 `execa("pnpm", [...args])`，
    只有本地路径会被锚定改写）。所以 `--config.minimum-release-age=0` 这类 pnpm 旗标可以直接写在
    `dsh plugin add` 后面。
  - **`minimum-release-age` 与宿主无关**：整个 DSH 源码树里没有这个配置名，宿主不设发布延迟策略；
    它是 pnpm 自己的供应链设置，只作用于 registry 版本解析（git ref 不受影响）。
    本包依赖（undici 8.10.0、@deepseek-ai/* 4.0.4/0.2.0-rc.1 等）发布均已超过一年，默认配置下不会被拦。
    只有用户自己的 pnpm 全局配置设了 `minimumReleaseAge` 才需要加这个旗标。
  - **带 prepare/build 脚本的 git 包会被 pnpm 11 拦**，CLI 报错时会提示把 key 加进 profile 的
    `pnpm-workspace.yaml` 的 `allowBuilds`。本包没有任何生命周期脚本，不涉及。
- **git 安装用的是仓库内容，不是工作区**：`package.json` 的 `files` 白名单（`lib`/`skills`/
  `cordis.patch.yml`/两份 README/LICENSE）决定打进包里的东西，所以**先提交推送再装**；
  `lib/image-size.js` 这类新文件没提交的话，git 装出来的包里就没有。
- `repository` 字段曾指向不带 `-v2` 的 v1 仓库地址（复制自 v1），已改为
  `git+https://github.com/fancyui/dsh-openrouter-imagen-v2.git`（仓库已确认存在）。
- `undici` 走普通解析，**必须能在包内找到**（`@deepseek-ai/*` 由宿主拦截）。
  v1 踩过：app 升级后 junction 链断掉，插件整个挂不上。
- 手动挂载必须用 **junction 而不是符号链接**：ESM 按真实路径解析依赖，符号链接会让包内的
  `import '@deepseek-ai/...'` 找不到。
- **不要同时用两条安装通道**：同一个 `(kind, path)` 的路由会被注册两次，整个插件树在启动时失败。
- `package.json` 的 `files` 含 `README.md` 与 `README.en.md`，**不含本文件** —— 开发笔记不进安装包。