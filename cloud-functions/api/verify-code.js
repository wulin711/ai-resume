import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const codesPath = join(__dirname, '..', '..', 'data', 'codes.json');
const codesData = JSON.parse(readFileSync(codesPath, 'utf-8'));
const codes = codesData.codes;

const usedCodes = new Map();
const RATE_LIMIT = new Map();

export default async function onRequest(context) {
  const { request } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers,
    });
  }

  try {
    // Rate limit: 10 attempts per IP per hour
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || 'unknown';
    const attempts = RATE_LIMIT.get(ip) || { count: 0, resetAt: Date.now() + 3600000 };
    if (Date.now() > attempts.resetAt) {
      attempts.count = 0;
      attempts.resetAt = Date.now() + 3600000;
    }
    attempts.count++;
    RATE_LIMIT.set(ip, attempts);

    if (attempts.count > 10) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'too_many_attempts',
        message: '尝试次数过多，请1小时后再试',
      }), { status: 429, headers });
    }

    const body = await request.json();
    const { code } = body;

    if (!code || typeof code !== 'string' || code.trim().length < 6) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'invalid_input',
        message: '请输入有效的验证码',
      }), { headers });
    }

    const normalizedCode = code.trim().toUpperCase();

    const codeEntry = codes.find(c => c.code === normalizedCode);
    if (!codeEntry) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'not_found',
        message: '验证码无效',
      }), { headers });
    }

    if (usedCodes.has(normalizedCode)) {
      return new Response(JSON.stringify({
        valid: false,
        reason: 'already_used',
        message: '该验证码已被使用',
      }), { headers });
    }

    usedCodes.set(normalizedCode, Date.now());

    return new Response(JSON.stringify({
      valid: true,
      message: '验证成功',
    }), { headers });

  } catch (err) {
    return new Response(JSON.stringify({
      valid: false,
      reason: 'error',
      message: '验证失败，请稍后重试',
    }), { status: 500, headers });
  }
}
