# v166 · 阻断桌面端登入自动下载歌曲、登入站点（#loginGate）铭牌化重塑 & 九色铭牌光谱图标设计

1. **深度排查并修复桌面端成员登入后自动下载歌曲的三大根因（`public/src/store.js`、`public/src/main.js`、`public/src/engine.js`、`functions/api/_library.js`、`functions/api/[[path]].js`）**：
   - **根因 1（桌面端 `navigator.connection` + 收藏同步早于云端曲库加载触发 `sweepAutoOffline`）**：iOS Safari 不支持 `navigator.connection`（`onWifi()` 恒为 `null`），而桌面端 Chrome/Edge 的 `onWifi()` 返回 `true`；且成员登入后 `flushFav()` / `memberFavorites()` 在 `refreshCloudLibrary()` 完成前先写入 `store.set({ favorites })`（此时 `libraryIds` 仍为空），导致云端曲库歌曲被误判为未离线而触发每轮 12 首的批量后台下载。现已加入 `auto_offline_v3` 迁移将历史自动下载开关重置为 `off`，强制在同步收藏前先 `await refreshCloudLibrary()`，并在 `sweepAutoOffline()` 中增加登入态与云端曲库就绪门控。
   - **根因 2（登入后静默恢复 `autoplay: false` 触发 `<audio preload="auto">` 与 `warmNeighbours({ bytes: true })` 后台拉取整首音频）**：`restoreSession()` 在静默恢复时调用 `el.pause()` 触发 `<audio>` 的 `pause` 事件，进而启动 `scheduleWarm(200, { bytes: true })` 后台解析 10 首歌曲并通过 `warmBlob()` 下载整首无损/母带音频字节。现改为静默恢复时使用 `preload="metadata"`、不冗余触发 `el.pause()`，且在用户未开始播放前禁止 `store.on` 与 `playIndex(autoplay: false)` 触发后台预热与 `warmBlob` 下载。
   - **根因 3（音频流返回 `application/octet-stream` 触发桌面浏览器/IDM 下载弹窗拦截）**：`serveTrack` 与 `relayAudio` 现根据音频后缀自动补齐标准 `audio/flac`、`audio/mpeg`、`audio/mp4` 等 MIME 类型并显式设置 `Content-Disposition: inline`，杜绝桌面下载器拦截弹窗。
2. **未登入时弹出的登入站点（`#loginGate`）全面重塑为 3D 挂绳铭牌 UI（`public/index.html` & `public/styles/vane.css`）**：
   - 去除原有暗黑背景遮罩，改为与主舞台一致的米白方格纸铭牌背景 + 顶部九色铭牌主题切换胶囊栏（未登入亦可实时切换 9 种铭牌配色）。
   - 采用仿真编织挂绳（`VANE AUDIO`）、立体金属银色夹扣、吊环孔位、防伪星芒铭牌环、票根输入框及底部条形码（`VANE AUDIO PASS · NO. VP-GATE`）完整呈现铭牌核验质感。
3. **基于 9 款铭牌配色灵感大胆重设计全套应用图标（`public/img/vane.svg`、`public/img/vane-maskable.svg`、`180/192/512 PNG` & `#i-pass-logo`）**：
   - 以「九色铭牌光谱扇面 + 编织挂绳金属夹 + 黑胶防伪光谱环 + 风向标指针 + 铭牌条形码」为核心视觉语言，同步更新 SVG 矢量图标、iOS/PWA 多尺寸超采样 PNG 图标与顶栏品牌徽标。

---

# v165 · 修复多次甩牌切歌封面图卡在上一首 & 修复首次打开 PWA 误报「音源打不开」

1. **修复多次连续甩牌切歌时铭牌内封面图不更新或停留在上一首的问题（`public/src/lanyard.js`）**：
   - **根因定位**：甩牌切歌会开启 260ms 的动画加速窗口（`flingBoostUntil`），将 `update()` 的重绘延后到定时器中执行；但第一次 `update()` 已立刻通过 `Object.assign(settings, nextProps)` 把 `settings.frontImage` 改成了新歌封面，当 260ms 窗口内触发第二次 `update()`（如歌词、音质标签、播放状态回写或再次甩牌）时，局部变量 `prevCover = settings.frontImage` 读到的已是新歌封面 URL，从而在定时器触发时误判为「封面未变化（`settings.frontImage === prevCover`）」，直接跳过了 `apply()` 与 `loadImage()`，导致 `images.front` 永久停留在上一首歌的图片。
   - **修复方案**：改为以实际完成加载并绑定到卡面的 `loadedFrontUrl` / `loadedBackUrl` 作为唯一比对基准，并在 `update()` 检测到 URL 变化的第一时间立即清空旧歌封面引用、同步读取已缓存图片（`resolvedImages`）或立即发起新封面网络预加载（无需等待 260ms 动画结束）；同时在 `loadImage()` 中加入免 CORS 自动降级重试与失败缓存剔除（`cache.delete(url)`），彻底杜绝连续甩牌时封面残留或加载失败缓存锁死。
2. **修复首次打开 PWA 时误报「这首歌的音源打不开，换个音质或音源再试」（实际按播放可正常播放）的问题（`public/src/engine.js` & `public/src/main.js`）**：
   - **根因定位**：首次打开 PWA 时，若在未满足 iOS WebKit 同步手势激活或异步 `resolveTrack()` 跨网络耗时后调用 `audio.play()`，WebKit 会因自动播放策略抛出 `NotAllowedError`（此时 `audio.src` 已成功绑定有效音源地址且 `audio.error` 为 `null`）；此前 `playIndex()` 与 `recoverBadSource()` 的 `catch` 分支未区分浏览器策略拒绝（`NotAllowedError` / `AbortError`）与真实媒体源损坏（`NotSupportedError` / `audio.error`），将策略拦截误判为音源损坏并写入 `这首歌的音源打不开，换个音质或音源再试`，而用户随后点击播放按钮时因处于同步手势且 `audio.src` 已就绪故能立即正常播放。
   - **修复方案**：
     - 在 `playIndex()` 与 `recoverBadSource()` 中识别 `NotAllowedError` / `AbortError`（且 `!audio.error`），绝不触发错误源恢复或显示「这首歌的音源打不开」，而是保持已解析好的 `audio.src` 待命并静默归位待播态（`playbackError: ''`）。
     - 在首次前台手势触发未预热曲目播放（`!audioUnlocked`）时，于 `await resolveTrack()` 之前同步绑定内存静音帧激活 iOS `<audio>` 元素，避免异步解析返回后手势令牌过期。
     - 在 `boot()` 启动流程中将本地 IndexedDB 离线曲目清点（`refreshOfflineIds()`）与版本号渲染前置到 `restoreSession()` 之前，确保已离线缓存的歌曲在首屏恢复时直接命中本地存储。

---

# v164 · 全站浏览器级 E2E 审计、弹窗控件浅色统一 & DOM/CSP 安全加固

1. **修复弹窗内切换栏与次级按钮残留的深色样式**：
   - 挂牌/撕票弹窗顶部的模式切换栏（`#postcardModePick`：`3D 全息铭牌 | 撕歌词票 | 2D 海图签`）、入库音质选择栏（`#ingestQualityPick`）及版本切换栏（`#verSrc`）原先继承了 `.sg.srcpick` 的 `rgba(0, 0, 0, 0.35)` 黑灰底色，现已全部统一为浅色磨砂槽 + 主题色选中胶囊。
   - 统一弹窗标题（`.sheet__head h2`）、关闭按钮、次级操作按钮（如 `系统分享`）及 iOS 添加主屏幕提示条（`#iosInstallHint`）的浅色对比度，并重映射 `--brass-hi` / `--brass-lo` 避免点击主按钮时闪现旧版暗金配色。
2. **修复撕歌词票模式下点击「保存海报图片」的导出逻辑**：
   - 在「撕歌词票」视图下点击保存或分享时，自动实时重绘锯齿票根画布并以 `vane-ticket-<歌名>.png` 导出，提示「已保存撕下的歌词票」。
3. **DOM 构造与防御性代码加固（零异常启动）**：
   - `list.js` 的 `#createRow()` 由 `innerHTML` 拼接改为原生 `document.createElement` / `createElementNS` 直接构造，消除虚拟列表创建行时的 HTML 解析开销并完全兼容严格 CSP Trusted-Types。
   - `glass-icons.js` 增加对 Safari 锁定模式 / 防指纹扩展下 `ctx.createImageData()` 返回空值的保护；`dial.js` 补齐 `els.svg.closest?.()` 可选链；`main.js` 补齐 `window.scrollTo?.()` 与 `.focus?.()` 保护。

---

# v164 · 全站 Chromium 浏览器真机视口验证与 5 项 UI/交互细节修复

通过无头 Chromium（393×852 iPhone 视口）逐屏截图与计算样式审查，发现并修复以下 5 处细节问题：

1. **修复打开队列/搜索/收藏/榜单弹层时底部五合一导航栏被模糊遮挡**：
   - 此前 `.panel-scrim` 设为全屏高度（`var(--app-h)`）并开启 `backdrop-filter: blur(8px)`，导致其盖在底部 `#rail` 导航栏上方使五个图标变模糊且阻挡点击。
   - 现将 `.panel-scrim` 恢复为透明点击层（`height: calc(var(--app-h) - 62px); background: transparent; backdrop-filter: none`），背景柔化完全由 `body.on-card` 元素级滤镜承担，既无黑灰断层线，又保证底部导航栏始终 100% 清晰可点。
2. **修复队列/收藏列表中无封面曲目的深黑底色块（`.row__thumb.th`）**：
   - 在铭牌浅色皮肤下，将曲目行默认占位缩略图由深黑蓝渐变改为跟随角色主题色的暖白浅色渐变卡片，消除列表左侧的黑块突兀感。
3. **修复挂牌/撕票弹窗（`#postcardScrim`）内部多处排版与深色残留**：
   - 修复弹窗顶部三段切换槽（`#postcardModePick`）此前残留的深灰底色（`rgba(0,0,0,0.35)`）与青色选中态，统一为浅色磨砂槽 + 主题红选中胶囊。
   - 隐藏 `#postcardLanyardWrap` 顶部与挂绳重叠的英文副标题行（`.vp-crew-title-row`），并将弹窗标题精简为单行不换行（`航海铭牌 · 3D 铭牌与歌词票`）。
   - 修复「撕歌词票」视图中无封面歌曲显示裂图图标的问题（自动回退至 `/img/vane-192.png`）。
4. **修复设置页「离线下载音质」标题被挤压折行**：
   - 为 `#settingsScrim .sn .si__title` 增加 `white-space: nowrap; flex: none`，并为设置页顶栏增加细微底部分隔线。
5. **优化首次进入主舞台的铭牌入场摆幅与初始歌词加载**：
   - 收敛 `placeHanging(..., intro=true)` 的初始横向偏移与角速度，避免入场前 1.5 秒铭牌摆出屏幕左边缘；冷启动加载默认精选歌单时自动静默预解析首曲歌词与封面。

---

# v163 · 移除陀螺仪全息光 & 合并两段式下拉手势（短拉暂停/播放 · 深拉撕歌词票）

1. **移除陀螺仪全息光**：
   - 彻底移除 `lanyard.js` 中的 `deviceorientation` / `devicemotion` 监听与权限请求，默认铭牌恢复纯净柔光白卡质感（`foil: 0.0`），零传感器开销。
2. **合并两段式下拉铭牌手势（短下拉暂停/播放 · 继续深拉撕歌词票）**：
   - **第一段（下拉 `56px ~ 118px`）**：显示提示 `⇣ 松手暂停/播放 · 继续下拉撕歌词票`，在此区间松手即触发 **暂停 / 播放**。
   - **第二段（继续下拉超过 `118px`）**：跨过阈值时触发一次轻震反馈，提示切换为 `⇣ 松手撕下当前歌词票`，松手后自动伴随仿真撕纸音效撕下当前歌词票并打开带 Lucide 剪刀图标的票根预览与保存弹窗。

---

# v162 · 修复 iOS PWA 陀螺仪全息光渲染与授权、Lucide 剪刀图标替换与下拉暂停/长按撕票解耦

1. **修复 iOS PWA 中陀螺仪全息光不生效的 3 个根因**：
   - **手势授权时机**：iOS WebKit 的 `DeviceOrientationEvent.requestPermission()` 与 `DeviceMotionEvent.requestPermission()` 仅在 `click` / `pointerup` / `touchend` 中允许弹窗授权（在 `pointerdown` 中调用会被系统静默拒绝）。现已改为在 `pointerup` / `click` / `touchend` 中请求权限，并同时监听 `deviceorientation` 与 `devicemotion`（重力加速度兜底）。
   - **白底 PVC 卡面合成模式修复**：Canvas 2D 中 `globalCompositeOperation = 'overlay'` 在纯白像素（`#ffffff`）上数学计算恒等于纯白（`1.0`），导致彩虹全息光在白色铭牌正面完全隐形。现已改为半透明彩虹棱镜渐变 + 随陀螺仪倾角实时横移的对角激光束（`beamGrad`），倾斜手机即可看到明显的彩虹全息流光。
2. **「撕歌词票」全面换用 Lucide 矢量图标（`#i-scissors` / `#i-ticket`）**：
   - 移除原有的 `✂` 字符，在 SVG Sprite、撕票模式按钮（`#postcardModeTicket`）、齿孔裁切滑块（`#ticketTearHandle`）以及 2D Canvas 票面绘制中全部采用标准 Lucide Scissors 矢量图标。
3. **彻底解耦「下拉暂停/播放」与「撕歌词票」**：
   - **向下拉动 3D 铭牌**：100% 专用于 **暂停 / 播放（`⇣ 松手暂停 / 播放`）**，绝不再与撕歌词票冲突。
   - **长按铭牌歌词票框（0.42s）或点卡片按钮切至「撕歌词票」**：触发撕下当前歌词票弹窗，沿齿孔虚线向右滑动剪刀滑块即可撕下保存。

---

# v161 · 撕歌词票（Tearable Lyric Ticket）、陀螺仪全息光、透明歌词预览栏与冷启动/版本号修复

1. **修复 PWA 设置页版本号不自动刷新**：
   - 移除 `main.js` 中阻止启动前 15 秒内 `controllerchange` 热刷新的限制，当新版 Service Worker 接管且当前未在播放时立即无感刷新。
   - 在 `visibilitychange`（从后台唤醒 PWA）及点击设置页右上角版本号（`VANE · V161`）时主动触发 `reg.update()`，无需杀后台即可感知并升至最新版本。
2. **修复首次进入 PWA 误报「这首歌的音源打不开」+ 歌词预览框改为全透明背景**：
   - 冷启动静默恢复（`autoplay: false`）及云端 D1 残留孤儿记录回退时自动携带 `fresh=1` 重新解析鲜活音源，并在 `_library.js` 中自动清理缺失 R2 对象的孤儿记录，彻底杜绝进入 PWA 时误报红色错误。
   - 将主界面歌手下方的双行歌词预览框（`#lyricTicker` / `.ticker.ly`）背景设为全透明，去除白色底框、边框与阴影，直接融入铭牌网格背景。
3. **新增「撕歌词票」（Tearable Lyric Ticket）与「陀螺仪全息光」（Gyroscope Holographic Foil）**：
   - **陀螺仪全息光**：在 `lanyard.js` 中接入 `DeviceOrientationEvent`（iOS 首次触碰铭牌自动在手势内请求陀螺仪权限），倾斜手机时实时驱动卡面彩虹全息衍射角、高光掠影与轻微物理摆动。
   - **撕歌词票**：3D 铭牌正面歌词框升级为带齿孔与裁切虚线的「歌词票根」，在铭牌下半部歌词票区向下拉动（或点击卡片按钮切换至「✂ 撕歌词票」模式）即可沿齿孔虚线横滑/下拉撕开歌词票，伴随仿真撕纸音效、分段震动反馈与带齿孔边缘的高清歌词票 PNG 导出。

---

# v160 · 全屏歌词跳播对比度修复、设置身份铭牌与主舞台解耦 & 甩牌渲染微调

1. **评估并加固 v159 甩牌切歌 6 项性能优化**：
   - `paintFaces()` 返回布尔值，当卡面签名（`facesSig`）未变时，休眠状态下 `setProgress()` 与 `update()` 直接跳过 `render()`，避免冗余全屏绘制。
   - `getStaticLayer()` 在拖拽（`sim.grab`）或甩牌冲刺窗口（`flingBoostUntil`）期间复用已有静态离屏层，不在高速甩牌帧中重建离屏 Canvas。
   - `apply()` 触发切歌/换封面时自动调用 `touch()` 唤醒 5 秒微风，保证新歌切入时挂绳自然摆动。
2. **修复 PWA 全屏歌词滑动跳播时字体发白看不清**：
   - 原先 `#lyricOverlay .lyrics.is-scrolling p.lyric:not(.on):not(.is-active)`（米白 `rgba(241, 237, 226, 0.85)`）与 `p.lyric.is-seek-target`（浅黄 `#f3d378`）选择器权重高于铭牌浅色皮肤，导致手指滑动歌词跳播时整屏文字变成浅米白/浅黄色，在浅色网格背景上几乎隐形。
   - 现已在 `html[data-pass-skin="true"]` 下以更高优先级覆盖：滑动中未高亮行采用 `84%` 深色墨字（`opacity: 0.92`），瞄准跳播行（`.is-seek-target`）采用高饱和主题色 `var(--crew-brand)` 加白光描边衬底，清晰醒目。
3. **设置页身份铭牌（`#postcardScrim`）与主舞台 3D 铭牌彻底解耦**：
   - 独立维护 `postcardCrewChar`（持久化于 `vplayer:identityTheme`），在设置页打开「站长/船员身份铭牌」或点击弹窗内的 9 色按钮时，仅更新弹窗内部的独立身份铭牌与配色，绝不改动主舞台铭牌配色（`activeCrewChar`）与全站皮肤。
   - 移除 `#postcardScrim` 内 `mountLanyard` 的 `onFlingNext` / `onFlingPrev` / `onPullToggle` 绑定，并在 `lanyard.js` 中仅当传入对应回调时才显示「松手切下一首」提示胶囊，使设置页铭牌可自由拖拽把玩与翻转，绝不会误触切歌或暂停播放。

---

# v159 · 甩牌切歌卡顿优化

针对「3D 铭牌甩牌切下一首时掉帧、卡顿」。改动集中在 `lanyard.js`、`dial.js`、`main.js` 三处，不改变任何视觉设计与手势行为，唯一可见差异是：停止操作约 5 秒后，挂绳的轻微摇摆会渐渐静止（见第 1 条）。

## 改了什么

| # | 文件 | 问题 | 改动 |
|---|---|---|---|
| 1 | `lanyard.js` | `breeze` 默认 0.45，`resting` 要求 `breeze === 0`，动画循环永远不休眠，页面可见时每帧全量物理 + 重绘 | 无操作 5 秒后微风在 1.5 秒内淡出，卡片静止后循环停止；拖动、点按、切歌、翻面都会重新唤醒。另设兜底，超时无论能量如何都停 |
| 2 | `lanyard.js` | 每帧重画技术网格（30+ 条路径）、水印、竖排状态文字 | 画到离屏层，仅在尺寸 / 主题色 / 文案变化时重画，每帧一次 `drawImage` |
| 3 | `lanyard.js` | 每帧对整张卡片做 `shadowBlur = 34` | 阴影预渲染成精灵图复用（卡片远近变化 ±15% 内直接缩放）；无法创建离屏画布时回退到原写法 |
| 4 | `lanyard.js` | 每次 `update()`（歌词行、播放状态、音质变化）都重画正反两张 420×590 卡面 | 只立刻重画当前朝向的一面，另一面翻过来时再画；内容签名不变则完全跳过（进度环按 2.5% 量化，与 `setProgress` 一致） |
| 5 | `lanyard.js` | 掉帧时 `dt` 变大 → 物理子步增加 → 下一帧更慢 | 子步数上限 20（60Hz 正常情况下为 16，不受影响） |
| 6 | `lanyard.js` | 每帧重复解析颜色字符串 | `rgbaFromHex` / `darkenHex` 做小容量记忆化 |
| 7 | `dial.js` | 铭牌模式下表盘是 `display:none`，但播放时仍每帧改写 48 个 SVG 属性 | 检测到舞台为 lanyard 模式即停止；切回表盘时 `dial.wake()` |
| 8 | `main.js` | `engine.next()` 在 pointerup 里同步触发所有订阅者重绘（标题 DOM 重建 + 强制布局、队列/搜索/收藏/榜单列表、上下文） | 上述订阅改为 `deferred()`，合并到两帧之后；**`engine.next()` 与音频启动保持同步**（iOS 手势要求不受影响）。`paintReadout` 仅在标题文字变化时重建标题节点；去掉切歌 toast（卡片飞出本身就是反馈） |
| 9 | `vane.css` | 铭牌画布每帧重绘可能牵连外部布局 / 绘制 | `.stage-lanyard__host { contain: layout paint; }` |

版本号 `v158 → v159`（`index.html`、`sw.js`、`main.js`，`check-dom-contract` 已通过）。

## 验证

用一个记录调用的假 2D 画布，在 Node + jsdom 里把原版和新版 `lanyard.js` 各跑 60 帧：

| 每帧 | v158 | v159 |
|---|---|---|
| `stroke` | 32 | 6 |
| `beginPath` | 35 | 9 |
| `fillText` | 3 | 1 |
| `shadowBlur` 设置 | 1 | 0 |

静置 20 秒：v158 仍在每帧调度（1200 帧全部执行）；v159 约 10 秒后循环停止（610 帧）。
相同内容的重复 `update()`：卡面重绘 0 次；新歌词：由 2 张卡面降为 1 张。

测试：`engine.lockscreen` 64/64、`engine.real-audio` 4/4、`permissions` 34/34、`charts` 17/17、`eviction` 9/9、`lyric-cache` 12/12、`boot` 8/9（失败的那一项在 v158 原版同样失败，原因是 jsdom 对 `HTMLMediaElement.paused` 的限制，与本次改动无关）。

## 未验证的部分

以上是调用次数与逻辑层面的验证，**没有在真机上量过帧率**。阴影精灵与真实 `shadowBlur` 的观感可能有细微差别（精灵随卡片透视缩放，原来的模糊半径固定为设备像素）。建议在 iPhone 上对比一次；如果觉得阴影不够柔，调整 `lanyard.js` 中的 `SHADOW_BLUR`。

---

# 榜单加载修复

针对「榜单有时刷得出来有时候不行，弱网/无网时一直显示这个榜单是空的」。

两个 commit：`9b8d327`（服务端契约）、`30892a5`（客户端重试与恢复）。

## 为什么会这样

三件事叠在一起，第三件把前两件的影响从「一次请求失败」放大成「半小时不可用」。

**一、服务端把失败伪装成了成功。** `functions/api/[[path]].js` 的榜单分支只把非 2xx 当作失败。响应体解析不出来、网易云在 200 里塞 `code: -460`（Workers 出口 IP 每天都会撞上）、补详情的第二次请求失败——三种情况全部落到 `tracks = []`，然后照样返回 `ok: true`。

**二、客户端把「空」当成了事实。** 拿到 `tracks: []` 就显示「这个榜单是空的」。这是一句关于榜单的断言，而真实情况是关于请求的：我们不知道。

**三、这个错误结论被缓存了三层。** 空响应带着 `max-age=1800` 返回，进了 Cloudflare 边缘缓存和浏览器 HTTP 缓存；`chartCache` 这个 `Map` 又在会话内永久记住它。接下来的三十分钟里，重试、刷新、切 tab 全都拿回同一个缓存的假答案——请求根本没离开浏览器。这就是「时好时坏」的来源。

补详情那条路值得单独说：大榜单（热歌榜、飙升榜、新歌榜）只返回 `trackIds`，必须靠第二次 `song/detail` 请求补齐。原来那里是 `if (detail.ok)` 且没有 `else`。所以**最常点的几个榜恰好是最容易变空的**。

## 改了什么

### `functions/api/[[path]].js`

| 位置 | 改动 |
|---|---|
| 新增 `upstreamOk()` | 检查网易云放在 200 里的 `code`。缺失算通过（部分接口成功时不带该字段），只拦明确说「不」的。 |
| 榜单列表分支 | 解析失败 / `code != 200` / 列表为空 → 502 带原因，不再返回 `charts: []` |
| 榜单详情分支 | 解析失败 / `code != 200` / 缺 `playlist` → 502 |
| 补详情分支 | `if (detail.ok)` 补上失败路径：非 2xx、解析失败、`code != 200`、补完仍为空 → 全部 502 |
| 响应头 | `tracks.length ? 'public, max-age=1800' : 'no-store'` |

最后一条是把「坏三十分钟」变回「坏一次请求」的关键。

### `public/src/api.js`

新增 `callWithRetry()`：3 次尝试，600ms → 1.2s 退避，每次尝试独立 8s 超时与独立 `AbortController`。

超时这一项在地铁里比重试更重要：连接将死时 fetch 不会 reject，它会挂住，几十秒到几分钟。一个永不结束的转圈比一条错误更糟，因为错误是可以动作的。超时算作可重试失败；调用方自己的 `signal` 优先级最高。

`apiError()` 让抛出的错误带上 `status`。「502 值得再问一次，400 永远不会」这个区分，字符串消息保不住。

`charts()` / `chart(id)` 现在接受 `{ signal, onRetry }`。

### `public/src/main.js`

- **只缓存非空结果。** 原来先写 `chartCache` 再判空；而缓存命中会跳过 fetch，所以一次抖动就把这个榜单钉死一整个会话。
- **`chartSeq` 防陈旧响应。** 慢网下连点两个榜，先点的后到，会把 A 的曲目渲染到 B 的名字下面。
- **`chartAbort` 取消上一个请求**，而不是让它和新请求赛跑。
- **`setChartNote()` 用 `textContent` 写状态行**，重试按钮因此能活过状态切换，不会被下一次 `innerHTML` 赋值删掉。
- **`chartFailureNote()` 不再对不空的东西说空。** 离线就说离线——这告诉读者应用没坏、隧道坏了，而且这是唯一一种「等一下」真的正确的情况。
- **`bindChartRecovery()` 监听 `online`。** 之前全仓库没有任何 `online` 监听（`grep` 可验），所以信号盲区里的一次失败会一直留在屏幕上；离开面板再回来也没用，`chartsLoaded` 和缓存都声称活已经干完了。`showView('charts')` 现在也会重试未完成的失败。

### `public/index.html` / `public/styles/vane.css`

`#chartEmpty` 拆成 `#chartEmptyTitle`、`#chartEmptyNote` 和一个真实的 `#chartRetryBtn`。做成静态节点是因为运行时用模板字符串拼出来的按钮对 `scripts/check-dom-contract.mjs` 和 `test/boot.test.mjs` 都是隐形的——而这两个正是它哪天消失时唯一会出声的东西。

`.empty .btn { justify-self: center }`：空状态是单列居中网格，`justify-items` 默认 `stretch`，不加这条按钮会撑满整个面板，看起来不像按钮。

## 验证

```
$ npx eslint . --max-warnings=0        # 无输出，无警告
$ node scripts/check-dom-contract.mjs  # DOM contract holds (225 ids, 20 sprite glyphs, 4 sources)
$ node scripts/check-schema.mjs        # idempotent, and correct on legacy data
$ node scripts/check-sync-start.mjs    # synchronous-start invariant holds
$ npm test                             # 16/16 + 5/5 + 10/10 passed
```

`test/charts.test.mjs` 新增，断言的不是happy path 而是「失败长得像失败」。对着修复前的服务端代码跑，10 个用例里 7 个失败：

```
3/10 passed
  ✗ a truncated chart list is an error, not zero charts
  ✗ a NetEase refusal on the chart list is an error
  ✗ a failed detail call is an error, not an empty chart
  ✗ a truncated detail body is an error, not an empty chart
  ✗ a refusal on the detail call is an error
  ✗ a body with no playlist at all is an error        200 !== 502
  ✗ a genuinely empty chart is reported as empty, and never cached
        + 'public, max-age=1800'
        - 'no-store'
```

已加入 `npm test`，否则它永远不会跑。

## 部署后要做的一件事

边缘缓存里可能还存着修复前那些「`ok: true` + 空数组 + `max-age=1800`」的响应。部署完清一次 Cloudflare 缓存，或者等三十分钟，否则会以为没修好。

## 一个没动的已知问题

`npm install` 在这个仓库跑不通：`package.json` 里 `lucide-static@^0.5.0` 这个版本在 npm 上不存在（该包 0.1.x 之后直接跳到 0.4xx.x）。这让 `npm run check` 里的 `scripts/build-icons.mjs` 在任何干净环境下都装不上依赖。跑上面那些检查时我是把 eslint / globals / jsdom 装在旁边目录再 symlink 进来的，没有改 `package.json` —— 这是另一个问题，改法（降到 `^0.1.0` 还是升到 `^0.400.0`）取决于 `build-icons.mjs` 用了哪些图标名，留给你定。
