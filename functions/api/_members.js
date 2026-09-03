/**
 * Multi-user access for VPlayer.
 *
 * Model (chosen deliberately):
 *   - ONE shared cloud library (the `tracks` table + R2 objects). Song bytes are
 *     stored once and everyone plays from the same copy — no per-user duplication.
 *   - Per-member favourites (`member_favorites`). Each person keeps an independent
 *     list; it lives server-side so it follows them across devices/contexts.
 *   - Invite codes gate who can join. The owner generates a code; redeeming it
 *     mints a member row and a bearer token the client stores.
 *
 * A token is not a password — it's an opaque random string. It identifies the
 * member on every request via the Authorization header or a `token` query param.
 * This is intentionally lightweight: no registration, no email, no sessions.
 *
 * The whole system is optional. With no members table or no invites, VPlayer
 * behaves exactly as the single-user app it was — membersReady() gates it.
 */

const enc = new TextEncoder();

export const membersReady = (env) => Boolean(env.DB);

function now() {
  return Date.now();
}

/** A URL-safe random token. */
function randToken(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A short, human-typeable invite code: 4-4 uppercase alphanumerics. */
function randCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const chars = [...buf].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Read the bearer token from Authorization: Bearer <t> or ?token=<t>. */
export function tokenFromRequest(request) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  try {
    return new URL(request.url).searchParams.get('token') || '';
  } catch {
    return '';
  }
}

/** Resolve the member for a request, or null. Touches last_seen. */
export async function memberFromRequest(env, request) {
  if (!membersReady(env)) return null;
  const token = tokenFromRequest(request);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT * FROM members WHERE token = ?').bind(token).first();
  if (!row) return null;
  // Best-effort last-seen bump; don't block the response on it.
  env.DB.prepare('UPDATE members SET last_seen = ? WHERE id = ?').bind(now(), row.id).run().catch(() => {});
  return row;
}

/**
 * Bootstrap: if there are no members yet, the first person to hit /api/members/
 * bootstrap with the OWNER_SECRET becomes the owner. This avoids a chicken-and-
 * egg problem (you need to be a member to create invites, but there are no
 * members). OWNER_SECRET is an env var only you know.
 */
export async function bootstrapOwner(env, secret, name) {
  if (!membersReady(env)) throw new Error('未配置数据库');
  if (!env.OWNER_SECRET) throw new Error('未设置 OWNER_SECRET');
  if (secret !== env.OWNER_SECRET) throw new Error('密钥不正确');

  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE is_owner = 1').first();
  if (existing && existing.n > 0) {
    // Owner already exists — return their token so you can recover it.
    const owner = await env.DB.prepare('SELECT * FROM members WHERE is_owner = 1 LIMIT 1').first();
    return { id: owner.id, token: owner.token, name: owner.name, isOwner: true, existing: true };
  }

  const id = randToken(8);
  const token = randToken(24);
  const t = now();
  await env.DB.prepare(
    'INSERT INTO members (id, token, name, invite_code, is_owner, created_at, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)'
  ).bind(id, token, name || '站长', '', t, t).run();
  return { id, token, name: name || '站长', isOwner: true, existing: false };
}

/** Create an invite code. Owner only. */
export async function createInvite(env, { label = '', maxUses = 1, expiresInDays = 0 } = {}) {
  if (!membersReady(env)) throw new Error('未配置数据库');
  const code = randCode();
  const t = now();
  const expiresAt = expiresInDays > 0 ? t + expiresInDays * 86400000 : null;
  await env.DB.prepare(
    'INSERT INTO invites (code, label, max_uses, used, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)'
  ).bind(code, label, maxUses, t, expiresAt).run();
  return { code, label, maxUses, expiresAt };
}

/** Redeem an invite → creates a member and returns their token. */
export async function redeemInvite(env, code, name) {
  if (!membersReady(env)) throw new Error('未配置数据库');
  const invite = await env.DB.prepare('SELECT * FROM invites WHERE code = ?').bind(String(code).trim().toUpperCase()).first();
  if (!invite) throw new Error('邀请码无效');
  if (invite.expires_at && now() > invite.expires_at) throw new Error('邀请码已过期');
  if (invite.max_uses !== 0 && invite.used >= invite.max_uses) throw new Error('邀请码已被用完');

  const id = randToken(8);
  const token = randToken(24);
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO members (id, token, name, invite_code, is_owner, created_at, last_seen) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).bind(id, token, name || '成员', invite.code, t, t),
    env.DB.prepare('UPDATE invites SET used = used + 1 WHERE code = ?').bind(invite.code),
  ]);
  return { id, token, name: name || '成员', isOwner: false };
}

/** List members (owner only). */
export async function listMembers(env) {
  if (!membersReady(env)) return [];
  const { results } = await env.DB.prepare(
    'SELECT id, name, invite_code, is_owner, created_at, last_seen FROM members ORDER BY created_at ASC'
  ).all();
  return results || [];
}

/** List invites (owner only). */
export async function listInvites(env) {
  if (!membersReady(env)) return [];
  const { results } = await env.DB.prepare(
    'SELECT code, label, max_uses, used, created_at, expires_at FROM invites ORDER BY created_at DESC'
  ).all();
  return results || [];
}

/** Remove a member (owner only). Their favourites go too. */
export async function removeMember(env, memberId) {
  if (!membersReady(env)) throw new Error('未配置数据库');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM member_favorites WHERE member_id = ?').bind(memberId),
    env.DB.prepare('DELETE FROM members WHERE id = ? AND is_owner = 0').bind(memberId),
  ]);
  return { ok: true };
}

/** Get a member's favourites. */
export async function getFavorites(env, memberId) {
  if (!membersReady(env)) return [];
  const { results } = await env.DB.prepare(
    'SELECT id, name, artist, album, cover, source FROM member_favorites WHERE member_id = ? ORDER BY added_at DESC'
  ).bind(memberId).all();
  return results || [];
}

/**
 * Replace a member's whole favourites list. The client owns the ordering and
 * membership of the list; the server just persists it. Simpler and more robust
 * than diffing add/remove, and the lists are small (hundreds of rows).
 */
export async function setFavorites(env, memberId, favorites) {
  if (!membersReady(env)) throw new Error('未配置数据库');
  const t = now();
  const rows = Array.isArray(favorites) ? favorites : [];
  const stmts = [env.DB.prepare('DELETE FROM member_favorites WHERE member_id = ?').bind(memberId)];
  // added_at descends with index so the DESC order above matches the client's.
  rows.forEach((f, i) => {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO member_favorites (member_id, id, name, artist, album, cover, source, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        memberId,
        String(f.id),
        f.name || '',
        f.artist || '',
        f.album || '',
        f.cover || '',
        f.source || '',
        t - i
      )
    );
  });
  // D1 batch has a statement cap; chunk large lists.
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return { ok: true, count: rows.length };
}

/**
 * Route handler for /api/members/*. Returns a Response or null if the path is
 * not a members route (so the caller can fall through).
 */
export async function membersRoute(context, rest, json, fail) {
  const { request, env } = context;
  const sub = rest[0] || '';

  if (!membersReady(env)) return fail('未配置数据库（需要 D1 绑定 DB）', 501);

  // --- Public: redeem an invite, no token needed ---
  if (sub === 'redeem' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    try {
      const member = await redeemInvite(env, body.code, body.name);
      return json({ ok: true, member });
    } catch (err) {
      return fail(err.message, 400);
    }
  }

  // --- Owner bootstrap with the secret ---
  if (sub === 'bootstrap' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    try {
      const owner = await bootstrapOwner(env, body.secret, body.name);
      return json({ ok: true, member: owner });
    } catch (err) {
      return fail(err.message, 403);
    }
  }

  // Everything below needs a valid member token.
  const member = await memberFromRequest(env, request);
  if (!member) return fail('需要有效的成员令牌', 401);

  // --- Who am I ---
  if (sub === 'me' && request.method === 'GET') {
    return json({ ok: true, member: { id: member.id, name: member.name, isOwner: Boolean(member.is_owner) } });
  }

  // --- Favourites: get / set ---
  if (sub === 'favorites') {
    if (request.method === 'GET') {
      return json({ ok: true, favorites: await getFavorites(env, member.id) });
    }
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const result = await setFavorites(env, member.id, body.favorites);
      return json({ ok: true, ...result });
    }
  }

  // --- Owner-only: manage invites and members ---
  const ownerOnly = () => Boolean(member.is_owner);

  if (sub === 'invites') {
    if (!ownerOnly()) return fail('仅站长可管理邀请码', 403);
    if (request.method === 'GET') {
      return json({ ok: true, invites: await listInvites(env) });
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const invite = await createInvite(env, {
        label: body.label,
        maxUses: Number(body.maxUses) || 1,
        expiresInDays: Number(body.expiresInDays) || 0,
      });
      return json({ ok: true, invite });
    }
  }

  if (sub === 'list') {
    if (!ownerOnly()) return fail('仅站长可查看成员', 403);
    return json({ ok: true, members: await listMembers(env) });
  }

  if (sub === 'remove' && request.method === 'POST') {
    if (!ownerOnly()) return fail('仅站长可移除成员', 403);
    const body = await request.json().catch(() => ({}));
    await removeMember(env, body.memberId);
    return json({ ok: true });
  }

  return fail(`未知成员接口 /api/members/${sub}`, 404);
}
