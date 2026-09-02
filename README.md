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

**一条规则：从哪个列表点的歌，那个列表就是播放上下文。**

搜索结果、收藏、本机音乐、载入的歌单——全部走同一个 `playFrom()`。按「下一首」播的是你刚才在看的列表的下一条。

**「接下来」独立存在**，跨上下文存活。轮到它时才被插进上下文的播放位置。

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
wrangler d1 create vplayer-db
wrangler d1 execute vplayer-db --file=schema.sql
# 然后在 wrangler.toml 里配置绑定，重新部署
```

### 可选密钥

| 密钥 | 用途 |
|------|------|
| `MUSIC_API_KEY` | 上游 API 鉴权（必须） |
| `LX_API_URL` | LX-music 备用源地址 |
| `LX_API_KEY` | LX-music 鉴权 |

---

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
  await navigator.clipboard.writeText(text).catch(()=>{
    const ta=document.createElement('textarea');
    ta.value=text;document.body.append(ta);ta.select();
    document.execCommand('copy');ta.remove();
  });
  alert(songs.length+' 首歌已复制到剪贴板！粘贴到 VPlayer 设置的导入框');
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
