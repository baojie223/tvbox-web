import { playCompatibleMedia } from './compatible-playback.js';

const byId = id => document.getElementById(id);
const configDialog = byId('config-dialog');
const accountDialog = byId('account-dialog');
const playerDialog = byId('player-dialog');
const searchInput = byId('search');
const sourceSearchInput = byId('source-search');
const sourceFilter = byId('source-filter');
const library = document.querySelector('.library');
const video = byId('video');
const pageSize = 48;
const state = {
  mode: 'vod', selected: { live: '', vod: '' }, config: null,
  category: '', page: 1, items: [], categories: [], more: false, searchTerm: '', sourceSearch: false,
};
let listRequest;
let searchRequest;
let detailRequest;
let accountRequest;
let playRequest;
let hls;
let currentVideo;
let playbackVersion = 0;
let playbackTimer;

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接放映室本地服务。');
  }
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `请求失败（HTTP ${response.status}）`);
    error.action = body.action;
    throw error;
  }
  return body;
}

function sourceRequest(path, params, options) {
  const query = new URLSearchParams({ config: state.config.id, source: state.selected[state.mode], ...params });
  return request(`/api/${path}?${query}`, options);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text, handler, selected, className) {
  const node = element('button', className, text);
  node.type = 'button';
  if (selected !== undefined) node.setAttribute('aria-pressed', selected);
  node.addEventListener('click', handler);
  return node;
}

function setStatus(id, text, error = false) {
  const output = byId(id);
  output.textContent = text;
  output.classList.toggle('error', error);
}

function setSearchFeedback(text = '') {
  const feedback = byId('search-feedback');
  feedback.textContent = text;
  feedback.hidden = !text;
}

function available() {
  return (state.mode === 'live' ? state.config?.lives : state.config?.sites) ?? [];
}

function activeSource() {
  return available().find(item => item.id === state.selected[state.mode]);
}

function openConfig(showCompatibility = false) {
  if (!configDialog.open) configDialog.showModal();
  if (showCompatibility) {
    byId('compatibility').open = true;
    byId('compatibility-summary').focus();
  }
}

function renderSources() {
  const list = available();
  sourceFilter.hidden = list.length <= 10;
  const filter = sourceFilter.hidden ? '' : sourceFilter.value.trim().toLowerCase();
  const items = list.filter(item => item.name.toLowerCase().includes(filter));
  const sources = byId('sources');
  const scroll = sources.scrollTop;
  sources.replaceChildren(...items.map(item => button(item.name, () => {
    if (state.selected[state.mode] === item.id && !state.searchTerm) return;
    state.selected[state.mode] = item.id;
    resetLibrary();
  }, item.id === state.selected[state.mode])));
  sources.scrollTop = scroll;
}

function renderSidebar() {
  for (const node of document.querySelectorAll('[data-mode]')) {
    node.setAttribute('aria-pressed', node.dataset.mode === state.mode);
  }
  const live = state.mode === 'live';
  const source = activeSource();
  byId('source-label').textContent = live ? '直播清单' : '点播片源';
  renderSources();
  byId('hero-source').textContent = source?.name ?? '';
  byId('hero-source').hidden = !source;
  byId('heading').textContent = live ? '直播频道' : '点播片库';
  byId('quark-login-link').hidden = !source?.quarkLogin;
  byId('source-search-form').hidden = !source || !!source.accountConfig;
}

function renderCompatibility() {
  const unavailable = state.config.unavailable;
  const label = `${unavailable.length} 条线路需要 TVBox 客户端`;
  byId('source-status').textContent = label;
  byId('source-status').hidden = !unavailable.length;
  byId('compatibility').hidden = !unavailable.length;
  byId('compatibility-summary').textContent = label;
  byId('compatibility-list').replaceChildren(...unavailable.map(item => element('li', '', `${item.name} · ${item.reason}`)));
}

function message(text, action, handler) {
  const output = byId('library-message');
  output.hidden = !text;
  output.textContent = text;
  if (action) output.append(button(action, handler, undefined, 'outline'));
}

function clearLibrary() {
  state.items = [];
  state.categories = [];
  state.more = false;
  byId('result-count').textContent = '';
  byId('categories').hidden = true;
  byId('items').replaceChildren();
  byId('pagination').hidden = true;
}

function resetLibrary() {
  searchRequest?.abort();
  searchRequest = undefined;
  state.searchTerm = '';
  state.sourceSearch = false;
  sourceSearchInput.value = '';
  byId('stop-search').hidden = true;
  state.category = '';
  state.page = 1;
  setSearchFeedback();
  clearLibrary();
  renderSidebar();
  loadLibrary();
}

async function loadConfig(url, fromDialog) {
  const loadButton = byId('load-config');
  loadButton.disabled = true;
  setStatus('config-feedback', '正在读取订阅…');
  try {
    const config = await request('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    state.config = config;
    sourceFilter.value = '';
    state.selected = { live: config.lives[0]?.id ?? '', vod: config.sites[0]?.id ?? '' };
    if (!available().length) state.mode = config.lives.length ? 'live' : 'vod';
    try { localStorage.setItem('tvbox-url', url); } catch { /* The subscription still works in this session. */ }
    setStatus('config-feedback', `已加载 ${config.lives.length} 个直播清单和 ${config.sites.length} 个网页点播源。`);
    renderCompatibility();
    resetLibrary();
    if (fromDialog && (config.lives.length || config.sites.length)) configDialog.close();
  } catch (error) {
    setStatus('config-feedback', error.message, true);
    if (!state.config) {
      library.setAttribute('aria-busy', 'false');
      byId('hero-summary').textContent = '订阅连接失败';
      message(error.message, '订阅设置', () => openConfig());
    }
  } finally {
    loadButton.disabled = false;
  }
}

function changeCategory(id) {
  state.category = id;
  state.page = 1;
  if (state.mode === 'live') renderLibrary();
  else loadLibrary();
}

function renderLibrary() {
  const live = state.mode === 'live';
  const categories = byId('categories');
  byId('library-heading').textContent = live ? '全部频道' : '全部影片';
  const showCategories = state.categories.length > 1;
  categories.hidden = !showCategories;
  if (showCategories) {
    const options = activeSource()?.categoryRequired ? state.categories : [{ id: '', name: '全部' }, ...state.categories];
    categories.replaceChildren(...options.map(item => button(item.name, () => changeCategory(item.id), item.id === state.category)));
  }
  const matches = live && state.category ? state.items.filter(item => item.group === state.category) : state.items;
  const start = (state.page - 1) * pageSize;
  const visible = live ? matches.slice(start, start + pageSize) : matches;
  const more = live ? matches.length > start + pageSize : state.more;
  byId('hero-summary').textContent = live ? `${state.items.length} 个频道` : '按分类浏览，或搜索全部点播片源';
  byId('result-count').textContent = `${matches.length} ${live ? '个频道' : '条结果'}`;
  const grid = byId('items');
  grid.classList.toggle('vod', !live);
  grid.replaceChildren(...visible.map(item => makeCard(item, live)));
  message(visible.length ? '' : '当前分类暂无内容，可切换分类或片源。');
  byId('pagination').hidden = state.page === 1 && !more;
  byId('page-number').textContent = `第 ${state.page} 页`;
  byId('previous-page').disabled = state.page === 1;
  byId('next-page').disabled = !more;
}

function makeCard(item, live, result) {
  const source = result?.source ?? activeSource();
  const name = (live ? item.name : item.title) || '未命名';
  const accountConfig = !live && source?.accountConfig && item.id === 'web';
  const card = button('', () => accountConfig ? openAccountConfig(name, source.id) : openPlayer(item.id, name, live, source), undefined, 'card');
  const art = element('span', 'card-art');
  const fallback = element('span', 'monogram', live ? [...name].slice(0, 9).join('') : [...name].slice(0, 5).join(''));
  fallback.setAttribute('aria-hidden', 'true');
  art.append(fallback);
  const image = live ? item.logo : item.image;
  if (image) {
    const img = element('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('load', () => { fallback.hidden = true; });
    img.addEventListener('error', () => img.remove());
    img.src = image;
    art.append(img);
  }
  const copy = element('span', 'card-copy');
  copy.append(element('span', 'card-title', name));
  const meta = live ? `${item.group}${item.lineCount > 1 ? ` · ${item.lineCount} 条线路` : ''}` : item.subtitle;
  if (meta) copy.append(element('span', 'card-meta', meta));
  if (result) {
    const qualifier = live ? '直播' : result.homepage || result.scope === 'home' ? '首页匹配' : result.scope === 'catalog' ? '分类匹配' : '';
    const label = [source.name, qualifier].filter(Boolean).join(' · ');
    const origin = element('span', 'card-source', label);
    origin.title = label;
    copy.append(origin);
  }
  card.append(art, copy);
  return card;
}

async function openAccountConfig(name, source = activeSource().id) {
  accountRequest?.abort();
  accountRequest = new AbortController();
  const { signal } = accountRequest;
  const link = byId('account-link');
  const retry = byId('account-retry');
  link.hidden = true;
  link.removeAttribute('href');
  retry.hidden = true;
  byId('account-title').textContent = name;
  setStatus('account-feedback', '正在连接 Android 配置页…');
  if (!accountDialog.open) accountDialog.showModal();
  try {
    const { url } = await sourceRequest('account-config', { source }, { method: 'POST', signal });
    if (signal.aborted) return;
    link.href = url;
    link.hidden = false;
    setStatus('account-feedback', '打开配置页，选择对应的服务扫码。');
  } catch (error) {
    if (signal.aborted) return;
    setStatus('account-feedback', error.message, true);
    retry.onclick = () => openAccountConfig(name, source);
    retry.hidden = false;
  }
}

async function loadLibrary() {
  listRequest?.abort();
  const source = activeSource();
  if (!source) {
    const text = state.mode === 'live' ? '此订阅没有网页可用的直播清单。' : '此订阅的点播线路需要 TVBox 客户端。';
    byId('hero-summary').textContent = '暂无网页可用片源';
    message(state.config ? text : '请先加载 TVBox 订阅。', '订阅设置', () => openConfig());
    library.setAttribute('aria-busy', 'false');
    return;
  }
  const controller = new AbortController();
  listRequest = controller;
  library.setAttribute('aria-busy', 'true');
  byId('hero-summary').textContent = '正在连接片源…';
  byId('result-count').textContent = '';
  byId('items').replaceChildren();
  byId('pagination').hidden = true;
  message('正在加载…');
  try {
    if (state.mode === 'live') {
      const channels = await sourceRequest('channels', {}, { signal: controller.signal });
      if (controller.signal.aborted) return;
      state.items = channels;
      state.categories = [...new Set(state.items.map(item => item.group))].map(group => ({ id: group, name: group }));
    } else {
      const result = await sourceRequest('catalog', { category: state.category, page: state.page }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      state.items = result.items;
      if (result.categories.length) state.categories = result.categories;
      if (source.categoryRequired && !state.category) state.category = state.categories[0]?.id ?? '';
      state.more = result.more;
    }
    renderLibrary();
  } catch (error) {
    if (controller.signal.aborted) return;
    byId('hero-summary').textContent = '片源暂时无法加载';
    message(error.message, '重试', loadLibrary);
  } finally {
    if (listRequest === controller) library.setAttribute('aria-busy', 'false');
  }
}

async function searchLibrary(keyword, source) {
  searchRequest?.abort();
  listRequest?.abort();
  listRequest = undefined;
  const controller = new AbortController();
  const { signal } = controller;
  searchRequest = controller;
  state.searchTerm = keyword;
  state.sourceSearch = !!source;
  const live = state.mode === 'live';
  const params = new URLSearchParams({ config: state.config.id, q: keyword });
  if (source) {
    params.set('source', source.id);
    params.set('mode', state.mode);
  }
  clearLibrary();
  library.setAttribute('aria-busy', 'false');
  byId('library-heading').textContent = source ? `“${keyword}”的片源内搜索结果` : `“${keyword}”的搜索结果`;
  byId('source-search-form').hidden = !source;
  byId('hero-source').hidden = !source;
  byId('hero-summary').textContent = source ? `在「${source.name}」中搜索` : '搜索当前订阅的点播片源和直播清单';
  byId('stop-search').hidden = false;
  const grid = byId('items');
  grid.classList.toggle('vod', !source || !live);
  message(source ? `正在搜索「${source.name}」…` : '正在搜索片源…');

  let total = 0;
  let searched = 0;
  let failed = 0;
  let complete = false;
  const seen = new Set();
  function updateProgress() {
    const checked = source ? `已查 ${searched} ${live ? '份清单' : '页'}` : `已查 ${searched}/${total} 个片源`;
    const progress = `${seen.size} 条结果 · ${checked}`;
    byId('result-count').textContent = failed ? `${progress} · ${failed} 个请求失败` : progress;
  }
  function showEvent(event) {
    if (event.type === 'start') total = event.total;
    if (event.type === 'source' || event.type === 'page') {
      searched++;
      if (event.failed) failed++;
      if (event.scope === 'catalog') byId('hero-summary').textContent = `在「${source.name}」的分类目录中匹配`;
      const cards = event.items.flatMap(item => {
        const key = JSON.stringify([event.live, event.source.id, item.id]);
        if (seen.has(key)) return [];
        seen.add(key);
        return [makeCard(item, event.live, event)];
      });
      grid.append(...cards);
      if (seen.size) message('');
    }
    if (event.type === 'done') complete = true;
    updateProgress();
  }
  try {
    const response = await fetch(`/api/search?${params}`, { signal });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error || `搜索请求失败（HTTP ${response.status}）。`);
    }
    let pending = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      if (signal.aborted) break;
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) if (line) showEvent(JSON.parse(line));
    }
    signal.throwIfAborted();
    if (!complete) throw new Error('搜索连接提前中断，已保留返回的结果。');
    if (!total) message('当前订阅没有可用的媒体片源。');
    else if (!seen.size) message(failed ? '未找到匹配结果，部分搜索请求失败。' : '未找到匹配结果，可试试其他关键词。');
  } catch (error) {
    if (searchRequest !== controller) return;
    if (signal.aborted) message('已停止搜索，已保留返回的结果。');
    else message(error instanceof TypeError ? '搜索连接中断，已保留返回的结果。' : error.message, '重试', () => searchLibrary(keyword, source));
  } finally {
    if (searchRequest === controller) {
      searchRequest = undefined;
      byId('stop-search').hidden = true;
    }
  }
}

function stopPlayback() {
  playbackVersion++;
  clearTimeout(playbackTimer);
  playRequest?.abort();
  playRequest = undefined;
  video.onerror = null;
  video.onplaying = null;
  video.pause();
  hls?.destroy();
  hls = undefined;
  video.removeAttribute('src');
  video.load();
}

function mediaHttpError(status) {
  const messages = {
    403: '片源拒绝访问',
    404: '媒体资源不存在',
    410: '媒体资源已失效',
    412: '媒体服务器拒绝了当前取流会话，请重试以重新解析地址',
    416: '片源无法读取请求的视频范围',
    502: '媒体转发失败，片源响应异常或连接中断',
  };
  return `${messages[status] || '媒体请求失败'}（HTTP ${status}）。`;
}

async function startPlayback(line, episode, alternatives, previousFailures) {
  stopPlayback();
  const version = playbackVersion;
  const controller = new AbortController();
  playRequest = controller;
  let started = false;
  let failed = false;
  let nativePlayback = false;
  let checkingNativeError = false;
  let stage = episode.id ? '分集解析' : '媒体加载';
  byId('screen').hidden = false;
  setStatus('player-feedback', previousFailures.length ? `正在换线，连接「${line.name}」…` : `正在连接「${line.name}」…`);
  const fail = (text, { action, canSwitch = !started } = {}) => {
    if (failed || version !== playbackVersion) return;
    failed = true;
    clearTimeout(playbackTimer);
    const failures = [...previousFailures, { text: `「${line.name}」${stage}：${text}`, action }];
    if (canSwitch && alternatives.length) {
      const [next, ...remaining] = alternatives;
      Object.assign(currentVideo, next);
      renderPlayer(remaining, failures);
      return;
    }
    stopPlayback();
    const output = byId('player-feedback');
    setStatus('player-feedback', failures.length === 1 ? failures[0].text : '以下线路播放失败', true);
    if (failures.length > 1) {
      const list = element('ul');
      list.append(...failures.map(failure => element('li', '', failure.text)));
      output.append(list);
    }
    const configSite = state.config?.sites.find(site => site.accountConfig);
    if (configSite && failures.some(failure => failure.action === 'account-config')) {
      output.append(button('打开账号配置中心', () => openAccountConfig('网页版配置中心', configSite.id), undefined, 'outline'));
    }
    if (failures.some(failure => failure.action === 'quark-login')) {
      const link = element('a', 'outline account-link', '夸克扫码登录');
      link.href = '/quark-login';
      link.target = '_blank';
      link.rel = 'noopener';
      output.append(link);
    }
    output.append(button('重试', () => renderPlayer(), undefined, 'outline'));
  };
  playbackTimer = setTimeout(() => fail('播放线路连接超时。'), 50_000);
  let media = episode;
  let isHls;
  try {
    if (episode.id) media = await sourceRequest('play', { ...currentVideo.selection, episode: episode.id }, { signal: controller.signal });
    stage = '媒体加载';
    isHls = media.hls;
    if (isHls == null) {
      const response = await fetch(media.url, { method: 'HEAD', signal: controller.signal });
      if (!response.ok) throw new Error(mediaHttpError(response.status));
      isHls = /mpegurl/i.test(response.headers.get('Content-Type') ?? '');
    }
  } catch (error) {
    fail(error instanceof TypeError ? '无法连接媒体转发服务。' : error.message, { action: error.action });
    return;
  }
  if (version !== playbackVersion) return;
  const mediaFailed = async () => {
    const code = video.error?.code;
    if (nativePlayback && (code === 2 || code === 4)) {
      if (checkingNativeError) return;
      checkingNativeError = true;
      try {
        const response = await fetch(media.url, { method: 'HEAD', signal: controller.signal });
        if (!response.ok) {
          fail(mediaHttpError(response.status));
          return;
        }
      } catch {
        fail('无法连接媒体转发服务。');
        return;
      }
    }
    if (code === 3 || code === 4) {
      stage = '浏览器解码';
      fail('浏览器无法播放该媒体格式或编码。');
    } else {
      fail('视频数据加载失败，请重试或切换线路。');
    }
  };
  const play = () => {
    if (version !== playbackVersion) return;
    video.play().catch(error => {
      if (version !== playbackVersion) return;
      if (error.name === 'NotAllowedError') {
        clearTimeout(playbackTimer);
        setStatus('player-feedback', '点击播放器上的播放按钮开始。');
      }
      else if (error.name !== 'AbortError') mediaFailed();
    });
  };
  video.onerror = mediaFailed;
  video.onplaying = () => {
    started = true;
    clearTimeout(playbackTimer);
    setStatus('player-feedback', '');
  };
  if (media.compatible) {
    stage = '原画音频转换';
    playCompatibleMedia(video, media, controller.signal, play, fail).catch(error => {
      if (!controller.signal.aborted) fail(error.message);
    });
  } else if (isHls && window.Hls?.isSupported()) {
    hls = new window.Hls();
    hls.on(window.Hls.Events.ERROR, (_, info) => {
      const unsupportedVideo = info.details === window.Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR &&
        ['video', 'audiovideo'].includes(info.sourceBufferName);
      if (!info.fatal && !unsupportedVideo) return;
      queueMicrotask(() => {
        if (unsupportedVideo) {
          stage = '浏览器解码';
          fail('浏览器无法解码这条线路的视频。', { canSwitch: video.videoWidth === 0 });
          return;
        }
        if (/^(manifest|level|audioTrack|subtitleTrack)/.test(info.details)) stage = '播放清单';
        else if (/^frag/.test(info.details)) stage = '视频分片';
        else if (/^key/.test(info.details)) stage = '解密密钥';
        else if (/^buffer/.test(info.details)) stage = '浏览器解码';
        const status = info.response?.code;
        if (status >= 400) fail(mediaHttpError(status));
        else if (/timeout/i.test(info.details)) fail('等待片源响应超时。');
        else if (/ParsingError/.test(info.details)) fail('片源返回的数据格式无法解析。');
        else if (stage === '浏览器解码') fail('浏览器无法处理这条线路的音视频数据。');
        else mediaFailed();
      });
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, play);
    hls.loadSource(media.url);
    hls.attachMedia(video);
  } else if (!isHls || video.canPlayType('application/vnd.apple.mpegurl')) {
    nativePlayback = true;
    video.src = media.url;
    play();
  } else {
    fail('当前浏览器缺少 HLS 播放支持。请使用 Edge 或 Chrome。');
  }
}

function episodeLabel(name) {
  const label = String(name ?? '').normalize('NFKC').trim().toLowerCase();
  const number = /^(?:第\s*|ep\s*)?(\d+)\s*[集话期]?$/.exec(label);
  return number ? String(Number(number[1])) : label;
}

function renderPlayer(remaining, previousFailures = []) {
  const { lines, lineIndex, episodeIndex } = currentVideo;
  const line = lines[lineIndex];
  byId('lines').hidden = lines.length < 2;
  byId('lines').replaceChildren(...lines.map((item, index) => button(item.name, () => {
    currentVideo.lineIndex = index;
    currentVideo.episodeIndex = 0;
    renderPlayer();
  }, index === lineIndex)));
  byId('episodes').hidden = !line || line.episodes.length < 2;
  byId('episodes').replaceChildren(...(line?.episodes ?? []).map((item, index) => button(item.name, () => {
    currentVideo.episodeIndex = index;
    renderPlayer();
  }, index === episodeIndex)));
  const episode = line?.episodes[episodeIndex];
  if (!episode) {
    setStatus('player-feedback', '读取分集：片源详情未提供分集地址。', true);
    return;
  }
  const label = episodeLabel(episode.name);
  const alternatives = remaining ?? lines.flatMap((item, index) => {
    if (!label || index === lineIndex) return [];
    const matches = item.episodes.flatMap((entry, index) => episodeLabel(entry.name) === label ? [index] : []);
    return matches.length === 1 ? [{ lineIndex: index, episodeIndex: matches[0] }] : [];
  });
  startPlayback(line, episode, alternatives, previousFailures);
}

async function openPlayer(id, name, live, source) {
  detailRequest?.abort();
  detailRequest = new AbortController();
  const { signal } = detailRequest;
  stopPlayback();
  byId('player-title').textContent = name;
  for (const section of ['screen', 'player-subtitle', 'lines', 'episodes', 'player-description']) byId(section).hidden = true;
  setStatus('player-feedback', '正在读取播放信息…');
  if (!playerDialog.open) playerDialog.showModal();
  try {
    const selection = { source: source.id, config: state.config.id };
    const detail = await sourceRequest(live ? 'live' : 'detail', { ...selection, id }, { signal });
    if (signal.aborted) return;
    byId('player-title').textContent = detail.title || name;
    byId('player-subtitle').textContent = [source.name, detail.subtitle].filter(Boolean).join(' · ');
    byId('player-subtitle').hidden = false;
    byId('player-description').textContent = detail.description ?? '';
    byId('player-description').hidden = !detail.description;
    currentVideo = { selection, lines: detail.lines, lineIndex: 0, episodeIndex: 0 };
    renderPlayer();
  } catch (error) {
    if (!signal.aborted) {
      setStatus('player-feedback', `读取${live ? '频道线路' : '影片详情'}：${error.message}`, true);
      byId('player-feedback').append(button('重试', () => openPlayer(id, name, live, source), undefined, 'outline'));
    }
  }
}

byId('open-config').addEventListener('click', () => openConfig());
sourceFilter.addEventListener('input', renderSources);
byId('source-status').addEventListener('click', () => openConfig(true));
byId('config-form').addEventListener('submit', event => {
  event.preventDefault();
  loadConfig(byId('config-url').value.trim(), true);
});
byId('search-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!state.config || !state.config.sites.length && !state.config.lives.length) {
    setSearchFeedback(state.config ? '当前订阅没有可用片源。' : '请先加载订阅，再搜索。');
    return;
  }
  setSearchFeedback();
  const keyword = searchInput.value.trim();
  if (keyword) searchLibrary(keyword);
  else resetLibrary();
});
byId('stop-search').addEventListener('click', () => searchRequest?.abort());
byId('source-search-form').addEventListener('submit', event => {
  event.preventDefault();
  const source = activeSource();
  if (!source || source.accountConfig) return;
  const keyword = sourceSearchInput.value.trim();
  if (keyword) searchLibrary(keyword, source);
  else resetLibrary();
});
sourceSearchInput.addEventListener('search', () => {
  if (!sourceSearchInput.value && state.sourceSearch) resetLibrary();
});
searchInput.addEventListener('input', () => setSearchFeedback());
searchInput.addEventListener('search', () => {
  if (!searchInput.value && state.searchTerm && !state.sourceSearch) resetLibrary();
});
for (const node of document.querySelectorAll('[data-mode]')) {
  node.addEventListener('click', () => {
    if (state.mode === node.dataset.mode && !state.searchTerm) return;
    state.mode = node.dataset.mode;
    resetLibrary();
  });
}
for (const [id, step] of [['previous-page', -1], ['next-page', 1]]) {
  byId(id).addEventListener('click', () => {
    state.page += step;
    if (state.mode === 'live') renderLibrary();
    else loadLibrary();
    library.scrollIntoView({ block: 'start' });
  });
}
for (const node of document.querySelectorAll('[data-close]')) {
  node.addEventListener('click', () => byId(node.dataset.close).close());
}
playerDialog.addEventListener('close', () => {
  detailRequest?.abort();
  stopPlayback();
});
accountDialog.addEventListener('close', () => accountRequest?.abort());

renderSidebar();
try {
  const { url } = await request('/api/default');
  let saved;
  try { saved = localStorage.getItem('tvbox-url'); } catch { /* Use the default subscription. */ }
  byId('config-url').value = saved || url;
  await loadConfig(saved || url, false);
} catch (error) {
  byId('hero-summary').textContent = '连接失败';
  message(error.message, '订阅设置', () => openConfig());
  library.setAttribute('aria-busy', 'false');
}

