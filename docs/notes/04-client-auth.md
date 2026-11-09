# 04 · 前端设置页 / 扫码登录 / 临时清理 深读笔记

> 对象：仓库根 `client.js`（1067 行，浏览器半端）、`lib/auth.mjs`（147）、`lib/cleanup.mjs`（80）、`vendor/qrcode.js`（2297，第三方）；旁证 `index.js` 调用点、`lib/config.mjs` 与 DSH 0.2.2-rc.1 的 client 模块契约。只读分析，未执行插件、未联网。
> 一句话结论：设置页不是 DSH 配置 schema 页，而是一个**自注册浏览器模块**——`window.__ModuleLoader__.load` 注册 lazy factory → factory 返回 Cordis 插件 `{inject:['slots'], apply}` → `apply` 里往 `settings.section` slot 插一个 `id=bili-live` 的 React 组件；所有数据走插件自己的 `/api/bili-live/*`，与 DSH 设置文档/`ctx.configForms` 完全无关。

---

## 0. 文件与三层身份

| 含义 | 值 | 位置 |
| --- | --- | --- |
| npm 包名 / 浏览器模块身份 | `dsh-bili-live` | `package.json` L2（加载器按包名核对注册 id） |
| ModuleLoader 注册 id | `dsh-bili-live` | `client.js` L15（必须 == 包名，否则报 loaded without registering） |
| 设置页 slot 注册 id | `bili-live` | `client.js` L1058（只决定设置导航的 section key） |
| 宿主 cordis 插件 name | `bili-live` | `index.js` L49 |
| bundle patch 条目 | `id: bili-live` / `name: dsh-bili-live` | `cordis.patch.yml` L7–9 |
| 页面标题 / 导航 label | `直播助手（DD版）` | `client.js` L547 / L1058 |
| 包声明 | `exports["./client"]`、`dsh.client{platform:'web',inject:['react']}`、`dsh.bundle.patch` | `package.json` L16–43 |

---

## 1. DSH 前端注入契约

### 1.1 包声明 → 浏览器 bundle

- 宿主扫描已启用的 Loader 条目，把 `dsh.client` 声明变成 `/plugins` 下的 bundle；页面 boot 先注入 `window.__ModuleLoader__` 队列 facade，外壳 `create()` 出模块系统后再接管注册。
- 执行 bundle 脚本**只注册 factory**，模块体副作用（含 CSS 注入）在 factory 闭包内、首次物化时才跑；重复执行同一 id 会抛 `duplicate factory registration`。
- `dsh.client.inject: ["react"]`（`package.json` L38–43）是「信息性包依赖边」，**不是** Cordis 服务注入（见 `DshClientManifest` 类型注释）；`react` 本来就在冻结的平台模块表里，所以 `client.js` L17 `require('react')` 直接可用。以后若 `require` 其它模块，必须写进 `dsh.client.external`，否则解析抛错。
- `id` 与包名不一致、或脚本执行两次，都会让这一 row 加载失败；失败只影响本插件，不影响其他插件。

### 1.2 `load` 形状与返回的插件对象

- L14–16：`window.__ModuleLoader__.load({ id: 'dsh-bili-live', factory: (require) => { ... } })`。可选 `chunk` 字段用于包内异步 chunk，本插件没用。
- factory 返回的导出对象就是 Cordis 插件：L1033–1065 `return { inject: ['slots'], apply(ctx) {...} }`。**这里的 `inject` 是 Cordis 服务注入**，与 `package.json` 里的 `dsh.client.inject` 是两个层面。
- L1034–1037 注释记录了一个坑：`inject` 写成空数组时 fiber 不等 `slots` 服务、注入 `settings.section` 会静默失效，必须声明 `['slots']`，且注入时机要排在声明该槽位的插件之后。
- `apply` 不用 `ctx.effect`（第三方 ctx 上不一定有，抛错会中断整段 apply），改用 try/catch + 双路径取服务：L1050–1055 `ctx.get('slots') || ctx.slots`，取不到或接口不全就 `return`（L1055）。
- 样式：L1039–1048 用 `document.createElement('style')` + `data-plugin-css="dsh-bili-live"` 只注入一次；失败仅 `console.warn`。
- 注册：L1056–1060 `slots.inject('settings.section', () => slots.register({ name:'settings.section', id:'bili-live', order:31, label:'直播助手（DD版）' }, () => h(Boundary, null, h(Panel))))`；失败同样只 warn（L1061–1063）——契约一变，表现是「设置里没有这一页」，只能看控制台。

### 1.3 挂进设置面板的方式

- `settings.section` 是 `@deepseek-ai/dsh-client-ui-settings` 声明的 list slot，真正的外壳（对话框/左导航/内容列）由 `ui-settings-general` 占 `sidebar.settings` 渲染；第三方只能「贡献一页」，不能加路由或菜单项。
- 注册 options：`id`（section key）、`order`（导航位置，31 排在官方 general=0 / models=10 / plugins=15 之后）、`label`（导航显示文字，本插件传字符串；当前 DSH 也支持函数/locale 做本地化）。组件会收到 `{ close }` prop，本插件 `Panel` 未使用。
- 可选图标：`settings.section.icon` list slot，注册 id 必须与 section 的 id 相同、组件收 `{size, active}`；本插件没注册 → 显示外壳默认字形。
- **没有** DSH 设置 schema / `ctx.configForms`，也没有 URL 路由；「设置页」= 设置对话框左侧一个 section，点开渲染 `Panel`。

### 1.4 页面分区（11 块 → 行号 / 字段 / 保存方式）

| # | 区块 | client.js 行号 | 内容与对应 config 字段 | 保存方式 |
| --- | --- | --- | --- | --- |
| 1 | 状态 hero | L545–585 | 标题/pill/版本(L547–550)；4 格统计：当前主播+房间、今天已回复、已收弹幕、关注数(L551–557)；当前标题+弹幕连接态(L558–559)；lastError(L560)；按钮「立即检查/看日志/去直播间」(L561–567)；手动切台行(L568–581)；msg 条(L582)；日志 pre(L585) | 读 `/status`，5s 轮询 |
| 2 | B站账号 | L587–617 | 登录态 + `插件自己的登录` 徽章 + UID(L590–597)；退出按钮(L598–602)；扫码按钮(L603–609)；QR 图与提示(L610–617) | `/login/*`、`/logout` |
| 3 | 自我介绍 | L619–647 | `username`(L623–626)、首句预览 `{name}` 替换(L627–632)、`aliases`(L633–640)、`introTemplate`(L641–647) | 本地 form，走保存栏 |
| 4 | 什么时候开口 | L649–709 | `autoReply`(L652–657 即时)、自由回复固定开说明(L658)、`fixedReply`(L659–664 即时)、`replyTemplate`(L665–671)、`cooldownMs` 秒(L672–678)、`dailyLimit`(L679–684)、`pollMs` 秒(L685–691)、试发输入(L692–703)、模型测试/试发按钮(L704–706)、`llm.available` 提示(L707–709) | 开关即时，输入走保存栏 |
| 5 | 听直播的声音 | L711–769 | `listenAudio`(L715–722 即时)、最近转写预览(L723–725)、`asrLang` select(L726–738 即时)、`audioKeywords`(L739–749)、`audioReply`(L750–755 即时)、`audioInRecap`(L756–761 即时)、`audioReplyCooldownMs` 秒(L762–768) | 混合 |
| 6 | 看直播的画面 | L771–802 | `visionEnabled`(L775–782 即时)、`visionIntervalMs` 分钟(L783–789)、`visionMaxShots`(L790–795)、`visionInRecap`(L796–801 即时) | 混合 |
| 7 | 守谁·按需添加 | L804–886 | 名单行 ↔ `streams`(L808–846)：序号、mid 输入、直播态、↑↓✕；添加行 L847–848（上限 30，L422）；`priorityEnabled`(L850–857 即时)、`randomWhenNoneLive`(L858–865 即时)、`randomKeywords`(L866–877)、`randomWatchMs` 分钟(L878–885) | 开关即时；名单/输入走保存栏 |
| 8 | 主播评分 | L888–960 | `ratingEnabled`(L891–896 即时)、`moderationEnabled`(L897–904 即时)、`moderationThreshold`(L905–911)、`ratingPushScore`(L912–918)、`ratingPushUid`(L919–924)、21026 说明(L925–926)、采样预览(L927–930)、十维权重编辑(L931–948)+合计(L947–948)、实际权重条 `weightTable`(L949)、上次推送/推送记录/清空(L950–959) | 开关即时；数字/权重走保存栏 |
| 9 | 直播笔记 | L962–979 | 说明(L965)、正在记录(L966–969)、文件列表(L970–974，名字去 `.txt` + KB)、打开文件夹(L975–976)、刷新(L977)、`recapDir`(L978–979) | `/open-folder`、`/status` |
| 10 | 页脚信息 | L981–987 | 家目录 `st.home`、凭证来源、模型路由 | 只读 |
| 11 | 保存栏 | L989–1007 | 「保存全部设置」按钮(L996–1000)、名单计数/消息(L1001–1005)、说明(L1006–1007) | `saveAll` |

### 1.5 前端调用的 API（全部同源 `/api/bili-live`，见 L20）

| 方法/路径 | client 调用行 | index.js 处理行 | 用途 |
| --- | --- | --- | --- |
| GET `/status` | L213（5s 轮询） | L1133–1198 | 全量状态 + config + logs + recaps |
| POST `/config` | L308（即时保存）、L381（saveAll） | L1201–1235 | patch 合并配置 |
| POST `/resolve` | L260、L403、L404 | L1245–1260 | 主播 UID/房间号 → stream+info |
| POST `/tick` | L564 | L1263–1266 | 立即检查一次 |
| POST `/switch` | L519（random）、L532（key） | L1274–1309 | 手动切台 |
| POST `/login/qr` | L451 | L1316–1327 | 生成二维码 `{ok,key,svg}` |
| POST `/login/poll` | L279（2s） | L1328–1354 | 扫码状态/落盘凭证 |
| POST `/logout` | L462 | L1356–1364 | 删凭证 |
| POST `/pushed/clear` | L479 | L1238–1243 | 清高分推送记录 |
| POST `/llm-test` | L491 | L1368–1384 | 模型自测 |
| POST `/send-test` | L506 | L1387–1397 | 试发一条真弹幕 |
| POST `/open-folder` | L472 | L1403–1416 | 宿主打开笔记目录 |
| POST `/stop`、GET `/records` | 前端未用 | L1268–1272、L1399–1401 | 手动离场 / 40 条笔记清单 |

- 约定：L21–32 `jget`/`jpost`，`credentials:'same-origin'`；HTTP 非 2xx 抛错并区分 401/403（L23）；**业务错误普遍是 200 + `{ok:false,error}`**，所以调用方必须自己看 `r.ok`（如 L506–512）。
- 服务端路由注册：`index.js` L1421–1431，`ctx.webServer.register({kind:'prefix', path:'/api/bili-live'})`。

### 1.6 状态管理（本地 React hooks，无 store）

| 状态 | 行号 | 说明 |
| --- | --- | --- |
| `st` / `form` / `msg` / `busy` | L192–195 | 服务端快照 / 本地编辑缓冲 / 提示条 / 按钮忙标记 |
| `rows` / `rowInfo` | L196–197 | 名单输入行 / 每行解析结果 |
| `logOpen` / `switchKey` | L198–199 | 日志展开 / 手动切台输入 |
| `qr` / `qrMsg` / `qrBusy` | L200–202 | 二维码 `{key,svg}` 与提示 |
| `files` / `testText` | L203–207 | 笔记列表 / 试发文本（localStorage `bl-test-text`，L206、L701） |
| `testRef` / `initedRef` / `liveRef` | L209、L237、L247 | 非受控输入值 / 名字只初始化一次 / 行状态最新引用 |
| 轮询 | L220–224（status 5s）、L244–270（行直播态 30s，首查 3s）、L272–301（QR 2s） | `useEffect` + `setInterval`，卸载清理 |

- `refresh`（L211–218）只在 `form` 为空时灌入服务端 config（L216），之后 `form` 是唯一编辑源。
- 名单与 `config.streams` 的映射 `applyRows`（L227–236）；初始化 effect 靠 `initedRef` 只跑一次（L237–242）。
- 所有 hooks 必须在 L303 `if (!st || !form) return` **之前**（L272–273 注释：放到后面会 React #310）。
- 保存语义：开关类走 `save({字段:值})`（L305–316，单个 patch，服务端 mergeConfig 只认 DEFAULTS 里的 key）；输入类只改 `form`，由保存栏 `saveAll`（L364–395）先逐行 `resolve` 名单、去重（L378）、再连 `formPatch()` 一起 POST；`formPatch` 字段清单 L318–360。`saveForm`（L362）和 `Field`（L179–189）是已定义未使用的备用件。
- `WEIGHT_DEFAULTS`（L142–145）是 `lib/rating.mjs` `DEFAULT_WEIGHTS` 的副本，两处要同步改。

---

## 2. UI 组件/函数 → 行号索引

| 组件/函数 | 行号 | 职责 |
| --- | --- | --- |
| `Switch` | L125–131 | 受控开关按钮 |
| `ToggleRow` | L133–139 | 开关 + 标题/说明一行 |
| `Field` | L179–189 | 通用输入行（**未使用**，加设置项可直接复用它） |
| `weightTable` | L153–177 | 把 `/status.weights` 画成横向条 |
| `Panel` | L191–1009 | 整个设置页（hooks + 动作 + 全部渲染） |
| `startLogin`/`logout` | L447–458 / L460–468 | 扫码、退出 |
| `openFolder`/`clearPushed` | L470–475 / L477–486 | 打开目录、清推送记录 |
| `testLlm`/`sendTest` | L488–498 / L500–513 | 模型自测、试发弹幕 |
| `switchRandom`/`switchTo` | L516–524 / L526–537 | 随机换台、进指定房间 |
| `save` / `formPatch` / `saveAll` | L305–316 / L318–360 / L364–395 | 即时保存 / 全量 patch / 保存栏 |
| `lookup`/`resolveRow`/`addRow`/`removeRow`/`moveRow` | L399–407 / L409–418 / L421–425 / L427–430 / L432–444 | 名单行操作 |
| `Boundary` | L1012–1031 | 渲染错误边界，把 stack 显示在页面上当线索 |
| `apply` | L1038–1064 | 样式注入 + settings.section 注册 |

### 2.1 改文案 / 改名 / 加图标

- 导航 label：client.js L1058；页面标题 L547；状态 pill 文案 L541；版本号 L550（来自 `/status.version` ← index.js L114–115 读 `package.json.version`）。
- 各区块标题在 `data-bl-h`：L589、L621、L651、L713、L773、L806、L890、L964、L991；长说明文字均为硬编码中文，直接搜字符串改。
- 插件级名称/描述：`package.json` L2–5、L16–20；README 标题等。改包名必须同步 client.js L15 的 `id`（加载器按包名核对）。
- 图标两条路：① 设置导航图标 = 在 apply 里追加一条 `settings.section.icon` 注册，`id:'bili-live'`，组件收 `{size,active}`；② `package.json` 的 `icon` 文件字段（插件清单展示用，不是导航图标）。当前都没用，显示默认字形。

### 2.2 加设置项（三种模式，后端必改）

1. **即时生效开关**：仿 L659–664 复制一个 `ToggleRow`，`onChange: (v) => save({ 新字段: v }, '提示')`。
2. **保存栏输入**：在 `Panel` 里加控件改 `form`，并在 `formPatch`（L318–360）补一行；数值记得前后端都 clamp（参考 L676–690 的秒→毫秒换算）。
3. **只读展示**：先在 index.js `/status` 返回里加字段（L1137–1197），渲染处读 `st.新字段`；`st.defaults` 虽然返回了（L1149），前端没用。

必改后端：`lib/config.mjs` 的 `DEFAULTS`（L11–135）+ `normalizeConfig`（L169–230）。因为 `mergeConfig` 只合并 `DEFAULTS` 里出现的 key（L233–241），**只在 client 加字段、不补 DEFAULTS，会被静默丢弃**。

### 2.3 加卡片 / 加页 / 调布局

- 同页加卡片：在 `Panel` return 的 children 里插 `h('div', { 'data-bl-sec': '' }, ...)`（L543–1008 任意位置），`data-bl-sec`/`data-bl-h`/`data-bl-row` 样式已备好（CSS L55–62）。
- 加独立设置页：在 `apply` 里再 `slots.register` 一条 `settings.section`（复制 L1056–1060，换 id/order/label/组件）；单行偏好可考虑 `settings.general.item`，标签页可考虑 `settings.plugins.tab`（均属当前 DSH slot 契约）。
- 布局：页容器 L543，最大宽 660px 与四列统计网格写死在 CSS L35、L51；区块顺序 = return 里 children 顺序；保存栏固定最后一节 L989–1007。
- 主题：CSS 全在 L34–123，`data-bl-*` 前缀，颜色用 `--dsw-alias-*` 变量 + 兜底；品牌色 `#fb7299`（粉）/`#00aeec`（蓝）。

---

## 3. 扫码登录（lib/auth.mjs + index.js 调用）

### 3.1 auth.mjs 索引

| 项 | 行号 | 说明 |
| --- | --- | --- |
| UA / Referer / 公共头 | L19–22 | 伪装桌面 Chrome 与 B站 主站来源 |
| `GEN` / `POLL` | L24 / L25 | `passport.bilibili.com/x/passport-login/web/qrcode/{generate,poll}?source=main-fe-site-header` |
| `loadQrLib` | L35–45 | 读 `vendor/qrcode.js` 原文，`new Function('module','exports','define', src)` 当 UMD 执行，取 `mod.exports`（函数或 `.qrcode`），进程内缓存 |
| `qrSvg` | L48–54 | `make(0,'M')`（自动版本、M 容错）→ `addData(url)` → `make()` → `createSvgTag({cellSize:4, margin:2})`，返回 SVG 字符串 |
| `getJson` | L58–64 | fetch + 统一 JSON 解析 |
| `generateQr` | L67–73 | 要码，返回 `{key, url}`；失败抛 `json.message` |
| `fetchBuvid3` | L76–83 | `api.bilibili.com/x/frontend/finger/spi` → `data.b_3`；失败返回 `''`（不致命） |
| `credFromUrl` | L86–101 | 从成功回调 `data.url` 查询串取 `SESSDATA`（`decodeURIComponent`）/`bili_jct`/`DedeUserID`/`Expires` |
| `credFromCookies` | L103–117 | 解析 `Set-Cookie` 行，要求有 `SESSDATA`，带 `buvid3` |
| `pollQr` | L123–137 | 状态码：86101 waiting / 86090 scanned / 86038 expired / 0 ok（L127–130）；成功优先 `data.url`、再 set-cookie；缺 `buvid3` 补一次 |
| `whoAmI` | L140–147 | `x/web-interface/nav` + Cookie → `{uname, mid}`，失败返回 null（登录验证兼昵称来源） |

### 3.2 服务端登录链路与凭证落盘

- 生成：`/login/qr`（index.js L1316–1327）`generateQr()` → `rt.qr={key,at}` → `qrSvg(qrLibFile=L177, url)` → `{ok,key,svg}`；SVG 走 JSON 回前端，经 `dangerouslySetInnerHTML` 塞进 160×160 白底容器（client.js L612，CSS L111–113）。浏览器不加载任何二维码库。
- 轮询：`/login/poll`（index.js L1328–1354）`pollQr`；非 ok 直接回 `{ok,status,message}`（L1334–1335）；ok 则 `whoAmI` → `saveOwnCred({...cred, uname})`（L1337–1338）→ 重置 `credAlive`（L1339–1341）→ 清 `rt.qr`；`cfg.username` 为空时自动填昵称（L1344–1347）→ `tick()`。
- **凭证落盘由 index.js 决定，不在 auth.mjs**：`<home>/credential.json`（L150），`saveOwnCred`（L160–171）写 `sessdata/bili_jct/buvid3/dedeuserid/uname/saved_at`；`<home>/logged-out.json` 是退出标记（L152–158），`loadCred` 先看它再读凭证。登录成功会删掉该标记（L161）。
- 凭证活性：`checkCredAlive`（L1114–1128）在每次 `/status` 时最多每 10 分钟调一次 `whoAmI`，失效则 `loggedIn` 变 false；`whoAmI` 返回的昵称会回写凭证（L1125）。
- 退出：`/logout`（L1356–1364）删 `credential.json` + 写 `logged-out.json`，不可逆，只能重扫。

### 3.3 vendor/qrcode.js 的用途

- 第三方 **qrcode-generator 1.4.4**（Kazuhiko Arase，MIT）：全局 `var qrcode`（L18），UMD 尾巴 L2288–2296 `module.exports = factory()`；`createSvgTag` 在 L495（支持对象参数 `{cellSize,margin,alt,title}`）。
- 不在 `package.json` exports 暴露、不经浏览器加载；index.js 只把文件路径 `qrLibFile`（L177）传给 `qrSvg`，由 auth.mjs L37–40 读文件 eval。因此它只是「服务端把 URL 画成 SVG」的工具，前端展示的是字符串。

---

## 4. 临时文件清理（lib/cleanup.mjs）

- 目录布局：`<home>/tmp/live/` 音频切片（index.js L565；`audio.mjs` L241 `seg-<roomId>-<ts>-<seq>.flv`）、`<home>/tmp/shots/` 画面分片（index.js L629；`vision.mjs` L123 `shot-<roomId>-<ts>-<seq>.flv`，抽帧后同目录生成 `.jpg`）。
- `clearRoomTmp(home, roomId)`（L40–58）：tag = `-<roomId>-`，遍历 `SUBS=['live','shots']`（L16）下的**文件**，文件名含 tag 才 `rmSync`；返回 `{files, bytes}`。
- `sweepTmp(home, {maxAgeMs, now})`（L61–77）：默认 6 小时（L19 `DEFAULT_MAX_AGE`），按 mtime 删超龄残留；兜底崩溃/断电留下的孤儿文件。
- `mb()`（L80）：日志用体积格式化。
- 调用方：① `finishRecap` 收尾第 ③ 步（index.js L533–538）——写完笔记、推送后清本场；② `tick` 每轮开头（index.js L1036–1041）——兜底扫超龄。即：每 `pollMs`（默认 60s）+ 设置页「立即检查」都会触发一次 sweep。
- 细节：只删文件、不删空目录；清场与「笔记是否写成」解耦（见 §6.5）；L46 `p.slice(p.lastIndexOf('\\') + 1)` 按 Windows 分隔符取 basename，POSIX 上取到全路径，但后续用 `includes(tag)` 判断，所以功能不受影响（仅路径里恰好含 `-房间号-` 时才会误删）。

---

## 5. 定制入口速查

| 想改什么 | 改哪里（行号） | 注意 |
| --- | --- | --- |
| 改名/描述 | `package.json` L2–5、L16–20；`client.js` L15/L547/L1058；`index.js` L49；`cordis.patch.yml` L7–9 | L15 的 ModuleLoader id 必须 == 新包名，否则加载器判定「没注册」 |
| 换导航图标 | `client.js` apply 内新增 `settings.section.icon` 注册（id `bili-live`）；或 `package.json.icon` | 两种图标用途不同：前者是设置导航，后者是插件清单 |
| 改页面文案 | 导航 L1058、标题 L547、pill L541、区块标题 L589/L621/L651/L713/L773/L806/L890/L964/L991、各说明字符串 | 目前无 i18n/locale 服务注入；多语言要么全量替换，要么引入 DSH locale 服务 |
| 加开关/数字项 | `client.js` 控件 + `formPatch` L318–360；`lib/config.mjs` `DEFAULTS` L11–135 + `normalizeConfig` L169–230 | 漏改 DEFAULTS → `mergeConfig` 静默丢弃（L233–241）；即时开关仿 L652–657 |
| 加设置卡片 | `Panel` return L543–1008 插 `data-bl-sec` 块；CSS L55 | 宽度 660 / 四列网格写死 L35/L51 |
| 加独立设置页 | `client.js` L1056–1060 再 register 一条 `settings.section` | id 唯一；order 决定导航顺序；组件可复用 `Boundary` |
| 替换登录方式 | 保持三个路由契约：`/login/qr` 回 `{ok,key,svg}`、`/login/poll` 回 `{ok,status,uname,mid,error}`、`/logout` 删凭证；实现可整体换 `auth.mjs` 或改 index.js L1316–1364 | 前端只认这些字段；凭证落盘逻辑在 index.js L160–171，换方案时别漏 |
| 改清理策略 | `cleanup.mjs` `SUBS` L16 / `DEFAULT_MAX_AGE` L19；目录名 index.js L565/L629；调用点 L533–538、L1039 | 改目录名两处同步；要白名单/总容量上限需自己加 |
| 换品牌色/主题 | `client.js` CSS L34–123 的 `#fb7299`/`#00aeec` 与 `--dsw-alias-*` 兜底 | 建议只改品牌色，结构色继续用 DSH 变量以兼容暗色 |

---

## 6. 风险与坑

### 6.1 注入契约 / DSH 版本兼容
- `package.json` 要求 `engines.dsh >= 0.1.7-rc.1`（L30–32）；本机 DSH 为 0.2.2-rc.1。`slots` 服务、`settings.section` options、组件 props（`{close}`）都是 DSH 客户端契约，跨版本可能变；本插件全程 try/catch + `console.warn`，契约一变表现为**设置页静默消失**，排查只能开控制台。
- 加载器规则：id == 包名、一个 bundle 只注册一次（重复执行抛错）、请求非基座模块必须在 `dsh.client.external` 声明。
- 没有 DSH 配置 schema / settings 文档：备份、迁移就是备份 `<home>/config.json` 与 `credential.json`（后者注意安全）。

### 6.2 开发 / HMR
- CSS 以 `data-plugin-css` 标记只注入一次（L1040–1045）：模块热替换后旧 `<style>` 还在，**新 CSS 不会重新注入**，改样式必须刷新页面；插件卸载也不会移除该 style（轻微泄漏）。
- `dsh.client` 未声明 `immediately`，属普通应用批；改 `client.js` 依赖 DSH 的 client HMR 链路，改 `package.json` 的 id/exports 要重启宿主。
- 追加 hook 必须在 L303 early return 之前，否则 React #310。
- 别名（L638）、语音词（L743）、喜好词（L870）、试发框（L697）是**故意非受控**：受控回写会吃掉逗号/中文输入法拼音，改代码时别「顺手」受控化。

### 6.3 前端状态一致性
- `save()` 用服务端返回的 config 覆盖 `form`（L309）：点任意开关会把**尚未点保存的输入框改动丢掉**，是当前实现最容易踩的 UX 坑。
- 多标签页/多客户端同开：服务端无 revision/ETag，最后写赢。
- 名单只在首次 `form` 到达时同步一次（L237–242）：外部改 `config.json` 后页面不刷新名单，需重开设置页。
- 前端对 `/login/poll` 的 `status:'error'`（服务端 200 + `{ok:true,status:'error',message}`，L1334–1335）没有分支处理（L281–296 只认 ok/scanned/waiting/expired），会保留上一条提示——小 UX bug。
- 无总开关 UI：`config.enabled` 只在 hero 显示（L540–541），要停插件得改 `config.json`。
- 设置页未覆盖的配置（只能改 `config.json` 或自己加 UI）：`enabled、freeReply、llmProvider/llmModel、recapEnabled/recapMinDanmaku、maxLen、audioSliceMs/audioQn/asrPython/audioKeepFiles、visionShotsInRecap`。

### 6.4 凭证安全（SESSDATA 泄露面）
- `<home>/credential.json` 明文存 `SESSDATA/bili_jct/buvid3`（index.js L160–171），无显式 `chmod`；任何能读家目录的进程都能操作该账号。分享笔记/备份时注意别带上它。
- 浏览器侧只拿 `uname/uid/own`（`/status` L1142–1147），**SESSDATA 不出现在任何前端响应里**；但 `/status` 回传 `home` 绝对路径（L1140 → 前端 L982），`/open-folder` 能在宿主执行 `xdg-open/explorer/open`（L1403–1416）。
- `/api/bili-live/*` 自身没有额外鉴权，依赖 DSH webServer/会话保护；若通过远程访问/隧道暴露且未加认证，`switch/send-test/open-folder/login` 都可被任意调用（`send-test` 会用你的账号发真弹幕）。
- QR SVG 经 `dangerouslySetInnerHTML` 注入（client.js L612）：内容来自服务端 vendor 库、目前可信；若换成外部来源就是 XSS 面。
- 扫码成功但 `whoAmI` 失败仍会落盘凭证（index.js L1337–1338，`me` 可能为 null）；凭证活性每 10 分钟才查一次（L1114–1128），「已登录」状态可能滞后。

### 6.5 清理相关
- 写笔记失败也照样清本场临时文件（index.js L533–538：清场紧跟在 writeRecap 的 try/catch 之后，只要没在更早处抛异常就会执行，rm 自身的失败只被吞掉）→ 想复盘那一场已经没有素材；要保留可把 `clearRoomTmp` 挪进 `writeRecap` 成功分支。
- `sweepTmp` 只按 mtime、默认 6 小时清文件，不删空目录、不设总量上限；长时间直播的切片会占用到 6 小时后才被清。
- `clearRoomTmp` 按 `-<roomId>-` 子串匹配，若文件名格式改了（如改分隔符），清理会静默失效；日志里只出现「清掉 N 个」，不会报错。
