// Cloudflare Pages Function: 次卡数据云端存储
// KV namespace 必须以 DATA 这个变量名绑定到本项目

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  // 客户端传的是 SHA-256(shopKey:password:salt) 的 hex，固定 64 位
  if (!/^[a-f0-9]{64}$/.test(key)) {
    return json({ error: 'invalid key' }, 400);
  }

  if (!env.DATA) {
    return json({ error: 'kv namespace DATA not bound' }, 500);
  }

  const kvKey = `shop:${key}`;

  if (request.method === 'GET') {
    const v = await env.DATA.get(kvKey);
    if (v == null) return json({ error: 'not found' }, 404);
    return new Response(v, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 5 * 1024 * 1024) {
      return json({ error: 'payload too large' }, 413);
    }
    try {
      JSON.parse(body);
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    await env.DATA.put(kvKey, body);
    return json({ ok: true });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,PUT,OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }

  return json({ error: 'method not allowed' }, 405);
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
