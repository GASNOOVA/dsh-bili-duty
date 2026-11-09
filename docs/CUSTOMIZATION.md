# 个人定制版开发指南

> 配套 [PLUGIN-MAP.md](PLUGIN-MAP.md)（插件解读地图）与 `docs/notes/`（逐文件深读）。
> 目标：把当前插件安全地演进成你自己的版本，而不是改成一团只在本机能跑的补丁。

## 0. 动手前先定三件事

1. **定制目标**：你要改的是「品牌外观」「内容产出」「玩法/策略」「采集能力」，还是「精简剪裁」？不同目标的改动面差一个数量级（见 §3 菜单）。
2. **运行边界**：只在自己机器上跑，还是要暴露到局域网/公网？后者必须补鉴权（见 PLUGIN-MAP §12 P0），这是本插件当前最大的安全缺口。
3. **账号与成本边界**：插件会用你的账号**真发弹幕/私信**；会消耗宿主模型 token；开语音/画面采集会吃 CPU/流量。先把这些上限想清楚，再调默认值。

## 1. 三条黄金规则

**规则一：配置的唯一真源是 `lib/config.mjs`。**
加任何设置项，必须同时改三处：`DEFAULTS`（默认值）→ `normalizeConfig`（清洗/白名单）→ 设置页控件（`client.js` 的 `formPatch` 或即时 `save`）。`mergeConfig` 只合并 `DEFAULTS` 里出现过的键，**漏改会被静默丢弃**，且没有任何报错。

**规则二：前端契约只加不改。**
`/status` 的返回字段被 `client.js` 直接消费，没有 schema/版本协商；改名/删字段会让设置页静默空白或报错。同理：`ModuleLoader id == 包名`、`settings.section` 注册 id 一致、`cordis.patch.yml` 的 id/name 对应。新功能优先**追加字段/追加 section**，不动旧字段。

**规则三：一切长生命周期的东西都进 `ctx.effect`。**
新增的定时器、子进程、事件监听、HTTP 路由，必须按 `index.js:1421-1433`（路由）和 `1441-1447`（卸载收尾）的写法注册清理；新增运行态先补进 `rt` 初始化（`index.js:180-194`），新增持久化扩 `state.json`。否则插件热重载/卸载后会重复堆叠、留下孤儿进程。

## 2. 开发 / 调试 / 部署工作流

### 2.1 准备

```bash
# 0) 先在仓库建一个自己的分支，别在原分支上裸改
cd /mnt/volume/dsh/dsh-bili-live
git checkout -b personal/v1

# 1) 安装为链接插件（pnpm 会建 symlink；成功后 DSH 自动把 dsh-bili-live
#    加入 profile 的 dsh.profile.bundles —— 无需手改 package.json）
dsh plugin --profile web add link:/mnt/volume/dsh/dsh-bili-live

# 若 pnpm 提示构建脚本待批准，按提示 allowBuilds 后重跑；本插件无构建脚本，通常不会触发。
```

注意：
- 安装会写 `~/.dsh/profiles/web`（**在工作区沙箱之外**），需要在有权限的终端里执行或走审批。
- 本机是 **web profile**；README 里的 `--profile desktop` 不适用于这里（desktop 由 Electron 持有）。
- 零依赖、无构建步骤：编辑仓库文件即编辑插件代码，不需要 `pnpm build`。

### 2.2 验证基线（改任何东西之前先跑通）

1. 重启 DSH → 打开 `http://127.0.0.1:3080` → 设置里应出现「直播助手（DD版）」。
2. 扫码登录（B 站 App 扫），确认「已登录 + UID」出现、昵称自动填上。
3. 点「立即检查」进一个直播间，看 hero 区「当前房间/连接状态/收弹幕」是否动。
4. 看 `~/.dsh/bili-live/live.log` 与设置页日志块是否正常。
5. 手动停止/等一场结束，确认 `~/.dsh/bili-live/recaps/` 落了一张 txt。
6. `git status` 应仍干净（运行产物都在家目录，不进仓库）。

### 2.3 日常循环

```
改代码（host: index.js/lib/*.mjs | client: client.js）
  → 重启 DSH（代码改动最可靠的生效方式）
  → 刷新页面（client.js 改动必须刷新；CSS 只注入一次，改样式尤其要刷新）
  → 用设置页日志 / live.log / ~/.dsh/bili-live/ 里的产物验证
```

调试小技巧：
- `live.log` + 设置页日志是唯一观测面；临时排查可以在 `log()` 前后加字段，但别把凭证/直播间内容打到日志里。
- 前端没有 devtools 断点时，用 `Boundary`（`client.js:1012-1031`）把异常栈直接渲染到设置页。
- 想验证「无模型/无 Python/无画面」的降级路径，不必真删环境，改配置模拟即可（`llmProvider` 填错、`listenAudio/visionEnabled=false`）。
- 改完一定测一次「卸载/停用插件」：不应留下定时器、子进程、`style` 泄漏。

### 2.4 回滚

```bash
git diff                    # 每步改动自己 review
git checkout -- <file>      # 单文件回滚
dsh plugin --profile web remove dsh-bili-live   # 彻底卸掉（profile 里）
```

## 3. 定制方向菜单

工作量：S ≈ 半天内、M ≈ 1~3 天、L ≈ 3 天以上。风险列只写「最容易翻车的点」。

### A. 品牌与外观（S）

| 想改什么 | 改哪里 |
| --- | --- |
| 插件名/描述 | `package.json` `name`/`description`；**包名改了要同步 `client.js:15` 的 ModuleLoader id**、`cordis.patch.yml` 的 `name`、README |
| 设置页导航名/标题 | `client.js:1058`（label）、`:547`（标题）、`:541`（状态 pill） |
| 区块标题/说明文案 | `client.js` 里 `data-bl-h` 各段与硬编码中文（搜字符串即可） |
| 导航图标 | 在 `client.js` apply 里追加 `settings.section.icon` 注册（id 必须为 `bili-live`）；或 `package.json.icon`（插件清单图标，用途不同） |
| 主题色/布局 | `client.js:34-123` 的 CSS；品牌色 `#fb7299`/`#00aeec`；布局宽度/网格写在 `L35/L51` |

风险：改包名不同步 ModuleLoader id → 加载器判定「loaded without registering」，设置页直接消失。

### B. 互动人设与回复（S~M）

| 想改什么 | 改哪里 |
| --- | --- |
| 自我介绍/固定回复文案 | `config.mjs` 的 `introTemplate`/`replyTemplate`（设置页也能改） |
| 触发词/别名/@识别 | `isCallingMe`（`index.js:827-836`）；结构化 @ 需要改 `lib/live.mjs` 的 `parseDanmaku` 并在 `onDanmaku` 里传字段 |
| 回复人设/语气/长度 | `freeReply`（`index.js:842-863`）与语音侧 `handleSpeech`（`778-824`）里的 prompt；`maxLen` 控制截断 |
| 冷却/每日上限 | `cooldownMs`/`dailyLimit`/`audioReplyCooldownMs`（config）；代码判定链 `866-906`/`778-824` |
| 不希望被模型乱说 | 加强 prompt 约束 + 发送前加敏感词/长度校验（`clipText` 之后） |

风险：弹幕文本会进 prompt（prompt injection 面）；模型输出会**真的发到直播间**。建议加「输出白名单/长度/敏感词」三道闸。

### C. 巡场与守候策略（S~M）

| 想改什么 | 改哪里 |
| --- | --- |
| 守谁/优先级 | 设置页名单（数组顺序即优先级）；`tick` 的遍历 `index.js:1072-1096` |
| 随机巡场算法/关键词 | `getRandomLiveRooms`（`lib/live.mjs:182-280`）+ `randomTour`（`index.js:1008-1029`） |
| 看多久换台 | `randomWatchMs`（config）→ `armRotateTimer`/`tick` 兜底 |
| 小房间不评分门槛 | `MIN_ONLINE`（`index.js:379`）与条件链 `393-405` |
| **下播后及时换台**（当前盲区） | 在 `tick` 里对 `rt.current` 补一次 `getRoomInfo(realRoomId).liveStatus` 检查；或给 `watch` 加下播轮询 |
| 名单全没播时干等 vs 巡场 | `randomWhenNoneLive`（config） |

风险：改选台逻辑容易引入「同一场反复进出」；`rt.recentRooms` 与 `rt.busy` 要一起考虑。

### D. 评分与推送（M）

| 想改什么 | 改哪里 |
| --- | --- |
| 默认权重/满分线 | `lib/rating.mjs` 的 `WEIGHTS`(315-329) 与 `LIKE_POINTS`(283)/`EXPECT_POINTS`(410)；**同步** `client.js:142-145` 手抄副本与 README |
| 加/删维度 | `WEIGHTS` + `computeScore` 的 `raw`/`baseRate`/`ratioOf`；新维度要确认 `parts`、`/status.weights`、笔记渲染都能跟上 |
| 改采集口径 | `collectStats`（`rating.mjs:88-228`）+ `index.js` 的 90s 采样与峰值合并（`213-267`） |
| 推送阈值/目标/文案 | `ratingPushScore`、`ratingPushUid`；`pushHighlight`（`index.js:326-374`）、触发条件 `529`、去重 `334-348` |
| 推送渠道扩展（webhook/多 UID） | `pushHighlight` 里替换/追加 `sendPrivateMsg`（`lib/live.mjs:358`） |
| 审核策略/阈值/免责规则 | `lib/moderation.mjs` 的 prompt(100-147)、`MAX_PENALTY`(22)/`MAX_DANMAKU`(21)、判定(178-185)；扣分应用 `index.js:427-434` |

风险：评分公式是「相对同规模期望」的调参结果，改 cap/锚点会整体改变分布；接口字段变化会静默漂移（所有请求都 `.catch` 吞错），改公式后建议拿几场历史笔记回放对账。

### E. 笔记与归档（S~M）

| 想改什么 | 改哪里 |
| --- | --- |
| txt → md / json / 双写 | `lib/recap.mjs` 的 `toText`(270-345) 与 `writeRecap`(360-374)；`listRecaps`(385-400) 的 `.txt` 过滤、`/records`、前端文件列表（`client.js:970-974`）要一起改 |
| 改模板/字段（评分块、摘录、主播原话） | `recap.mjs` 模板；`index.js` 只传 `summary/aiWords/rating/online`，扩展字段要两边都改 |
| 改输出目录 | `recapDir`（`recap.mjs:350-354`）；`/open-folder`、README 一起改 |
| 每日/周报 | 现在没有调度：可读 `listRecaps` 聚合，或参照 `schedule`（`index.js:1105-1109`）加定时器 + `state.json` 记上次时间 |
| 笔记进知识库/静态站 | 建议 md + front-matter（日期/主播/分区/分数/时长），便于 Obsidian/静态生成器消费 |

风险：换格式要同步「列表过滤 + 前端展示 + 打开文件夹」，漏一处就出现空列表。

### F. 采集与媒体（M~L）

| 想改什么 | 改哪里 |
| --- | --- |
| 画面清晰度（当前硬编码） | `lib/vision.mjs:19` 的 `qn='150'`；建议新增 `visionQn` 配置（DEFAULTS + normalizeConfig + 设置页 + `index.js:689` 透传） |
| 音频清晰度/切片/超时 | `audioQn`、`audioSliceMs`（config）；`index.js:604/727` |
| 换 ASR 模型/语言/Python | `asrModel`/`asrLang`/`asrPython`；语言提示词在 `tools/asr_worker.py:69-86` |
| 自建/换云端转写 | 唯一装配点 `ensureAsr`（`index.js:568-576`）；实现同构接口（`start/transcribe/cancelPending/stop/status/available`，`transcribe` 回 `{text,lang,sec,ms}`）即可整包替换 |
| 更多帧/出视频片段 | `grab_frame.py:43-48`（输出 JPEG）与 `vision.mjs:96-132`（GOP 策略）；要 mp4 需改抽帧脚本 |
| 接其它直播平台 | 换 `live.mjs` 的房间查询/弹幕客户端/发送 + `audio.mjs:getPlayUrl`；契约见 02 笔记 §7 |

风险：WBI 签名与弹幕协议是 B 站私有实现，改动后要重新验证签名/心跳/解压；换平台时 index.js 对 `liveStatus/realRoomId/uid` 的耦合要一起抽象。

### G. 设置页 UI（S~M）

| 想改什么 | 改哪里 |
| --- | --- |
| 加即时开关 | 仿 `client.js:652-657` 的 `ToggleRow` + `save({字段:v})`；后端补 DEFAULTS/normalizeConfig |
| 加保存型输入 | 改 `form` + 在 `formPatch`(318-360) 补一行；数值前后端都 clamp |
| 加卡片/调顺序 | `Panel` 的 return（`543-1008`）里插 `data-bl-sec` 块；顺序即区块顺序 |
| 加独立设置页 | `client.js:1056-1060` 再 register 一条 `settings.section`（id 唯一） |
| 修 UX 坑 | `save()` 覆盖 form（`309`）、无总开关 UI、登录 `status:'error'` 分支（`281-296`）、名单只同步一次（`237-242`） |

风险：hooks 必须在 `client.js:303` 的 early return 之前，否则 React #310；CSS 只注入一次，HMR 后不更新。

### H. 精简版（S~M）

「只要弹幕 + 笔记」或「只要评分」这类剪裁最省事，删除路径也清晰：

- 关掉即可（不改代码）：`listenAudio=false`、`visionEnabled=false`、`ratingEnabled=false`、`recapEnabled` 相关。
- 真要删代码：`index.js` 里删除音频块（568-824）、画面块（631-714）、评分调用（393-459）、推送（326-374/529）；`client.js` 删对应区块；`lib/` 删未引用模块；`package.json files` 与 README 目录结构同步。
- 建议保留 `config.mjs` 的键（缺失会被 normalize 兜底），或同步删除 DEFAULTS 键与前端控件。

风险：删采集时注意 `ctx.effect` 清理与 `tmp/` 清理调用点；删评分后 `/status` 的 `rating/weights` 字段前端仍会读，要么保留空值要么同步删前端。

### I. 平台扩展（L）

要接 YouTube/Twitch/斗鱼等：抽象一个「房间查询 + 弹幕事件流 + 发送」接口，替换 `lib/live.mjs` 与 `audio.mjs:getPlayUrl`；`audio/vision/asr/recap/rating` 与平台无关，可原样复用。评分采集（`rating.mjs` 的 B 站接口）需要按平台重写或做能力开关。

## 4. 推荐路线（按意图组合）

| 路线 | 内容 | 工作量 | 适合 |
| --- | --- | --- | --- |
| **轻定制** | A 改名/文案/主题 + 调整默认配置（守谁、时长、开关） | S | 只想让它更像自己的、少折腾 |
| **内容定制** | E 笔记 md/JSON + 推送渠道（webhook/多账号）+ 周报 | M | 想把它当「直播观察日记/情报源」 |
| **玩法定制** | C 巡场策略 + D 评分重构 + B 回复人设 | M~L | 想做出和原版不同的「AI 观众」体验 |
| **精简版** | H 只留弹幕+笔记（或只留评分），去掉 ASR/画面/推送 | S~M | 嫌重、机器带不动、只想要核心价值 |

建议顺序：**先装基线跑通 → 再选一条路线 → 每次只动一个子系统 → 每步可回归**。

## 5. 每次改动的回归检查清单

- [ ] 新配置键已在 `DEFAULTS` + `normalizeConfig`（否则 `mergeConfig` 静默丢弃）
- [ ] `/status` 结构变化只加不改；前端读不到新字段时不会崩
- [ ] 降级路径：无凭证 / 无 llm / 无 python / 无画面 / B 站接口失败，各试一次
- [ ] 定时器、子进程、监听都有清理（`ctx.effect`）；插件停用后无残留
- [ ] 重启 DSH 两次，确认没有重复注册/重复堆叠
- [ ] 改评分/推送时，拿一场旧笔记对账数字；改格式时确认列表与前端显示正常
- [ ] 文档同步：README、本指南、`docs/notes/` 里对应行号（行号漂移是常态，改完顺手更新）
- [ ] `git diff` 自查：不提交 `config.json`/`credential.json`/`recaps/`（`.gitignore` 已覆盖）

## 6. 仓库与版本策略

- **fork 而不是裸改**：在 GitHub 建你自己的远端（原仓库 `origin` 指向 `GASNOOVA/dsh-bili-live`），把 `origin` 改成你的、加 `upstream` 指原仓库，方便以后同步上游修复。
- **分支**：`main` 保持可跑；定制在一个或多个 `personal/*` 分支；每完成一个方向合并一次。
- **版本号**：`package.json.version` 从 `0.9.3` 起按自己的节奏递增（如 `0.10.0-personal.1`）；设置页会显示这个版本，方便确认装的是哪份。`engines.dsh` 保持兼容范围，DSH 升级后再调。
- **发布方式**：只在本机用 `link:` 安装即可；要分享再考虑私有 npm/GitHub（`dsh plugin add github:你/仓库`，注意 git 托管包安装会触发构建批准流程，而本插件无构建脚本，通常直接可用）。
- **许可证**：MIT，保留原版权与 LICENSE 声明即可（README 里注明「基于 GASNOOVA/dsh-bili-live 的个人定制版」）。

## 7. 下一步

把你想改的方向（A~I 任意组合，或直接描述需求）告诉我，我会按本指南给出：
1. 一份具体的改动清单（文件/行号/新增配置项/前端控件）；
2. 需要新增的 prompt、模板或接口设计；
3. 分步实施顺序与每步验收方法。

如果暂时没想好，也可以先做「基线安装 + 跑通」，再在真实使用中发现问题——本页 §3 里已经标出了几个现成的改进点（画面清晰度配置化、下播检测、笔记 md、设置页 UX、总开关 UI）。
