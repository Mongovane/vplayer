# VPlayer (`v143`)

一个基于 Cloudflare Pages + Workers + D1 + R2 的沉浸式风向标（Vane）PWA 音乐播放器，从 [CPlayer](https://github.com/ChKSz/CPlayer) 重构演进而来。

**线上地址**: [vplayer4.pages.dev](https://vplayer4.pages.dev)

## 功能概览

### 播放与多源容灾
- **三源搜索与智能回退**：支持网易云音乐、QQ 音乐、酷狗音乐三源搜索与跨源同名歌曲智能匹配（12 节点内置落雪/GD/Meting/NCM 混合音源池自动容灾，免 `MUSIC_API_KEY` 亦可开箱即用）。
- **六档蒲福风级音质**：`自动` / `128k 轻风` / `320k 强风` / `无损 FLAC 大风` / `192kHz/24bit 狂风` / `超清母带 飓风`，在播放界面徽章一键切换。
- **风眼全屏沉浸歌词（VANE Eye）**：
  - **右下探入式风眼背景表盘**：放大至视口 1.7 倍的风向标表盘从右下角探入背景，刻度、流金进度弧与指针随音乐实时旋转，与主页视觉一脉相承。
  - **小字居中 + 当前行平滑放大 + 行内逐字流金上浮**：未唱到行保持 `17px` 柔和半透明居中排布（无高斯模糊伪影与换行重排闪烁）；唱到当前行（`.lyric.is-active`）平滑放大至 `26px` 粗体，并叠加字符级（`.ch`）从左到右流金染色、微幅上浮跳动与暖金光晕。
  - **长间奏三点呼吸指示**：两句歌词间隔较长时自动浮现三枚金色圆点依次点亮与放大呼吸。
  - **顶部方位角读数与任意状态跳播**：顶部展示单行「曲名 · 歌手」与金色等宽方位角时间（如 `NE 055° · 0:41`）；手动上下滑动歌词浮现 `▶ 1:23 · 跳播` 胶囊（3 秒无操作自动归位），无论当前处于播放中、暂停态、冷启动未播态还是 iOS 锁屏保活态，点击跳播胶囊或任意歌词行均在手势内同步定位并立即发声（`engine.seekAndPlay()`）。
- **多平台官方热榜**：
  - **网易云音乐（精选 4 大常见榜）**：`飙升榜` (`19723756`)、`热歌榜` (`3778678`)、`新歌榜` (`3779629`)、`原创榜` (`2884035`)。
  - **QQ 音乐热榜**：`QQ 热歌榜` (`qq:26`)、`QQ 飙升榜` (`qq:62`)、`QQ 新歌榜` (`qq:27`)、`QQ 流行指数` (`qq:4`)。
  - **酷狗音乐热榜**：`酷狗 TOP500` (`kg:8888`)、`酷狗 飙升榜` (`kg:6666`)、`酷狗 热歌榜` (`kg:52144`)。

### 收藏与云端共享库
- **增量收藏同步**：每次收藏/取消收藏作为幂等增量（`add` / `remove`）自动同步至 D1，支持离线操作入队与多端合并。
- **R2 云端音乐库**：音频字节跨设备共享存储、Range 断点播放、一键全部入库、一键从云端恢复到收藏。
- **精简折叠设置面板**：常规播放、音质、离线配额与外观设置直观呈现；站长专属的邀请码生成、成员管理、曲库维护及酷狗控制台提取脚本统一收纳在默认折叠的「高级与站长管理」折叠区中。

### 离线与 PWA
- **IndexedDB 离线存储**：支持 `512M / 2G / 8G / 不限` 配额管理、LRU 自动淘汰、Range 断点续传与持久化存储申请（默认关闭自动全量缓存，避免挤占手机空间）。
- **移动端五栏贴底导航**：`歌词 / 队列 / 搜索 / 收藏 / 榜单` 吸底导航条（`height: calc(56px + env(safe-area-inset-bottom))` 零缝隙贴合 iOS 主屏幕底部安全区），搜索与收藏面板内置二级筛选/排序栏。
- **Service Worker 平滑热更新**：三端版本号（`public/index.html`、`public/sw.js`、`public/src/main.js`）严格对齐（当前 `v143`），版本升级时通过 `reg.update()` + `SKIP_WAITING` 原地平滑接管并保留离线缓存，绝不调用 `unregister()` 破坏离线可用性。

## 零回归研发与迭代规范（Non-Regression Engineering Specification）

为确保后续任何 Bug 修复或新功能开发**绝对不会破坏已有正常使用的功能**，本项目实行以下强制性工程规范：

### 1. 提交与打包前必跑的六道自动化门禁 (`npm run check`)

任何代码修改完成后，必须完整执行 `npm run check` 并确保 **0 Error、0 Warning、全部测试 100% 通过**：

```bash
npm run check
```

`npm run check` 依次串联以下 6 道硬性检查：

| 序号 | 检查脚本 | 防御的回归问题 |
| :--- | :--- | :--- |
| **1** | `eslint . --max-warnings=0` | 拦截 `no-undef` 跨函数作用域引用错误、未定义变量与死代码 |
| **2** | `node scripts/build-icons.mjs` | 校验并同步 `public/index.html` 内置的 26 个 SVG 精灵图标字形 |
| **3** | `node scripts/check-dom-contract.mjs` | 校验前端 4 个源码模块引用的全部 297 个 DOM ID 与 `document.querySelector` 选择器在 `index.html` 中 100% 存在且唯一；校验所有 `<details>` 默认闭合（无 `open` 属性）；**强制校验 `index.html`、`sw.js`、`main.js` 三端版本号一致且不含 `.unregister()`** |
| **4** | `node scripts/check-store-contract.mjs` | 校验 `store.js` 的 35 个状态键与全仓 470+ 处读写订阅完全闭合，杜绝键名拼写错误 |
| **5** | `node scripts/check-schema.mjs` | 在真实 `node:sqlite` 引擎上执行两遍 `schema.sql`，验证建表/迁移语句 100% 幂等且不含 D1 禁用的复合查询语法 |
| **6** | `node scripts/check-sync-start.mjs` + `npm test` | 静态校验 `engine.js` 的 iOS 锁屏同步起播窗口不变量，并运行 6 大测试套件共 **136 项单元测试** |

### 2. 核心模块修改红线（严禁回退的既有契约）

1. **音频引擎与 iOS 锁屏红线 (`public/src/engine.js`)**
   - **同步起播窗口不可破**：`playIndex()` 在命中预热缓存（`warmGet`）或云端直连时，必须在第一个 `await` 之前同步执行 `audio.src = ...` 与 `audio.play()`；MediaSession 的 `play`、`pause`、`previoustrack`、`nexttrack` 处理器严禁声明为 `async`。
   - **锁屏与中途断流严禁误切歌**：当曲目已播放超过 2 秒（`isMidSong`）或处于锁屏后台（`document.visibilityState === 'hidden'`）时，遇到网络波动或流截断必须优先同步重连当前曲目并跳回断点（`pausedAt`），**严禁调用 `skipBroken()` 自动跳到下一首**。
   - **峰值时长保护不可删**：必须维护单曲峰值时长 `peakDuration` 与 `expectedTrackDuration()`，禁止 `durationchange` 在流截断时将 `store.duration` 改小。
   - **自动切歌防重入锁不可破**：`timeupdate` 曲末预切歌与 `ended` 事件必须通过 `fromAutoAdvance` 和 `lastAutoAdvanceAt` 互斥，且 `playIndex` 在 `fromAutoAdvance: true` 时不得同步清空 `advancing` 标志。
2. **全屏歌词与移动端视口布局红线 (`public/src/lyrics.js`、`public/styles/vane.css`)**
   - **底部五栏导航贴底**：移动端 `.mobile-nav` 必须保持 `position: fixed; left: 0; right: 0; bottom: 0; height: calc(56px + env(safe-area-inset-bottom))` 与 `padding-bottom: env(safe-area-inset-bottom)`，严禁叠加多余底部外边距导致悬空。
   - **全屏歌词零重排闪烁**：歌词行激活切换时仅通过 `.is-active` 的 `font-size` / `opacity` 过渡与行内 `.ch` 字符 `transform` / `color` 更新实现，严禁对 `.lyric` 使用 `transform: scale()` 或在 `timeupdate` 中重建整表 DOM；后台/锁屏时自动暂停 `requestAnimationFrame` 循环。
   - **面板与二级搜索工具条**：切换移动端底部五栏（队列/搜索/收藏/榜单）时，必须同步设置 `document.body.dataset.mobilePanel = 'drawer'` 并联动 `#favSearchBar` / `#queueActionsBar` 的显隐。
3. **安全与鉴权红线 (`functions/api/[[path]].js`、`functions/api/_members.js`、`public/src/api.js`)**
   - 外部流与封面代理（`/api/stream`、`/api/image`）必须经过 `isPrivateHost`（含 `100.64.0.0/10` CGNAT、十进制/十六进制 IP、`::ffff:` IPv4-mapped IPv6 拦截）校验；`/api/image` 必须强制校验 `image/*` MIME 白名单并返回 `x-content-type-options: nosniff`。
   - `OWNER_SECRET` 校验必须保持恒定时间比较，邀请码兑换 `UPDATE` 必须携带 `AND (max_uses = 0 OR used < max_uses)` 原子条件；前端所有 API 请求遇到 `401` 必须触发 `onUnauthorized()`。
4. **测试先行与回归单测只增不减**
   - 每次修复 Bug 或新增特性，必须在 `test/` 对应测试文件中补充回归用例，确保同一问题永不复发。

## 架构

```
public/
├── index.html            # Shell + SVG 图标精灵 + 自定义 vane 标志 + 风眼全屏歌词与五栏导航
├── styles/vane.css       # Vane 设计系统 + 桌面/移动响应式布局
├── sw.js                 # Service Worker（平滑热更新 + 离线缓存）
├── manifest.webmanifest  # PWA 配置（viewport-fit=cover）
├── src/
│   ├── store.js          # 状态管理（按 key 订阅 + 持久化偏好 + 历史栈）
│   ├── api.js            # API 客户端 + 多平台榜单 + IndexedDB 歌词缓存 + LRC 解析
│   ├── engine.js         # 音频引擎（iOS 锁屏保活 / 同步起播 / 断流续播 / 防误切歌）
│   ├── dial.js           # 表盘（拖拽 seek / 行波风羽 / 封面色调提取）
│   ├── list.js           # 虚拟滚动列表（队列 / 搜索 / 收藏 / 榜单共用）
│   ├── lyrics.js         # 风眼全屏歌词（1.7x 背景表盘 / 居中放大 / 逐字流金上浮 / 跳播起播）
│   ├── main.js           # 组装：DOM 绑定 / 播放模型 / 手势 / 抽屉面板 / 批量导入
│   └── offline.js        # IndexedDB 离线（增量落盘 / 续传 / LRU / 标签读取 / 导入）
functions/api/
├── [[path]].js           # Pages Function：API 代理 + 多平台热榜 + 12 节点音源池 + SSRF 防护
├── _library.js           # R2 + D1 服务端音乐库（Range 播放 / 审核队列 / LRU 淘汰）
├── _members.js           # 成员与邀请码鉴权（恒定时间校验 / 并发安全兑换 / 增量收藏同步）
└── _lyrics.js            # D1 服务端歌词持久缓存
scripts/
├── build-icons.mjs       # Lucide SVG 图标精灵构建与引用检查
├── check-dom-contract.mjs# DOM ID / 选择器 / <details> / 三端版本号一致性检查
├── check-store-contract.mjs # Store 状态键读写契约检查
├── check-schema.mjs      # schema.sql 幂等性与脏数据迁移双遍检查
└── check-sync-start.mjs  # iOS 锁屏同步手势起播静态不变量检查
test/
├── engine.lockscreen.test.mjs # 62 项音频引擎与 iOS 锁屏回归测试
├── permissions.test.mjs  # 33 项权限、12 节点音源池与跨源解析测试
├── charts.test.mjs       # 15 项网易云/QQ/酷狗多平台榜单测试
├── lyric-cache.test.mjs  # 12 项服务端歌词缓存测试
├── eviction.test.mjs     # 9 项离线缓存淘汰与歌名归一化测试
└── boot.test.mjs         # 5 项 DOM 缺失容错启动测试
```

### 播放模型

列表分两类，因为「点一首歌」在两类列表里意味着不同的事。

- **你自己的列表（收藏、本机音乐、载入的歌单）**：点一首就是「播这个列表」，走 `playFrom()`，整体成为播放上下文，按「下一首」顺着它走。
- **浏览用的列表（搜索结果、榜单）**：点一首只是「听听这首」，走 `playFromBrowse()`：
  - 队列为空 → 整个列表成为上下文，「下一首」顺着正在看的结果走；
  - 队列非空 → 只把这一首插到当前播放位置之后，队列原样保留，「下一首」回到队列里继续。
  - 若想让浏览结果整体替换或追加到队列，可使用面板顶部的 `播放全部 / 加入队列` 按钮。

### 多平台榜单

「榜单」面板支持一键切换三大平台官方排行榜：

- **网易云音乐**：保留最常用的 4 个官方榜（`飙升榜`、`热歌榜`、`新歌榜`、`原创榜`），直连公开接口与客户端/边缘 30 分钟缓存，浏览榜单不消耗计费 API 额度。
- **QQ 音乐**：内置 `QQ 热歌榜`、`QQ 飙升榜`、`QQ 新歌榜`、`QQ 流行指数`，优先直连 `u.y.qq.com` `ToplistInfoServer`，失败时自动回退至 `c.y.qq.com` 与镜像源。
- **酷狗音乐**：内置 `酷狗 TOP500`、`酷狗 飙升榜`、`酷狗 热歌榜`，优先直连 `mobilecdn.kugou.com/api/v3/rank/song`，失败时自动回退至 `m.kugou.com/rank/info/`。

### iOS 锁屏与防误切歌机制

1. **同步手势起播窗口**：MediaSession 的 `play / pause / previoustrack / nexttrack` 携带的后台发声授权不会跨过事件循环，因此 `playIndex()` 在命中预热缓存时必须在第一个 `await` 前完成 `audio.src` 绑定与 `audio.play()`。
2. **双向邻居 `blob:` 预热与动态让路**：按歌曲 ID 预热上一首、下一首及当前曲目为本地 `blob:` 对象 URL（最多驻留 3 个 `blob:`，超出自动 `revokeObjectURL`，单曲超 48MB 自动降级流式）；当正在播放的网络流缓冲余量低于 5 秒时，立即中断后台预热下载（`cancelWarm()`）以保障当前播放不断流。
3. **锁屏暂停静音保活（`iosKeepAlive`）**：iOS 锁屏下一旦 `<audio>` 真正停止超过 5 秒，系统会收回音频会话导致再次点击播放无声。启用保活后，锁屏暂停时自动切换为与原曲等长的超低采样率静音 WAV 循环并钉住锁屏进度条（`playbackRate: 0.0000001`），使锁屏及 AirPods 暂停超过 5 秒后仍可随时恢复发声或切歌（最长保活 5 分钟，回到前台立即退出保活）。
4. **五重锁屏防误切歌保护（`v143`）**：
   - **`fromAutoAdvance` 防双重切歌锁**：修复 `playIndex()` 同步重置 `advancing = false` 导致 `timeupdate` 曲末预切歌后又被 WebKit 尾随 `ended` 事件二次触发 `next()` 的问题；且 `timeupdate` 预切歌仅在下一首已同步就绪（`nextWarmReady`）时触发。
   - **峰值时长 `peakDuration` 锁定**：防止锁屏下 HTTP 流中途断开时 WebKit 先触发 `durationchange` 将 `audio.duration` 改小为已播放秒数，进而导致 `timeupdate` 误判曲末切歌或 `ended` 漏检截断流。
   - **中途截断流原地续播**：当 `ended` 触发但当前位置距 `expectedTrackDuration`（综合 `peakDuration`、`track.duration`、`store.duration` 及末行歌词时间戳）仍差 8 秒以上时，自动重连当前音源并 Seek 到截断秒数继续播放，绝不提前跳到下一首。
   - **中途 `error` 同步重连与禁跳保护**：播放已推进超过 2 秒后若触发 `<audio>` `error` 事件，优先在事件栈内同步重绑当前曲目并跳回断点；即使锁屏下网络彻底中断，也仅在断点处暂停提示，**严禁调用 `skipBroken()` 切到下一首**。
   - **本地 `blob:` 免 TTL 误销毁**：修复 `warmGet()` 误按 HTTP URL 检查 8 分钟 `WARM_TTL` 导致已下载的本地 `blob:` 被提前回收的问题，且严禁对正在播放的 `blob:` 调用 `URL.revokeObjectURL`。

## 数据库 (`schema.sql`)

只有一份幂等 SQL 文件 `schema.sql`，既能建新库也能升级旧库，可任意次数重复执行：

```bash
npm run db          # 远端 D1
npm run db:local    # 本地 miniflare
```

## 部署

```bash
# 1. 安装依赖并执行全量门禁检查
npm install
npm run check

# 2. 初始化或更新 D1 数据库（可选）
npm run db

# 3. 部署至 Cloudflare Pages
npx wrangler pages deploy public --project-name=vplayer
```

## 许可

代码: MIT  
图标: Lucide (ISC)
