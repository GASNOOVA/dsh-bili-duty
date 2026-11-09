# 03 · 评分 / 恶意审核 / 笔记 / LLM 模块解读

> 分析对象：`/mnt/volume/dsh/dsh-bili-live`（package.json 版本 0.9.3）。只读分析，不执行插件、不联网。
> 覆盖 `lib/rating.mjs`(544 行)、`lib/moderation.mjs`(219)、`lib/recap.mjs`(400)、`lib/llm.mjs`(140)，并串上调用方 `index.js`、`lib/config.mjs`、`client.js`。
> 行号 = 当前工作区文件行号，可直接按 `文件:行号` 定位改动点。源码注释里大量「用户裁定/实测」是这版公式的由来，改公式前建议先读对应注释。

## 0. 全景与调用链

一场直播收尾（`index.js:385 finishRecap`）把四个模块串起来：

```
watch()/进房  ──> startRating()（index.js:213-255）
   │               └─ 立即采一次 + 每 90s 采一次 collectStats()，各项取历史峰值
   ▼
离场 stopWatching()（index.js:541-558）
   └─ stopRating()（258-267）→ sample（含 fanGain）
      └─ finishRecap(rec, why, shots, sample)
           ① computeScore(sample + 实录派生量, buildWeights(cfg)) → scoreTier
           ①.5 moderator.judge(rec) → 扣 0~5 分，得到最终分（只在已算分时执行）
           ② writeRecap(home, rec, summary, {rating, online, aiWords}) → <home>/recaps/*.txt
           ③ 过线才推送（只对随机巡场），推送前再问一次模型写评价
```

模块间依赖：`moderation.mjs` 只 import `recap.mjs` 的 `clockStamp`（moderation.mjs:19）；`rating.mjs` 不依赖其他 lib（自带 cookie/HTTP，rating.mjs:23-32 说明为避免循环依赖）；`recap.mjs` 不依赖模型；`llm.mjs` 是唯一借用宿主 `llm` 服务的出口。
关键调用点（index.js）：建 llm/moderator 174-176；采样 213-255（90s 定时器 253）；停采样与 fanGain 258-267；打分门槛 393-405；派生量 405-416；算分 417-423；审核改分 425-434；写总结 prompt 461-518；落盘 519-526；推送条件 528-531；笔记目录/列表 HTTP 1391-1392、1399-1401。

---

## 1. lib/rating.mjs —— 十维评分

### 1.1 collectStats：接口与字段口径（rating.mjs:88-228）

所有请求共用一个 `headers()`（UA + Referer + 可选 Cookie，14-32）；`api()`（34-40）负责 12s 超时、HTTP 非 2xx 报错、`code!==0` 报错并剥出 `data`。每个接口独立 `.catch(()=>null)`：**任何一项失败只留默认值，不拖垮整场**（84-86 注释）。

| 行号 | 接口 | 采集字段 | 口径/用途 |
| --- | --- | --- | --- |
| 110-121 | `api.live.bilibili.com/room/v1/Room/get_info?room_id=` | `popularity`(room.online)、`attention`、`area`、`title`、`upUid`(room.uid) | room.online 是**人气值不是人数**（注释实测放大 ~2900 倍，114-116），只当参考、不入分；attention 仅兜底 |
| 126-133 | `xlive/web-room/v1/index/getInfoByRoom?room_id=` | `fansClub`(anchor_info.medal_info.fansclub)、attention 兜底 | 粉丝团人数：开播/下播两次采样相减 = 本场新增粉丝团（路人转化率数据源，123-125） |
| 136-142 | `live_user/v1/Master/info?uid=` | `follower`(follower_num)、attention | follower 用于动态获赞满分线 likeCapOf（299-313） |
| 145-152 | `api.bilibili.com/x/web-interface/card?mid=` | `likes`(like_num)、`videoCount`(archive_count)、`likesPerVideo=round(likes/videoCount)`(151) | 获赞率入 likeRate；获赞/投稿取不到则为 0 |
| 158-172 | `api.bilibili.com/x/space/wbi/arc/search`（WBI 签名） | `posts30d`=近 30 天 created 的 vlist 条数(166-170)、`postsKnown`(171) | ps=50、order=pubdate；拿不到时默认 **5**（正好是 cap，「未知当正常」163）；44-47 记录旧 newlist 接口在 2026-10 失效、会返回全站推荐流的事故 |
| 176-218 | `xlive/general-interface/v1/rank/getOnlineGoldRank?roomId=&ruid=&page=&pageSize=50` | `online`=onlineNum(216)、`payerCount`、`payerFans`、`payerStrangers`、`payerTruncated`、`uidPrecisionRisk` | **真实同接**只在这里；ruid 必须传主播 uid；翻页到不满 50，MAX_PAGES=30（≤1500 人）；按 uid 去重；`medalInfo.targetId==upUid` 判「自己人」还是路人(204-214) |
| 221-225 | `xlive/app-room/v2/guardTab/topList?roomid=&ruid=&page_size=10` | `guardCount`(info.num) | 大航海数**已废弃不入分**，仅日志/推送文案展示（267-268） |

WBI 签名（42-82）：`nav` 接口取 `wbi_img.img_url/sub_url` 文件名拼串 → 按 64 位 `WBI_TAB` 重排 → `slice(0,32)` 得 mixin，缓存 2h（53-57）；`wbiApi` 参数排序、加 `wts`（秒）、`md5(qs+mixin)` 得 `w_rid`。空间接口若报 -403「访问权限不足」，先查这里。

字段口径坑（改采集必看）：
- `online` 与 `popularity` 是两个量，不能混；`onlineKnown` 只在 rank 返回 `onlineNum>0` 时为 true（91-94、215-217）。
- 同接缺失时 computeScore 的分母有 30/5 保底，会出现「没数据反而高分」，所以上层**整场不打分**（index.js:396-399）。
- `payerFans/payerStrangers` 必须和 `payerCount` 取自**同一次采样**，否则分子分母对不上（index.js:240-243）。
- 18 位 uid 过 JSON.parse 有精度风险，`uidPrecisionRisk` 标记（206-211）。
- `attention` 与 `follower_num` 实测相同（143-144），attention 不再入分。

### 1.2 输入值在调用侧的推导（决定公式的入参）

- `startRating`（index.js:213-255）：进房立即采 + 每 90s；`best` 各项取 max（online/attention/follower/likes/payerCount/guardCount/popularity），`payerFans/payerStrangers` 跟随 payerCount 较大的那次，`likesPerVideo/posts30d` 取最近采到的非零；`firstAttn/firstFansClub` 存首采基准、`lastFansClub` 存末采（222-227）。
- `stopRating`（258-267）：`fanGain = max(0, lastFansClub - firstFansClub)`，返回 `sample`。
- `finishRecap` 派生量（405-416）：`minutes=max(1,liveSec/60)`；`dpm=round(rec.size/minutes*10)/10`（每分钟弹幕）；`speakers=rec.speakers()`；`fansPresent=rec.fansPresent`；`seenCount=rec.seenCount`；`attentionGain`（峰值关注−开场）；`fanGain`。
- 打分门槛（393-405，MIN_ONLINE=20 在 376-379）：`liveSec>=60`、`sample.onlineKnown`、`sample.online>=20` 三者任一不满足就**整场不打分**，恶意审核也不会跑。

### 1.3 computeScore 完整公式（rating.mjs:369-533）

设最终分 `Score ∈ [0,10]`（返回时 `round(score*100)/10`，519-521 行；内部 score ∈[0,1]）：

```
Score = 10 × Σ_k  w̃_k × N_k
其中 w̃_k = 用户百分数 / Σ用户百分数（buildWeights 归一，Σw̃=1，343-355）
```

**F1 两套分母**（385-386；注释 380-384）：
```
crowd = max(online, 30)   // 给「每人能刷多少」类：一条弹幕/一笔钱
heads = max(online, 5)    // 给「有多少人做某事」类：只防 1~4 人的极端比例
densityDen = max(seenCount, heads)   // 粉丝浓度专用（456 行）
```

**F2 派生比率**（453-462、484）：
```
interaction      = dpm / (crowd/100)                  // 每百人每分钟弹幕
speakerRate      = speakers / heads                   // 发言人数 ÷ 在场人数
fansDensity      = fansPresent / densityDen            // 挂牌人数 ÷ 本场出现过的人数
fansPayRate      = payerFans / heads                   // 挂本房牌的付费者 ÷ 在场人数
strangerPayRate  = payerStrangers / heads              // 未挂牌付费者 ÷ 在场人数
fanGainRate      = fanGain / heads                     // 本场新增粉丝团 ÷ 在场人数
```
付费分母刻意用 heads 而不是 crowd（457-459）：用 30 的下限会把 15 人小房的 20% 付费率腰斩成 10%。

**F3 同规模期望值**（410-441）。四档锚点（全部取自 138 场真实日志的中位数，411-424）：

| 同接档 | 锚点 x | 发言率 | 每百人弹幕 | 粉丝付费率 | 路人付费率 |
| --- | --- | --- | --- | --- | --- |
| 20~50 人（熟人房） | 35 | 0.1968 | 12.01 | 0.0435 | 0.2008 |
| 50~200（潜水房） | 125 | 0.0331 | 2.98 | 0.005 | 0.0234 |
| 200~500 | 350 | 0.0652 | 5.53 | 0.0266 | 0.0696 |
| 500+ | 2000 | 0.0247 | 1.05 | 0.0139 | 0.0227 |

`expectOf(key, n)`（426-441）：列映射 `speakerRate:1, interaction:2, fansPayRate:3, strangerPayRate:4`；`x=max(n,20)`；`x<=35` 用第一档、`x>2000` 用最后一档，其余按**对数刻度**插值：
```
t = (ln x − ln x0) / (ln x1 − ln x0)
expect = p[col] + t × (q[col] − p[col])
```
（注释说明：翻倍时比率本该对数下降，线性插值会把小档拉得太缓。）

**F4 期望比 → 单项分**（442-451、464-469）：
```
ratio_k = baseRate_k / expectOf(k, online)     // expect 为 0 时兜底 1（465-468 的 `|| 1`）

expNorm(r):
  r >= 1.35          → 1                       // 超过同规模 1.35 倍封顶
  1.00 <= r < 1.35   → 0.85 + (r−1) × 0.15/0.35 // 1 倍期望 = 0.85 分
  0.30 <= r < 1.00   → 0.25 + (r−0.3) × 0.6/0.7 // 0.3 倍 = 0.25 分
  r < 0.30           → r × 0.8333              // 一路收 0，给「没人说话」留的
```
只有 `BY_EXPECT = {interaction, speakerRate, fansPayRate, strangerPayRate}` 走这条（487）；其余六项走固定 cap。

**F5 固定 cap 归一**（236-242）：
```
norm(v, cap, linear):
  v<=0 或 cap<=0 → 0
  linear=true    → min(1, v / cap)
  linear=false   → min(1, log10(1+v) / log10(1+cap))   // 对数，只比量级
```
其中 likeRate 的 cap 是**动态**的 `likeCapOf(follower)`（491）：粉丝数→获赞满分线的锚点插值（LIKE_POINTS 283-296，likeCapOf 299-313）：

| 粉丝数 | ≤1万 | 5万 | 20万 | 50万 | 100万 | 200万 | 500万 | 1000万+ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 满分线（赞/稿） | 900 | 1800 | 4500 | 9000 | 18000 | 36000 | 90000 | 180000 |

- 锚点间线性插值并四舍五入（305-310）；`follower<=0` 返回 **1800** 中性线（299-303，不是最低档 900，避免「接口失败=白送 0.1 分」）。
- 2026-10-20 起全线 ×3（285-287 注释）：原 100 万粉 6000 封顶太容易，要「出过爆款」才满分。

**F6 加权与明细**（487-519）：
```
n_k = BY_EXPECT.has(k) ? expNorm(ratio_k) : norm(raw_k, cap_k, linear_k)
score = Σ n_k × w̃_k        // 0..1
parts[k] = {
  label, value=raw_k, show=展示串, ratio,      // ratio 仅期望项非 0
  normalized=round(n*1000)/1000,
  points=round(n*w̃*100)/10,   // 该项得分（满分 max = w̃*10）
  max=round(w̃*1000)/100, cap              // 实际满分线（likeRate = likeCap）
}
return { score: round(score*100)/10, parts, weights, likeCap, expect{...四期望值} }  // 520-533
```
`parts.points` 之和 ≈ score（各自 0.1 舍入会有微小差）；笔记的条形图用 `points/max` 画格（recap.mjs:288-298）。

### 1.4 WEIGHTS / DEFAULT_WEIGHTS / buildWeights / scoreTier

`WEIGHTS`（315-329，默认权重来自 0.9.0 用户四条裁定，244-268 注释）：

| key | 中文 | 默认权重 | cap | 归一方式 |
| --- | --- | --- | --- | --- |
| likeRate | 作品获赞 | 0.10 | 动态 likeCap | 对数 |
| interaction | 直播互动 | 0.17 | 12* | 期望比 |
| speakerRate | 观众参与 | 0.12 | 0.25* | 期望比（线性/比率） |
| danmaku | 弹幕热度 | 0.07 | 6 | 对数 |
| online | 人气规模 | 0.05 | 30 | 对数 |
| fansDensity | 粉丝浓度 | 0.12 | 0.15 | 线性 |
| posts | 更新频率 | 0.08 | 5 | 线性 |
| fansPayRate | 粉丝付费率 | 0.20 | 0.10* | 期望比（线性/比率） |
| strangerPayRate | 路人付费率 | 0.08 | 0.25* | 期望比（线性/比率） |
| fanGainRate | 路人转化率 | 0.01 | 0.10 | 线性 |

合计 1.00（=100 分）。`*` 的期望项实际分数由 F3/F4 决定，cap 只在 `parts.cap`/展示里当兜底；其余项的 cap 直接进 norm。

- `DEFAULT_WEIGHTS`（332-334）：把 weight×100 四舍五入成百分数，作为 `config.mjs:74` 的默认值和设置页初始值。**改默认权重只需改 WEIGHTS**，DEFAULT_WEIGHTS 自动跟随；但设置页 `client.js:141-145` 的 `WEIGHT_DEFAULTS` 是手抄副本，必须同步。
- `buildWeights(overrides)`（343-355）：逐项取覆盖值（无则默认）→ `Number` + clamp 0~100 → 百分数 `w`；若 `Σw>0` 则逐项除以总和；`Σw==0` 时保持全 0（该场总分 0）。overrides 只认 WEIGHTS 里有的 key。
- `scoreTier(score)`（536-544）：`≥9 S/顶尖、≥8 A/很强、≥6 B/中上、≥4 C/一般、≥2 D/偏弱、<2 E/很弱`。审核改分后 index.js:433 会用最终分重算 tier。

### 1.5 一个算例（虚构输入，仅演示口径与量级）

输入：online=100、dpm=3.0、speakers=8、fansPresent=12、seenCount=60、payerFans=2、payerStrangers=1、likesPerVideo=2000、follower=500000、posts30d=4、fanGain=1。则 crowd=heads=100、densityDen=100，逐项：

| 维度 | 比率/原值 | 期望线 | ratio | N | 权重 | points |
| --- | --- | --- | --- | --- | --- | --- |
| interaction | 3.0/百人 | ≈4.56 | 0.658 | ≈0.556 | .17 | 0.95 |
| speakerRate | 0.08 | ≈0.0618 | 1.295 | ≈0.976 | .12 | 1.17 |
| fansPayRate | 0.02 | ≈0.0118 | 1.70→封顶 | 1.0 | .20 | 2.00 |
| strangerPayRate | 0.01 | ≈0.0545 | 0.184 | ≈0.153 | .08 | 0.12 |
| likeRate | 2000 | 9000 | — | 0.835 | .10 | 0.83 |
| danmaku | 3.0 | 6 | — | 0.712 | .07 | 0.50 |
| online | 100 | 30 | — | 1.0 | .05 | 0.50 |
| fansDensity | 0.12 | 0.15 | — | 0.80 | .12 | 0.96 |
| posts | 4 | 5 | — | 0.80 | .08 | 0.64 |
| fanGainRate | 0.01 | 0.10 | — | 0.10 | .01 | 0.01 |
| 合计 | | | | | 1.00 | **≈7.68 → 7.7（B 档）** |

### 1.6 改公式速查

- 换单项满分线：改 `WEIGHTS[key].cap`（或 likeRate 的 `LIKE_POINTS`/`likeCapOf`）。
- 换期望值/曲线：改 `EXPECT_POINTS`（410-424）、`expectOf` 的插值方式（426-441）、`expNorm` 折点（442-451）。
- 换哪些项走期望比：改 `BY_EXPECT`（487）+ `ratioOf`（464-469）+ `expectOf` 列映射（427）。
- 换分母口径：改 385-386 与 453-462；注意注释里的实测理由，别改回 30。
- 新增维度：`WEIGHTS` 加一项 + `raw/baseRate` 补值 + 必要时 `BY_EXPECT/EXPECT_POINTS` + `client.js` 的 `WEIGHT_DEFAULTS/WEIGHT_LABELS`；`DEFAULT_WEIGHTS`、config 归一、笔记渲染（遍历 parts）、status weights 都是自动的。

---

## 2. lib/moderation.mjs —— 隐藏的恶意内容扣分

### 2.1 入口与开关

- `makeModerator(llm, cfg, log)`（30）返回 `{enabled, judge(rec)}`。
- 开关 `on()`（31）：`cfg.moderationEnabled !== false && cfg.ratingEnabled !== false`——**评分关掉审核也关**。
- `judge`（43-204）前置：`!on() || !llm.available → null`（44）；`threshold = max(1, round(cfg.moderationThreshold||10))`（45，config 层钳 3~60，config.mjs:204）；`rec.size < 8 && !rec.blockCount → null`（46-47，太冷清不花调用）。
- 只被 `index.js:425-434` 在「已算出评分」的分支里调用，所以短场/未知同接/同接<20 的场次根本不审。

### 2.2 送审数据

- 弹幕：`items.length<=400` 全给，否则 `rec.sample(400)`（49-50，均匀抽样）。
- 独轮车统计 `floodText`（54-93）：按 `uid||name` 聚合**全场原始弹幕**，算每账号总条数、占比、同一句最大重复；命中「`count>=30 且 share>=3%`」或「同句重复 `>=15` 次」才列为刷屏，按条数降序取前 6（80-92）。这些结构化统计专门补采样看不出规模的缺陷。
- 文本格式：弹幕行 `HH:MM 昵称：内容`（95）；封禁行 `HH:MM 封禁 某某（房管/主播操作|系统自动）`（96-98）。

### 2.3 prompt 结构（100-147）

按行号概括（不贴全文）：

| 段 | 行号 | 内容 |
| --- | --- | --- |
| 角色 | 101 | 后台审核一场 B站 直播记录，找恶意内容并给扣分/加分建议 |
| 首要判别 | 103-107 | 先分清玩笑/互损/玩梗/跟风复读 vs 真恶意；「拿不准一律不算」 |
| 算恶意 | 109-113 | 独轮车、带节奏、网络暴力、粗鄙语言（含定义与区别） |
| 不算恶意 | 115-122 | 台词引用、熟人互损、全房跟风复读、正常玩梗、正常批评、念稿脏字等 |
| 现场数据 | 124-134 | 弹幕量/采样说明、封禁次数、刷屏统计（强调按全场算，判断时计入） |
| 输出要求 | 136-144 | ①`maliciousCount` 全场恶意条数（只数确信的；刷屏按量计）；②`score` 0~5，且给出分档：不到阈值 0、阈值~19→0.5~1.5、20~39→1.5~3、40+→3~5；③有封禁必须 0；④`samples` 最多 8 条/每条 30 字；⑤`note` ≤15 字；只输出一行 JSON |

### 2.4 调用、解析与重试

- `ask`（149-155）：`llm.generate({prompt, maxTokens:1200, timeoutMs:60000, onError: log(...)})`。
- 第一次 ask（159）→ `parseJsonLoose`（208-219：去 ``` 围栏，取第一个 `{` 到最后一个 `}` 再 JSON.parse，失败 null）。
- 解析失败但返回非空（多半是大白话）：**先把原始返回写日志**（164），再追加「重来一次，只输出一行 JSON」追问一次（165-169）；仍失败再记日志（171）。
- 最终拿不到对象：`log('...本场不扣分')` 并返回 null（173-176）——审核失败绝不阻塞结算。

### 2.5 扣分判定与返回结构（178-203）

```
malicious = max(0, round(Number(obj.maliciousCount)||0))
blocked   = rec.blockCount > 0                       // 本场有封禁 ⇒ 一律不扣（179-182）
penalty   = (!blocked && malicious >= threshold)
              ? round1(min(5, max(0, Number(obj.score)||0)))   // MAX_PENALTY=5，round1
              : 0
bonus     = 0                                        // 已废弃，仅兼容旧笔记渲染（186-187）
waived    = blocked && malicious >= threshold        // 「该扣没扣」时才在评价里交代一句（197-199）
samples   = 去空白后 ≤8 条（188-190）；note = 压缩后 ≤60 字（201）
return { threshold, malicious, penalty, bonus, blocked, waived, samples, note, blocks: rec.blockCount }
```

index.js 应用（427-434）：`final = clamp(round((score − penalty + bonus)*10)/10, 0, 10)`；**只有 penalty/bonus 非 0 才**把 `rating.mod` 挂上并重算 tier（428-434）→ 笔记里的算式（recap.mjs:45-52）只在真扣分时出现。`waived` 会被塞进总结 prompt，让模型在【大肥鱼的评价】里自然交代「看到脏弹幕但现场封过人、分不清封的是不是这些」（index.js:496-498）；日志分支在 446-458。

### 2.6 风险

- 额外一次模型调用（400 条弹幕 + 提示词，输入粗估数千~上万 token，输出上限 1200）；解析失败会翻倍。只在已评分的场次产生。
- `maliciousCount` 是模型自报的**估计值**；扣分档位在 prompt 里是软约束，代码只硬钳 `malicious>=threshold` 与 `penalty∈[0,5]`。
- 封禁免责口径过宽：B站 只给「封了谁」不给原因，无法区分封恶意弹幕还是封广告（180-181），所以宁可少扣。
- 只审弹幕不审语音（设计取舍，README 也说明）；审核结果不进总结正文，只进日志/笔记算式。

---

## 3. lib/recap.mjs —— 直播记录器与 txt 笔记

### 3.1 LiveRecorder 的内存结构（82-346）

| 数据 | 行号 | 说明 |
| --- | --- | --- |
| 基本字段 | 86-97 | roomId/uid/uname/title/startedAt/endedAt/items/speech/blocks/dropped；`random` 由 index.js:979 外部挂上（构造器没有） |
| `items` 弹幕 | 133-148 | push 兼容 `t/ts`、`name/uname`；`{t,name,text≤200,uid,medal}`；`MAX_ITEMS=20000`（14），超了从头 splice 且 `dropped+1` |
| `speech` 转写 | 100-108 | 压空白；<2 字丢；8 秒内同文去重；单条 ≤300 字；`MAX_SPEECH=4000`（15） |
| `blocks` 封禁 | 186-195 | `{at,uid,uname,operator}`，上限 200；只当「有没有人管」的信号 |
| 粉丝牌/出场人数 | 155-180 | `noteMedalUid`→`medalUids`、`fansPresent`；`noteSeenUid`→`seenUids`、`seenCount`（粉丝浓度的分母，与挂牌人数同量纲） |
| 结束时间 | 207-210 | `close` 只认第一次，重复调用不往后拖 |
| 统计方法 | 202-267 | `size`；`speakers()`（uid 或 `n:名字`去重）；`hotMinute()`（按 `floor(t/60000)` 分桶取最大）；`keywords()`（中文 2-gram 滑窗、去标点/数字/空白、20 词停用表、n≥3、top）；`sample(n)`（均匀含首尾）；`digest(n=70)`（采样文本截 6000 字符）；`speechSample/speechDigest`（40 段/6000 字符） |

### 3.2 txt 笔记模板（toText 270-345）

| 区块 | 行号 | 内容 |
| --- | --- | --- |
| 头部 | 273-281 | `日期 · 主播 的直播`、分隔线、直播间 URL、开播标题、观看时段（时分+humanSpan）、弹幕总数/发言人数、语音段数、同接峰值 |
| 评分块 | 282-300 | `评分：x/10（S/A/B…档 · 文字）`+`modLine` 算式（45-52，仅真扣分时）；总评条 + 每个维度一行：`标签 |####-----| 得分/满分 展示值`；`padW` 按显示宽度（中文=2 列）对齐（58-63），`barOf` 固定 20 格（66-69） |
| 大概发生了什么 | 303-313 | 模型 summary；**为空时本地统计降级**：时长、最热闹一分钟、高频词 top8 |
| 大肥鱼的评价 | 316-320 | `extra.aiWords`（index.js:511-517 从模型输出里按 `【大肥鱼的评价】` 拆出） |
| 最热闹的一分钟 | 322-327 | `hotMinute` 的时间与条数 |
| 弹幕摘录 | 329-334 | `sample(40)`，`HH:MM 昵称：内容` |
| 主播说了什么 | 336-341 | `speechSample(60)`，注明本机转写可能有错字 |
| 页脚 | 343 | 自动记录署名 |

### 3.3 落盘、目录与列表（348-400）

- `recapDir(home)`（350-354）：`join(home,'recaps')` 并 `mkdirSync recursive`。
- `writeRecap(home, recorder, summary, extra)`（360-374）：文件名 `YYYY-MM-DD 主播 时-分.txt`（dayStamp/clockStamp 22-31，**进程本地时区**）；`safeName`（72-78）把 Windows 非法字符换空格、压缩空白、截 40 字；同名（断线重开/同一天两场）加 ` (2)`、` (3)` 递增（366-371）；utf8 写入。
- `listRecaps(home, limit=12)`（385-400）：只列 `.txt`、按 mtime 倒序、默认 12；调用时会自动建目录。
- 调用方：`index.js:520` 写盘；status 返回 `recaps`/`recapDir`（1191-1192）；`GET /records` 列 40 条（1399-1401）；`POST /open-folder` 打开目录（1403-1416）。

### 3.4 模型不可用时的降级

- 是否写笔记：`index.js:464-466`——`!cfg.recapEnabled` 或（`rec.size < cfg.recapMinDanmaku` 且 `speechSize==0`）就不写。
- 模型不可用/`generate` 返回空 → `summary=''` → `toText` 走本地统计版（306-312），笔记照常落盘；判据是 summary 空，不只是 `llm.available`。
- 可选输入：`audioInRecap` 决定是否带语音转写（index.js:469）；`visionInRecap/visionShotsInRecap` 决定是否带 ≤3 张画面（470）；图片经宿主 `attachments.saveImage` 转附件（index.js:273-296）。

### 3.5 风险

- **全内存**：进程崩溃/被 kill/插件卸载（index.js:1441-1443 用 silent 跳过总结）就丢整场；README 也明确。
- items 剪到最近 2 万条，`dropped` 只计数、不写进笔记 → 超长场次早期弹幕静默丢失。
- 时区不一致：`dayStamp/clockStamp` 用进程本地时区，而 index.js:78-81 的 `dayKey` 用北京时间（+8）；跨时区机器上「日期」和「今天」口径会不同。
- `keywords` 是 2-gram 粗统计不是分词，停用表短；`safeName` 不处理 Windows 保留名（CON 等）和结尾点号。
- 隐私：笔记是明文，含昵称、弹幕原文、主播原话，落在 `<home>/recaps/`。

---

## 4. lib/llm.mjs —— 借宿主模型说话

- 定位（1-12）：插件不持有模型；用 `ctx.get('llm')` 借宿主的；**任何失败都吞掉返回 ''**，直播回复少一句可以，卡主流程不行。
- `makeLlm(ctx,cfg)`（18）返回 `{available, route(), generate(o)}`。
- 惰性取服务（20-26）：apply 时 llm 可能还没挂上，真要用时才 `ctx.get('llm')`；`getDefaultModel`（28-36）读 `ctx.get('agentDefaultModel').currentSelection()`。
- 路由 `resolveRoute`（39-61）：`cfg.llmProvider/llmModel` 优先；缺项用 DSH 当前默认模型；仍缺 provider 就取 `llm.listProviders()[0].id`；model 兜底 `'deepseek-flash'`；无 provider → null。所以用户换 DSH 默认模型，插件自动跟随（8-10 注释）。
- `route()`（69-79）：给设置页/status 展示 `{provider, model, providers[]}`（index.js:1150、1382）。
- `generate(o)`（85-127）：
  - 守卫：无 llm 服务或 `cfg.llmEnabled===false` → `''`（87）；路由不成立 → `''`（89）。
  - 超时：`AbortController` + `setTimeout(max(3000, o.timeoutMs || 20000))`（90-91）。
  - 调用签名：`svc.prepareCall({provider, model, maxTokens: max(16, o.maxTokens||120)}, ctl.signal)`（94-97）；只带 maxTokens，不带 temperature 等（93 注释：少一个旋钮少一次失败）。
  - 消息组装（99-109）：单条 `role:'user'`、`id:'bili-live-<ts>'`、`source:{kind:'bili-live'}`、`content=[...images 的 attachment, {type:'text',text:prompt}]`。
  - 流式：`call.stream({...call.config, messages, system?, signal})` 逐 chunk 累加 `textOf`；收尾剥首尾引号/空白（110-119）。
  - 失败：`catch` 调 `o.onError(e)`（调用方写日志），返回 `''`；`finally` 清定时器（120-126）。
- `textOf`（131-140）：兼容 `string`、`{type:'text-delta',text}`、`{type:'text-delta',delta:{text}}`、`{delta:string}`、`{content:{type:'text',text}}` 等不同宿主版本的流式 chunk 形状。
- 调用方与参数（index.js）：写总结 502-509（maxTokens 10000、90s、最多 3 图）；推送前主播评价 316-322（1200/60s）；弹幕自由回复 857-862（80/15s）；语音接话 795-807（80/15s）；恶意审核 150-155（1200/60s）；`/llm-test` 1372-1378（600/30s）。总结类 prompt 的组装在 index.js:461-518（时间/分区必须显式喂，否则模型会脑补时段，471-500 注释），不在 llm.mjs 里。
- 成本口径（README）：接一句话 ≈800 token、一张笔记 ≈8k~9.5k（含 3 张图）；本机 ASR/抽帧 0 token。实际预算以各入口 `maxTokens` 为准。
- 风险：
  - `llmEnabled` 不在 `config.mjs` 的 DEFAULTS/normalizeConfig 里（config.mjs:11-135 无此键），设置页改不了、`mergeConfig` 也不会合并；当前等于恒开（87 只拦显式 false）。要加总开关需同时改 DEFAULTS/config/client。
  - 静默降级：所有异常只返回 ''，只能靠各调用方的 `onError` 日志定位；除 moderation 自己重试外没有重试。
  - 路由是启发式：宿主没 llm/默认模型变化/provider 被移除 → 总结退化本地统计、回复退固定话术；provider 列表取第一个不一定对。
  - 图片透传依赖 index.js 里 `ctx.get('attachments')`；llm.mjs 只把 attachment 塞进 content。
  - 模型输出只剥首尾引号，不校验长度/内容；发弹幕路径由 `cfg.maxLen` 的 `clipText` 二次限制（index.js:810）。
  - 隐私：弹幕、昵称、UID、语音转写、直播画面都会进宿主模型；插件自身不额外落 AI prompt。

---

## 5. 定制入口速查

| 想改什么 | 改哪里 | 注意 |
| --- | --- | --- |
| 调默认十维权重 | `lib/rating.mjs:315-329` WEIGHTS（后端唯一真源，DEFAULT_WEIGHTS 自动跟随）+ `client.js:141-150` 的 WEIGHT_DEFAULTS/LABELS + README 表 | 用户端的调权不用改代码：设置页 `client.js:930-949` → POST /config → index.js:1201-1207 → config.mjs:195-202 → buildWeights |
| 加/删评分维度 | WEIGHTS + `computeScore` 的 `raw`(470-485)/`baseRate`(453-462)/`ratioOf`(464-469) + 必要时 `BY_EXPECT`/`EXPECT_POINTS` + client 的 WEIGHT_DEFAULTS/LABELS | `parts` 渲染、status weights、config 归一会自动跟随；新维度若走期望比要加 expectOf 列映射 |
| 改满分线/曲线 | 单项 cap（WEIGHTS）或 `LIKE_POINTS`(283-296)/`likeCapOf`(299-313)；期望值 `EXPECT_POINTS`(410-424)、`expNorm`(442-451) | 改完会改变分数分布；样本期实测结论见 244-268、401-424 注释 |
| 改门槛/推送 | `MIN_ONLINE` index.js:379、60 秒门槛 393、`ratingPushScore`（config 63/193、推送条件 index.js:529 是**严格大于**）、月度去重 334-348/pushed.json | 推送只对 `rec.random` 的场次（528-531）；B站 不能给自己发私信 |
| 改采集口径 | `collectStats` 各接口/字段（rating.mjs:88-228）+ index.js 的 90s 采样与峰值合并（213-255）、派生量（405-416） | 每个接口都能单独挂，改字段要同步 parts/笔记展示与日志 |
| 改恶意审核 | prompt `moderation.mjs:100-147`；`MAX_PENALTY`(22)/`MAX_DANMAKU`(21)/跳过规则(46-47)/刷屏阈值(80-82)；扣分应用 index.js:427-434；waived 文案 index.js:496-498；开关/阈值 config.mjs:203-204、client.js:894-912 | 改 prompt 输出字段要同步 `parseJsonLoose` 的字段名（178-201）与返回结构 |
| txt→md/json | `recap.mjs:270-345`（模板）+ `writeRecap`(360-374，扩展名) + `listRecaps`(385-400，`.txt` 过滤) + `/records`(1399-1401) + 前端文件列表(`client.js:955-980`) | 换格式要同时改过滤/前端显示；JSON 可在 writeRecap 旁加旁路写出 |
| 改输出目录 | `recap.mjs:350-354` recapDir；home 来源 `index.js:54-68/103`（dshHomePath('bili-live') 或 `$DSH_HOME/bili-live`） | 改目录后 `/open-folder`、列表、README 一起改 |
| 换模型路由 | `config.mjs:182-183` llmProvider/llmModel（设置页可填）；`llm.mjs:39-61` resolveRoute | 留空 = 跟随 DSH 默认模型；宿主无 llm 时全部 AI 功能降级 |
| 加每日/周报 | 数据源用 `listRecaps`（recap.mjs:385-400）+ 笔记文件；新增聚合逻辑可挂 `finishRecap`（index.js:385）之后，或参照 schedule(1105-1109)/state.json(104-111) 加定时器与持久化 | 现在没有现成调度；跨天/时区口径参考 dayKey（北京时间）与笔记本地时区差异 |

---

## 6. 风险点汇总

1. **B站 接口与字段变化**：`room.online` 是虚高人气值、真实同接只在 `getOnlineGoldRank.onlineNum`；`arc/search` 必须 WBI 签名（旧 newlist 曾返回全站推荐流，rating.mjs:44-47 有事故记录）；card 的 like_num/archive_count、medalInfo.targetId 都可能变。所有请求都被 `.catch(()=>null)` 吞掉 → **字段失效时分数会静默漂移**，只能看日志和 sample（`onlineKnown/postsKnown/payerTruncated/uidPrecisionRisk` 是仅有的显式标记）。
2. **除零/极端值**：全 0 权重 → 0 分（buildWeights 353 的 total>0 分支）；`expectOf` 兜底 `|| 1`；likeCap 粉丝数为 0 → 1800 而非 0；分母 crowd/heads 有下限；但 `seenCount=0` 时 densityDen 落到 heads，靠 index 的 online≥20 门槛兜底。
3. **归一化与舍入**：分数是加权平均×10，改任何 cap / 权重 / 期望表都会改变分布；`parts.points` 各自舍入后与总分可能有 0.1 差；`parts.max = w̃×10` 仅在权重已归一（buildWeights）时成立——直接给 `computeScore` 传未归一的 overrides 会得到错误总分。
4. **token 成本**：总结上限 10000 output + 3 张图；命中推送再问一次主播评价（1200/60s）；恶意审核每次已评分场次一次（400 条弹幕 + 提示词，失败翻倍）。长时间挂机时关 `visionInRecap`/`listenAudio` 可省。
5. **隐私**：弹幕、昵称、UID、语音转写、直播画面会进入宿主 LLM；笔记明文落在 home/recaps；credential.json 仅用于 B站 请求头，不发给模型。
6. **生命周期/内存**：记录器与评分采样全在内存，崩溃/卸载丢整场（index.js:1441-1443 silent 跳过落盘）；`finishRecap` 是 fire-and-forget（557 行 `.catch`），不会阻塞主循环，但也不会重试。
7. **文档漂移（改前以代码为准）**：README 的默认权重表是 19/16/12/12/10/8/8/7/5/3，代码已是 `20/17/12/12/10/8/8/7/5/1`（rating.mjs:315-329）；README 获赞满分线 300~60000，代码已全线 ×3 到 `900~180000`（LIKE_POINTS 283-296）；README 说粉丝数缺失退回 600，代码是 1800（299-303）；`config.mjs:69-73` 注释里的默认权重 15/15/10/… 也过期。设置页 `client.js:141-145` 是 WEIGHTS 的手抄副本，改默认值必须两处同步。
