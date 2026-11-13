const status = document.getElementById('quark-status');
const qr = document.getElementById('quark-qr');
const refresh = document.getElementById('quark-refresh');
const logout = document.getElementById('quark-logout');
let timer;
let attempt;

async function api(path, body) {
  const response = await fetch('/api/quark/' + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `夸克请求失败（HTTP ${response.status}）。`);
  return result;
}

function loggedIn() {
  attempt = undefined;
  qr.hidden = true;
  qr.removeAttribute('src');
  refresh.hidden = true;
  logout.hidden = false;
  status.textContent = '已登录。会话已加密保存在本机，重启后会自动恢复。回到花卷试验版即可继续播放。';
}

function showError(error) {
  qr.hidden = true;
  qr.removeAttribute('src');
  refresh.hidden = false;
  status.textContent = error.message;
}

async function poll(id) {
  if (attempt !== id) return;
  try {
    const { state } = await api('poll', { id });
    if (attempt !== id) return;
    if (state === 'logged-in') loggedIn();
    else if (state === 'waiting') timer = setTimeout(() => poll(id), 2500);
    else showError(new Error('二维码已失效，请重新生成。'));
  } catch (error) {
    if (attempt === id) showError(error);
  }
}

async function start() {
  clearTimeout(timer);
  attempt = undefined;
  refresh.hidden = true;
  qr.hidden = true;
  status.textContent = '正在生成二维码…';
  try {
    const { id, qr: image } = await api('login', {});
    attempt = id;
    qr.src = image;
    qr.hidden = false;
    refresh.hidden = false;
    status.textContent = '请用手机夸克 App 扫码，并在手机上确认登录。';
    timer = setTimeout(() => poll(id), 2500);
  } catch (error) {
    showError(error);
  }
}

refresh.addEventListener('click', start);
logout.addEventListener('click', async () => {
  try {
    await api('logout', {});
    logout.hidden = true;
    refresh.hidden = false;
    status.textContent = '已退出本机登录。';
  } catch (error) {
    status.textContent = error.message;
  }
});
window.addEventListener('pagehide', () => { clearTimeout(timer); attempt = undefined; });
try {
  if ((await api('status')).loggedIn) loggedIn();
  else await start();
} catch (error) {
  showError(error);
}
