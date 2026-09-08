# VPlayer

一个基于 Cloudflare Pages 的 PWA 音乐播放器，从 [CPlayer](https://github.com/ChKSz/CPlayer) 重构而来。

**线上地址**: [vplayer4.pages.dev](https://vplayer4.pages.dev)

---

## 功能

### 播放
- 三源搜索（网易云 / QQ / 酷狗），自动回退
- 六档音质（128k → 192kHz/24bit 母带），在播放界面的徽章上直接切换
- 歌词同步滚动，全屏沉浸式展示，点击歌词跳转
- 封面跟随切歌更新，表盘指针/弧线/风羽实时动画

### 收藏与云端
- 收藏夹（纯元数据，不占空间）
- R2 云端音乐库（稳定 URL、跨设备、断网不可用但不占本机空间）
- 一键全部入库（自动跳过已入库的）
- 一键从云端恢复全部到收藏

### 离线
- IndexedDB 离线存储（下载到本机，断网可播）
- 可配额（512M / 2G / 8G / 不限），LRU 自动淘汰最久没听的
- 下载中断后自动续传（Range 请求）
- 持久化存储申请（防止 iOS 回收）

### 导入
- 酷狗收藏导入（浏览器控制台脚本提取 → 批量搜索匹配）
- 文本粘贴导入（每行「歌名 - 歌手」）
- JSON 粘贴导入（酷狗 API 响应格式）
- 本地文件导入（MP3/FLAC/M4A，自动读取 ID3/FLAC 标签）
- 歌单文件导入（.json / 旧版 playlist.js）

### PWA
- 添加到主屏幕，全屏运行
- 锁屏控制（MediaSession API）
- Service Worker 离线缓存（网络优先，skipWaiting + clients.claim）
- iOS 后台播放（不使用 Web Audio，避免 AudioContext 挂起）

---

## 架构

```
public/
├── index.html            # Shell + SVG 图标精灵 + 自定义 vane 标志
├── styles/vane.css       # 设计系统 + 全部布局（无外部 CSS）
├── sw.js                 # Service Worker（网络优先 + skipWaiting）
├── manifest.webmanifest  # PWA 配置
├── src/
│   ├── store.js          # 状态管理（按 key 订阅 + 持久化偏好）
│   ├── api.js            # API 客户端 + IndexedDB 歌词缓存 + LRC 解析
│   ├── engine.js         # 音频引擎（iOS 检测 / 断流恢复 / CORS 重试 / 离线优先）
│   ├── dial.js           # 表盘（seek / 风羽 / 封面 / 空闲暂停动画循环）
│   ├── list.js           # 虚拟滚动列表（队列 / 搜索 / 收藏 / 本机共用）
│   ├── lyrics.js         # 歌词渲染（景深高亮 / 邻行半亮）
│   ├── main.js           # 组装：DOM 绑定 / 播放模型 / 手势 / 面板 / 导入
│   └── offline.js        # IndexedDB 离线（增量落盘 / 续传 / LRU / 标签读取 / 导入）
functions/api/
├── [[path]].js           # Pages Function：API 代理 + 搜索 + 解析 + 流中继
└── _library.js           # R2 + D1 服务端音乐库（Range 播放 / LRU 淘汰）
```

### 播放模型

列表分两类，因为「点一首歌」在两类列表里意味着不同的事。

**你自己的列表**——收藏、本机音乐、载入的歌单——点一首就是「播这个列表」。
走 `playFrom()`，整体成为播放上下文，按「下一首」顺着它走。这些列表是你
攒出来的，把它变成队列正是你的意图。

**浏览用的列表**——搜索结果、榜单——点一首只是「听听这首」。走
`playFromBrowse()`：

- 队列是空的 → 整个列表成为上下文，「下一首」顺着你正在看的结果走
- 队列非空 → 只把这一首插到当前播放位置之后，队列原样保留，
  「下一首」回到队列里继续

早先这两个面板的同一个手势代价不同：搜索走 `playFrom()` 会整体替换队列，
一次好奇的点击就把载入的歌单清空了；榜单则一次追加 50 条。想让浏览结果
**成为**队列仍然可以，但现在必须明说——两个面板都有 `全部播放 / 加入队列`，
和收藏面板同一对按钮、同一套词。

**「接下来」独立存在**，跨上下文存活。轮到它时才被插进上下文的播放位置。

### 榜单

「榜单」面板列出网易云的官方排行榜，点一个看当日热歌。

**浏览榜单不消耗 API 额度。** 榜单接口直接调网易云自己的公开端点
（`/api/toplist/detail`、`/api/v6/playlist/detail`、`/api/v3/song/detail`），
不走计费的上游 API。只有**点播放**时解析播放地址才消耗 1 次额度，和搜索结果一样。

榜单列表和每个榜单的歌曲都在客户端缓存，服务端也缓存 30 分钟（榜单最多日更），
来回切看过的榜单不会重复请求。

> 大型官方榜单的 `playlist/detail` 只返回 `trackIds` 而不返回曲目详情，
> 所以需要第二步按 id 批量取 `song/detail`，并按 id 顺序还原榜单排名。

### id 词表

只有两个前缀，`qq:` 和 `kg:`。**其余一切都是网易云的裸 id**，没有 `163_`
这种东西——`sourceOf()` 只认那两个，`bare()` 也只剥那两个。

榜单接口曾经发过 `163_2166519574`，于是这个 id 原样送到上游解析，
主源和 LX 备用源同时返回空，整个榜单一首都播不了。现在 `bare()` 会
额外容忍 `163_` / `wy_`（边缘缓存 30 分钟，且用户收藏里已经存了带前缀的
id），客户端在读取收藏和恢复会话时也做一次归一化并去重。

服务端 R2/D1 里已入库的行由 `npm run db` 一并修正。

导入的本地文件用 `local:` 前缀，它不解析、不查歌词，只从 IndexedDB 取。

### 网易云搜索走免费直连

网易云搜索直接调 `music.163.com/api/search/get`，**不消耗 API 额度**。

切换前实测过：同一个查询走计费上游和走直连，**30 条结果完全相同、顺序也相同**
——计费接口显然就是在转发这个端点，付费买不到更好的排序。而搜索是额度的最大
消费项（批量导入每首 1 次），所以默认改走免费路径。加 `?paid=1` 可强制回到
计费路径，以备免费端点被限流或改结构。

> 顺带测出来的：`source=kugou` 返回的结果和 `163` 完全一致，`source=qq` 返回空
> ——计费 API 的三个"音源"实际是同一个后端。

### 为什么会匹配到翻唱

不是排序问题，是**版权下架**。搜「晴天 周杰伦」，网易云返回 30 条全是翻唱、
女声版、钢琴版，**周杰伦的原版根本不在结果里**；而搜「如约而至 许嵩」第一条
就是原版。所以批量导入只能退而取一个陌生人的版本。

入库确认清单会把这种情况标成红色 `!`（区别于关键词提示的 `?`）：前者是确定的
替代——要找的歌手在这个音源上没有；后者只是猜测。

## 设置面板

仅 iOS 的两个锁屏设置放在一个默认折叠的 `<details class="fold">` 里。它们各自
都要一段话才说得清,而那是设置面板里很大一块地方,给一个多数人永远不会碰的东西
花掉不值得。`hidden` 设在 `<details>` 上而不是里面任一个块上,所以在不适用的
平台上整块消失。DOM 契约检查会确认它不会带着 `open` 发布出去。

## 图标

Lucide(ISC),由 `scripts/build-icons.mjs` 从 `lucide-static` 生成到
`public/index.html` 的精灵图里。**不要手改 symbol**——改脚本里的映射表再
`npm run icons`。路径数据不能手抄:抄错一个坐标在 diff 里和抄对完全一样。

每个字形是 Lucide 原生 24×24 网格上的一个 `<symbol>`。symbol 自带 viewBox,
所以它会缩放到引用它的 `<svg>` 给的任何尺寸,外层 viewBox 不必再和精灵图一致
——旧的 256×256 精灵图要求一致,而品牌标志那处就写错了(24 单位的路径套在
256 的 viewBox 里,只渲染出 9% 大小),顺手修了。

`i-vane` 是自制的,**故意保留为 `<g>`**:表盘那边用手调的
`translate(153 40) scale(1.417)` 包着它,换成 `<symbol>` 会建立自己的视口而
忽略那个变换。

两个用自定义属性调控的地方,因为 CSS 选择器伸不进 `<use>` 的影子树,而继承的
自定义属性可以:

- `--icon-stroke`(默认 2)。Lucide 的 2 单位描边画在 24 网格上,在 14–19px 时
  细到约 1.2px,在 `--gust-dim` 下会发虚,所以小尺寸处上调。
- `--icon-fill`(默认 none)。Lucide 没有实心心形,所以收藏态由
  `.row__tail button.is-on svg { --icon-fill: currentColor }` 填充。

播放/暂停/上一首/下一首额外带 `fill="currentColor"`:描边适合设置项里的功能键,
但 transport 是唯一「粗细本身带含义」的地方——64px 的黄铜按钮里放一个发丝三角
看起来像禁用了。

`npm run check` 会跑生成脚本并校验每个 `#i-*` 引用都能解析。一个
`<use href="#i-typo">` 什么都不渲染,没有报错也没有 console 警告,只有一个空
按钮,所以这个必须查而不是信。

## 开发检查

`npm run check` 有四道:

1. **eslint** —— `no-undef` 为主的运行时隐患。抓到过 `openLyrics`/`closeLyrics`
   声明在 `bindEvents()` 里却被同级的 `bindKeys()` 调用,四个键位静默 ReferenceError。
2. **图标生成 + 引用校验** —— 每个 `#i-*` 都必须解析。一个 `<use href="#i-typo">`
   什么都不渲染,没报错也没警告,只有一个空按钮。
3. **DOM 契约** (`scripts/check-dom-contract.mjs`) —— 代码里 `$('id')` 查的每个
   元素都必须在 `index.html` 里,`document.querySelector` 的每个选择器都必须命中,
   id 不能重复。**这个抓的是「整个应用起不来」**:`$('keepAliveOpt')` 返回 null,
   下一行属性访问抛异常,而所有监听都注册在同一个 `bindEvents()` 里——一个 div
   没了,什么都不工作。eslint 看不见,`node --check` 看不见,engine 测试也看不见
   (它们自己造 DOM,不加载页面)。这个错误发生过两次,两次都是按字符区间改设置
   面板,顺手把邻居的块删掉了。
   > 只检查 `document.` 上的查询。`el.querySelector('.row__art')` 查的是运行时
   > 生成的标记,第一版把它们也算进去,报了 15 条假警报——那样的检查很快就没人跑。
4. **静态不变量 + engine 运行时测试** —— 见上面「iOS 锁屏」。

DOM 契约那一道还顺带管两件小事:`<details>` 不能带着 `open` 发布,以及它必须有
`<summary>`(否则没有可点的东西)。

主 `main.js` 那个把所有监听塞进一个函数的结构本身是这类脆弱的来源:任何一处
null 都带走后面全部。仅 iOS 的那两个设置块已经单独 guard 了(它们本来就是可选
渲染的),但真正的修法是让 `main.js` 不再是「一个函数那么大的作用域」。

```bash
npm install
npm run check      # eslint，0 error 才算过
npm run dev
```

`node --check` 只做语法解析。它看不见一个声明在 `bindEvents()` 里的
`function` 对同级的 `bindKeys()` 不可见——那是调用时的作用域解析，不是语法
错误。`openLyrics` / `closeLyrics` 就这样带着四处 `ReferenceError` 上线过：
桌面上按 `l`、歌词开着时按 `Escape`、按 `1`/`2`/`3` 切视图，全都静默失败。

抓这个的规则叫 `no-undef`，`eslint.config.mjs` 存在的唯一理由就是它。
其余规则都是同一类：解析得过、运行时炸。

`no-use-before-define` 明确关掉了：模块里「第 300 行的函数读第 1200 行的
`let`」是安全的，因为那个函数只会在求值结束后被调用，而这个代码库到处这么
写。开着它会报 ~30 条，一条真的都没有——那样的检查很快就没人跑了。

### iOS 锁屏

锁屏上的播放/暂停/上一首/下一首都走同一条**同步**路径。

一个 MediaSession handler 携带着「允许后台发声」的用户手势授权,而这个授权
**不会跨过 event loop**。所以 `playIndex()` 在拿到预解析 URL 的情况下,必须在
第一个 `await` 之前就完成 `audio.src = …` 和 `audio.play()`。慢路径(要解析
网络)在锁屏下必然无声,所以预热的职责就是让慢路径不被走到。

预热缓存按 **track id** 存,同时覆盖**上一首、下一首和当前这首**:

- 上一首也是锁屏按钮,只预热前向是它一直没声音的原因
- 当前这首在里面,因为「唤醒一个被暂停的元素」靠的是重新绑定 src,而这个
  绑定也必须是本地的
- 按 id 存顺带解决了失效问题:查一个 id 不可能拿回另一首歌,所以重排队列
  不再需要清空缓存

**暂停时也会预热。** `timeupdate` 在暂停状态下不触发,而它曾是唯一的预热触发
点——所以在锁屏上暂停之后,第一次按下一首会花掉缓存里那一条,之后每一次都要
走网络,也就无声。暂停恰好还是预热的最佳时机:没有正在播的流可被抢带宽。

**预热分两趟。**

1. **解析 URL** —— 几百字节。锁屏真正需要的就是它:`audio.src =` 不能 await,
   但它只需要一个 URL。积极做。
2. **预拉字节** —— 整份文件,昂贵。opt-in:只在暂停时(没有流可抢)和
   `timeupdate` 报告缓冲有余量时进行,每趟只拉一个,永远不拉元素正在读的 URL。

这两件事曾经合成一趟做,结果是切歌 800ms 后无条件开始下载,不看缓冲余量,而且
**包括正在播的那首**——云端曲目于是在流的同时被整份重下,元素自己的请求输了,
0:00 卡死。

**预拉的结果是 blob,不是 HTTP 缓存。** 这是一次回退,而回退本身是重点。

blob 方案原本就在,能用。后来被换成 `fetch(url, { cache: 'force-cache' })`
读完就丢,理由是「填满 HTTP 缓存就能让后续的 src 赋值本地解析——锁屏反对的
不是赋值,是访问网络」。前半句对,后半句在 iOS 上不成立:媒体元素**不走 Fetch
API 的缓存**,WebKit 把媒体交给独立的 loader,而且它发 Range 请求。原作者做
blob 实验时留下的注释把这件事说得很清楚——「浏览器不会把 206 部分响应复用为
完整的缓存资源」,以及「离线曲目(播的是 blob: URL)是唯一能活过锁屏切歌的」。
所以填 HTTP 缓存对它要解决的场景毫无作用。

用 `res.blob()` 而不是 `arrayBuffer()`:WebKit 会用文件而非常驻内存来backing
大 blob,而读进 ArrayBuffer 正是上一次把页面搞到被系统杀掉的原因。48MB 以上
的曲目跳过,回落到流式播放。

**暂停之后不能指望定时器还会运行。** 实测(iOS 18.7,锁屏):MediaSession 事件
**能**唤醒页面并跑 handler,但 `setTimeout` **不能**——暂停后安排的预热从来没有
执行过,直到下一次按键把页面唤醒。所以缓冲余量的门槛从 30 秒降到 10 秒:凡是要
准备好的,都得在音频还在播的时候准备好。

### 锁屏暂停:唯一能走的路

先说测出来的结论。iOS 18.7,锁屏,transport 暂停之后:

```
playIndex {"id":"65739","warm":"blob"}
src {"kind":"blob","path":"sync"}
media:metadata {"dur":259}          ← 音源加载完全正常
(没有 media:playing,没有 play:ok,没有 play:fail)
```

一个本机 blob,在 MediaSession handler 里同步绑定,metadata 也读到了——
**`play()` 就是不 settle**。没有 error 可以 catch,也没有下一步可以试。
iOS 不会把音频会话交还给一个它已经允许其停止的页面。

**但同一份日志也说明了什么还是好的**:元素**正在播放**时换 src 没问题——曲末的
pre-advance 一直是这么工作的。所以杀死会话的是那个「停」,绕过它的办法就是不停。

于是:`iosKeepAlive`(默认开,仅 iOS)。锁屏上按暂停时,静音并把播放头钉住,
而不是真的 `pause()`。会话不断,上一首／下一首／播放全都还能用。

**一个只能实测发现的细节:WebKit 在调用 action handler 之前就已经把元素暂停了,
`pause` DOM 事件是之后作为独立任务投递的。**

```
106.93s [h] session:pause          ← handler 跑
106.95s [h] media:pause {"at":3}   ← DOM 事件 20ms 后才到
```

所以「元素还在播」这个看起来天经地义的前置条件,在这里**永远是假的**,hold 一次
都没生效过。持有会话因此意味着**在 handler 里把它静音重启**——那里还有允许发声
的用户激活,而且距离平台自己那次暂停只有几微秒,是能拿到的最好时机。同理,那个
迟到的 DOM `pause` 事件**不能**用来拆掉 hold,否则每次都会在静音重启落地之前
把它撤销。

**锁屏期间的按键会排队,在解锁瞬间一次性投递。** 实测 30 毫秒内 6 次
`session:*`,每一次 `playIndex` 都在 abort 上一次刚开始的加载,中间每一首都是
白做的,最终落在哪首是随机的。所以 transport 的切歌做了 200ms 限流——不是
debounce:debounce 需要定时器,而定时器正是锁屏下不跑的东西,那样会把已经能用的
路径弄坏。限流只需要测量距上次的间隔,不需要定时器来*允许*任何事。人的连按在
两百毫秒量级,重放的队列在几毫秒量级。

代价不藏着:iOS 可能仍在锁屏上显示「正在播放」,而且解码器一直在跑,耗电。
所以有 5 分钟上限,过了就真正暂停;回到前台立刻退出 hold(前台真暂停是好的,
没必要留个静音解码器);设置里可以关。

如果关掉(选「真正暂停」),就会走另一条路:锁屏上真的暂停之后,**把播放/暂停键
从 transport 上撤掉**,只留上一首/下一首。因为那个键按下去既不报错也不出声——
画出来的按钮什么都不做,比没有按钮更糟。iOS 画哪些键完全由注册了哪些 handler
决定,所以移除 handler 是唯一的办法。回到前台或重新出声后自动恢复。这也可以
单独关掉。

`timeupdate` 是 hold 期间唯一还在跑的时钟(元素在播,所以它一直触发),所以钉
播放头和计时上限都放在那里,并且在它之前 early return——`elapsed` 不能动、
曲末不能 pre-advance、邻居不能重新下载。

两层检查:

- `scripts/check-sync-start.mjs` —— 静态断言语句顺序(`play()` 之前不能有
  `await`、handler 不能是 async、pause 必须 re-warm)。这类不变量没法用运行时
  测试覆盖:jsdom、桌面浏览器、前台标签页一律能正常发声。
- `test/engine.lockscreen.test.mjs` —— 在 jsdom 里跑**真实的** engine.js,只把
  `api.js` / `offline.js` 换成 stub(靠 `test/loader.mjs` 重定向 import)。元素
  是个会记录 src 赋值和 play 调用时序的假货,所以「是否在第一个 await 之前绑定
  了 src」「起了几个整文件请求、针对哪个 URL」都是可断言的。

两者都跑过反向验证:把每个 bug 重新塞回去,确认对应的检查真的会红。目前 30 条测试,
覆盖 24 类回归——`play()` 前插 await、handler 变 async、只预热前向、暂停不
re-warm、`wasPlaying` 门槛、无条件预拉字节、预热误触 LRU、预拉不保留字节、
淘汰不 revoke、blob 数量无上限、日志不落盘、日志不读回、锁屏暂停真的暂停、
不钉播放头、恢复时误调 play()、切歌忘记 unmute、无时限、忽略设置开关、
前台也 hold、`!audio.paused` 前置条件、不做静音重启、重启失败不回退、
DOM pause 事件拆掉 hold、transport 无限流、限流窗口过大。

## 数据库

**只有一份 SQL:`schema.sql`。** 它既能建库也能升级已有的库,可以任意次数重复
执行,并且是后续所有变更的唯一去处。

在 Cloudflare 控制台执行(Workers & Pages → D1 → 选中数据库 → Console):把
`schema.sql` **整段**粘进去执行即可。整份文件不含任何反斜杠,也不含任何需要转义
的东西 —— 数据修正用 `substr(id, 1, 4) = '163_'` 而不是 `LIKE ... ESCAPE`,正是
为了这个:`LIKE` 里的 `_` 是单字符通配符,躲开它需要一个反斜杠,而反斜杠经过网页
表单和 JSON 请求体不保证原样到达 SQLite。

命令行也行:

```bash
npm run db          # 远端
npm run db:local    # 本地 miniflare
```

19 条语句,8KB。最后一条是核对查询,也是**唯一返回结果的语句**,所以控制台显示
的就是它。如果控制台对长文本有意见,按文件里的 `0 / 1 / 2 / 3 / 变更步骤 / 核对`
六段分开粘,顺序无所谓 —— 每一段都幂等。

### D1 不是标准 SQLite

已经踩过一次:核对查询原本写成 8 项 `UNION ALL`,本地 `node:sqlite` 通过(它的
上限是 500),D1 控制台直接报 `too many terms in compound SELECT`。**D1 对
compound SELECT 的项数上限远低于标准 SQLite,而且没有文档。**

现在核对查询用标量子查询写成一行多列,没有这个限制,而且读起来就是一行仪表盘。
`check-schema.mjs` 会拒绝这份文件里出现 `UNION` / `INTERSECT` / `EXCEPT` ——
一条不可能被误犯的规则,比猜那个上限值有用。

同理,`ALTER TABLE ... ADD COLUMN` 不要写进这份文件(见文件末尾的说明)。

先执行还是先 `npm run deploy` 都可以 —— 代码会检查 `track_requests` 表是否存在,
没有时上传返回一句「请站长执行」而不是 500,审核队列显示为空而不是报错。不过
推荐**先执行 SQL 再部署**:SQL 是纯追加的,对旧代码毫无影响(旧代码根本不碰新表),
反过来则有一个"成员暂时不能上传"的窗口。

执行完最后会打印一张表。`leftover_tracks` / `leftover_favs` 应该都是 0;
`owners` 是 0 而 `members` 不是 0,说明没人是站长 —— 那样删除、清理、审核会对
所有人返回 403,包括你自己。

### 怎么往里加变更

追加到「变更步骤」一节,写成可重复执行的形式:

- 建表 / 建索引 → `IF NOT EXISTS`,天然幂等
- 数据修正 → 让 `WHERE` 在修完之后匹配不到任何行
- **加列 → 不要写进这份文件**。SQLite 没有 `ADD COLUMN IF NOT EXISTS`,而
  `wrangler d1 execute` 一遇错就中止整个文件。单独 `--command` 执行一次,然后把
  列补进 `CREATE TABLE` 供新库使用,并在文件里记一笔

`scripts/check-schema.mjs` 用真实 SQLite(`node:sqlite`,和 D1 同一个引擎)验证
两件事:**跑两遍之后整个库逐行一致**,以及**在一个塞满了它要清理的脏数据的旧库
上结果正确** —— 空库会让每条数据修正语句因为什么都没做而通过。反向验证过 6 类:
去掉 `ESCAPE`(会把 `163456789` 误伤成 `456789`)、去掉去重 `DELETE`(`UPDATE`
撞主键)、`INSERT` 少了 `OR IGNORE`、漏建表、漏建索引、`substr` 偏移写错。

## 权限模型

一份共享云端曲库,存储由一个人的配额买单。所以:

| | 成员(邀请码加入) | 站长 |
|---|---|---|
| 播放云端曲目 | ✓ | ✓ |
| 收藏(各自独立) | ✓ | ✓ |
| 上传到云端 | **提交申请** | 直接入库 |
| 删除云端曲目 | ✗ | ✓ |
| 清理 / 修复元数据 | ✗ | ✓ |
| 邀请码 / 成员管理 | ✗ | ✓ |

**申请队列里只有元数据。** 一条 pending 的申请不解析、不下载、不占存储——
音频是在站长点「通过」的那一刻才取的。所以队列积压是免费的。
按歌曲 id 做主键而不是按申请:两个人要同一首歌是一个决定,不是两个。

**藏起按钮不是防护,服务端拒绝才是。** `test/permissions.test.mjs` 拿真实的
路由处理函数跑 13 条断言,D1/R2 用内存替身。反向验证过 6 类:DELETE 少检查
(✗2)、成员上传直接入库(✗4)、审核少检查(✗1)、`isOwner` 把无 token 当
站长(✗8)、单用户模式被误锁(✗1)、邀请码删除少检查(✗1)。

> 替身不校验 SQL 是否真能在 SQLite 上跑,它校验的是分支——决策在分支里。

**没有任何成员时一切照旧。** 曲库比成员系统更早存在,必须能在没有它的情况下
工作,否则加邀请码等于把原主人锁在自己的应用外面。

**删除邀请码不会踢人。** token 才是成员的身份凭证,邀请码只是门。撤销成员是
另一个动作(`remove`),混在一起会让「删掉一个过期的码」变成一次意外驱逐。

## 收藏同步

自动的,基于增量。这替换掉了原来的 `收藏上传` / `收藏下载` 两个按钮,那对按钮
不是一个自洽的设计:

- **上传**把本机整份写盖云端。刚加入的手机有 5 首收藏,笔记本上有 200 首——
  手机上点一下,云端那 200 首就没了。破坏性的方向只需一次点击,而且看起来像备份。
- **下载**是合并而不是覆盖,所以两个按钮不是互逆的。在一台设备上取消收藏永远
  传不出去:任何设备下一次「下载」都会把它加回来。
- 两个都是手动的,所以两台设备的常态是「已经偏离」,而唯一能发现的方法是肉眼比对。

现在:每次收藏/取消都作为增量入队,冲到服务端,服务端应用后返回权威列表。删除
因此能传播,不存在整份覆盖,队列还落盘——离线时点的那一下不会丢。

队列里 `add` 和 `remove` 对同一个 id 互斥:收藏后又在冲刷前取消,不是两个要发送
的事实,而是一个最终状态;两个都发会让结果取决于服务端碰巧以什么顺序遍历。

冲刷期间新到的改动会叠加在服务端答复之上——没有这一步,飞行途中点的那一下会在
片刻后被可见地撤销。

## 播放来源顺序

一首歌开始播放时，按这个顺序找音频：

1. **本机离线副本**（IndexedDB blob）— 不耗流量、不依赖网络、启动最快
2. **预热缓存** — 上一首播放时已经在后台缓冲好的下一首
3. **云端 R2** — 自己的存储，URL 不过期，比上游稳定
4. **上游 API** — 按当前音质解析
5. **备用源池** — 上游失败时兜底

离线优先是主流做法（Spotify / Apple Music / 网易云同理）。R2 排在离线之后、上游之前：比本地慢，但比上游可靠。

只有 `offlineIds` 里确实存在的曲目才会去查 IndexedDB —— 对"云端为主、少量离线"的用法，这在几乎每次播放时都省掉两次异步查询。这不只是快一点：每个 await 都会让出事件循环，而在后台切歌时让出事件循环就会丢失 iOS 的播放授权。

### 解析链

设备离线副本 → R2 云端库 → 上游 API → LX 备用源

### 设计语言：Vane

- **色板**: `--ink #0A0D10` · `--brass #C8A24A` · `--wind #6FC5D6`（跟随封面色调）
- **图标**: Phosphor fill（MIT），16 个内联 + 1 个自定义 vane 标志
- **发光**: 5 处——进度弧、指针、播放键（播放中）、当前曲标记、蒲福风级格子
- **零外部字体**: 系统字体栈 + 等宽数字

---

## 部署

### 前置条件
- Node.js 18+
- Cloudflare 账号（Pages + Workers）
- 上游 API 密钥（`MUSIC_API_KEY`）

### 步骤

```bash
# 1. 创建 Pages 项目
npx wrangler pages project create vplayer

# 2. 设置密钥
wrangler pages secret put MUSIC_API_KEY --project-name=vplayer

# 3. 部署
npx wrangler pages deploy public --project-name=vplayer

# 4. (可选) R2 + D1 云端库
wrangler r2 bucket create vplayer-audio
wrangler d1 create vplayer
# 在 wrangler.toml 里配置绑定，然后：
npm run db          # 建表 + 数据修正，可重复执行
npx wrangler pages deploy public --project-name=vplayer
```

> `npm run db` 是唯一需要执行的 SQL 命令，任何时候执行都安全。数据库名要和
> `package.json` 里的 `db` 脚本一致（默认 `vplayer`）。

### 可选密钥

| 密钥 | 用途 |
|------|------|
| `MUSIC_API_KEY` | 上游 API 鉴权（必须） |
| `LX_API_URL` | 落雪备用源地址（播放解析回退） |
| `LX_API_KEY` | 落雪源鉴权 key（对应脚本里的 X-Request-Key / API_KEY） |
| `LX_API_STYLE` | 端点格式：`path`（默认，lx-music-api-server）或 `query`（ikun/juhe 风格） |

---

## 接入落雪音源（增强播放解析）

播放地址的备用解析走一个**备用源池**。池里每个后端都是 lx 风格的 HTTP 代理：给它 `{来源, 歌曲ID, 音质}`，返回真实播放地址（解决会员歌曲的 url 鉴权）。搜索和歌词仍走主 API。

### 内置池

VPlayer 内置了几个公共备用源（来自 [pdone/lx-music-source](https://github.com/pdone/lx-music-source)），开箱即用，无需配置：

| 名称 | 后端 | 格式 |
|------|------|------|
| huibq | `lxmusicapi.onrender.com` | path | ✅ 可用（但经酷我解析，忽略 source） |

内置池目前只有 huibq 一个能从 Cloudflare Worker 稳定连通。其他社区源在 Worker 环境下不可用：

| 源 | 问题 |
|----|------|
| ikun / ikunHK / yyxzq | 后端返回 530（已挂/key 失效） |
| juhe | 网易返回 "source not match" |
| flower / grass (裸 IP) | 在 Cloudflare 后面，拒绝裸 IP 直连（error 1003） |
| yh / yc (tempmusics.tk) | http 被 nginx 403，https 被 Cloudflare 523（源站不可达） |
| nya (IP:9866) | 403 |
| lx | 需要按歌计算的 sign 参数 |

**共同原因**：这些公共音源服务器几乎都对数据中心 IP 做了封禁（专防批量调用），只是拦截层不同（Cloudflare 1003/523、nginx 403、后端 530）。它们从落雪桌面端（住宅 IP）能用，从 Cloudflare Worker（数据中心 IP）几乎都连不通。这是环境限制，改请求格式无解——已逐个实测确认。

> 这些源的端点/header 是在落雪沙盒里跑脚本抓真实请求得到的，不是猜的。它们从 Worker 连不通是环境限制（数据中心 IP、Cloudflare 拦截），不是请求格式错。如果你有自己的后端，用下面的自定义配置加进池子。`GET /api/lxtest` 实时测活。

### 自定义源

如果你有自己的 lx-music-api-server 或其他后端，配三个 secret 加进池子（会排在内置源前面优先用）：

```bash
wrangler pages secret put LX_API_URL    # 你的后端地址
wrangler pages secret put LX_API_KEY    # 鉴权 key
wrangler pages secret put LX_API_STYLE  # path（默认）/ query / post
```

三种格式：
```
path : GET  {base}{prefix}/url/{source}/{songId}/{quality}
query: GET  {base}/url?source=&songId=&quality=
juhe : POST {base}/{source}  body {source,type,musicInfo}
```
`sign: "tag"` 会额外加一个 tag header = hex(JSON.stringify([songId,quality],null,1))（flower/grass 用）。

每个后端的确切端点、header 和响应格式，是在落雪脚本沙盒里跑一遍、抓取它实际发出的请求得到的（不是读混淆代码猜的）。

`source` 用落雪代号：网易=`wy`、QQ=`tx`、酷狗=`kg`、酷我=`kw`、咪咕=`mg`。VPlayer 自动映射。

**完全用自己的池**：设 `LX_POOL`（逗号分隔，每项 `名称|地址|key|格式`），会替换掉内置池：
```bash
wrangler pages secret put LX_POOL
# 例：myserver|https://my.host|mykey|path,backup|https://backup.host|k2|query
```

只想禁用内置池、只用 `LX_API_URL`：设 `LX_POOL_DISABLE_BUILTIN=1`。

### 关键说明

这些音源脚本（ikun/juhe/flower 等）**本质都是 HTTP 代理**——脚本自己不解密，只是把请求转发给作者的服务器，加密/签名在服务器端做。所以不需要在浏览器里跑脚本沙盒，Worker 直接请求后端即可。**你需要的是后端 URL 和 key（就写在 `.js` 脚本开头的 `API_URL` / `API_KEY`），不是脚本文件本身。**

### 批量入库的额度轮换

「全部入库」时：每首歌先走主 API 解析，主 API 额度用完或失败时，自动落到备用源池，并且每首从池里不同的源开始（`rotate` 参数），把请求摊到多个后端上。这样即使主源中途额度耗尽，整批也能靠备用源池分批完成，不会卡住。

设置里的「播放解析源」开关：**主源优先**（先主 API，失败回退池）或 **备用源(落雪)**（直接走池）。

## 多人共享（邀请码）

VPlayer 可以做成 3-4 人共用：**每人独立收藏，共享同一个云端曲库**（歌曲字节只存一份，不重复占空间）。收藏存在服务端，跟着人走，换设备也在。

### 开通（站长一次性）

1. 设置一个只有你知道的密钥：
   ```bash
   wrangler pages secret put OWNER_SECRET --project-name=vplayer
   ```
2. 用这个密钥认领站长身份（在浏览器控制台或用 curl）：
   ```js
   fetch('/api/members/bootstrap', {method:'POST', headers:{'content-type':'application/json'},
     body: JSON.stringify({secret:'你的OWNER_SECRET', name:'站长'})}).then(r=>r.json()).then(console.log)
   ```
   返回的 `token` 会自动存进浏览器。之后设置里的「成员」区会显示站长面板。

### 邀请别人

站长在 设置 → 成员 → 「生成邀请码」，得到一个 `XXXX-XXXX` 的码，发给对方。对方在自己的 VPlayer 设置 → 成员 → 输入邀请码 + 昵称 → 「加入」。加入后：

- 他的收藏会同步到云端（点「同步收藏到云端」，或收藏变化时自动同步）
- 他能播放共享曲库里的所有歌
- 站长能在成员列表里看到谁加入了、最近活跃时间，也能移除成员

### 说明

- **只存歌曲字节**，封面和歌词播放时从上游取（省 R2 空间）
- 收藏是**每人独立**的，互不影响；曲库是**共享**的
- 令牌存在浏览器 localStorage，退出即清除
- 整套是可选的：不设 OWNER_SECRET、不生成邀请码，VPlayer 就是原来的单人应用

### 两个"收藏"按钮的区别

设置里有两处都提到收藏，做的是不同的事：

| 位置 | 按钮 | 方向 | 搬什么 |
|---|---|---|---|
| Members | **收藏上传** | 本机 → 服务端你的成员记录 | 收藏清单（歌名/歌手），你个人独有 |
| Members | **收藏下载** | 服务端 → 本机 | 同上，合并而不覆盖 |
| 云端音乐库 | **曲库→收藏** | R2 共享曲库 → 本机收藏 | 已经存了音频文件的歌，所有成员共用 |

换设备想拿回收藏，用 **收藏下载**；想把共享曲库里的歌加进自己的收藏，用
**曲库→收藏**。

## PWA 和浏览器数据不同步？

收藏、离线、偏好都存在**浏览器本地**（localStorage + IndexedDB）。每个"浏览器上下文"有独立的存储，互不相通：

- Safari 标签页 / 添加到主屏幕的 PWA / Chrome / 桌面 Chrome —— 这几个是**各自独立的四套存储**

所以在 PWA 里的收藏，浏览器里看不到，反之亦然。这是 Web 存储的固有隔离，不是 bug。

**跨设备/跨上下文同步的办法：用云端音乐库（R2）当桥**：
1. 在有数据的一端 → 收藏 → 「全部入库」把歌复制到 R2
2. 在另一端 → 设置 → 云端音乐库 → 「全部恢复到收藏」

云端库是所有上下文共享的（存在服务端 R2/D1），这是唯一能跨设备同步收藏的路径。

## 从酷狗导入收藏

酷狗的分享页是 SPA，歌曲数据通过签名 API 动态加载，服务端无法抓取。需要在浏览器控制台提取：

### 操作步骤

1. **电脑 Chrome** 打开酷狗分享链接
2. **F12 → Console**，粘贴以下脚本并回车：

```javascript
(async()=>{
  const d=document.querySelector('iframe')?.contentDocument||document;
  const s=d.querySelector('[class*=container__]')||d.scrollingElement;
  let n=0,t=0;
  for(let i=0;i<200;i++){
    s.scrollTop=s.scrollHeight;
    await new Promise(r=>setTimeout(r,300));
    const c=d.querySelectorAll('[class*=songItem__]').length;
    if(c===n){t++;if(t>=8)break}else t=0;
    n=c;
  }
  const songs=[...d.querySelectorAll('[class*=songItem__]')].map(e=>{
    const a=e.querySelector('[class*=songName]')?.textContent.trim()||'';
    const b=e.querySelector('[class*=singer]')?.textContent.trim()||'';
    return a+(b?' - '+b:'');
  }).filter(Boolean);
  const text=songs.join('\n');
  const ta=document.createElement('textarea');
  ta.value=text;
  ta.style.cssText='position:fixed;top:0;left:0;width:100%;height:50%;z-index:99999;font-size:14px';
  document.body.append(ta);
  ta.select();
  alert(songs.length+' 首歌已显示在文本框里，请全选复制（Ctrl+A → Ctrl+C），然后粘贴到 VPlayer');
})()
```

3. 等自动滚动完成（约 60 秒），弹出提示
4. 打开 VPlayer → 设置 → 批量导入歌曲 → 粘贴 → 开始搜索并导入
5. 完成后 → 收藏 → 全部入库

> **实测**: 419 首全部提取成功（2026-09-02 在 Chrome DevTools 验证）。

---

## 键盘快捷键

| 键 | 功能 |
|----|------|
| `Space` | 播放 / 暂停 |
| `←` `→` | 快退 / 快进 5 秒 |
| `↑` `↓` | 音量 +/- 5% |
| `L` | 打开 / 关闭歌词 |
| `1` `2` `3` | 打开队列 / 搜索 / 收藏 |
| `Escape` | 关闭当前面板 |
| `M` | 切换循环模式 |

---

## 手势（手机）

| 手势 | 位置 | 功能 |
|------|------|------|
| 左右滑动 | 表盘封面 | 下一首 / 上一首 |
| 拖动 | 表盘圆环 | Seek 到对应时间 |

---

## 已知限制

- **后台下载**: PWA 离开前台时下载暂停（iOS 无 Background Fetch），回到前台自动续传
- **离线存储**: 受浏览器配额限制，未持久化时可能被系统回收
- **DRM 文件**: `.kgm`/`.ncm`/`.qmc*` 等加密格式无法导入，需先在原应用导出为 MP3/FLAC
- **iOS Safari**: Web Audio 会挂起后台播放，已禁用分析器，风羽用行波动画替代

---

## 开发

```bash
# 本地开发
npx wrangler pages dev public --compatibility-date=2024-01-01

# 带 D1/R2 绑定
npx wrangler pages dev public --d1=DB --r2=MUSIC
```

### Service Worker 缓存

修改 CSS/JS 后需要在 `sw.js` 里递增 `CACHE` 常量名（当前 `v26`），否则已安装的 PWA 会继续使用旧缓存。`skipWaiting` + `clients.claim` 确保部署后一次刷新即可生效。

---

## 许可

代码: MIT  
图标: [Phosphor Icons](https://phosphoricons.com/) (MIT)  
上游 API: 由 [api.chksz.com](https://api.chksz.com) 提供
