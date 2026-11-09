# 01 · 宿主端 `index.js` 深读笔记

> 对象：仓库根 `index.js`（1448 行，ESM，`export` 三个符号）。只读分析，未执行插件、未联网。
> 一句话结论：`apply(ctx)`（L102）是一个大闭包。启动时只做「解析家目录 → 读配置/状态/凭证 → 挂 `/api/bili-live/*` 路由 → 起轮询定时器 + 3 秒首查」；巡场、回弹幕、听声音、看画面、离场结算全部是闭包内函数。**运行态只在内存 `rt`（L180–194）**，落盘只有 `config.json / state.json / pushed.json / credential.json`、`live.log` 和笔记。

---

## 1. DSH 插件契约用法（name / inject / apply / ctx）

### 1.1 导出与 `package.json`、`cordis.patch.yml` 的对应关系

| 位置 | 内容 | 作用 / 与包声明的对应 |
| --- | --- | --- |
| L49 | `export const name = 'bili-live'` | cordis 插件名；DSH 面板/日志里的插件标识 |
| L50 | `export const inject = ['webServer']` | 声明硬依赖：`apply` 执行前宿主必须先激活 `webServer`，因此 L1422 `ctx.webServer` 可直接用 |
| L102 | `export function apply(ctx)` | 唯一入口，同步执行；所有初始化在函数体里完成，不返回额外 API |
| L113–115 | 读 `package.json` 的 `version` | 兜底 `''`；`/api/bili-live/status` 里回传（L1139） |
| `package.json` `main`/`exports["."]` | `./index.js` | 宿主端入口即本文件 |
| `package.json` `exports["./client"]` | `./client.js` | 浏览器端设置页，由另一份笔记分析 |
| `package.json` `dsh.bundle.patch` | `./cordis.patch.yml` | DSH bundle 机制读取该 patch，把 `- insert: [{id: bili-live, name: dsh-bili-live}]` 插进 profile 插件树；装包后即生效 |
| `package.json` `dsh.client` | `{ platform: 'web', inject: ['react'] }` | 声明浏览器端模块平台与依赖；与宿主端 `apply` 无关，但同属一个包的两端 |
| `package.json` `engines.dsh` | `>=0.1.7-rc.1` | 插件兼容的 DSH 版本下限 |

> 注意：本插件**没有**在 DSH profile 里声明配置 schema，配置是插件自己写 `$DSH_HOME/bili-live/config.json`，由设置页 POST `/api/bili-live/config` 改写——这是与常规 DSH 配置项最大的不同，定制时不要去找 `dsh.config`。

### 1.2 `ctx` 上实际用到的服务（只有 5 个，且大多懒取）

| 服务 | 取用位置 | 用途 | 契约要点 |
| --- | --- | --- | --- |
| `ctx.get('dshHomePath')` | `stateDirOf` L54–68 | 拿 DSH 家目录；`p('bili-live')` → `<DSH_HOME>/bili-live` | 由 `dsh-app-boot` 提供（`ctx.provide('dshHomePath', dshHomePath)` 一个函数）。插件同时兼容「函数」和「字符串」两种形态，失败回退 `$DSH_HOME` / `~/.dsh`（L65） |
| `ctx.webServer` | L1421–1433 | 注册 `/api/bili-live` 前缀路由 | `register({ kind: 'prefix', path, handler })` 返回 disposer；handler 自己负责写响应（`IncomingMessage/ServerResponse` 原生风格） |
| `ctx.effect(fn, label)` | L1421（注册路由）、L1441（卸载清理） | 把「副作用 + 清理」绑到插件 fiber：`fn` 返回 disposer，插件卸载时自动执行 | 注册路由的 disposer 会自动摘路由；L1441 的 effect 返回闭包负责清定时器/停采集 |
| `ctx.get('attachments')` | `shotRefs` L276 | 把抽帧 JPEG 存成模型可吃的图片附件 | `att.saveImage({ data: Uint8Array, mediaType: 'image/jpeg', name })` → `ImageAttachmentRef`；服务不存在时只记日志、总结退化为纯文本（L277） |
| `ctx.get('llm')` | 间接：`lib/llm.mjs` L20–26、L86–97 | 所有 AI 回复/总结/审核 | 懒取（`apply` 时 llm 可能还没挂上）；`prepareCall({provider, model, maxTokens}, signal)` → `call.stream({...})`；另有 `ctx.get('agentDefaultModel').currentSelection()` 跟随宿主默认模型（llm.mjs L30–36） |

未被使用、但 DSH 插件常见的：`ctx.logger`（自己写 `live.log`）、`ctx.config`、`ctx.bus（事件）`、`ctx.command`、`ctx.timer`。因此日志格式、配置合并、定时器都要自己维护。

### 1.3 启动与卸载顺序

启动（`apply` 内，全部同步/即发即忘）：
1. L103 `stateDirOf(ctx)` 建家目录；L104–107 定义 4 个文件路径。
2. L110–115 载入 `pushed.json`、包目录与版本。
3. L117–128 读 `config.json`（`normalizeConfig`）与 `state.json`（跨天清零回合计）。
4. L150–177 凭证路径、`makeLlm`、`makeModerator`、二维码库路径。
5. L180–194 初始化内存运行态 `rt`。
6. L1129–1419 定义 `handle(req,res)`（大 if 链）。
7. L1421–1433 用 `ctx.effect` 注册前缀路由；失败只打日志、插件继续跑（此时无设置页 API）。
8. L1435 `schedule()` 起 `setInterval(tick, cfg.pollMs)`；L1436 打「已挂载」日志；L1438–1439 3 秒后首查（`setTimeout` + `unref`）。

卸载（L1441–1447，按顺序）：
1. `clearInterval(rt.timer)`；
2. `stopWatching('插件卸载', { silent: true })` —— 静默，不写半截笔记（L557）；
3. `stopAudio` / `stopVision` 收流；
4. `rt.asr?.stop()` 停转写子进程。
> `stopWatching` 内部会 `clearTimeout(rt.rotateTimer)`、停弹幕客户端、`stopRating`；但 **L1438 的 3 秒 boot 定时器没有保存句柄**，卸载时不会清（见风险 §6-3）。

---

## 2. `apply()` 分段索引

### 2.1 文件顶部工具函数与家目录（L21–100）

| 行号 | 符号 | 职责 / 关键细节 |
| --- | --- | --- |
| L21–25 | node 内置导入 | `fs`（同步读写为主）、`spawn`、`homedir`、`path`、`url`；**全程同步文件 IO**，无 `fs/promises` |
| L27–47 | 11 个本地模块导入 | `live / config / auth / llm / recap / audio / vision / asr / cleanup / rating / moderation`；本文件是唯一把三路采集与结算串起来的地方，其余模块只提供能力 |
| L52 | `MAX_LOGS = 60` | 内存日志环形上限；`/status` 只回最近 30 条（L1197） |
| L54–68 | `stateDirOf(ctx)` | 家目录解析（见 §1.2），并 `mkdirSync(..., {recursive:true})` |
| L70–72 | `readJson(file, fallback)` | 读坏/不存在静默回退，**不区分错误类型** |
| L74–76 | `writeJson(file, value)` | 写失败静默吞掉（状态丢失无提示） |
| L78–81 | `dayKey()` | `Date.now()+8h` 后取 ISO 日期 → 固定北京时间「今天」，与系统时区无关 |
| L83–89 | `sendJson(res, code, obj)` | 统一 JSON 响应 + `no-store` |
| L91–100 | `readBody(req)` | 读请求体；**上限 1e6 字节**，超限 `req.destroy()` 并回 `{}`；JSON 坏也回 `{}` |

### 2.2 家目录文件布局（`$DSH_HOME/bili-live/`）

| 路径 | 定义/写入位置 | 内容与生命周期 |
| --- | --- | --- |
| `config.json` | L104；`saveCfg` L138 | 设置页配置，`normalizeConfig` 清洗后写回 |
| `state.json` | L105；`saveState` L139 | 仅 `{introDone{roomId:ts}, today, replyCount, lastReplyAt{roomId:ts}}`（L119–124） |
| `pushed.json` | L106；`savePushed` L111 | `{pushKey: {uname, score, at, roomId}}`，30 天判重（L334–347） |
| `credential.json` | L150；`saveOwnCred` L160–171 | 扫码所得 `{sessdata,bili_jct,buvid3,dedeuserid,uname,saved_at}`，明文 |
| `logged-out.json` | L152；`/logout` L1358 | 「主动退出」标记；存在即 `loadCred()` 返回 null（L153–158），重新扫码时删除（L161） |
| `live.log` | L107；`log` L135 `appendFileSync` | 只追加、无轮转、无大小上限 |
| `recaps/` | 由 `lib/recap.mjs` 的 `recapDir` 创建；`writeRecap` L520、`listRecaps` L1191 | 每场一张 txt；三处路由引用（/status、/records、/open-folder） |
| `tmp/live/` | L565 | 音频切片 flv（`clearRoomTmp`/`sweepTmp` 清） |
| `tmp/shots/` | L629 | 画面 flv/jpg（同上） |
| `.venv-asr/`、`.hf-cache/` | 不在 index.js 内创建 | ASR 环境/模型缓存，由 `lib/asr.mjs`、README 约定 |

### 2.3 配置、状态、日志（L102–146）

| 行号 | 符号 | 说明 |
| --- | --- | --- |
| L117 | `cfg` | `normalizeConfig(readJson(cfgFile, DEFAULTS))`；之后**原地修改**（`Object.assign` L1204） |
| L118–128 | `st` / `state` | 只取 4 个字段；载入时跨天则清 `replyCount`（不立即落盘） |
| L130–136 | `logs` / `log(msg)` | `[HH:MM:SS]`（UTC 切片，非北京时间）→ 内存 + `live.log` |
| L138–139 | `saveCfg` / `saveState` | 同步写；失败静默 |
| L140–146 | `rollDay()` | 跨天重置 `replyCount` 并落盘；调用点：`/status` L1134、弹幕回复 L871、语音回复 L783 |

### 2.4 凭证（L148–171）

`loadCred()`（L154–158）：先看退出标记，只认本插件 `credential.json`，且必须有 `sessdata`。`credSourceOf()` 恒为 `'own'` 或 `''`。`saveOwnCred` 会顺手删退出标记。**不借用其它插件登录态**（头部注释 L18 明确）。

### 2.5 运行时状态 `rt` 与状态投影（L179–207）

`rt` 初始键：`current`（`{realRoomId,uname,title,status,since,client,random}`）、`recorder`、`lastRecap`、`timer`、`busy`、`lastCheckAt`、`lastError`、`myUid`、`danmakuCount`、`qr`、`asr`、`audio`、`audioLastReplyAt`。
**动态挂载、初始未声明的键**：`rt.rating`（L215）、`rt.rotateTimer`（L542/L922）、`rt.vision`（L696）、`rt.lastPush`（L366）、`rt.recentRooms`（L1016）、`rt.asrTimeouts`（L750）。定制时留意这些键没有统一初始化/清理点。
`statusOfCurrent()`（L196–207）：把 `rt.current` 转成 `/status` 的 `current`，附直播 URL。

### 2.6 评分采样（L209–267 + L376–379）

| 行号 | 符号 | 说明 |
| --- | --- | --- |
| L213–255 | `startRating(realRoomId, uid, cred)` | 进房即采一次，之后 **每 90 秒**（L253）`collectStats` 一次；各项取历史最大/最新（L227–248） |
| L216–251 | `take()` | 首次采到的 `attention`/`fansClub` 记为开场基准（L223–226）；付费人数与分子分母必须同一次采样（L240–243） |
| L253–254 | 采样定时器 | `setInterval(..., 90000)` + `unref()` |
| L258–267 | `stopRating()` | 清定时器，返回 `{...best, firstAttn, fansClub, fanGain}`；无采样返回 null |
| L379 | `MIN_ONLINE = 20` | 评分硬门槛（注释说明小分母噪声） |
| 使用点 | L388–459 | 见 §2.8 结算流程 |

### 2.7 画面→附件、主播评价、高分推送（L269–374）

| 行号 | 符号 | 说明 |
| --- | --- | --- |
| L273–296 | `shotRefs(shots, max)` | 均匀挑 1–6 张（n=1 取中间，L279–284），读文件→`attachments.saveImage`；取不到 attachments 或某张失败就 `break`（L290–293） |
| L302–323 | `describeAnchor(rec, rating, summary)` | 单独一次 LLM 调用写「风格 + 评价」，`maxTokens 1200 / timeout 60s`；llm 不可用返回 `''` |
| L326–374 | `pushHighlight(rec, rating, summary)` | 高分私信：不填 UID 只记日志（L327–331）；按 `upUid`/名字 30 天判重（L334–347）；`sendPrivateMsg` 成功后**才**写 `pushed.json`（L367–372） |
| L366 | `rt.lastPush` | 面板展示最近一次推送结果 |

### 2.8 离场结算 `finishRecap(rec, why, shots, sample)`（L381–538）

调用方不 `await`（L557、L530 等），内部流水线：

| 行号 | 阶段 | 细节 |
| --- | --- | --- |
| L386 | 收笔 | `rec.close()` 固定 `endedAt`（只认第一次） |
| L388–459 | ① 评分 | 条件链：`ratingEnabled` 且 `sample` 存在；`liveSec < 60` 不打分（L393）；`!sample.onlineKnown` 不打分（L396）；`online < 20` 不打分（L400）；否则算 `dpm`、`speakers`、`fansPresent`、`seenCount`、`attentionGain`、`fanGain`（L406–416）→ `computeScore(..., buildWeights(cfg.ratingWeights))`（L417–420）→ `moderator.judge(rec)`（L427）→ 有扣/加分时改最终分并保留 `rawScore`（L428–434）；日志含各维度「相对同规模 ×倍」（L438–445） |
| L461–526 | ② 写笔记 | 条件 `recapEnabled && (rec.size >= recapMinDanmaku || speechSize > 0)`（L464–465）；`llm.available` 时组装 prompt（L468–501）：时间/时段显式喂入（L470–480、L500）、语音摘要 40 段（L469）、画面附件最多 `visionShotsInRecap` 张（L470）、`maxTokens 10000 / timeout 90s`（L506–507）；按 `【大肥鱼的评价】` 拆分正文与评价（L510–517）；`writeRecap` 落盘（L520）→ `rt.lastRecap`（L521）；模型不可用则 `summary=''` 走本地统计版 |
| L528–531 | ③ 推送 | 仅 `rating && rec.random && rating.score > cfg.ratingPushScore`；异常只记日志 |
| L533–537 | ④ 清理 | `clearRoomTmp(home, rec.roomId)` 删本场切片/截图 |

### 2.9 离开直播间 `stopWatching(why, opts)`（L540–558）

顺序：清 `rotateTimer` → `client.stop()` → `stopAudio` → **先快照 `rt.vision.shots`**（L549–550，注释说明顺序坑）→ `stopVision` → `stopRating` → 清 `rt.current`/`rt.recorder` → 非 `silent` 时 `finishRecap(...)`（不 await、异常吞掉）。`silent` 只在插件卸载时用（L1443）。

### 2.10 音频链路（L560–622、L717–766）

| 行号 | 符号 | 说明 |
| --- | --- | --- |
| L565 | `audioDir` | `<home>/tmp/live` |
| L568–576 | `ensureAsr()` | 懒创建**全局唯一** `AsrWorker`（python=`findPython(cfg.asrPython)`，model=`cfg.asrModel`） |
| L578–586 | `stopAudio(why)` | 停 tap + `asr.cancelPending(why)`（作废旧房间排队转写） |
| L589–622 | `startAudio(roomId, cred)` | 开关 `listenAudio`；同房间且 `sliceMs` 未变则 no-op（L592）；重建时保留计数（L594–619）；`AudioTap.onSegment → handleSegment` |
| L717–766 | `handleSegment(seg, roomId)` | 房间校验（L719）→ `transcribe`（超时预算 `max(45s, sliceMs*3)` L727）→ 计数/`lastText`（L729–733）→ `rec.addSpeech` + `handleSpeech`（L736–740）；异常分类：正常丢弃只 log（L744–745），超时计数 ≥3 且模型非 small 时**自动把 `cfg.asrModel` 改为 small 并写盘**（L748–759）；`finally` 按 `audioKeepFiles` 删分片（L763–765） |

### 2.11 画面链路（L624–714）

| 行号 | 符号 | 说明 |
| --- | --- | --- |
| L629 | `shotDir` | `<home>/tmp/shots` |
| L631–637 | `stopVision(why)` | 停 tap；不删 shots（留给结算） |
| L642–678 | `grabFrame(flv, jpg)` | spawn `tools/grab_frame.py`；参数走 stdin JSON `{path, maxWidth:960}`（中文路径坑，注释 L640–641）；stdout 收 JPEG 字节、stderr 最后一行当元信息；退出后删 flv |
| L680–699 | `startVision(roomId, cred)` | 开关 `visionEnabled`；同房间且 `intervalMs` 未变则 no-op（L683）；重建保留已截 shots（L685） |
| L701–714 | `handleShot(s, roomId)` | 房间/身份校验 → 超上限丢弃 → `grabFrame` → `rt.vision.shots.push({at,file,w,h,bytes})` |

### 2.12 语音关键词触发（L768–824）

`hitKeyword`（L769–775）：`cfg.audioKeywords` 中长度 ≥2 的子串匹配，返回命中的词。`handleSpeech`（L778–824）：先 `log` 命中（一直记，不因开关停记）→ 需 `audioReply && autoReply && username`（L782）→ `rollDay` + `dailyLimit` + `audioReplyCooldownMs`（L783–786）→ 有凭证（L787–788）→ 有模型则带最近 12 条弹幕和 10 段语音生成（L790–808），否则 `fixedReply` 用模板（L809）→ `clipText` → `sendDanmaku`（L813）→ 成功更新 `audioLastReplyAt`、`lastReplyAt`、`replyCount`、`saveState`（L814–819）。

### 2.13 弹幕识别与回复（L826–906）

| 行号 | 符号 | 说明 |
| --- | --- | --- |
| L827–836 | `isCallingMe(text)` | `cfg.username + cfg.aliases`（长度 ≥2）做小写子串匹配；`@+name` 也是子串，实质同一逻辑。@ 不带结构化字段，误判可能（README 边界也承认） |
| L842–863 | `freeReply(d, info)` | 带最近 24 条弹幕做上下文，`maxTokens 80 / timeout 15s`；失败返回 `''` |
| L866–906 | `handleDanmaku(d, roomId, info)` | 开关/昵称检查（L867）→ 忽略自己 UID（L868，`rt.myUid` 在 tick L1050 设置）→ `isCallingMe`（L869）→ `rollDay`+`dailyLimit`（L871–873）→ 每房间 `cooldownMs`（L874–875）→ 首次用 `introTemplate`（L877–882），之后模型自由回复、失败退回 `fixedReply`（L883–888）→ `clipText(maxLen)`（L889）→ 凭证→`sendDanmaku`（L892–894）→ 成功写 `introDone/lastReplyAt/replyCount` + `saveState`（L895–900） |

### 2.14 换台计时（L908–931）

- `rotateNow()`（L909–914）：日志「巡场看够 N 分钟」→ `stopWatching` → `tick()`。
- `armRotateTimer()`（L921–931）：清旧 timer；**仅 `rt.current.random` 时有效**；起点是 `rt.current.since`；`wantMs` 下限 60 秒；已超时就当场 `rotateNow()`；定时器 `unref`。
- 设计意图（注释 L916–920）：改设置也按新时长重算，所以 `/config` 会再调它（L1209）。

### 2.15 `watch` / `randomTour` / `tick` / `schedule`（L933–1109）

| 行号 | 函数 | 关键流程 |
| --- | --- | --- |
| L934–1001 | `watch(stream, info, opts)` | 解析 `realRoomId`（L935）→ 无凭证直接返回（L937–938）→ `new LiveRecorder`（L940–946）→ `noteMedal` ＝ 记录见过/挂牌（L949–954）→ `new DanmakuClient`：`onDanmaku` 计数+记牌+`recorder.push`+`handleDanmaku`（L959–964）、`onEvent` 解析进房/封禁（L966–972）、`onStatus` 带连接身份防串台（L974）、`onLog`（L975）→ 设 `rt.recorder`/`rt.current`（L977–988，`random` 标记决定是否推送）→ `await client.start()`（L992）→ `startAudio` / `startVision` / `startRating`（L993–996）→ `opts.random` 时 `armRotateTimer`（L997–1000） |
| L1008–1029 | `randomTour(cred, reason, opts)` | 已在随机房且非 force 直接 false（L1009）→ 有当前房先 `stopWatching`（L1010）→ `getRandomLiveRooms({want:60, keywords})`（L1011）→ 三层池：未看过的命中房 → 未看过的其他房 → 兜底全部（L1014–1021）→ 随机选、记录最近 12 间（L1022–1023）→ `getRoomInfo` 复核 `liveStatus===1`（L1024–1025）→ `watch(..., {random:true})` |
| L1032–1103 | `tick()` | `rt.busy` 防重入（L1033）→ `sweepTmp` 兜底清 6 小时+残留（L1038–1041）→ `!cfg.enabled` 停看返回（L1042）→ 无凭证停看返回（L1044–1049）→ 更新 `rt.myUid`（L1050）→ 随机房到点兜底换台（L1053–1061，防睡眠丢定时器）→ 优先级关闭时 `targets=[]`（L1064–1065）→ 无目标走随机（L1066–1070）→ 按数组顺序逐个查 `getRoomByUid`/`getRoomInfo`，第一个 `liveStatus===1` 即选中（L1072–1080）→ 全没播：`randomWhenNoneLive` 则随机、否则停看（L1082–1091）→ 已在同房间则不动（L1093–1094）→ `stopWatching('切到优先级更高的直播间')` + `await watch(...)`（L1095–1096）；异常写 `lastError`、`finally` 清 busy（L1097–1102） |
| L1105–1109 | `schedule()` | 重设 `setInterval(tick, cfg.pollMs)` + `unref`；`/config` 改轮询时调用（L1206） |

> 「下播检测」的真实口径：**优先级模式**靠下一轮 `tick` 逐个查 `liveStatus` 间接发现（L1072–1089，`randomWhenNoneLive` 打开时会以 `randomTour` 方式离开当前房）；**随机巡场**没有主动轮询当前房的 `liveStatus`，`DanmakuClient.onStatus`（`connected/closed/error`）只更新面板（L974），不触发离场——主播下播后要么等下一位优先级主播开播/下一轮 tick，要么等 rotate 定时器到点（最多 `randomWatchMs`），要么手动 `/stop`。定制「准点离场」时应补一条：`tick` 里对 `rt.current` 主动查一次房况。

### 2.16 HTTP 路由清单（`handle`，L1129–1419）

匹配方式：先 `new URL` 取 pathname、去尾部 `/`（L1130–1131），然后**逐条 `path.endsWith(...)` + method 判断**，命中即返回，末尾 404（L1418）。因为路由以 `kind:'prefix'` 挂在 `/api/bili-live` 下，`endsWith` 使 `/api/bili-live/任意/status` 也能命中（见风险 §6-7）。

| 行号 | Method + 后缀 | 作用 | 请求 → 响应要点 |
| --- | --- | --- | --- |
| L1133–1199 | `GET /status` | 设置页主轮询接口 | 无 body → 大对象：`ok/version/home/loggedIn/login/config/defaults/llm/current/recording/audio/vision/lastRecap/rating/weights/ratingWeights/lastPush/pushed/recaps/recapDir/received/lastCheckAt/lastError/state/logs`；同时 `rollDay`、触发表情检查 `checkCredAlive` |
| L1201–1236 | `POST /config` | 改配置（局部 patch） | body 任意字段 → `mergeConfig`+`Object.assign`+`saveCfg`→`schedule`→`armRotateTimer`→按新开关启停音频/画面/ASR、必要时踢 `tick`；回 `{ok, config}` |
| L1238–1243 | `POST /pushed/clear` | 清空推送判重表 | → `{ok, cleared, pushed:{count:0,list:[]}}` |
| L1245–1261 | `POST /resolve` | 房间号/UID 解析成主播记录 | `{mid?, roomId?}` → `{ok, stream, info:{uname,title,liveStatus,realRoomId}}`；失败 `{ok:false,error}` |
| L1263–1266 | `POST /tick` | 手动触发一次检查 | 无 body → `{ok, current, lastError}`；**若 tick 正忙会立即返回旧状态** |
| L1268–1272 | `POST /stop` | 离开当前这一场（不关总开关） | → `{ok:true}` |
| L1274–1312 | `POST /switch` | 手动切台 | `{mode:'random'}` 或 `{key:房间号/UID}`；`rt.busy` 时拒绝；key 先当房间号再当 UID；手动进房按 `random:true` 处理（会打分、到点换台）；回 `{ok,current,lastError}` |
| L1316–1326 | `POST /login/qr` | 生成扫码登录二维码 | → `{ok,key,svg}`（`vendor/qrcode.js` 渲染） |
| L1328–1354 | `POST /login/poll` | 轮询扫码结果 | `{key}` → 未好 `{ok,status,message}`；成功则 `whoAmI`、`saveOwnCred`、重置 `credAlive`、若昵称为空自动填 `cfg.username`（L1344–1347）、`tick`；回 `{ok,status:'ok',uname,mid}` |
| L1356–1364 | `POST /logout` | 退出登录 | 删 `credential.json`、写 `logged-out.json`、清二维码/凭证活性；**不会立刻 stopWatching**（等下一轮 tick） |
| L1368–1384 | `POST /llm-test` | 模型连通性自测 | 生成「收到」，`maxTokens 600 / timeout 30s` → `{ok,text,error,ms,...route()}` |
| L1387–1397 | `POST /send-test` | 当前房间手动试发弹幕 | `{text?}` → `sendDanmaku`，回 `{ok,text,room,uname,error,code}`；无人/无凭证直接拒绝 |
| L1399–1401 | `GET /records` | 最近笔记列表 | → `{ok, dir, files: listRecaps(home,40)}` |
| L1403–1416 | `POST /open-folder` | 系统文件管理器打开 `recaps/` | 按平台 `explorer.exe/open/xdg-open`，detached spawn → `{ok,dir}` |
| L1418 | 其他 | 404 | `{ok:false,error:'unknown METHOD path'}` |

> 勘误：任务背景里提到的 `/api/bili-live/logs` 在本版源码中**并不存在**。日志只有两处出口：`GET /status` 的 `logs` 字段（最近 30 条，L1197）和家目录 `live.log`；内存环形上限 `MAX_LOGS=60`（L52）。定制若要单独的日志接口，需在 `handle` 里新增。

`checkCredAlive`（L1113–1128）：内存缓存 `{at, alive, name}`，每 10 分钟最多问一次 `whoAmI`；成功后若昵称变化自动回写 `credential.json`。它**只由 `/status` 触发**，不后台跑。

### 2.17 路由注册与收尾（L1421–1448）

| 行号 | 内容 |
| --- | --- |
| L1421–1433 | `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/api/bili-live', handler: 包装 handle}))`；注册失败只 log，插件其余部分继续运行 |
| L1425–1429 | 包装层 try/catch：异常统一 `sendJson(500, {ok:false,error})` |
| L1435–1436 | `schedule()` + 启动日志（家目录/版本/关注数/轮询间隔） |
| L1438–1439 | `setTimeout(tick, 3000)`（注释：别和其它插件抢启动），句柄未保存、`unref` |
| L1441–1447 | 卸载 effect：清轮询、静默停看、停音频/画面/ASR |

---

## 3. 主循环 / 状态机（文字版）

**大状态机（顶层）**：`idle` ⇄ `watching-{priority|random}` → `leaving`（`stopWatching`）→ `settling`（`finishRecap`，异步）→ 回 `tick` 选下一台。
- 进入路径：`tick` 优先级命中（L1073–1096）、`randomTour`（L1027）、`/switch`（L1303）。
- 离开路径：`tick` 检测到更高优先级/同房不变（L1094–1096）、随机到点（L1053–1061 / `rotateNow` L909）、手动 `/stop`（L1270）、`/config` 关闭总开关（L1210）、`/config` 改开关时只停采集不停看（L1225–1234）、插件卸载（L1443）。
- 结算在离开后**异步**跑，不阻塞下一台进房。

**时间常量**（定制时全局搜这些数字）：

| 值 | 位置 | 含义 |
| --- | --- | --- |
| `60000` / 20s–600s clamp | `pollMs` 默认；config.mjs L86、L208 | 开播检查轮询 |
| `90000` | L253 | 直播中评分采样间隔 |
| `60000`（60 秒） | L393 | 少于 60 秒不打分 |
| `MIN_ONLINE=20` | L379 | 同接低于 20 不打分 |
| `3000` | L1438 | 启动后首查延迟 |
| `10 * 60 * 1000` | L1117 | 凭证活性检查节流 |
| `30 * 24 * 3600 * 1000` | L339 | 推送判重窗口 |
| `1800000`（30 分钟） | config.mjs L57；L925/L1054 兜底 | 随机巡场单台时长上限 |
| `60000` | L910/L925 | 巡场时长的下限（防止设 0） |
| `15s/60s/90s` | config.mjs L95、L109；L320、L507 | 音频切片 / 语音冷却 / 模型超时 |

**弹幕回复判定链**（`handleDanmaku`）：`autoReply && username` → 非自己 → `isCallingMe` → 跨天重置 → `replyCount < dailyLimit` → 房间冷却 → 首次自我介绍 / 自由回复 → `clipText` → 发送成功才计数落盘。
**语音回复判定链**（`handleSpeech`）：关键词命中（长度 ≥2 子串）→ `audioReply && autoReply && username` → 每日额度（**与弹幕共用**）→ 语音冷却 → 模型/模板 → 发送成功计数。
**评分采样**：进房 `take()` 一次 + 90s 周期；峰值取 max，付费分子分母取同次采样；`stopRating` 时算 `fanGain`（结束−开场，负记 0）。
**结算流水线**：`rec.close` → 评分（门槛判断）→ 恶意审核改分 → 模型写笔记（可选语音/画面）→ 高分推送（仅随机房）→ 清理本场 tmp。

---

## 4. 关键符号 → 行号索引（定点修改用）

### 4.1 常量 / 变量 / 内存态

| 符号 | 行号 | 说明 |
| --- | --- | --- |
| `name` / `inject` | L49 / L50 | 插件声明 |
| `MAX_LOGS` | L52 | 内存日志上限 60 |
| `home` / `cfgFile` / `stateFile` / `pushedFile` / `logFile` | L103–107 | 家目录与文件 |
| `ownCredFile` / `loggedOutFile` | L150 / L152 | 凭证与退出标记 |
| `qrLibFile` | L177 | `vendor/qrcode.js` |
| `cfg` | L117 | 清洗后配置；全闭包共享可变对象 |
| `state` | L119–124 | 日报/介绍状态 |
| `logs` | L130 | 环形日志数组 |
| `rt` | L180–194 | 运行态总容器 |
| `rt.current` | L181、L980–988 | 当前房间；`random` 决定是否推送 |
| `rt.recorder` | L182、L940/L977 | 当前 `LiveRecorder` |
| `rt.rating` | L215（动态） | `{best, firstAttn, firstFansClub, lastFansClub, timer}` |
| `rt.vision` | L696（动态） | `{tap, roomId, shots, dropped, startedAt}` |
| `rt.audio` | L611–620 | `{tap, roomId, transcribed, chars, dropped, lastText, startedAt}` |
| `rt.asr` | L191、L568–576 | 全局唯一 `AsrWorker` |
| `rt.recentRooms` | L1016/L1023（动态） | 最近 12 间，防重复巡场 |
| `rt.lastPush` / `rt.lastRecap` | L366 / L521 | 面板展示 |
| `credAlive` | L1113 | 凭证活性缓存 |

### 4.2 函数

| 符号 | 行号 | 一句话职责 |
| --- | --- | --- |
| `stateDirOf` | L54–68 | 解析并创建家目录 |
| `readJson` / `writeJson` / `dayKey` / `sendJson` / `readBody` | L70–100 | 工具层（失败静默） |
| `apply` | L102–1448 | 全部宿主逻辑 |
| `startRating` / `stopRating` | L213–255 / L258–267 | 90s 采样 / 交峰值与增量 |
| `shotRefs` | L273–296 | 抽帧→附件引用 |
| `describeAnchor` | L302–323 | 主播风格评价（仅推送时） |
| `pushHighlight` | L326–374 | 高分私信 + 30 天判重 |
| `finishRecap` | L385–538 | 离场结算总流水线 |
| `stopWatching` | L541–558 | 停采集 + 异步结算 |
| `ensureAsr` / `stopAudio` / `startAudio` | L568–576 / L578–586 / L589–622 | ASR 生命周期 |
| `stopVision` / `grabFrame` / `startVision` / `handleShot` | L631–637 / L642–678 / L680–699 / L701–714 | 画面采样链路 |
| `handleSegment` | L717–766 | 一片音频：转写→记录→关键词 |
| `hitKeyword` / `handleSpeech` | L769–775 / L778–824 | 语音触发回复 |
| `isCallingMe` / `freeReply` / `handleDanmaku` | L827–836 / L842–863 / L866–906 | 弹幕触发回复 |
| `rotateNow` / `armRotateTimer` | L909–914 / L921–931 | 巡场换台计时 |
| `watch` | L934–1001 | 进房：弹幕客户端+三路采集 |
| `randomTour` | L1008–1029 | 随机巡场选台 |
| `tick` | L1032–1103 | 一次开播检查/切台/兜底 |
| `schedule` | L1105–1109 | 轮询定时器 |
| `checkCredAlive` | L1114–1128 | 10 分钟节流验凭证 |
| `handle` | L1129–1419 | HTTP 路由分发 |
| 路由注册 / 启动 / 卸载 | L1421–1433 / L1435–1439 / L1441–1447 | DSH 生命周期挂载 |

---

## 5. 定制入口（想改什么 → 改哪里）

| 想做的事 | 首选改动点 | 备注 |
| --- | --- | --- |
| 改轮询频率 / 巡场时长 / 每晚回复上限 | `cfg.pollMs`（config.mjs L86）、`cfg.randomWatchMs`（L57）、`cfg.dailyLimit`（L44） | 设置页可改；`schedule()` L1105 重设定时器，`armRotateTimer` L921 重设换台 |
| 改评分门槛 / 小房间不评分策略 | `MIN_ONLINE` L379；`finishRecap` 条件链 L393–405 | 纯硬编码，需要动 index.js |
| 改评分采样频率或峰值口径 | `startRating` L213–255（90000）、`stopRating` L258–267 | 采样字段在 lib/rating.mjs，指数口径也在那边 |
| 改推送阈值 / 目标 / 文案 / 去重窗口 | L326–374；触发条件 L529；prompt L305–315 | 只有 `rec.random` 才推；成功才写 pushed.json |
| 改 @/别名识别规则 | `isCallingMe` L827–836 | 当前是纯文本子串；要认结构化 @ 需改 lib/live.mjs 解析并在 `onDanmaku` 里传字段 |
| 改自我介绍 / 固定回复 / 自由回复人设 | L877–887（intro/固定）、`freeReply` L842–863、语音侧 L790–809 | 文案在 config.mjs L40、L28 |
| 加/改笔记内容与格式（txt→md/json） | `finishRecap` 组装 prompt L461–526；落盘改 `lib/recap.mjs` 的 `writeRecap/toText`（L360+） | index.js 只传 `summary/aiWords/rating/online` 四个值，扩展字段要两边一起改 |
| 加/改 HTTP 接口 | `handle` L1129–1419；注册前缀 L1424 | 路由是 `endsWith` 匹配，新路由注意顺序；建议在 404 前加 |
| 加配置项 | `lib/config.mjs` 的 `DEFAULTS`（L11–135）+ `normalizeConfig`（L169–230）；`/status` 的 `defaults` 自动带出（L1149）；`client.js` 设置页加控件 | `mergeConfig` 只合并 `DEFAULTS` 里出现的键（L237–239），漏改 config.mjs 会导致前端传了也被丢弃 |
| 换模型 / 固定模型路由 | `cfg.llmProvider/llmModel`（config.mjs L33–34）+ `lib/llm.mjs` 的 `resolveRoute` L39–61 | 默认跟随宿主 `agentDefaultModel`；API 返回 `llm.route()` 可观测 |
| 换 ASR 模型/解释器/语言/分片 | config 字段 `asrModel/asrPython/asrLang/audioSliceMs`；`ensureAsr` L568、`handleSegment` L724–727 | 连续超时自动降 small 并写盘（L748–759），定制时注意这个副作用 |
| 改抽帧间隔/上限/清晰度 | config `visionIntervalMs/visionMaxShots`；`startVision` L680、`handleShot` L701 | 视频流 qn 由 `lib/vision.mjs` getUrl 决定（默认 150） |
| 改清理策略 | `clearRoomTmp` L535；`sweepTmp` L1039；`lib/cleanup.mjs` 的 6 小时上限 | 本场结束删本房文件；孤儿兜底 |
| 换/加直播平台 | `tick` 的查询 L1072–1080、`randomTour` L1011、`watch` L956–976 | 抽象点在 lib/live.mjs；index.js 耦合了 `liveStatus/realRoomId/uid` 等字段 |
| 改设置页展示/文案/页面 | `client.js`（另见 04 笔记）；`/status` 结构 L1137–1198 | 面板数据全靠 `/status` |
| 加持久化字段 / 重启恢复 | state 初始化 L119–128、`saveState` L139、`rollDay` L140 | 当前只持久化回复相关状态；`rt.recentRooms`、评分峰值等重启即丢 |

---

## 6. 风险与坑

1. **内存态是唯一真相**：`rt`、`LiveRecorder` 里所有弹幕/语音/评分/画面都只在内存；`state.json` 只存回复计数和介绍标记。进程退出/崩溃/DSH 关闭，当前场直接丢（README L188 也承认）。插件卸载走 `silent`（L1443）是故意不写半截笔记。
2. **结算 fire-and-forget**：`finishRecap` 在 L557/L530 等处不 `await`，失败仅 `log`；结算与下一场 `watch` 并行，切换很快时可能有两场结算同时跑（多份 LLM 调用/多份 tmp 清理），没有互斥。`stopWatching` 已置空 `rt.current/recorder`，回调靠 `roomId`/对象身份校验（L703、L719、L974）防串台。
3. **定时器/子进程清理不完整**：轮询与 rotate/评分定时器都 `unref` 且大多在卸载时清理；但 L1438 的 3 秒 boot 定时器**没有句柄、卸载不清**（极端情况下插件已卸载仍会 `tick`）；`grabFrame` 的 python 子进程（L647）没有登记/`kill`，卸载时可能留孤儿；进行中的 `tick` 不可取消。
4. **`tick` 半初始化卡死风险**：`watch` 先设 `rt.current`（L980）再 `await client.start()`（L992）。若 start 抛错，`rt.current` 已存在且 `random` 已标记；下一轮 `tick` 若优先级选中同房会因 L1094 直接返回，随机房则 `randomTour` 因 L1009 返回 false，要等 30 分钟兜底才换台。定制时建议把 `rt.current` 赋值移到连接成功之后或加失败回滚。
5. **`rt` 动态键无统一初始化**：`rt.rating/vision/lastPush/recentRooms/asrTimeouts` 都是运行中挂的，类型与清理点分散；新增状态建议先补进 L180–194 并想好卸载清理。
6. **异常大面积静默**：`readJson/writeJson/log/saveState/saveCfg`、`finishRecap.catch(()=>{})`、`take().catch`、`onDanmaku(...).catch(()=>{})`（L963）、`/config` 各 `try/catch` 都会吞错；可观测性只有内存日志 60 条 + `live.log`。磁盘满/权限问题时状态可能静默丢。
7. **HTTP 路由无鉴权 + `endsWith` 宽松匹配**：`handle` 不校验来源/Origin/CSRF，也**不校验 `Content-Type`**；`/config`、`/logout`、`/send-test`、`/open-folder` 都是状态变更 POST。默认只绑 loopback（DSH webServer 配置），但本机任意进程/网页若能把请求打到 127.0.0.1:3080，可改配置、发弹幕。定制版若要暴露局域网，必须先加 token/Origin 校验。
8. **凭证安全**：`credential.json` 明文存 `SESSDATA/bili_jct`（L160–171）；`/status` 会回传 `home`、`uid`、`uname`、完整 config（含关注名单）——别把该端口暴露出去。`saveOwnCred` 每次扫码/改名重写，注意权限。
9. **配置系统的隐藏坑**：`mergeConfig` 只认 `DEFAULTS` 的键（config.mjs L237–239），未知字段静默丢弃；`normalizeConfig` 强制 `freeReply: true`（config.mjs L179）不可关；`lib/llm.mjs` L87 引用了 `cfg.llmEnabled`，但 `DEFAULTS` 里没有这个键 → **这个开关永远无法配置/生效**（死代码）。
10. **自动改配置的副作用**：ASR 连续 3 次超时把 `cfg.asrModel` 改成 `small` 并 **`saveCfg()` 落盘**（L748–759），用户设置被悄悄改写；`/login/poll` 成功且昵称为空时自动填 `username`（L1344–1347）。定制时要决定是否保留。
11. **跨天/时区逻辑**：`dayKey()` 固定 +8h 北京时间（L78–81）；`rollDay` 只在 `/status`、弹幕/语音回复时触发（L1134/L871/L783），长期无事件时 `replyCount` 会保持旧值直到下次事件才重置——逻辑上没错，但面板显示可能滞后。
12. **状态文件无限增长**：`state.introDone` 按房间只增不减、`pushed.json` 不修剪（只按 30 天忽略）、`live.log` 无轮转；长期挂机需自行加清理。
13. **LLM 内容不可信**：弹幕文本、语音转写会直接塞进 prompt（L793–800、L851–852、L490–492），存在 prompt injection/被带节奏风险；模型回复又直接发到直播间。另外恶意审核 prompt 也吃弹幕（moderation.mjs），解析失败就按 0 处理。定制时建议对模型输出做更强约束（长度、敏感词、失败静默）。
14. **成本不受全局预算约束**：笔记单次 `maxTokens 10000` + 最多 6 张图；`describeAnchor` 1200；弹幕/语音回复各 80；`/llm-test` 600。长时间挂机 + 高频换台时 token 可能超预期；README 给了估算，但代码没有日预算。
15. **`/status` 很重**：每次携带完整 `config/defaults/weights/logs(30)/recaps(8)/pushed(12)`，前端若高频轮询会产生可观序列化开销；且 L1163 调了两次同步 `findPython`（6 个路径 `existsSync`）。
16. **模型/服务缺失的降级是静默的**：无 `attachments` 时画面不进总结（L277）；无 `llm` 时笔记退本地统计、回复退模板；`ctx.get` 全 try/catch——功能缺失只会体现在日志里。
17. **与 DSH 生命周期耦合**：`inject` 只声明 `webServer`，`llm/attachments/dshHomePath` 都是懒取 + 容错；路由注册失败插件继续跑（L1431–1433），此时设置页完全不可用；`ctx.effect` 是唯一正确的注册/清理通道，定制时新增的监听/定时器都应包进 `ctx.effect`。
18. **`/logout` 不立即停看**：只删凭证和置标记（L1356–1364），当前房间要等下一轮 `tick`（默认最多 60 秒）才 `stopWatching`；期间弹幕客户端仍在读、回复因无凭证失败。
19. **前端契约同步风险**：`/status` 字段被 `client.js` 直接消费；任何字段改名/删减都会静默破设置页（无 schema/版本协商）。定制时优先**只加不改**。
20. **时间戳口径混杂**：`log` 用 UTC `ISO.slice(11,19)`（L132）、`dayKey` 用北京时间、`recap` 文件名用本地时区（lib/recap.mjs）；跨时区机器上排查日志会对不上。

---

## 7. 修改前建议（给后续定制）

- 先读 `lib/config.mjs` 的 `DEFAULTS`（唯一配置真源）与 `client.js` 设置页，再决定「加配置项」还是「硬编码改造」。
- index.js 改动尽量集中在：`finishRecap`（结算）→ `watch/stopWatching`（生命周期）→ `handle`（API）三段；其余是采集细节。
- 任何新增的定时器/子进程/事件监听，都放进 `ctx.effect` 的清理闭包（L1441–1447 风格），否则插件热重载会重复堆叠。
- 新增运行态优先补进 `rt` 初始化（L180–194）；新增持久化优先扩 `state.json`（L119–128/L139）。
- 改评分/推送/审核相关逻辑时同步检查 `/status` 面板字段与笔记 `extra`（L520），否则设置页或笔记会出现空值。
