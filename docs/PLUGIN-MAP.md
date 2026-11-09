# dsh-bili-live 插件解读地图

> 面向「基于本插件做个人定制版」的地图。基于 2026-11-09 对仓库 15 个源文件（约 8100 行）的通读；每个子系统的逐行深读笔记在 [docs/notes/](notes/)（共 1221 行，带行号索引）。
>
> 代码基线：`v0.9.3`（git `9554ab4`），MIT，工作区未被修改。

## 0. 一句话

挂在自己的 B 站账号上的直播助手 DSH 插件：定时巡查/守候直播间，三路采集（弹幕长连接、本机 ASR 转写、定时抽帧），离场时给主播十维评分、让宿主模型写一张 txt 笔记，高分推送私信给另一个账号；平时只在被 @ 或听到关键词时接一句话。

**它不是**：独立应用、B 站客户端、录播/剪辑工具、通用直播框架。一切跟随 DSH 进程（关掉 DSH 就停），插件没有自己的模型（借宿主 `llm` 服务），也不采集你的账号信息（只读公开直播数据 + 自己扫码的凭证）。

## 1. 技术形态与 DSH 契约

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 插件类型 | 双半端：宿主端 Cordis 插件 + 浏览器端自注册模块 | `index.js` / `client.js` |
| 依赖 | **零 npm 依赖、无构建步骤**（`package.json` 无 dependencies/peerDependencies/scripts），改文件即改代码 | `package.json` |
| 宿主入口 | `main: index.js`；`name='bili-live'`、`inject=['webServer']`、`apply(ctx)` | `index.js:49/50/102` |
| 浏览器入口 | `exports["./client"]` + `dsh.client { platform:'web', inject:['react'] }` | `package.json:16-43` |
| 浏览器注册 | `window.__ModuleLoader__.load({id, factory})`，**id 必须 == 包名**；factory 返回 `{inject:['slots'], apply}` | `client.js:14-16`、`1033-1065` |
| 挂载声明 | `cordis.patch.yml` 插一条 loader entry `{id: bili-live, name: dsh-bili-live}`；生效前提是包名进入 profile 的 `dsh.profile.bundles` | `cordis.patch.yml` |
| 宿主服务 | 声明注入仅 `webServer`；其余全部懒取：`llm`、`agentDefaultModel`（默认模型路由）、`attachments`（画面转附件）、`dshHomePath`（家目录） | `lib/llm.mjs`、`index.js:54/173/276` |
| HTTP | `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/api/bili-live'}))` | `index.js:1421-1433` |
| 设置页 | `slots.inject('settings.section', () => slots.register({name:'settings.section', id:'bili-live', order:31, label:'直播助手（DD版）'}, …))`；**没有** DSH 配置 schema、没有独立路由 | `client.js:1056-1060` |
| 兼容性 | `engines.dsh >= 0.1.7-rc.1`（本机 DSH 0.2.2-rc.1 ✓）、`node >= 22`（本机 v24.22.2 ✓） | `package.json:30-33` |
| 许可 | MIT（可自由改，保留版权声明） | `package.json`、`README.md` |

⚠️ 四层 id 别混：**npm 包名 = ModuleLoader 注册 id = 浏览器模块身份**（`dsh-bili-live`）；**宿主插件 name = 设置 section id**（`bili-live`）；**patch 条目** `id: bili-live` / `name: dsh-bili-live`。改名时至少要同步包名与 ModuleLoader id。

## 2. 架构总览

```
DSH 宿主进程
└─ index.js  apply(ctx)
   ├─ 主循环 schedule()/tick()（每 pollMs，默认 60s）
   │   ├─ 开关注名单：按数组顺序 getRoomByUid/getRoomInfo，liveStatus==1 的第一个 → watch()
   │   └─ 关名单/全没播：getRandomLiveRooms → 三层兜底选房 → watch(random=true)
   ├─ watch(房间) 进房后三路并行
   │   ├─ DanmakuClient（wss 长连接）→ 弹幕记录 + handleDanmaku（@/别名→回复）
   │   ├─ AudioTap ← getPlayUrl(qn=80) → 切片 → AsrWorker(python) → handleSpeech（关键词→回复）
   │   ├─ VisionTap ← getPlayUrl(qn=150) → 分片 → grab_frame.py(PyAV) → shots[]
   │   └─ startRating：每 90s collectStats()，各项取峰值
   ├─ stopWatching()（下播/被顶掉/看满时长/手动/卸载）
   │   └─ finishRecap()（异步，不阻塞下一场）
   │       ├─ computeScore(十维) → moderator.judge(隐藏恶意扣分)
   │       ├─ llm.generate(总结+评价) → writeRecap(txt)
   │       ├─ pushHighlight（仅随机房 & 分数>阈值 & 30 天去重）→ sendPrivateMsg
   │       └─ clearRoomTmp（删本场切片/截图）
   └─ HTTP /api/bili-live/*  ←── client.js（设置页 11 区块，5s 轮询 /status）

子进程：tools/asr_worker.py（常驻，stdin/stdout JSONL，懒创建）
        tools/grab_frame.py（一次一帧，stdout 回 JPEG）
```

## 3. 模块职责（15 个文件）

| 文件 | 行数 | 职责 | 关键符号 |
| --- | --- | --- | --- |
| `index.js` | 1448 | 宿主端全部编排：主循环、三路采集装配、回复、评分采样、离场结算、推送、14 条 HTTP 路由、DSH 生命周期 | `apply`(102)、`watch`(934)、`finishRecap`(385)、`handle`(1129) |
| `client.js` | 1067 | 浏览器端设置页（自注册模块），11 个区块，纯 React hooks | `Panel`(191)、`apply`(1038) |
| `lib/live.mjs` | 702 | B 站接口层：房间/随机巡场/WBI 签名/弹幕 wss 协议/PB 解码/发弹幕/私信 | `DanmakuClient`(593)、`getRandomLiveRooms`(182)、`sendDanmaku`(305) |
| `lib/audio.mjs` | 255 | 拉音频流 → FLV 增量拆包 → 只留音频 tag → 按时长切片落盘 | `getPlayUrl`(34)、`FlvSplitter`(73)、`AudioTap`(146) |
| `lib/asr.mjs` | 259 | 常驻 faster-whisper 进程的宿主侧封装（启动超时、队列、卡死重启） | `AsrWorker`(44)、`findPython`(20) |
| `lib/vision.mjs` | 140 | 另拉一路视频流，只留视频 tag，缓存最近 GOP，定时落 flv 分片 | `VisionTap`(18) |
| `lib/rating.mjs` | 544 | 十维评分：接口采集、归一化、期望值、加权、分档 | `collectStats`(88)、`computeScore`(369)、`WEIGHTS`(315) |
| `lib/moderation.mjs` | 219 | 恶意内容审核（隐藏扣分）：只审弹幕，判「玩笑 vs 真恶意」 | `makeModerator`(30) |
| `lib/recap.mjs` | 400 | 直播记录器（内存）+ txt 笔记模板/落盘/列表 | `LiveRecorder`(82)、`writeRecap`(360) |
| `lib/auth.mjs` | 147 | B 站扫码登录 + buvid3 + whoAmI | `generateQr`(67)、`pollQr`(123) |
| `lib/llm.mjs` | 140 | 借宿主 llm 服务：路由解析 + 流式生成 + 静默降级 | `makeLlm`(18) |
| `lib/config.mjs` | 247 | 43 项配置默认值 + 清洗 + merge | `DEFAULTS`(11)、`normalizeConfig`(169) |
| `lib/cleanup.mjs` | 80 | 本场临时文件清理 + 超龄孤儿兜底 | `clearRoomTmp`(40)、`sweepTmp`(61) |
| `tools/asr_worker.py` | 101 | 转写子进程：读 JSONL 路径 → faster-whisper → 回 JSONL | — |
| `tools/grab_frame.py` | 66 | 抽帧子进程：stdin 给 flv 路径 → PyAV 取首帧 → JPEG 到 stdout | — |
| `vendor/qrcode.js` | 2297 | 第三方 qrcode-generator 1.4.4（MIT），服务端 eval 出 SVG | `qrSvg`(auth.mjs:48) |

## 4. 一场直播的生命周期

1. **选台**（`tick` 1032-1103）：先 `sweepTmp` 扫孤儿文件 → 校验总开关/凭证 → 随机房到点兜底 → 按名单顺序查开播 → 名单全没播则 `randomTour`（唯一例外：`randomWhenNoneLive=false` 时干等）。
2. **进房**（`watch` 934-1001）：建 `LiveRecorder` → 连接弹幕 → `startAudio`/`startVision`/`startRating` → 随机房 `armRotateTimer`。注意 `rt.current` 在 `await client.start()` 之前就赋值（见风险 P1）。
3. **采集**：弹幕全量进 recorder（上限 2 万条）；语音段转写后进 `speech`（上限 4000）并查关键词；画面按 `visionIntervalMs`（默认 5 分钟）抽帧，上限 `visionMaxShots`（默认 24）；评分每 90 秒采一次峰值。
4. **交互**（默认不说多余的话）：
   - 弹幕回复链：`autoReply && username` → 非自己 → `isCallingMe`（昵称/别名子串或 `@昵称`）→ 每日额度 → 房间冷却（`cooldownMs`）→ 首次自我介绍 / 模型自由回复（失败退固定模板）。
   - 语音回复链：`audioKeywords` 命中 → `audioReply && autoReply && username` → 每日额度（与弹幕**共用**）→ 语音冷却 → 模型/模板。
5. **离场**（`stopWatching` 541-558）：停弹幕/音频/画面/评分 → `rt.current=null` → 异步 `finishRecap`。
6. **结算**（`finishRecap` 385-538）：
   - 评分门槛：看不满 60 秒 / 没采到同接 / 同接 < 20（`MIN_ONLINE`）→ 不打分。
   - 打分 → 恶意审核（可能扣 0~5 分）→ 模型写总结+评价（可带语音摘录与最多 3 张画面）→ 落 txt 笔记。
   - 推送：仅 `rec.random` 且分数 > `ratingPushScore`；按 upUid 30 天去重；发失败不记账。
   - 清理：删本场 `tmp/live`、`tmp/shots` 文件。
7. **下播检测**：名单模式靠下一轮 tick 间接发现；**随机房不主动轮询当前房 liveStatus**，要等 `randomWatchMs` 到点兜底（默认 30 分钟）或手动停止。这是定制时值得改的点。

## 5. 配置系统（43 项）

- **唯一真源**：`lib/config.mjs` 的 `DEFAULTS`(11-135)。`normalizeConfig`(169-230) 负责 clamp/白名单/数组去重上限；`mergeConfig`(233-241) **只合并 DEFAULTS 里出现过的键**——只在前端加设置项、不补 DEFAULTS，会被静默丢弃。
- **保存链路**：设置页本地 `form` → `POST /config` → `mergeConfig` → `Object.assign(cfg)` → `saveCfg()` → `schedule()` 重设轮询、`armRotateTimer()` 重设换台、按需启停音频/画面、必要时重建 ASR。
- **分组**：
  - 总开关与身份：`enabled`、`username`、`aliases`、`introTemplate`
  - 回复行为：`autoReply`、`freeReply`（强制 true）、`fixedReply`、`replyTemplate`、`cooldownMs`、`dailyLimit`、`maxLen`
  - 模型：`llmProvider`、`llmModel`（留空 = 跟随 DSH 默认模型）
  - 巡场/守候：`priorityEnabled`、`randomWhenNoneLive`、`randomWatchMs`、`randomKeywords`、`pollMs`、`streams[]`（顺序 = 优先级）
  - 评分/推送：`ratingEnabled`、`ratingWeights`、`ratingPushScore`、`ratingPushUid`
  - 审核：`moderationEnabled`、`moderationThreshold`
  - 笔记：`recapEnabled`、`recapMinDanmaku`
  - 音频/ASR：`listenAudio`、`audioSliceMs`、`audioQn`、`asrModel`、`asrLang`、`asrPython`、`audioKeywords`、`audioReply`、`audioReplyCooldownMs`、`audioInRecap`、`audioKeepFiles`
  - 画面：`visionEnabled`、`visionIntervalMs`、`visionMaxShots`、`visionInRecap`、`visionShotsInRecap`
- **设置页未覆盖**（只能改 `config.json`）：`enabled`、`freeReply`、`llmProvider/llmModel`、`recapEnabled/recapMinDanmaku`、`maxLen`、`audioSliceMs/audioQn/asrPython/audioKeepFiles`、`visionShotsInRecap`。
- **死配置**：`llmEnabled` 被 `lib/llm.mjs:87` 引用，但不在 DEFAULTS/normalizeConfig 里 → 永远无法配置（恒开）。
- **会自改配置的副作用**：ASR 连续 3 次超时自动把 `asrModel` 降为 `small` 并**落盘**（`index.js:748-759`）；扫码登录后昵称为空会自动填 `username`（`index.js:1344-1347`）。定制时决定保留还是去掉。
- 权重不用改代码：设置页可调 `ratingWeights`（百分数，不用凑 100，按总和归一），后端 `buildWeights` 处理。

## 6. HTTP API（14 条，前缀 `/api/bili-live`）

| 方法/路径 | 处理行 | 作用 |
| --- | --- | --- |
| GET `/status` | 1133-1198 | 全量状态：登录、config、defaults、llm 路由、当前房间、音频/画面/评分、lastRecap、推送记录、笔记列表、日志 30 条 |
| POST `/config` | 1201-1235 | patch 合并配置并即时应用 |
| POST `/pushed/clear` | 1238-1243 | 清空推送判重表 |
| POST `/resolve` | 1245-1260 | 房间号/主播 UID → 主播记录 |
| POST `/tick` | 1263-1266 | 立即检查一次 |
| POST `/stop` | 1268-1272 | 离开当前场（不是关总开关） |
| POST `/switch` | 1274-1309 | 手动切台（`mode:random` 或 `key` 房间号/UID，算随机巡场） |
| POST `/login/qr` | 1316-1327 | 生成登录二维码 SVG |
| POST `/login/poll` | 1328-1354 | 轮询扫码状态、成功落盘凭证 |
| POST `/logout` | 1356-1364 | 删凭证 + 写退出标记 |
| POST `/llm-test` | 1368-1384 | 模型自测 |
| POST `/send-test` | 1387-1397 | **用你的账号真发一条弹幕** |
| GET `/records` | 1399-1401 | 笔记文件列表（40 条） |
| POST `/open-folder` | 1403-1416 | 宿主打开笔记目录（xdg-open/open/explorer） |

实现细节：路由用 `path.endsWith(...)` 宽松匹配；**没有 `/logs` 路由**（日志只在 `/status.logs`）；业务错误多为 200 + `{ok:false}`；无鉴权/无 Origin 校验，默认只靠 DSH webServer 的 loopback 绑定。

## 7. 磁盘布局与内存态

```
$DSH_HOME/bili-live/            # Linux: ~/.dsh/bili-live/
├─ config.json                  # 43 项设置（设置页写）
├─ state.json                   # 只存回复状态：introDone/today/replyCount/lastReplyAt
├─ pushed.json                  # 推送判重表 upUid → {uname,score,at,roomId}
├─ credential.json              # 明文 SESSDATA/bili_jct/buvid3/dedeuserid/uname
├─ logged-out.json              # 退出标记（有它就不认旧凭证）
├─ live.log                     # 运行日志（无轮转）
├─ recaps/YYYY-MM-DD 主播 时-分.txt
└─ tmp/live/*.flv  tmp/shots/*.flv|*.jpg   # 本场切片/截图（正常离场删除，孤儿 6 小时兜底）
```

**内存是唯一真相**：`rt` 运行态 + `LiveRecorder` 全在内存；进程崩溃/DSH 关闭，当前场直接丢（卸载走 silent、故意不写半截笔记）。`state.json` 只持久化回复相关状态；`recentRooms`、评分峰值、当前房间等重启即丢。

## 8. 评分 / 审核 / 笔记口径（摘要）

- **公式**：`Score = 10 × Σ(w̃_k × N_k)`，`w̃` = 用户百分数按总和归一。
- **十维 + 一隐藏**：作品获赞、直播互动、观众参与、弹幕热度、人气规模、粉丝浓度、更新频率、粉丝付费率、路人付费率、路人转化率；默认权重 **20/17/12/12/10/8/8/7/5/1**（README 里的 19/16/…/3 已过期）。
- **归一化**：四项比率型（互动/参与/两个付费率）走「实测 ÷ 同规模期望」（锚点 35/125/350/2000 对数插值 + `expNorm` 三段折线）；其余固定 cap，跨量级用对数、比率用线性；获赞 cap 随粉丝数在 900~180000 间锚点插值（比 README 全线 ×3）。
- **分母**：`crowd = max(online,30)` 只给「每百人弹幕」；`heads = max(online,5)` 给其余人数类比率。
- **入口门槛**：看 ≥60 秒、采到同接（onlineKnown）、同接 ≥20（`MIN_ONLINE`）。
- **恶意审核**：算分后单独问一次模型，只审弹幕（≤400 条采样 + 独轮车统计），恶意 ≥ 阈值（默认 10）且**本场无封禁**才扣 0~5 分；有封禁一律免责，waived 时在评价里说明。
- **笔记**：txt 模板含评分条形图、模型总结、大肥鱼评价、最热闹一分钟、弹幕摘录、主播原话；模型不可用退「本地统计版」。
- 完整公式、prompt 结构、模板见 [03 笔记](notes/03-score-recap.md)。

## 9. 前端设置页

11 个区块：状态 hero、B 站账号（扫码登录）、自我介绍、什么时候开口、听声音、看画面、守谁（名单/自动巡场）、主播评分（十维权重）、直播笔记、页脚信息、保存栏。

- 状态模型：`st`（服务端快照，5s 轮询）+ `form`（本地编辑缓冲）；**开关类即时保存**，输入类由「保存全部设置」提交。
- 已知体验坑：`save()` 会用服务端 config **覆盖 form、丢掉未保存的输入**；没有总开关 UI（`enabled` 只在 hero 显示）；登录轮询的 `status:'error'` 分支前端没处理；名单只在首次拿到 form 时同步一次；CSS 只注入一次，HMR 后不更新。
- 加设置项三模式与必改后端，见 [04 笔记 §2.2](notes/04-client-auth.md) 与 [02 定制指南](CUSTOMIZATION.md)。

## 10. 本机现状核查（2026-11-09）

| 项 | 状态 |
| --- | --- |
| 是否已安装 | **否**。`~/.dsh/profiles/web/node_modules` 里只有插件市场 `dsh-plugin`，profile 的 `dsh.profile.bundles` 也没有 `dsh-bili-live` |
| 是否运行过 | **否**。`~/.dsh/bili-live/` 不存在（无配置、凭证、笔记） |
| profile | `web`（`~/.dsh/profiles/web`）；DSH `0.2.2-rc.1`；node v24.22.2；pnpm 12.18.0 可用 |
| HMR | base 默认启用，但 `root: []` 只监听 profile 配置；**改插件代码最稳是重启 DSH**（链接包在 profile 重新组合时也会被替换，但依赖触发时机） |
| 安装命令 | `dsh plugin --profile web add link:/mnt/volume/dsh/dsh-bili-live`（自动把新 bundle 加入 `dsh.profile.bundles`；需在沙箱外/批准后执行，会写 `~/.dsh/profiles/web`） |
| README 的 `--profile desktop` 示例 | 本机是 Web profile；desktop profile 由 Electron 持有，CLI 管理其插件需带 Desktop 运行时 |
| ASR 环境 | 未建 venv；README 的 `Scripts/pip` 是 Windows 路径，Linux 应用 `bin/pip`；`av`/`Pillow`/`faster-whisper` 需自装（不装只影响「听声音/抽帧」） |
| 网络 | 插件运行需要能访问 B 站接口/wss/直播流；离线时只会在日志里报错并降级 |

## 11. 文档漂移勘误（改前必看）

README 与代码已有多处不一致，**以代码为准**：

| README 说法 | 代码实际 | 证据 |
| --- | --- | --- |
| 默认权重 19/16/12/12/10/8/8/7/5/3 | **20/17/12/12/10/8/8/7/5/1** | `lib/rating.mjs:315-329` |
| 获赞满分线 300~60000/稿 | 全线 ×3 → **900~180000** | `rating.mjs:283-296` `LIKE_POINTS` |
| 粉丝数拿不到退回 600 | **1800**（中性线） | `rating.mjs:299-313` |
| ASR 默认 medium | **small** | `config.mjs:99` |
| 每 2 分钟抽一帧 | **5 分钟**（`visionIntervalMs=300000`） | `config.mjs:121` |
| 未提「同接 < 20 不打分」 | 代码有硬门槛 | `index.js:379/400` |
| 目录结构、隐私、成本描述 | 基本准确 | — |

另：`config.mjs:69-73` 注释里的默认权重 15/15/10/10/10/10/13/10/5/2 也是过期值；`client.js:142-145` 的 `WEIGHT_DEFAULTS` 是 `rating.mjs` 的**手抄副本**（当前一致，改默认值必须两处同步 + README）。

## 12. 风险清单（定制前心里有数）

**P0 · 安全**
- `/api/bili-live/*` 无鉴权、无 Origin/CSRF 校验，`/send-test` 会用你的账号真发弹幕、`/open-folder` 会在宿主执行打开命令。默认靠 webServer 只绑 loopback；**一旦暴露到局域网/隧道，必须先加 token/Origin 校验**。
- `credential.json` 明文存 SESSDATA（未 chmod）；`/status` 回传家目录绝对路径。分享日志/备份时别带上凭证与 `home`。

**P1 · 稳定性**
- 当前场全内存，崩溃即丢；`finishRecap` fire-and-forget、异常被吞、无重试，失败只落日志。
- `watch` 先设 `rt.current` 再 `await client.start()`：连接失败会卡在「假进房」，随机房要等 30 分钟兜底才换台。
- `grabFrame` 的 python 子进程无超时、未登记 kill；启动后 3 秒首查定时器句柄没保存（卸载不清）。
- 随机房不主动轮询当前房 `liveStatus`，下播后不能及时发现。
- 弹幕 wss 只取 `host_list[0]`（不切备用 host）；WBI 签名缓存 6 小时，提前失效只能等 TTL/重启。
- ASR 队列主动丢中间片（不是完整逐字稿）；连续超时才杀进程并可能自动降模型。

**P2 · 一致性 / 成本**
- 文档漂移（见上）；`llmEnabled` 死开关；ASR 超时自动改配置落盘。
- 接口全部 `.catch` 吞错，B 站字段变化会**静默**影响分数（仅有 `onlineKnown` 等少数显式标记）。
- token 无全局预算：笔记上限 1 万 output + 最多 6 张图，推送再问一次评价，审核每场一次。
- `state.introDone` / `pushed.json` / `live.log` 无轮转/修剪；`/status` 载荷重（内含完整 config/defaults/日志）。

**P3 · 体验**
- 设置页开关覆盖未保存输入；无总开关 UI；登录 error 分支缺失；CSS HMR 不更新；改任何 `client.js` 都要刷新页面。

## 13. 深读笔记索引

| 笔记 | 内容 | 适合什么时候读 |
| --- | --- | --- |
| [01 host-index.md](notes/01-host-index.md) | 宿主端 index.js：apply 分段、路由、主循环、60 项符号行号表、20 条坑 | 改主流程/结算/路由/生命周期 |
| [02 media.md](notes/02-media.md) | B 站接口清单、WBI、弹幕 wss 协议、FLV 切音频、ASR 协议、抽帧、降级表、15 条坑 | 改采集、换清晰度、换 ASR、接平台 |
| [03 score-recap.md](notes/03-score-recap.md) | 评分公式与期望值、审核 prompt、笔记模板、LLM 契约、6 条坑 | 改评分/审核/笔记/模型 |
| [04 client-auth.md](notes/04-client-auth.md) | DSH 前端注入契约、11 区块行号、扫码登录、清理、定制入口、坑 | 改设置页/登录/品牌 |

推荐顺序：先读本页 → 04（界面与部署）→ 01（主流程）→ 按需 02 / 03。
