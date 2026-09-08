-- ============================================================================
-- VPlayer · 数据库全量脚本
--
-- 这是唯一一份需要维护的 SQL。它既能建库,也能升级已有的库,而且可以**任意次数
-- 重复执行** —— 每一步都是幂等的。
--
-- 两种执行方式,任选:
--
--   A. Cloudflare 控制台 → Workers & Pages → D1 → 选中数据库 → Console
--      把这份文件**整段**粘进去,执行。整份不含任何反斜杠,不含需要转义的东西,
--      所有语句用分号分隔。最后一条是核对查询,也是唯一返回结果的语句,所以
--      控制台显示的就是它。
--      如果控制台对长文本有意见,按下面的「0 / 1 / 2 / 3 / 变更步骤 / 核对」
--      六段分开粘,顺序无所谓 —— 每一段都幂等。
--
--   B. 命令行:npm run db (远端) / npm run db:local (本地 miniflare)
--
-- ----------------------------------------------------------------------------
-- 后续怎么改这份文件
--
-- 追加到最后的「变更步骤」一节,并且必须写成可重复执行的形式:
--
--   * 建表 / 建索引  → CREATE TABLE / INDEX IF NOT EXISTS,天然幂等
--   * 数据修正       → 让 WHERE 条件在修完之后匹配不到任何行
--   * 加列           → SQLite 没有 ADD COLUMN IF NOT EXISTS。见文件末尾
--                      「加列的写法」,不要直接写进这个文件
--
-- 每一步顺手往 schema_migrations 里记一笔,这样 SELECT 一下就知道跑过什么。
-- ============================================================================


-- ============================================================================
-- 0 · 变更记录
--
-- 不用它来决定要不要执行(每一步本身就幂等),只用来回答「这个库上跑过什么」。
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  step       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);


-- ============================================================================
-- 1 · 曲库
--
-- D1 只存账目,音频在 R2。这个拆分不是随意的:D1 是 SQLite,单次查询返回量有上限
-- 且没有字节范围读,一个 40MB 的 FLAC 作为一行存进去将无法拖动进度条。R2 原生
-- 支持 range 且出网免费,这正是音频需要的。而 D1 擅长的恰好是淘汰所需要的 ——
-- 按最后使用时间排序、对体积求和。
-- ============================================================================

CREATE TABLE IF NOT EXISTS tracks (
  -- 与线路一致的歌曲 id:网易云是裸数字,QQ 是 qq:<mid>,酷狗是 kg:<hash>。
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  artist       TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  cover        TEXT NOT NULL DEFAULT '',

  -- R2 对象键。显式存储而非推导,这样扩展名可以跟随上游实际返回的类型。
  object_key   TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes        INTEGER NOT NULL DEFAULT 0,
  -- 这份副本实际是什么音质,而不是当初请求的是什么。
  level        TEXT NOT NULL DEFAULT '',
  duration     INTEGER,
  lyric        TEXT NOT NULL DEFAULT '',

  created_at   INTEGER NOT NULL,
  last_played  INTEGER NOT NULL,
  play_count   INTEGER NOT NULL DEFAULT 0
);

-- 淘汰策略是最久未播优先,所以这个排序需要索引。
CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks (last_played);

-- 单行计数表,否则每次都要全表扫描求和。
CREATE TABLE IF NOT EXISTS library_meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO library_meta (key, value) VALUES ('total_bytes', 0);


-- ============================================================================
-- 2 · 多用户(邀请码 + 各自的收藏)
--
-- 所有人共用**一份**云端曲库(上面的 tracks),避免同一首歌的字节存多份。收藏是
-- 按成员各自独立的。加入由站长生成的邀请码把关;兑换后创建成员行并返回一个长期
-- token。
-- ============================================================================

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,             -- 用户输入的那串
  label       TEXT NOT NULL DEFAULT '',
  max_uses    INTEGER NOT NULL DEFAULT 1,   -- 0 = 不限
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER                       -- NULL = 永不过期
);

-- token 是客户端保存并在每个请求上发送的东西,它在没有密码的情况下标识成员。
CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  invite_code TEXT NOT NULL DEFAULT '',
  is_owner    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_token ON members (token);

-- 只有元数据 —— 可播放的 id 加上渲染一行所需的字段。播放仍然走共享曲库或上游。
CREATE TABLE IF NOT EXISTS member_favorites (
  member_id  TEXT NOT NULL,
  id         TEXT NOT NULL,                 -- 歌曲 id,与 tracks.id 同格式
  name       TEXT NOT NULL DEFAULT '',
  artist     TEXT NOT NULL DEFAULT '',
  album      TEXT NOT NULL DEFAULT '',
  cover      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (member_id, id)
);

CREATE INDEX IF NOT EXISTS idx_member_favorites_member
  ON member_favorites (member_id);


-- ============================================================================
-- 3 · 上传审核队列
--
-- 云端曲库是共享的,它的字节花的是一个人的存储配额。所以邀请码加入的成员可以
-- **申请**加一首歌,但不能自己加。非站长对 /api/library/:id 的 PUT 会落到这里
-- 而不是入库;站长通过之后,字节才被真正取回。
--
-- 主键是歌曲 id 而不是申请 id:两个人要同一首歌是一个决定,不是两个。被驳回的行
-- 保留下来,这样同一个请求不会在下一次点击时又悄悄回到队列顶部。
-- ============================================================================

CREATE TABLE IF NOT EXISTS track_requests (
  id           TEXT PRIMARY KEY,            -- 歌曲 id,与 tracks.id 同格式
  member_id    TEXT NOT NULL,
  member_name  TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  artist       TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  cover        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  level        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | rejected
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_track_requests_status
  ON track_requests (status, requested_at);


-- ============================================================================
-- 变更步骤 —— 只增不改,每一步都可重复执行
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 剥掉榜单 id 的 163_ 前缀
--
-- /api/charts 曾经发出 `163_2166519574` 这种 id。id 词表里只有 qq: 和 kg: 两个
-- 前缀 —— sourceOf() 只认这两个,bare() 也只剥这两个 —— 所以带前缀的 id 原样送到
-- 上游解析器,整个榜单一首都播不了,主源和备用源一起死。
--
-- 接口已经改成发裸 id。已经用带前缀的 id 写进 D1 的行不处理的话 findTrack() 就
-- 找不到它们,/api/song 会重新解析并重新入库,留下一条指向没人引用的 R2 对象的
-- 孤儿行。
--
-- 条件写成 substr(id, 1, 4) = '163_' 而不是 LIKE。两个理由:
--
--   1. LIKE 里的 `_` 是单字符通配符,所以 '163_%' 会把 `163456789` 这种正常的
--      网易云 id 也匹配上,砍成 `456789`。躲开它需要一个 ESCAPE 子句和一个反斜杠。
--   2. 而那个反斜杠在 Cloudflare 控制台的输入框里经过网页和 JSON 传输,不保证
--      原样到达 SQLite。substr 是精确比较,没有通配符也不需要转义,两条路都躲开
--      了 —— 整份文件因此不含任何反斜杠,可以整段粘贴。
--
-- 幂等:改完之后没有任何 id 的前四个字符是 '163_'。
-- ----------------------------------------------------------------------------

-- 先删掉「裸 id 已经存在」的那些带前缀行,否则下面的 UPDATE 会撞主键。留下的那份
-- 是搜索入库的,音频是同一个。
DELETE FROM tracks
 WHERE substr(id, 1, 4) = '163_'
   AND substr(id, 5) IN (
     SELECT id FROM tracks WHERE substr(id, 1, 4) <> '163_'
   );

UPDATE tracks
   SET id = substr(id, 5)
 WHERE substr(id, 1, 4) = '163_';

-- 收藏里也可能存了带前缀的 id(从榜单点的心)。同样先去重再改。
DELETE FROM member_favorites
 WHERE substr(id, 1, 4) = '163_'
   AND EXISTS (
     SELECT 1 FROM member_favorites AS f2
      WHERE f2.member_id = member_favorites.member_id
        AND f2.id = substr(member_favorites.id, 5)
   );

UPDATE member_favorites
   SET id = substr(id, 5)
 WHERE substr(id, 1, 4) = '163_';

INSERT OR IGNORE INTO schema_migrations (step, applied_at)
VALUES ('strip-163-prefix', 1767225600000);

INSERT OR IGNORE INTO schema_migrations (step, applied_at)
VALUES ('track-requests', 1767225600000);


-- ----------------------------------------------------------------------------
-- 加列的写法(模板,当前没有需要加的列)
--
-- SQLite 没有 ADD COLUMN IF NOT EXISTS,而 wrangler d1 execute 遇到错误会中止
-- 整个文件。所以加列**不要**直接写进这份文件 —— 在控制台单独执行一次:
--
--   ALTER TABLE tracks ADD COLUMN mood TEXT NOT NULL DEFAULT '';
--
-- 然后把这一列补进上面的 CREATE TABLE(给将来的新库用),并在这里记一笔说明它是
-- 手工加的。这样新库从 CREATE TABLE 拿到列,旧库从那次手工执行拿到列,而这份文件
-- 依然可以重复执行。
-- ----------------------------------------------------------------------------


-- ============================================================================
-- 执行完看一眼
--
-- 一行多列,不是 UNION ALL。**D1 对 compound SELECT 的项数上限远低于标准
-- SQLite**:8 项(1 个 SELECT + 7 个 UNION ALL)在本地 sqlite 上没问题,在 D1
-- 控制台直接报 "too many terms in compound SELECT"。标量子查询没有这个限制,
-- 而且读起来是一行一目了然的仪表盘,本来就更合适。
--
-- 这是整份文件里唯一一条返回结果的语句,所以控制台显示的就是它。
--
-- leftover_* 两列必须是 0。
-- members 不是 0 而 owners 是 0,说明没人是站长 —— 那样删除、清理、审核会对
-- 所有人返回 403,包括你自己。补救:
--   UPDATE members SET is_owner = 1 WHERE id = '你的 member id';
-- ============================================================================

SELECT
  (SELECT COUNT(*) FROM tracks)                                         AS tracks,
  (SELECT COUNT(*) FROM members)                                        AS members,
  (SELECT COUNT(*) FROM members WHERE is_owner = 1)                     AS owners,
  (SELECT COUNT(*) FROM invites)                                        AS invites,
  (SELECT COUNT(*) FROM member_favorites)                               AS favorites,
  (SELECT COUNT(*) FROM track_requests)                                 AS requests,
  (SELECT COUNT(*) FROM tracks WHERE substr(id, 1, 4) = '163_')          AS leftover_tracks,
  (SELECT COUNT(*) FROM member_favorites WHERE substr(id, 1, 4) = '163_') AS leftover_favs;
