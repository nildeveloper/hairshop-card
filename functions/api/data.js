// Cloudflare Pages Function: 次卡数据云端存储
// KV namespace 必须以 DATA 这个变量名绑定到本项目
// 纯二进制存取 —— 加解密/压缩全部由客户端处理
//
// 环境变量（在 Cloudflare Pages → Settings → Environment variables 配置）：
//   TURNSTILE_SECRET   —— Cloudflare Turnstile 的 secret key；不设则跳过验证
//   DAILY_WRITE_LIMIT  —— 每天最大 PUT 次数（默认 2000，触发后当天拒绝新写入）

const DEFAULT_DAILY_LIMIT = 2000;
const COUNTER_TTL_SEC = 172800; // 48h，自动过期

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!/^[a-f0-9]{64}$/.test(key)) {
    return json({ error: 'invalid key' }, 400);
  }

  if (!env.DATA) {
    return json({ error: 'kv namespace DATA not bound' }, 500);
  }

  const kvKey = `shop:${key}`;

  if (request.method === 'GET') {
    const buf = await env.DATA.get(kvKey, 'arrayBuffer');
    if (buf == null) return json({ error: 'not found' }, 404);

    return new Response(buf, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'PUT') {
    // 1. Turnstile 人机校验（若 secret 已配置）
    if (env.TURNSTILE_SECRET) {
      const token = request.headers.get('cf-turnstile-token');
      if (!token) return json({ error: 'turnstile required' }, 403);
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const vr = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
      if (!vr.success) {
        return json({ error: 'turnstile failed', codes: vr['error-codes'] || [] }, 403);
      }
    }

    // 2. 日写入额度（账单兜底保险丝）
    const limit = parseInt(env.DAILY_WRITE_LIMIT || String(DEFAULT_DAILY_LIMIT), 10);
    const today = new Date().toISOString().slice(0, 10);
    const counterKey = `meta:writes:${today}`;
    const cur = parseInt((await env.DATA.get(counterKey)) || '0', 10);
    if (cur >= limit) {
      return json({ error: 'daily write quota exceeded, retry tomorrow' }, 503);
    }

    // 3. 校验 payload 并写入
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 2 * 1024 * 1024) {
      return json({ error: 'payload too large' }, 413);
    }
    await env.DATA.put(kvKey, buf);

    // 4. 计数 +1（不阻塞响应；KV 弱一致，计数为近似值）
    context.waitUntil(
      env.DATA.put(counterKey, String(cur + 1), { expirationTtl: COUNTER_TTL_SEC })
    );

    return json({ ok: true });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,PUT,OPTIONS',
        'access-control-allow-headers': 'content-type,cf-turnstile-token',
      },
    });
  }

  return json({ error: 'method not allowed' }, 405);
}

async function verifyTurnstile(token, secret, ip) {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    return await r.json();
  } catch (e) {
    return { success: false, 'error-codes': ['siteverify_network_error'] };
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
