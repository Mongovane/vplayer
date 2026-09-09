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
