// Cloudflare Pages Function: 次卡数据云端存储
// KV namespace 必须以 DATA 这个变量名绑定到本项目
// 支持 gzip 压缩上传（Content-Type: application/octet-stream）和旧的 JSON 明文上传

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
    // 以二进制读出，根据魔数判断是否 gzip 压缩
    const buf = await env.DATA.get(kvKey, 'arrayBuffer');
    if (buf == null) return json({ error: 'not found' }, 404);

    const bytes = new Uint8Array(buf);
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

    if (isGzip) {
      try {
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([buf]).stream().pipeThrough(ds);
        const text = await new Response(stream).text();
        return new Response(text, {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      } catch (e) {
        return json({ error: 'decompress failed' }, 500);
      }
    }

    // 老数据：未压缩的 JSON 明文，直接返回
    return new Response(buf, {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'PUT') {
    const ct = request.headers.get('content-type') || '';

    if (ct.includes('application/octet-stream')) {
      // 新版客户端：gzip 压缩后的二进制
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 2 * 1024 * 1024) {
        return json({ error: 'payload too large' }, 413);
      }
      await env.DATA.put(kvKey, buf);
      return json({ ok: true });
    }

    // 旧版客户端：未压缩的 JSON 明文（向后兼容）
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
