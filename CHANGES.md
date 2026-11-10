# v160 · 全屏歌词跳播对比度修复、设置身份铭牌与主舞台解耦 & 甩牌渲染微调

1. **评估并加固 v159 甩牌切歌 6 项性能优化**：
   - `paintFaces()` 返回布尔值，当卡面签名（`facesSig`）未变时，休眠状态下 `setProgress()` 与 `update()` 直接跳过 `render()`，避免冗余全屏绘制。
   - `getStaticLayer()` 在拖拽（`sim.grab`）或甩牌冲刺窗口（`flingBoostUntil`）期间复用已有静态离屏层，不在高速甩牌帧中重建离屏 Canvas。
   - `apply()` 触发切歌/换封面时自动调用 `touch()` 唤醒 5 秒微风，保证新歌切入时挂绳自然摆动。
2. **修复 PWA 全屏歌词滑动跳播时字体发白看不清**：
   - 原先 `#lyricOverlay .lyrics.is-scrolling p.lyric:not(.on):not(.is-active)`（米白 `rgba(241, 237, 226, 0.85)`）与 `p.lyric.is-seek-target`（浅黄 `#f3d378`）选择器权重高于工牌浅色皮肤，导致手指滑动歌词跳播时整屏文字变成浅米白/浅黄色，在浅色网格背景上几乎隐形。
   - 现已在 `html[data-pass-skin="true"]` 下以更高优先级覆盖：滑动中未高亮行采用 `84%` 深色墨字（`opacity: 0.92`），瞄准跳播行（`.is-seek-target`）采用高饱和主题色 `var(--crew-brand)` 加白光描边衬底，清晰醒目。
3. **设置页身份铭牌（`#postcardScrim`）与主舞台 3D 工牌彻底解耦**：
   - 独立维护 `postcardCrewChar`（持久化于 `vplayer:identityTheme`），在设置页打开「站长/船员身份铭牌」或点击弹窗内的 9 色按钮时，仅更新弹窗内部的独立身份铭牌与配色，绝不改动主舞台工牌配色（`activeCrewChar`）与全站皮肤。
   - 移除 `#postcardScrim` 内 `mountLanyard` 的 `onFlingNext` / `onFlingPrev` / `onPullToggle` 绑定，并在 `lanyard.js` 中仅当传入对应回调时才显示「松手切下一首」提示胶囊，使设置页铭牌可自由拖拽把玩与翻转，绝不会误触切歌或暂停播放。

---

# v159 · 甩牌切歌卡顿优化

针对「3D 工牌甩牌切下一首时掉帧、卡顿」。改动集中在 `lanyard.js`、`dial.js`、`main.js` 三处，不改变任何视觉设计与手势行为，唯一可见差异是：停止操作约 5 秒后，挂绳的轻微摇摆会渐渐静止（见第 1 条）。

## 改了什么

| # | 文件 | 问题 | 改动 |
|---|---|---|---|
| 1 | `lanyard.js` | `breeze` 默认 0.45，`resting` 要求 `breeze === 0`，动画循环永远不休眠，页面可见时每帧全量物理 + 重绘 | 无操作 5 秒后微风在 1.5 秒内淡出，卡片静止后循环停止；拖动、点按、切歌、翻面都会重新唤醒。另设兜底，超时无论能量如何都停 |
| 2 | `lanyard.js` | 每帧重画技术网格（30+ 条路径）、水印、竖排状态文字 | 画到离屏层，仅在尺寸 / 主题色 / 文案变化时重画，每帧一次 `drawImage` |
| 3 | `lanyard.js` | 每帧对整张卡片做 `shadowBlur = 34` | 阴影预渲染成精灵图复用（卡片远近变化 ±15% 内直接缩放）；无法创建离屏画布时回退到原写法 |
| 4 | `lanyard.js` | 每次 `update()`（歌词行、播放状态、音质变化）都重画正反两张 420×590 卡面 | 只立刻重画当前朝向的一面，另一面翻过来时再画；内容签名不变则完全跳过（进度环按 2.5% 量化，与 `setProgress` 一致） |
| 5 | `lanyard.js` | 掉帧时 `dt` 变大 → 物理子步增加 → 下一帧更慢 | 子步数上限 20（60Hz 正常情况下为 16，不受影响） |
| 6 | `lanyard.js` | 每帧重复解析颜色字符串 | `rgbaFromHex` / `darkenHex` 做小容量记忆化 |
| 7 | `dial.js` | 工牌模式下表盘是 `display:none`，但播放时仍每帧改写 48 个 SVG 属性 | 检测到舞台为 lanyard 模式即停止；切回表盘时 `dial.wake()` |
| 8 | `main.js` | `engine.next()` 在 pointerup 里同步触发所有订阅者重绘（标题 DOM 重建 + 强制布局、队列/搜索/收藏/榜单列表、上下文） | 上述订阅改为 `deferred()`，合并到两帧之后；**`engine.next()` 与音频启动保持同步**（iOS 手势要求不受影响）。`paintReadout` 仅在标题文字变化时重建标题节点；去掉切歌 toast（卡片飞出本身就是反馈） |
| 9 | `vane.css` | 工牌画布每帧重绘可能牵连外部布局 / 绘制 | `.stage-lanyard__host { contain: layout paint; }` |

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
