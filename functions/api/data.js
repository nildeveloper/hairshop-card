// Cloudflare Pages Function: 次卡数据云端存储
// KV namespace 必须以 DATA 这个变量名绑定到本项目
// 纯二进制存取 —— 加解密/压缩全部由客户端处理
//
// 防护层：
//   1) HMAC 验签：前端用 password 派生 verifier（HMAC key），首次 PUT 通过 x-init 注册到 KV，
//      之后每次 PUT 用 verifier 签 (method|key|ts|sha256(body))。攻击者没 password 就算不出签名。
//   2) per-shopKey 每日 PUT 上限（默认 100）：即便密码泄露也挡得住高频刷写。
//   3) 全局每日 PUT 上限（默认 2000）：账单兜底保险丝。
//
// 环境变量（可选，在 Cloudflare Pages → Settings → Environment variables 配置）：
//   DAILY_WRITE_LIMIT     —— 全站每天最大 PUT 次数（默认 2000）
//   DAILY_KEY_LIMIT       —— 单 key 每天最大 PUT 次数（默认 100）
//   TS_WINDOW_SEC         —— timestamp 容差秒数（默认 600，±10min）

const DEFAULT_DAILY_GLOBAL = 2000;
const DEFAULT_DAILY_KEY    = 100;
const DEFAULT_TS_WINDOW    = 600;
const COUNTER_TTL_SEC      = 172800; // 48h，自动过期

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

  const kvKey  = `shop:${key}`;
  const authKv = `auth:${key}`;

  if (request.method === 'GET') {
    const buf = await env.DATA.get(kvKey, 'arrayBuffer');
    if (buf == null) return json({ error: 'not found' }, 404);

    return new Response(buf, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'PUT') {
    // 1. payload 大小
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 2 * 1024 * 1024) {
      return json({ error: 'payload too large' }, 413);
    }

    // 2. 时间戳窗口
    const tsHeader = request.headers.get('x-ts') || '';
    const sigHex   = request.headers.get('x-sig') || '';
    const initHex  = request.headers.get('x-init') || '';
    const ts = parseInt(tsHeader, 10);
    if (!ts || isNaN(ts)) return json({ error: 'missing x-ts' }, 401);
    const window = parseInt(env.TS_WINDOW_SEC || String(DEFAULT_TS_WINDOW), 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > window) {
      return json({ error: 'timestamp out of window', skew: now - ts }, 401);
    }

    // 3. 取 verifier：KV 优先；首次写入用 x-init（TOFU）
    if (!/^[a-f0-9]{64}$/.test(sigHex)) return json({ error: 'missing x-sig' }, 401);
    let verifierHex = await env.DATA.get(authKv);
    let isFirstWrite = false;
    if (!verifierHex) {
      if (!/^[a-f0-9]{64}$/.test(initHex)) {
        return json({ error: 'verifier not registered; provide x-init on first write' }, 401);
      }
      verifierHex = initHex;
      isFirstWrite = true;
    }

    // 4. 验签
    const ok = await verifyHmac(verifierHex, sigHex, `PUT|${key}|${ts}|${await sha256Hex(buf)}`);
    if (!ok) return json({ error: 'invalid signature' }, 401);

    // 5. per-key 每日额度
    const today = new Date().toISOString().slice(0, 10);
    const keyCounterKey = `kw:${key}:${today}`;
    const keyLimit = parseInt(env.DAILY_KEY_LIMIT || String(DEFAULT_DAILY_KEY), 10);
    const keyCur = parseInt((await env.DATA.get(keyCounterKey)) || '0', 10);
    if (keyCur >= keyLimit) {
      return json({ error: 'per-key daily quota exceeded, retry tomorrow' }, 429);
    }

    // 6. 全局每日额度
    const globalCounterKey = `meta:writes:${today}`;
    const globalLimit = parseInt(env.DAILY_WRITE_LIMIT || String(DEFAULT_DAILY_GLOBAL), 10);
    const globalCur = parseInt((await env.DATA.get(globalCounterKey)) || '0', 10);
    if (globalCur >= globalLimit) {
      return json({ error: 'global daily quota exceeded, retry tomorrow' }, 503);
    }

    // 7. 写数据 + 注册 verifier（首次）
    await env.DATA.put(kvKey, buf);
    if (isFirstWrite) {
      await env.DATA.put(authKv, verifierHex);
    }

    // 8. 计数 +1（不阻塞响应；KV 弱一致，计数为近似值）
    context.waitUntil(Promise.all([
      env.DATA.put(keyCounterKey, String(keyCur + 1), { expirationTtl: COUNTER_TTL_SEC }),
      env.DATA.put(globalCounterKey, String(globalCur + 1), { expirationTtl: COUNTER_TTL_SEC }),
    ]));

    return json({ ok: true, registered: isFirstWrite });
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,PUT,OPTIONS',
        'access-control-allow-headers': 'content-type,x-ts,x-sig,x-init',
      },
    });
  }

  return json({ error: 'method not allowed' }, 405);
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function verifyHmac(keyHex, sigHex, message) {
  try {
    const key = await crypto.subtle.importKey(
      'raw', hexToBytes(keyHex),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['verify']
    );
    return await crypto.subtle.verify(
      'HMAC', key,
      hexToBytes(sigHex),
      new TextEncoder().encode(message)
    );
  } catch {
    return false;
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
