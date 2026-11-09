# 02 · 媒体采集链路解读（live / audio / asr / vision / tools）

> 只读分析，基于当前工作区源码。行号以各文件当前版本为准。本笔记只覆盖「采集 / 转写 / 抽帧」链路；评分、笔记、UI 见其它笔记。

## 0. 链路总览

**三条采集路径彼此独立**：弹幕走 WebSocket 长连接；声音、画面各自再拉一路 FLV HTTP 流（互不影响）。

```
index.js watch() ─┬─ DanmakuClient ── wss /sub（op 7/8/5/2）──> parseDanmaku/InteractWord/Block ──> 回调
                  ├─ AudioTap ── getPlayUrl(qn) ── FLV(type=8) ──> seg-*.flv ──> AsrWorker ──> 转写文本
                  └─ VisionTap ─ getPlayUrl(qn) ── FLV(type=9) ──> shot-*.flv ──> grab_frame.py(PyAV) ─> JPEG
```

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| lib/live.mjs | 702 | B站接口、WBI、房间查询、随机巡场、发弹幕/私信、弹幕 WS + PB 解析 |
| lib/audio.mjs | 255 | getPlayUrl、FLV 增量拆包、音频切片落盘 |
| lib/asr.mjs | 259 | faster-whisper 常驻子进程的宿主侧封装 |
| lib/vision.mjs | 140 | 画面流采样：攒 GOP → 落 flv 分片 |
| tools/grab_frame.py | 66 | FLV 分片 → 首帧 JPEG（PyAV + Pillow） |
| tools/asr_worker.py | 101 | 常驻转写进程（faster-whisper） |

- 依赖：Node ≥22（内置 WebSocket/fetch，package.json 32）；ASR 需本机 Python 环境装 faster-whisper；抽帧需 av + Pillow（README 147-165）。
- 上层编排全部在 index.js：imports 42-44；watch() 934-1001；startAudio 589-622；startVision 680-699；stopWatching 541-558；离场清理 finishRecap 533-537。

## 1. lib/live.mjs —— B站接口 + 弹幕长连接

### 1.1 公共约定

- `UA` 20、`LIVE_REF='https://live.bilibili.com/'` 21；`cookieOf` 24-31 只拼 `SESSDATA/bili_jct/buvid3/DedeUserID`；`headersOf` 33-38 加 UA/Referer/Cookie；`getJson` 40-44 **不检查 HTTP 状态**，非 JSON 时返回 `{code:-1,message:'非 JSON 响应…'}`（风控页/HTML 不会抛异常）。
- 凭证形状 `{sessdata,bili_jct,buvid3,dedeuserid}`，由 auth.mjs 产出（见笔记 04），本文件只读不落盘。
- `safeUid` 91-96：B站 uid 最长 18 位，超出 Number 安全整数就保留字符串；`getRoomInfo` 133 明确对 uid 不做 `Number()`（否则精度截断会查到别人）。

### 1.2 B站接口清单（除发送外均 GET，全部带 UA/Referer，可选 Cookie）

| # | 用途 | URL / 关键参数 | 返回/错误 | 行号 |
| --- | --- | --- | --- | --- |
| 1 | 主播 UID→房间 | `api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=` | `{roomId,liveStatus,title,uname,online}`；`code!=0` 抛错 | 111-122 |
| 2 | 房间号→真实信息 | `…/room/v1/Room/get_info?room_id=` | `{realRoomId,uid,liveStatus,title,uname,online}` | 125-139 |
| 3 | 主播昵称 | `…/live_user/v1/Master/info?uid=` | 只缓存成功结果（83 的 Map）；失败返回 '' | 98-108 |
| 4 | 弹幕服务器 | `…/xlive/web-room/v1/index/getDanmuInfo?id=<real>&type=0&web_location=444.8` + **WBI** | `{token,host_list[].host/wss_port}`；失败抛错（-352 即签名问题） | 282-291 |
| 5 | WBI 密钥 | `api.bilibili.com/x/web-interface/nav` | `data.wbi_img.img_url/sub_url` | 55-65 |
| 6 | 分区树 | `…/room/v1/Area/getList?parent_id=0` | `{id,name,list[{id,name}]}`，缓存 1h（145） | 147-163 |
| 7 | 巡场源① | `…/xlive/web-interface/v1/index/getList?platform=web` | 首页模块 + recommend_room_list | 207-213 |
| 8 | 巡场源② | `…/room/v1/room/get_user_recommend?page=1&page_size=6` | 6 条推荐 | 215-220 |
| 9 | 分区房间 | `…/room/v1/Area/getRoomList?platform=web&parent_area_id=&area_id=&sort_type=online&page_no=1&page_size=` | 列表；单请求失败静默跳过 | 226-251 |
| 10 | 发弹幕 | `POST api.live.bilibili.com/msg/send` | `{ok,code,message,data}` | 305-340 |
| 11 | 发私信 | `POST api.vc.bilibili.com/web_im/v1/web_im/send_msg` | `{ok,code,message}` | 358-399 |

### 1.3 WBI 签名（122 行文件头注释里点名的最大坑）

- `MIXIN_TAB` 48-51；`mixinKey` 55-65：`img`/`sub` 文件名去掉扩展名拼成 64 字符串，按表重排取前 32；`wbiCache` 53/56 **全局缓存 6 小时**。
- `wbiSign` 68-78：参数 append `wts`(秒) → 键排序 → `encodeURIComponent` → `qs + mixin` 求 MD5 → 返回 `…&w_rid=…`。目前只有 `getDanmuInfo` 用它（283）。
- 坑：缓存 key 提前失效时不会立刻刷新，只能等 6h TTL 或进程重启；`getDanmuInfo` 失败会被 DanmakuClient 当连接失败重连（仍用同一 key）。

### 1.4 房间查询与随机巡场 `getRandomLiveRooms` 182-280

- 签名默认 `{minOnline:100,maxOnline:600000,want:12,keywords:[]}` 182-185；`push` 187-205 过滤人气过低/过高、按 roomId 去重，归一字段 `{roomId,mid,uname,title,online,parent,area}`。
- `safeUid`/`getRoomInfo` 的 uid 字符串设计见 1.1；index.js 用 `mid` 走 `getRoomByUid`（含改名跟随），只有 roomId 时走 `getRoomInfo`（index.js 1075、1252、1291-1293）。
- 数据源：① 首页模块（覆盖虚拟主播/唱见/电台等）207-213；② 推荐位 215-220；③ 有关键词时翻分区 226-251——**父分区只固定返回最热 30 个**（注释 142-144），所以 9/1/5 三个区若子分区数在 3~12 就逐个取，10/2/3/6 只取父分区；每 6 个请求一批并发；单分区失败静默跳过。
- 关键词：`KW_PATTERNS` 168-176（日V 假名 / 新V / asmr / 3d麦 / 虚拟声优…）+ 小写 `includes`；两档排序 267-277：**强命中**（标题+主播名）→ **弱命中**（父/子分区名）→ 其它，三档内部各自 Fisher-Yates 洗牌 253-259，返回 `[...strong,...weak,...no].slice(0,want)`。没有关键词就纯洗牌 279。
- index.js 消费：`randomTour` 1008-1029 传 `want:60`，三层兜底（未看过的命中房→未看过的其它→全部），`recentRooms` 只记最近 12 间；进房前 `getRoomInfo` 复核 `liveStatus===1` 1024-1025。

### 1.5 发弹幕 / 私信（风控字段）

- `sendDanmaku` 305-340：先要求 `bili_jct`；form 字段 `color=16777215,fontsize=25,mode=1,msg,rnd=秒时间戳,roomid,bubble=0,csrf,csrf_token`；Referer 为 `live.bilibili.com/<realRoomId>`；错误码表 `SEND_ERR` 295-302（-101 未登录、-111 csrf、10030 敏感词、1003212 太快、1003211 禁弹幕、10031 风控）；**不抛异常**，一律 `{ok,code,message}`。
- 坑：`rnd` 是秒级时间戳而非随机数，同一秒发两条会相同；真正的限流靠 index.js 的 cooldown/dailyLimit（config.mjs 42-44）。
- `sendPrivateMsg` 358-399：先校验 `dedeuserid`→receiver 纯数字→**禁止给自己发**（21026，364）；form `msg[sender_uid]/[receiver_id]/[receiver_type]=1/[msg_type]=1/[dev_id]=固定串 371/[timestamp]/[content]=JSON{content}`，内容截断 800 字；错误码 `DM_ERR` 344-350（-400、21026、25005 不收未关注私信）。

### 1.6 弹幕长连接协议 `DanmakuClient` 593-702

- 包格式 `pack` 403-413：16B 头 = total(4) + headerLen=16(2) + ver(2) + op(4) + seq=1(4)，后接 body；`unpack` 415-435 按 total 循环，**ver=3 → brotli、ver=2 → zlib inflate**（node:zlib 18），递归拆到非压缩子包后 `{op,ver,body}`。
- 建连 `connect` 617-683：`getDanmuServer` 换 `wss://<host>:<wss_port>/sub` → **`binaryType='arraybuffer'`**（625，必须；否则 ev.data 是 Blob，注释 13-14）→ `onopen` 发鉴权包 `op=7` JSON `{uid,roomid,protover:3,platform:'web',type:2,key:token}` 630-637 → 开心跳。
- 心跳 `startHeartbeat` 685-690：每 30s 发 `pack(2,'')`；`stopHeartbeat` 692-694。
- 收包 641-659：字符串帧直接忽略；`op=8` → `connected=true,retry=0,status('connected')`；`op=5` → `parseMessages` 拆 JSON（先整体 parse，失败再按 `\0` 分隔，438-452）→ 先 `onRaw`（调试）→ `parseDanmaku` 命中 `onDanmaku`，否则整包交给 `onEvent`（进房/关注/封禁事件在这里二次解析）。
- 重连：`onclose` 663-673 若 `stopped` 直接返回（切台主动停不误报 status），否则 `retry++`、`wait=min(30s,1s*2^min(retry,5))`；建连异常 674-682 `wait=min(60s,2s*2^min(retry,5))`。只有收到 op=8 才重置 retry。
- 生命周期：`start` 612-615（不等待 op=8 就返回，index.js 随后立即启动音频/画面）；`stop` 696-701（置位、清心跳、close）。
- 坑：只取 `hosts[0]`（282-291），该 host 故障会反复重连同一台；重连的 setTimeout 未保存句柄，靠 connect 入口的 `stopped` 判断兜底。

### 1.7 PB 解码与事件数据结构

- `decodePB` 473-502：极简 protobuf 读取（varint / 长度前缀 / 递归 depth≤5），输出 `Map<"1.2.3", value>`；能按 UTF-8 打印的存字符串，否则继续往下拆，wire 5/1 只跳过。
- `parseInteractWord` 509-533：只认 `INTERACT_WORD*`；`data.pb` 是 base64 protobuf → `uid=f.1, uname=f.2, msgType=f.5`（1 进房/2 关注/3 分享/4 特关/5 互粉），粉丝牌名 `9.3||22.3.1`、主播 uid `9.1||22.3.10`、房间号 `9.12`；返回 `{uid,uname,msgType,medal:{level:0,name,anchor:'',upUid,roomId}}`。
- `parseDanmaku` 536-559：只认 `DANMU_MSG*`（**cmd 带后缀，必须前缀匹配**，537-538）；`info[1]` 文本、`info[2][0..1]` uid/uname、`info[3][1..4]` 牌子等级/名/主播名/房间号、`ts=info[0][4]`；返回 `{uid,uname,text,ts,medal|null}`。两个 parse 的 medal 字段集故意一致，各自有值就填。
- `parseBlockEvent` 566-574：`ROOM_BLOCK_MSG|USER` → `{uid,uname,operator,at}`；operator=1 表示房管/主播操作。
- `isOwnMedal` 582-587：`medal.roomId===本房` 或 `medal.upUid===主播uid` 即自家粉，供评分「粉丝浓度」去重统计。

## 2. lib/audio.mjs —— 音频拉流切片

### 2.1 getPlayUrl 34-65

- `GET …/xlive/web-room/v2/index/getRoomPlayInfo?room_id&protocol=0&format=0&codec=0&qn=<80>&platform=web&ptype=8&dolby=5`；**protocol=0 指 flv**（1=hls），注释 37-38 说明分片多，必要时才换。
- 取 `playurl_info.playurl.stream[]` 中 `protocol_name==='http_stream'` 的第一条 stream/format/codec/url_info，拼 `host+base_url+extra`，返回 `{url,codec,qn(current_qn),acceptQn}`；找不到抛「没有可用的 flv 流」。
- 只请求不校验清晰度：B站 可能返回其它 qn，实际以 `current_qn` 为准。音频用 `cfg.audioQn`（config.mjs 97 默认 80=流畅，clamp 80~10000）。
- 拉流请求只用 `headersOf(null)`（无 Cookie）——普通直播流免登录；受限/付费房间可能取不到。
- 上层传的是 **getUrl 回调**，每次重连都重新取一条新直链（AudioTap 192），直链过期可自愈。

### 2.2 FlvSplitter 73-133（增量 FLV 拆包）

- 内部 `buf` 拼接（109-132）；未对齐时 `#tryAlign` 80-106：首包以 `FLV` 开头则按 header 的 dataOffset（通常 9）再跳过 4B PreviousTagSize0，共 13B；中途接入则扫描 0/1/2 字节为 tag type（8 音/9 视/18 脚本）、dataSize(3B) 合法、时间戳扩展 3B 为 0；最多扫 8192B，还扫不到只留末尾 64B（累计 `dropped`）。
- 完整 tag = 11B 头 + dataSize + 4B prevTagSize；`ts` 由字节 4-6 与 `buf[7]<<24` 合成；输出 `{type,ts,raw}`，raw 含头尾。dataSize 上限 4MB，异常时重新对齐。
- 坑：undici 的 fetch body 吐的是 Uint8Array 不是 Buffer，push 111 已转 Buffer（源码注释点名踩过）。

### 2.3 AudioTap 146-255（生命周期与切片落盘）

- 构造 147-163：`getUrl/roomId/dir/sliceMs/onSegment/onLog`；sliceMs clamp 3s~60s、默认 10s（index.js 传 `cfg.audioSliceMs`，默认 15s，config.mjs 95）；stats `{segments,audioMs,bytesIn,reconnects,lastError}`。
- `start` 165-168 起循环；`stop` 170-174 置 stopped → abort → `#flush('stop')` 把最后不足一片的也写出去。
- `#loop` 176-189：pump 异常时 log「拉流断开…（3 秒后重连）」、`reconnects++`、sleep 3s 重来（重新 getUrl）。`#pump` 191-219：fetch 流式 for await，每 15s 查一次、90s 无数据 abort；只处理 `type===8`，AAC `AudioSpecificConfig`（`isAacSeqHeader` 136-138：`data[0]>>4===0x0a && data[1]===0`）单独存 `seqHeader` 不进分片。
- `#addTag` 221-227：首个 tag ts 记为 `segStartTs`，ts 差 ≥ sliceMs 就 flush；`#flush` 229-250 拼 `FLV_HEADER(21) + seqHeader + tags`，文件名 `seg-<roomId>-<Date.now()>-<seq>.flv`，同步 `writeFileSync`，回 `onSegment({file,audioMs,tags,bytes,reason})`；写盘失败只 log。
- 设计要点（注释 11-14）：分片必须从 tag 边界切且带 AAC 序列头，否则解码器打不开；丢视频 tag 只省磁盘**不省流量**，想省只能降 qn。
- 坑：`start()` 无防重入（VisionTap 有），重复 start 会有两条 pump；`stop()` 的末片回调在 index.js `stopAudio` 里因 `rt.audio=null` 先执行（index.js 578-586）而被丢弃删除。

## 3. lib/asr.mjs —— faster-whisper 常驻进程封装

### 3.1 环境发现

- `WORKER=tools/asr_worker.py` 16-17；`findPython` 20-35 顺序：配置 `cfg.asrPython` → env `BILI_LIVE_ASR_PYTHON` → `~/.dsh/bili-live/.venv-asr/{Scripts/python.exe,bin/python}` → `~/.dsh/bili-duty/.venv-asr/…` → `~/.dsh/bili-duty/.venv/…`；都没有返回 `''`（上层据此降级）。
- `defaultHfHome` 38-42：优先 `~/.dsh/bili-live/.hf-cache`；若 `~/.dsh/bili-duty/.hf-cache` 存在则复用后者。
- `available` 65-67 = python 非空 && worker 脚本存在。

### 3.2 启动与状态机 `start` 70-171

- 幂等：`ready` 直接 true、`starting` 复用同一个 Promise；启动前先 kill 上一轮遗留 proc（74-77，防止“幽灵”进程占 1GB）；不可用 → 写 `lastError` 并 `resolve(false)`。
- `spawn(python,[WORKER,model], {stdio:pipe, windowsHide, env:BILI_LIVE_HF_HOME+PYTHONIOENCODING=utf-8})` 93-97；stderr 只留末尾 12 行（106-113），exit 时取末 3 行拼错误（120-135）：`ready=false、proc=null、rl.close`，reject 所有 pending；启动阶段退出则 `done(false)`。
- stdout 用 readline 逐行 JSON（137-158）：`ready` 字段决定成功/失败；其它按 `id` 匹配 pending。
- **模型加载上限 90s** 161-168：超时 kill 进程并 `done(false)`。
- `stop` 251-258：先 `stdin.end('{"cmd":"quit"}\n')`，1.5s 后 kill；注意 stop 不会重置 `starting`/`lastError`，成功后 `lastError` 可能仍是旧值（仅展示层影响）。

### 3.3 进程间协议（stdin/stdout JSONL）

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| Node→py | `{"id":<n>,"path":"<绝对路径>","lang":"auto\|zh\|ja\|en"}` | 每段一行，196 行发送；worker 串行处理 |
| py→Node | `{"id":n,"ok":true,"text":"…","lang":"zh","sec":10.2,"ms":1200}` | 156 行 resolve |
| py→Node | `{"id":n,"ok":false,"error":"…"}` | reject，单条失败不影响进程 |
| py→Node | `{"ready":true,"model":"small"}` / `{"ready":false,"error":"…"}` | 启动握手 |
| Node→py | `{"cmd":"quit"}` | 优雅退出（255） |

### 3.4 transcribe 174-230：队列保护与超时策略

- 每次先 `await start()`；若进程刚好退出（stdin 不可写）自动重试一次（178-182）。
- **队列上限 maxQueue=2**：超限时丢弃“第二老”的一条，保留「正在处理 + 最新一片」，reject 并 `stats.dropped++`（186-195）。直播要实时，积压无意义。
- 超时 `timeoutMs`（默认 90s；index.js 传 `max(45s, 3*audioSliceMs)`，index.js 724-728）：超时删 pending、`consecutiveTimeouts++`；只有「自己是最后一条」或「连续 2 次超时」才 `stop()` 杀进程（204-209），否则只丢这一片——杀进程会连带排队的段，容易雪崩。
- `cancelPending` 233-238：切台时 reject 所有排队/在途（index.js stopAudio 584 调）。
- `status` 240-249：`available/ready/python/model/lastError + {count,totalMs,audioSec,dropped}`，供 /status 接口（index.js 1161-1164）。

### 3.5 降级路径

- `available=false`：index.js startAudio 597-600 只记一句 `lastError`、不启动音频；弹幕/画面/评分/笔记照常（README 160）。
- 转写失败：handleSegment 741-762 捕获；`/找不到音频文件|积压过多|取消这段转写/` 视为正常跳过，其余记「转写失败：…」。
- **连续 3 次超时且模型不是 small** → index.js 748-759 自动 `cfg.asrModel='small'`、saveCfg、停掉并重建 AsrWorker（机器带不动大模型的自愈）。
- 空文本算成功（transcribed+1），只是不触发关键词。

## 4. lib/vision.mjs + tools/grab_frame.py —— 画面采样

### 4.1 VisionTap 18-133

- 独立再拉一路 FLV（注释 5-6：不复用 AudioTap 的流，避免塞视频破坏音频分片；代价只是本地带宽）。构造 19-35：`intervalMs` clamp 10s~30min、默认 5min（config `visionIntervalMs`）；**`qn='150'` 硬编码，index.js 未传参（689），也没配置项**。
- `start` 37-43：`setInterval(()=>#emit('tick'), intervalMs)` + 循环拉流；`stop` 45-49 清 timer + abort。
- `#loop` 55-68 断流 log「画面流断开…（5 秒后重连）」；`#pump` 70-94 与 AudioTap 同构：fetch、90s watchdog、FlvSplitter、只处理 `type===9`。
- `#videoTag` 96-115：FLV video tag data 中 `data[0]` 高 4 位 frameType（1=关键帧，2=非关键帧）、低 4 位 codecId（只认 7=AVC）；`data[1]===0` 是 AVCDecoderConfigurationRecord → 存 `seqHeader`；`data[1]===1` 是 NALU；关键帧重置 `gop=[tag]`，非关键帧追加，`gopBytes>4MB` 时从头部丢 tag（113-114）。
- `#emit` 117-132：必须 `seqHeader && gop.length`；拼 `FLV_HEADER(video,15) + seqHeader + gop` 写 `shot-<roomId>-<Date.now()>-<seq>.flv`，回 `onSlice({file,tagCount,bytes,reason})`；**不重置 gop**（等下一个关键帧自然重置）。
- `isAvcSeqHeader` 136-138 与 `#videoTag` 内联判断重复，当前无调用方（冗余 export）；140 行 re-export `getPlayUrl`（index.js 实际从 audio.mjs 导入，未用到）。

### 4.2 抽帧进程（tools/grab_frame.py 1-66 + index.js grabFrame 642-678）

- **协议**：stdin 一行 `{"path":"…flv","out":"ignored","maxWidth":960}`（Node 只发 path/maxWidth，673）；成功 → stdout 二进制 JPEG、stderr 最后一行 JSON 元信息 `{ok,w,h,bytes,codec,source}`、exit 0；失败 → stderr 原因、exit 2（坏 JSON/缺 path）或 1（无视频流/解不出帧）。
- **实现**：`av.open` 28 → 必须有 video stream（29-31）→ `container.decode(video=0)` 取第一帧（34-37）→ 宽 > maxWidth 时 LANCZOS 缩到 960（43-46）→ RGB JPEG quality=85（47-48）→ stderr 元信息 51-59 → stdout JPEG 60-62。
- 为什么 stdin/stdout：中文用户名经 argv 传 python 会编码走样；python 子进程在沙箱里不能写插件家目录，必须由 Node 落盘（注释 5-7、index.js 640-641）。
- Node 侧 `grabFrame` 642-678：spawn、收集 stdout/stderr、exit 后 code!=0 或无 JPEG → 失败；成功则 Node `writeFileSync(jpg)`；**无论成败都删输入 flv**（653）；解析 stderr 末行元信息（坏了不影响出图）。**无超时、无 kill**。
- 节流：`handleShot` 701-714 若 `v.shots.length >= cfg.visionMaxShots`（默认 24，config.mjs 123）就删片丢弃；否则抽帧成功入 `v.shots`；离场时 stopWatching 先快照 shots 再 stopVision（549-551），总结时按 `visionShotsInRecap`（默认 3）喂给模型。
- 坑：GOP 超 4MB 从头裁剪可能把 I 帧丢掉（4.1 的 113-114），PyAV 解不出首帧 → dropped；抽帧 python 卡死无超时会挂住该次 handleShot（不阻塞其它异步任务）；画面路径固定 qn=150 无法从设置页调。

## 5. tools/asr_worker.py（101 行，常驻转写进程）

- 目的（注释 5-6）：WhisperModel 加载 3-4s，每片重启会浪费 1/3 时间；常驻后从 stdin 收路径、stdout 吐 JSON。
- 环境与镜像 26-30：`BILI_LIVE_HF_HOME` 或 `~/.dsh/bili-duty/.hf-cache`；`HF_ENDPOINT` 默认 `https://hf-mirror.com`；`HF_HOME`；`HF_HUB_DISABLE_XET=1`；22-23 强制 stdout/stderr UTF-8。
- 依赖：`faster_whisper`；缺依赖 → `{"ready":false,"error":"faster_whisper 不可用：…"}` + exit 1（40-44）；模型加载失败同样处理（46-51）。
- 模型参数 47：`WhisperModel(name, device='cpu', compute_type='int8')`——**只有 CPU 路径**，无 CUDA/半精度分支。
- 主循环 53-97：逐行 JSON；`{"cmd":"quit"}` 退出；path 缺/不存在 → `{"id",ok:false,error:"找不到音频文件"}`；语言策略 69-86：`zh/ja/en` 固定 `language` + 对应 `initial_prompt`（中文提示词带“打游戏和观众聊天”），其它（含 auto）`language=None` 自动检测且**不喂提示词**（注释 70-71：提示词会把语言拉偏）；`vad_filter=True`、`condition_on_previous_text=False`（78-81）；成功回 `text/lang/sec/ms`，异常回 `type: message`。
- 失败行为：单条失败继续循环；进程崩溃由 Node 侧 exit 处理并清 pending。

## 6. 对外 API、依赖图与失败降级

**依赖关系（箭头=import/调用）**

- index.js → live.mjs（DanmakuClient/getRoom*/getRandomLiveRooms/send*/parse*/isOwnMedal；`wbiSign` 仅 live.mjs 内部使用）、audio.mjs（AudioTap/getPlayUrl）、vision.mjs（VisionTap）、asr.mjs（AsrWorker/findPython）；**index.js 还直接 spawn tools/grab_frame.py**。
- audio.mjs → live.mjs（headersOf）；vision.mjs → audio.mjs（getPlayUrl、FlvSplitter）+ live.mjs（headersOf）→ Promise 回调 `onSlice` 交回 index.js；asr.mjs → tools/asr_worker.py（spawn）。
- 注意：**vision.mjs 本身不碰 PyAV**，抽帧进程由 index.js 的 `grabFrame` 编排——比“vision 模块内完成抽帧”的实现更解耦，换抽帧实现只改 grab_frame.py/index.js 两处。

**对外 API 速查**

| 模块 | API（行号） | 输入 → 输出 |
| --- | --- | --- |
| live | `getRoomByUid`(111)、`getRoomInfo`(125) | id+cred → 房间信息对象（失败抛 Error） |
| live | `getRandomLiveRooms`(182) | cred, opts → 房间数组（带 matched 标记） |
| live | `getDanmuServer`(282)、`DanmakuClient`(593) | 房间号 → token+url / 事件回调 |
| live | `sendDanmaku`(305)、`sendPrivateMsg`(358) | cred+目标+文本 → `{ok,code,message}`（不抛） |
| audio | `getPlayUrl`(34)、`FlvSplitter`(73)、`AudioTap`(146) | 房间号 → flv 直链 / tag 流 / 切片回调 |
| asr | `findPython`(20)、`defaultHfHome`(38)、`AsrWorker`(44) | 配置 → 解释器路径；`transcribe` → `{text,lang,sec,ms}` |
| vision | `VisionTap`(18)、`isAvcSeqHeader`(136)、getPlayUrl re-export(140) | 房间号 → flv 分片回调 |

**失败降级总表**

| 故障 | 表现 | 恢复/降级 |
| --- | --- | --- |
| B站 HTTP 接口失败 | `getJson` 返回 code=-1 或抛错 | 调用方 try/catch 记日志；巡场单源失败跳过 |
| 弹幕 WS 断线 | status('closed')，指数退避 | 1s×2^n，上限 30s（异常 60s），连上重置 |
| 切台主动停弹幕 | onclose 直接 return | 不误报“中断” |
| 音频流断/直链过期 | 3s 后重连并重新 getUrl；90s 无数据 abort | 自愈；下播后空转直到 stopWatching |
| 画面流断 | 5s 后重连 | 自愈 |
| 无 Python / worker 缺失 | `available=false`，`lastError` 提示 | 音频不启动，其余功能照常 |
| 转写超时/积压 | 丢单段（dropped++），连续 2 次超时才杀进程 | 连续 3 次超时自动降 small（index.js 748-759） |
| 抽帧失败 | dropped++、log 一行 | 总结不带图或少图，不失败 |
| 临时文件残留 | 正常离场 clearRoomTmp；每轮 tick sweepTmp 6h | cleanup.mjs 18-19/40-77，index.js 533-537、1037-1041 |

## 7. 定制入口（按目标定位）

| 想改什么 | 改哪里（文件:行） | 说明/注意 |
| --- | --- | --- |
| 音频清晰度/流量 | config.mjs:97,212 `audioQn`；index.js:604 | qn 80=流畅、150=高清、250+ 更高；B站 可能不认请求值；qn 越小越省流量 |
| 画面清晰度 | vision.mjs:19 `qn='150'` 硬编码；index.js:689 getUrl 透传 | 建议新增 `visionQn` 配置项（DEFAULTS+normalizeConfig+设置页），否则只能改源码 |
| 切片时长（延迟/准确率） | config.mjs:95,211；index.js:607；超时预算 index.js:727 | 越短延迟越小、切得越碎识别越差；超时随 sliceMs 走 |
| 换 ASR 模型 | config.mjs:99,213（tiny/base/small/medium）；asr_worker.py:39,47 | 默认 small；README 写 medium 是旧文档；大模型 CPU 慢，连续超时会自动降 small |
| 换语音语言/多语 | config.mjs:101,214；asr_worker.py:69-86 | 加语言：prompts 字典 + config 白名单 + 设置页选项；auto 下不要加 initial_prompt |
| 自建/替换转写后端 | 保持 asr.mjs 类接口（start/transcribe/cancelPending/stop/status/available）；index.js:568-576 ensureAsr 是唯一装配点 | 可以整包换云端 ASR；只要 `transcribe(file,{lang,timeoutMs})` 返回 `{text,lang,sec,ms}` |
| 改 ASR 进程协议 | asr.mjs:93-158（宿主侧） + asr_worker.py 全文 | 协议是简单 JSONL，可加字段（如热词、说话人分离）；Node 侧按 id 路由 |
| 相机/抽帧策略 | vision.mjs:24（interval）、96-115（GOP/序列头）、117-132（落盘）；config.mjs:121-127；grab_frame.py:43-48 | 想一次多帧/要视频片段：改 grab_frame.py 输出多张或直接出 mp4；改间隔只需配置项 |
| 换拉流协议 | audio.mjs:34-65 `protocol/format/codec` | 换 HLS(protocol=1) 要重写拉流与拆包（FlvSplitter 不适用），放大改造 |
| 音频→转写改流式 | audio.mjs:221-250 目前落盘再转 | 可改内存 Buffer 交 worker；需 worker 支持非文件输入（当前 av.open 需 path） |
| 接入其它直播平台 | live.mjs 房间查询/弹幕/发送 + audio.mjs:getPlayUrl | 契约：房间信息 `{realRoomId,uid,liveStatus,title,uname,online}`；弹幕回调 `{uid,uname,text,ts,medal}`；`getPlayUrl→{url}`；切片/ASR/抽帧与平台无关 |
| 换模型镜像/缓存目录 | asr.mjs:38-42；asr_worker.py:26-30 | HF_ENDPOINT 默认 hf-mirror；可指向本地已下载模型 |
| 语音触发/回复策略 | index.js:768-824；config.mjs:105-111 | audioKeywords/audioReply/audioReplyCooldownMs/audioInRecap/audioKeepFiles |
| 调试弹幕原始消息 | DanmakuClient `onRaw`（live.mjs:601,652） | 当前 index.js 未传；可临时挂日志/探针（文件头 4 行提到 _tmp_live_probe/probe2.mjs，不在仓库） |

## 8. 坑与风险清单（本链路）

1. **WBI**：全局缓存 6h（55-65），提前失效时只能等 TTL/重启；`getDanmuInfo` 不带签名直接 -352（文件头 9 行注释）。
2. **弹幕服务器只取 host_list[0]**（289-290）：该 host 故障会反复重连同一台，不会切备用。
3. **uid 精度**：18 位 uid 必须字符串转发，`Number()` 会截断（131-133、91-96）。
4. **WebSocket binaryType 必须 arraybuffer**（625）；`onmessage` 收到字符串帧直接丢弃。
5. **cmd 前缀匹配**：`DANMU_MSG:4:0:…` 这类带后缀必须 startsWith（537-538）。
6. **拉流不带 Cookie**（audio 195、vision 74 都是 `headersOf(null)`）：受限/付费房间可能取不到流。
7. **视频字节仍要读进来再丢**：省流量只能降 qn，不是丢视频 tag（audio 注释 13-14）。
8. **语音不是完整逐字稿**：队列主动丢中间片（asr 186-195），只有“正在处理 + 最新一片”。
9. **杀转写进程的连锁反应**：超时才杀，且会 reject 排队段（asr 204-209）；设计上靠 maxQueue=2 压低风险。
10. **GOP 裁剪可能丢 I 帧**（vision 113-114）；**抽帧 python 无超时**（index.js 642-678）——极端情况该次 handleShot 永久挂起（但不阻塞其它异步回调）。
11. **临时文件**：正常离场 clearRoomTmp，崩溃残留靠 sweepTmp（6h）；debug 用完记得关 `audioKeepFiles`（config 112-113）。
12. **文档漂移**：README 说默认模型 medium、每 2 分钟一帧；代码默认 small、5 分钟（config 99、121）——定制时以代码为准。
13. **隐私**：转写在本地跑（音频不出机），但转写文本与画面帧会进 LLM 总结（audioInRecap/visionInRecap 可关）。

## 9. 一句话结论

媒体链路 = 三条独立拉流/长连接 + 两个 Python 子进程（常驻转写、一次性抽帧），协议都薄且边界清楚；**可替换点集中在 live.mjs（平台接口层）、audio.mjs:getPlayUrl+切片、asr.mjs 的 JSONL 协议、vision.mjs 的 GOP+抽帧脚本**。定制优先级建议：先加 `visionQn`/ASR 后端替换（接口最稳），再动平台适配与 HLS。
