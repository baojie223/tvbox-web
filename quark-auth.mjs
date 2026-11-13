import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { loadQuarkSession, removeQuarkSession, saveQuarkSession } from './quark-store.mjs';

export const quarkLoginEnabled = process.env.TVBOX_HUAJUAN_NODE === '1';
const quarkOrigin = 'https://pan.quark.cn';
const pcOrigin = 'https://drive-pc.quark.cn';
const desktop = { pr: 'ucpro', fr: 'pc', sys: 'win32' };
const cas = { ...desktop, client_id: '386', v: '1.2' };
export const quarkDesktopAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const cookieValue = /^[\x21-\x2b\x2d-\x3a\x3c-\x7e]{1,4096}$/;
let challenge;
let account;
let generation = 0;
let accountChanges = Promise.resolve();

export class QuarkLoginError extends Error {
  action = 'quark-login';
}

function endpoint(origin, path, params) {
  const url = new URL(path, origin);
  url.search = new URLSearchParams(params);
  return url;
}

async function quarkRequest(url, cookie) {
  const headers = { 'user-agent': quarkDesktopAgent, referer: quarkOrigin + '/' };
  if (cookie) headers.cookie = cookie;
  let response;
  try {
    response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('无法连接夸克登录服务，请重试。');
  }
  if (!response.ok) throw new Error(`夸克登录服务返回 HTTP ${response.status}。`);
  return response;
}

async function casRequest(method, params = {}) {
  const response = await quarkRequest(endpoint('https://uop.quark.cn', '/cas/ajax/' + method, {
    ...cas, request_id: randomUUID(), ...params,
  }));
  return response.json();
}

export function quarkAccount(id) {
  return account && (id === undefined || account.id === id) ? account : undefined;
}

export async function restoreQuarkAccount() {
  if (!quarkLoginEnabled) return;
  try {
    account = await loadQuarkSession();
  } catch {
    console.warn('无法恢复本机保存的夸克会话，请重新扫码。');
  }
}

function changeAccount(work) {
  const change = accountChanges.then(work);
  accountChanges = change.catch(() => {});
  return change;
}

export function clearQuarkAccount(id) {
  if (id === undefined) {
    challenge = undefined;
    generation++;
  }
  return changeAccount(async () => {
    if (id !== undefined && account?.id !== id) return;
    if (quarkLoginEnabled) {
      try { await removeQuarkSession(); }
      catch { throw new Error('无法清除本机保存的夸克会话，请重试。'); }
    }
    account = undefined;
  });
}

export async function createQuarkLogin() {
  const version = ++generation;
  challenge = undefined;
  const result = await casRequest('getTokenForQrcodeLogin');
  const token = result.data?.members?.token;
  if (result.status !== 2000000 || typeof token !== 'string' || !token) throw new Error('夸克未生成可用的扫码令牌。');
  const address = endpoint('https://su.quark.cn', '/4_eMHBJ', {
    token, client_id: cas.client_id, sch: 'pckk@other_ch', sve: '3.1.8', ssb: 'weblogin',
    uc_param_str: '', uc_biz_str: 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0',
  });
  const qr = await QRCode.toDataURL(address.href, { width: 240, margin: 3 });
  if (version !== generation) throw new Error('扫码请求已更新，请使用最新二维码。');
  challenge = { id: randomUUID(), token, expires: Date.now() + 5 * 60_000 };
  return { id: challenge.id, qr };
}

async function exchange(ticket) {
  const login = await quarkRequest(endpoint(quarkOrigin, '/desktop/account/login', { ...desktop, st: ticket }));
  const data = (await login.json()).data;
  const uid = String(data?.uid ?? '');
  if (typeof data?.pus !== 'string' || !cookieValue.test(data.pus) || !cookieValue.test(uid)) {
    throw new Error('扫码确认后，夸克没有发放有效的桌面会话。');
  }
  const cookies = new Map([['__pus', data.pus], ['__uid', uid]]);
  const cookie = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const flush = await quarkRequest(endpoint(pcOrigin, '/1/clouddrive/auth/pc/flush', { ...desktop, ve: '3.1.8' }), cookie());
  const result = await flush.json().catch(() => ({}));
  if (result.code !== undefined && result.code !== 0) throw new Error('夸克未完成桌面会话确认。');
  for (const header of flush.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const match = /^(__pus|__uid|__kps)=(.*)$/.exec(pair.trim());
    if (match && cookieValue.test(match[2])) cookies.set(match[1], match[2]);
  }
  return cookie();
}

async function checkChallenge(current) {
  const result = await casRequest('getServiceTicketByQrcodeToken', { token: current.token });
  if (challenge !== current) return { state: 'expired' };
  if (result.status === 50004001) return { state: 'waiting' };
  if ([50004002, 50004003, 50004004].includes(result.status)) {
    challenge = undefined;
    return { state: 'expired' };
  }
  const ticket = result.data?.members?.service_ticket;
  if (result.status !== 2000000 || typeof ticket !== 'string' || !ticket) throw new Error('夸克没有返回有效的扫码确认结果。');
  try {
    const cookie = await exchange(ticket);
    return await changeAccount(async () => {
      if (challenge !== current) return { state: 'expired' };
      const next = { id: randomUUID(), cookie };
      if (quarkLoginEnabled) {
        try { await saveQuarkSession(next); }
        catch { throw new Error('夸克已确认扫码，但本机无法保存会话，请重试。'); }
      }
      account = next;
      return { state: 'logged-in' };
    });
  } finally {
    if (challenge === current) challenge = undefined;
  }
}

export function pollQuarkLogin(id) {
  const current = challenge;
  if (!current || current.id !== id || Date.now() >= current.expires) return { state: 'expired' };
  current.pending ??= checkChallenge(current).finally(() => { current.pending = undefined; });
  return current.pending;
}
