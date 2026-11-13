import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function sessionFile() {
  const directory = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !directory) throw new Error('夸克会话持久化需要 Windows 用户数据目录。');
  return join(directory, 'TVBoxWeb', 'quark-session.dpapi');
}

function dpapi(method, bytes) {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Security
    $data = [Convert]::FromBase64String([Console]::In.ReadToEnd())
    $purpose = [Text.Encoding]::UTF8.GetBytes('TVBoxWeb/QuarkSession/v1')
    $result = [Security.Cryptography.ProtectedData]::${method}($data, $purpose, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($result))
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal: AbortSignal.timeout(10_000),
    });
    const chunks = [];
    const failure = () => reject(new Error('Windows 无法处理夸克会话的加密存储。'));
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', failure);
    child.stdin.on('error', failure);
    child.on('close', code => {
      if (code !== 0 || !chunks.length) return failure();
      resolve(Buffer.from(Buffer.concat(chunks).toString('ascii'), 'base64'));
    });
    child.stdin.end(bytes.toString('base64'));
  });
}

export async function loadQuarkSession(file = sessionFile()) {
  let encrypted;
  try {
    encrypted = await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const { id, cookie, version } = JSON.parse((await dpapi('Unprotect', encrypted)).toString('utf8'));
  if (version !== 1 || typeof id !== 'string' || !id || typeof cookie !== 'string' || !cookie || /[\r\n]/.test(cookie)) {
    throw new Error('已保存的夸克会话格式无效。');
  }
  return { id, cookie };
}

export async function saveQuarkSession({ id, cookie }, file = sessionFile()) {
  const encrypted = await dpapi('Protect', Buffer.from(JSON.stringify({ version: 1, id, cookie })));
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, encrypted, { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function removeQuarkSession(file = sessionFile()) {
  await unlink(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}
