// ===== 全局状态 =====
let currentModule = 'chat';
let currentProjectId = null;
let canvasScale = 1, canvasX = 0, canvasY = 0;
let isPanning = false, panStartX, panStartY;

const assets = { chat: [], image: [], video: [] };
let assetCounter = { chat: 1, image: 1, video: 1 };

let allModelsCache = [];
const generatingSet = new Set();
let previewEl = null;

// ===== 启动 =====
window.addEventListener('pywebviewready', async () => {
  previewEl = document.createElement('div');
  previewEl.className = 'at-preview';
  previewEl.innerHTML = '<img>';
  document.body.appendChild(previewEl);

  const cfg = await window.pywebview.api.get_config();
  fillSettings(cfg);
  if (!cfg.api_key) openSettings();
  else loadAllModelLists();
  switchModule('chat');
});

// ===== 模型分类 =====
function classifyModel(id) {
  const s = (id || '').toLowerCase();
  if (/video|veo|sora|kling|runway|pika|wan\d|hunyuan.*video|luma|minimax.*video|seedance/i.test(s)) return 'video';
  if (/image|img|dall-?e|flux|stable-?diffusion|sd[-_]?\d|midjourney|seedream|kolors|jimeng.*image/i.test(s)) return 'image';
  return 'text';
}
function filterModelsByType(type) {
  return allModelsCache.filter(m => classifyModel(m) === type);
}

async function loadAllModelLists() {
  const res = await window.pywebview.api.list_models();
  if (res.status !== 'success') return;
  const models = res.models || [];
  if (!models.length) return;
  allModelsCache = models;
  const cfg = await window.pywebview.api.get_config();
  populateModelSelect('chat-model', filterModelsByType('text'), cfg.model_text);
  populateModelSelect('img-model', filterModelsByType('image'), cfg.model_image);
  populateModelSelect('vid-model', filterModelsByType('video'), cfg.model_video);
}

function populateModelSelect(id, models, current) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const old = sel.value;
  sel.innerHTML = '<option value="">默认模型</option>';
  const listToUse = models.slice();
  if (current && !listToUse.includes(current)) listToUse.unshift(current);
  listToUse.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  });
  if (current && listToUse.includes(current)) sel.value = current;
  else if (old && listToUse.includes(old)) sel.value = old;
}

// ===== 模块切换 =====
async function switchModule(m) {
  if (currentProjectId) await autoSave();
  currentModule = m;
  currentProjectId = null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.m === m));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(m + '-view').classList.add('active');
  await refreshProjects();
  updateEmptyState();
}

// ===== 项目列表 =====
async function refreshProjects() {
  const list = document.getElementById('project-list');
  const ps = await window.pywebview.api.get_projects(currentModule);
  list.innerHTML = '';
  if (!ps.length) {
    list.innerHTML = '<div class="empty-tip">还没有任务，点上方按钮新建</div>';
    return;
  }
  ps.forEach(p => {
    const el = document.createElement('div');
    el.className = 'proj' + (p.id === currentProjectId ? ' active' : '');
    const isGenerating = generatingSet.has(p.id);
    el.innerHTML = `
      <span class="name">
        <span class="status-dot ${isGenerating ? 'generating' : ''}"></span>
        ${p.name}
      </span>
      <span class="del">✕</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains('del')) return;
      openProject(p.id);
    };
    el.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (confirm('删除「' + p.name + '」？')) {
        await window.pywebview.api.delete_project(p.id);
        if (currentProjectId === p.id) { currentProjectId = null; clearCurrentView(); updateEmptyState(); }
        refreshProjects();
      }
    };
    list.appendChild(el);
  });
}

async function newTask() {
  if (currentProjectId) await autoSave();
  const nameMap = { chat: '新对话', image: '新图片任务', video: '新视频任务', canvas: '新画布' };
  const res = await window.pywebview.api.create_project(currentModule, nameMap[currentModule]);
  if (res.status === 'success') {
    currentProjectId = res.project.id;
    clearCurrentView();
    if (currentModule === 'chat') { assets.chat = []; assetCounter.chat = 1; renderAssetList('chat'); }
    if (currentModule === 'image') { assets.image = []; assetCounter.image = 1; renderAssetList('image'); }
    if (currentModule === 'video') { assets.video = []; assetCounter.video = 1; renderAssetList('video'); }
    await refreshProjects();
    updateEmptyState();
    if (currentModule === 'canvas') addNode('text');
  }
}

async function openProject(pid) {
  if (currentProjectId === pid) return;
  if (currentProjectId) await autoSave();
  const res = await window.pywebview.api.get_project_data(pid);
  if (res.status !== 'success') return;
  currentProjectId = pid;
  const p = res.project;
  clearCurrentView();

  if (currentModule === 'chat') { assets.chat = []; renderAssetList('chat'); }
  if (currentModule === 'image') { assets.image = []; renderAssetList('image'); }
  if (currentModule === 'video') { assets.video = []; renderAssetList('video'); }

  if (p.type === 'chat') {
    (p.data.messages || []).forEach(m => appendMsg(m.role, m.content, m.images));
  } else if (p.type === 'image') {
    (p.data.generations || []).forEach(g => addImageCard(g.url));
    setEditorText('img-prompt', p.data.lastPrompt || '');
  } else if (p.type === 'video') {
    (p.data.tasks || []).forEach(t => addVideoCard(t));
  } else if (p.type === 'canvas') {
    (p.data.nodes || []).forEach(n => renderNode(n));
    if (p.data.view) { canvasX = p.data.view.x; canvasY = p.data.view.y; canvasScale = p.data.view.scale; updateCanvasTransform(); }
  }
  await refreshProjects();
  updateEmptyState();
}

function updateEmptyState() {
  const m = currentModule;
  const map = {
    chat: ['chat-history', 'chat-empty'],
    image: ['img-history', 'img-empty'],
    video: ['vid-history', 'vid-empty']
  };
  if (!map[m]) return;
  const has = document.getElementById(map[m][0]).children.length > 0;
  document.getElementById(map[m][1]).style.display = has ? 'none' : 'flex';
  document.getElementById(map[m][0]).style.display = has ? 'block' : 'none';
}

function clearCurrentView() {
  document.getElementById('chat-history').innerHTML = '';
  document.getElementById('img-gallery').innerHTML = '';
  document.getElementById('vid-list').innerHTML = '';
  document.getElementById('vid-status').textContent = '';
  document.getElementById('nodes-layer').innerHTML = '';
  setEditorText('img-prompt', '');
  setEditorText('vid-prompt', '');
  setEditorText('chat-input', '');
}

async function autoSave() {
  if (!currentProjectId) return;
  const pid = currentProjectId;
  const data = {};
  if (currentModule === 'chat') {
    const msgs = [];
    document.querySelectorAll('#chat-history .msg').forEach(m => {
      let content = m.dataset.raw || '';
      const imgs = [];
      m.querySelectorAll('.msg-imgs img').forEach(img => imgs.push(img.src));
      msgs.push({ role: m.classList.contains('user') ? 'user' : 'assistant', content: content, images: imgs });
    });
    data.messages = msgs;
  } else if (currentModule === 'image') {
    const gens = [];
    document.querySelectorAll('#img-gallery img').forEach(img => gens.push({url: img.src}));
    data.generations = gens;
    data.lastPrompt = getEditorData('img-prompt').text;
  } else if (currentModule === 'video') {
    const tasks = [];
    document.querySelectorAll('#vid-list .vid-card').forEach(c => {
      try { tasks.push(JSON.parse(c.dataset.task || '{}')); } catch(e){}
    });
    data.tasks = tasks;
  } else if (currentModule === 'canvas') {
    const nodes = [];
    document.querySelectorAll('#nodes-layer .node').forEach(n => {
      nodes.push({
        title: n.dataset.title, type: n.dataset.type,
        x: parseInt(n.style.left) || 0, y: parseInt(n.style.top) || 0,
        html: n.querySelector('.node-body').innerHTML,
        prompt: n.querySelector('textarea') ? n.querySelector('textarea').value : ''
      });
    });
    data.nodes = nodes;
    data.view = {x: canvasX, y: canvasY, scale: canvasScale};
  }
  await window.pywebview.api.save_project_data(pid, data);
}

async function appendToProject(pid, module, item) {
  const res = await window.pywebview.api.get_project_data(pid);
  if (res.status !== 'success') return;
  const data = res.project.data || {};
  if (module === 'image') {
    data.generations = data.generations || [];
    data.generations.push(item);
  } else if (module === 'video') {
    data.tasks = data.tasks || [];
    data.tasks.push(item);
  } else if (module === 'chat') {
    data.messages = data.messages || [];
    data.messages.push(item);
  }
  await window.pywebview.api.save_project_data(pid, data);
}

// ===== 素材管理 =====
function renderAssetList(module) {
  const el = document.getElementById(module + '-assets');
  if (!el) return;
  el.innerHTML = '';
  const list = assets[module] || [];
  list.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'asset-chip';
    chip.title = a.name;
    chip.innerHTML = `<img src="${a.base64}"><div class="rm">✕</div>`;
    chip.querySelector('.rm').onclick = () => removeAsset(module, i);
    chip.onmouseenter = () => showPreview(a.base64, chip.getBoundingClientRect());
    chip.onmouseleave = hidePreview;
    el.appendChild(chip);
  });
}

function removeAsset(module, index) {
  assets[module].splice(index, 1);
  renderAssetList(module);
}

async function handleUpload(module, fileList) {
  if (!assets[module]) assets[module] = [];
  for (const f of fileList) {
    if (!f.type.startsWith('image/')) continue;
    const b64 = await fileToBase64(f);
    assets[module].push({ id: assetCounter[module]++, name: f.name, base64: b64 });
  }
  renderAssetList(module);
}

document.getElementById('chat-ref').addEventListener('change', async e => {
  await handleUpload('chat', e.target.files);
  e.target.value = '';
});
document.getElementById('img-ref').addEventListener('change', async e => {
  await handleUpload('image', e.target.files);
  e.target.value = '';
});
document.getElementById('vid-ref').addEventListener('change', async e => {
  await handleUpload('video', e.target.files);
  e.target.value = '';
});

// ===== 输入区读写 =====
function getEditorData(editorId) {
  const editor = document.getElementById(editorId);
  const images = [];
  let text = '';
  const processNode = (node) => {
    if (node.nodeType === 3) { text += node.textContent; return; }
    if (node.nodeType !== 1) return;
    if (node.classList && node.classList.contains('at-chip')) {
      const i = images.length;
      images.push(node.dataset.base64);
      text += `@[img:${i}]`;
      return;
    }
    if (node.tagName === 'BR') { text += '\n'; return; }
    const isBlock = ['DIV', 'P'].includes(node.tagName);
    const startLen = text.length;
    node.childNodes.forEach(processNode);
    if (isBlock && text.length > startLen && !text.endsWith('\n')) text += '\n';
  };
  editor.childNodes.forEach(processNode);
  return { text: text.replace(/\u00A0/g, ' ').trim(), images };
}

function setEditorText(editorId, text) {
  const editor = document.getElementById(editorId);
  editor.innerHTML = '';
  if (text) editor.textContent = text;
}

function toggleExpand(editorId) {
  const editor = document.getElementById(editorId);
  editor.classList.toggle('expanded');
}

// ===== @ 素材弹窗 + chip =====
let savedRange = null;

function saveSelection(editorId) {
  const editor = document.getElementById(editorId);
  const sel = window.getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}

function restoreSelection(editorId) {
  const editor = document.getElementById(editorId);
  if (!savedRange) { editor.focus(); return; }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
  editor.focus();
}

function bindAt(editorId, popupId, module) {
  const editor = document.getElementById(editorId);
  const popup = document.getElementById(popupId);

  ['keyup', 'mouseup', 'input', 'blur'].forEach(ev => {
    editor.addEventListener(ev, () => saveSelection(editorId));
  });

  editor.addEventListener('input', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) { popup.classList.remove('show'); return; }
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== 3) { popup.classList.remove('show'); return; }
    const before = range.startContainer.textContent.slice(0, range.startOffset);
    if (before.endsWith('@')) {
      const list = assets[module] || [];
      if (!list.length) {
        popup.innerHTML = '<div class="at-hint">还没有上传素材，先点上方 + 上传图片</div>';
        popup.classList.add('show');
        return;
      }
      popup.innerHTML = '<div class="at-hint">选择要引用的素材</div>';
      list.forEach((a, i) => {
        const item = document.createElement('div');
        item.className = 'at-item';
        item.innerHTML = `<img src="${a.base64}"><span class="name">图片${i+1} · ${a.name}</span>`;
        item.onmousedown = (e) => {
          e.preventDefault();
          insertAtChip(editorId, a);
          popup.classList.remove('show');
        };
        popup.appendChild(item);
      });
      popup.classList.add('show');
    } else {
      popup.classList.remove('show');
    }
  });

  editor.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      if (e.isComposing) return;
      if (e.shiftKey) return;
      e.preventDefault();
      if (module === 'chat') sendChat();
      else if (module === 'image') doImage();
      else if (module === 'video') doVideo();
    }
  });
}

function insertAtChip(editorId, asset) {
  const editor = document.getElementById(editorId);
  restoreSelection(editorId);

  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);

  if (range.startContainer.nodeType === 3 && range.startOffset > 0) {
    const before = range.startContainer.textContent.slice(0, range.startOffset);
    if (before.endsWith('@')) {
      range.setStart(range.startContainer, range.startOffset - 1);
      range.deleteContents();
    }
  }

  const chip = document.createElement('span');
  chip.className = 'at-chip';
  chip.contentEditable = 'false';
  chip.dataset.base64 = asset.base64;
  chip.dataset.name = asset.name;
  chip.innerHTML = `<img src="${asset.base64}"><span>图片</span><span class="chip-remove">×</span>`;

  chip.querySelector('.chip-remove').onmousedown = (e) => {
    e.preventDefault();
    chip.remove();
    saveSelection(editorId);
  };
  chip.onmouseenter = () => showPreview(asset.base64, chip.getBoundingClientRect());
  chip.onmouseleave = hidePreview;

  range.insertNode(chip);

  const space = document.createTextNode('\u00A0');
  chip.after(space);
  const newRange = document.createRange();
  newRange.setStartAfter(space);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
  saveSelection(editorId);
}

bindAt('chat-input', 'chat-at', 'chat');
bindAt('img-prompt', 'img-at', 'image');
bindAt('vid-prompt', 'vid-at', 'video');

// ===== 悬浮预览 =====
function showPreview(base64, rect) {
  const img = previewEl.querySelector('img');
  img.src = base64;
  previewEl.classList.add('show');
  const pw = previewEl.offsetWidth;
  const ph = previewEl.offsetHeight;
  let x = rect.left;
  let y = rect.top - ph - 10;
  if (y < 10) y = rect.bottom + 10;
  if (x + pw > window.innerWidth - 10) x = window.innerWidth - pw - 10;
  if (x < 10) x = 10;
  previewEl.style.left = x + 'px';
  previewEl.style.top = y + 'px';
}
function hidePreview() {
  previewEl.classList.remove('show');
}

// ===== 对话 =====
function appendMsg(role, content, images) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  const displayContent = (content || '').replace(/@\[img:\d+\]/g, '').replace(/\s+/g, ' ').trim();
  div.dataset.raw = content || '';
  div.textContent = displayContent || content || '';
  if (images && images.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-imgs';
    images.forEach(b64 => {
      const img = document.createElement('img');
      img.src = b64;
      wrap.appendChild(img);
    });
    div.appendChild(wrap);
  }
  document.getElementById('chat-history').appendChild(div);
  const h = document.getElementById('chat-history');
  h.scrollTop = h.scrollHeight;
  updateEmptyState();
}

async function sendChat() {
  if (!currentProjectId) await newTask();
  const myPid = currentProjectId;
  const data = getEditorData('chat-input');
  const rawText = data.text;
  const images = data.images;
  if (!rawText && !images.length) return;

  appendMsg('user', rawText, images);
  setEditorText('chat-input', '');

  const msgs = [];
  document.querySelectorAll('#chat-history .msg').forEach(m => {
    msgs.push({
      role: m.classList.contains('user') ? 'user' : 'assistant',
      content: m.dataset.raw || m.innerText
    });
  });

  const tmp = document.createElement('div');
  tmp.className = 'msg ai';
  tmp.textContent = '正在思考...';
  document.getElementById('chat-history').appendChild(tmp);
  const btn = document.getElementById('chat-send');
  btn.disabled = true;

  generatingSet.add(myPid);
  refreshProjects();
  const model = document.getElementById('chat-model').value || null;
  const res = await window.pywebview.api.text_chat(msgs, images, model);
  generatingSet.delete(myPid);

  btn.disabled = false;
  tmp.remove();

  if (res.status === 'success') {
    await appendToProject(myPid, 'chat', {role: 'assistant', content: res.content});
    if (currentProjectId === myPid) {
      appendMsg('assistant', res.content);
    }
  } else {
    if (currentProjectId === myPid) appendMsg('assistant', '[错误] ' + res.message);
  }
  await refreshProjects();
}

// ===== 图片 =====
async function doImage() {
  if (!currentProjectId) await newTask();
  const myPid = currentProjectId;
  const data = getEditorData('img-prompt');
  if (!data.text) return alert('请输入提示词');
  const btn = document.getElementById('img-gen');
  btn.disabled = true; btn.textContent = '生成中...';

  const model = document.getElementById('img-model').value || null;
  const size = document.getElementById('img-size').value;
  const ratio = document.getElementById('img-ratio').value;

  generatingSet.add(myPid);
  refreshProjects();

  try {
    const res = await window.pywebview.api.generate_image(data.text, size, ratio, data.images.length ? data.images : null, model);
    if (res.status === 'success') {
      await appendToProject(myPid, 'image', {url: res.url});
      if (currentProjectId === myPid) {
        const proj = await window.pywebview.api.get_project_data(myPid);
        if (proj.status === 'success') {
          const gallery = document.getElementById('img-gallery');
          gallery.innerHTML = '';
          (proj.project.data.generations || []).forEach(g => {
            const img = document.createElement('img');
            img.src = g.url;
            img.onclick = () => window.open(g.url);
            gallery.appendChild(img);
          });
          updateEmptyState();
        }
      }
    } else {
      if (currentProjectId === myPid) alert('失败：' + res.message);
    }
  } finally {
    generatingSet.delete(myPid);
    btn.disabled = false; btn.textContent = '生成';
    refreshProjects();
  }
}

function addImageCard(url) {
  const img = document.createElement('img');
  img.src = url;
  img.onclick = () => window.open(url);
  document.getElementById('img-gallery').appendChild(img);
  updateEmptyState();
}

// ===== 视频 =====
async function doVideo() {
  if (!currentProjectId) await newTask();
  const myPid = currentProjectId;
  const data = getEditorData('vid-prompt');
  if (!data.text) return alert('请输入描述');

  const btn = document.getElementById('vid-gen');
  const status = document.getElementById('vid-status');
  btn.disabled = true; btn.textContent = '创建任务中...';

  const model = document.getElementById('vid-model').value || null;
  const mode = document.getElementById('vid-mode').value;
  const size = document.getElementById('vid-size').value;
  const ratio = document.getElementById('vid-ratio').value;
  const seconds = document.getElementById('vid-seconds').value;

  generatingSet.add(myPid);
  refreshProjects();

  try {
    const createRes = await window.pywebview.api.create_video_task(
      data.text, mode, size, ratio, seconds,
      data.images.length ? data.images : null, model
    );
    if (createRes.status !== 'success') {
      if (currentProjectId === myPid) status.textContent = '创建失败：' + createRes.message;
      return;
    }
    const r = createRes.raw;
    const vid = r.video_id || r.id || r.task_id;
    if (!vid) {
      if (currentProjectId === myPid) status.textContent = '未获取任务ID：' + JSON.stringify(r);
      return;
    }
    if (currentProjectId === myPid) {
      status.textContent = '任务已创建 ' + vid + '，正在生成...';
      btn.textContent = '生成中...';
    }
    const waitRes = await window.pywebview.api.wait_video(vid, model);
    if (waitRes.status === 'success') {
      const task = { prompt: data.text, url: waitRes.url, video_id: vid };
      await appendToProject(myPid, 'video', task);
      if (currentProjectId === myPid) {
        status.textContent = '生成完成';
        const proj = await window.pywebview.api.get_project_data(myPid);
        if (proj.status === 'success') {
          const list = document.getElementById('vid-list');
          list.innerHTML = '';
          (proj.project.data.tasks || []).forEach(t => {
            const card = document.createElement('div');
            card.className = 'vid-card';
            card.dataset.task = JSON.stringify(t);
            card.innerHTML = `${t.url ? `<video src="${t.url}" controls></video>` : '<div style="padding:20px;color:#999;">无视频地址</div>'}<div class="info">${t.prompt || ''}</div>`;
            list.appendChild(card);
          });
          updateEmptyState();
        }
      }
    } else {
      if (currentProjectId === myPid) status.textContent = '失败：' + waitRes.message;
    }
  } finally {
    generatingSet.delete(myPid);
    btn.disabled = false; btn.textContent = '生成';
    refreshProjects();
  }
}

function addVideoCard(task) {
  const card = document.createElement('div');
  card.className = 'vid-card';
  card.dataset.task = JSON.stringify(task);
  card.innerHTML = `${task.url ? `<video src="${task.url}" controls></video>` : '<div style="padding:20px;color:#999;">无视频地址</div>'}<div class="info">${task.prompt || ''}</div>`;
  document.getElementById('vid-list').appendChild(card);
  updateEmptyState();
}

// ===== 画布 =====
const canvasWrap = document.getElementById('canvas-wrap');

canvasWrap.addEventListener('mousedown', e => {
  if (e.target.closest('.node') || e.target.closest('#canvas-bottom')) return;
  if (e.button !== 0) return;
  isPanning = true;
  panStartX = e.clientX - canvasX;
  panStartY = e.clientY - canvasY;
  canvasWrap.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', e => {
  if (!isPanning) return;
  canvasX = e.clientX - panStartX;
  canvasY = e.clientY - panStartY;
  updateCanvasTransform();
});
window.addEventListener('mouseup', () => {
  isPanning = false;
  canvasWrap.style.cursor = 'default';
});
canvasWrap.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  canvasScale = Math.max(0.1, Math.min(canvasScale * factor, 5));
  updateCanvasTransform();
}, {passive: false});

canvasWrap.addEventListener('contextmenu', e => {
  e.preventDefault();
  const menu = document.getElementById('ctx-menu');
  menu.style.display = 'flex';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
});
window.addEventListener('click', () => { document.getElementById('ctx-menu').style.display = 'none'; });

function updateCanvasTransform() {
  const t = `translate(${canvasX}px, ${canvasY}px) scale(${canvasScale})`;
  document.getElementById('grid').style.transform = t;
  document.getElementById('nodes-layer').style.transform = t;
  document.getElementById('zoom-display').textContent = Math.round(canvasScale * 100) + '%';
}
function zoom(f) { canvasScale = Math.max(0.1, Math.min(canvasScale * f, 5)); updateCanvasTransform(); }
function resetZoom() { canvasScale = 1; canvasX = 0; canvasY = 0; updateCanvasTransform(); }
function addNodeFromButton() { document.getElementById('node-picker').classList.add('show'); }
function closeNodePicker() { document.getElementById('node-picker').classList.remove('show'); }

function addNode(type) {
  document.getElementById('ctx-menu').style.display = 'none';
  const x = (canvasWrap.clientWidth / 2 - canvasX) / canvasScale;
  const y = (canvasWrap.clientHeight / 2 - canvasY) / canvasScale;
  renderNode({
    type, x, y,
    title: type === 'text' ? '文本生成' : type === 'image' ? '图片节点' : '视频节点',
    html: '', prompt: ''
  });
}

function renderNode(data) {
  const node = document.createElement('div');
  node.className = 'node';
  node.dataset.type = data.type;
  node.dataset.title = data.title || '';
  node.style.left = data.x + 'px';
  node.style.top = data.y + 'px';
  let inner = '';
  if (data.type === 'text') {
    inner = `
      <div class="node-tools">
        <button class="mini" onclick="nodeUploadImage(this)">📎 上传素材</button>
      </div>
      <div class="node-assets"></div>
      <textarea placeholder="输入提示词">${data.prompt || ''}</textarea>
      <button onclick="nodeGenImage(this)">生成图片</button>`;
  } else if (data.type === 'image') {
    inner = `<div style="color:#888;font-size:12px;">图片节点</div>`;
  } else if (data.type === 'video') {
    inner = `
      <div class="node-tools">
        <button class="mini" onclick="nodeUploadImage(this)">📎 上传素材</button>
      </div>
      <div class="node-assets"></div>
      <textarea placeholder="视频描述">${data.prompt || ''}</textarea>
      <button onclick="alert('视频请到视频模块生成')">生成视频</button>`;
  }
  node.innerHTML = `<div class="node-header"><span>${data.title || ''}</span><span style="cursor:pointer" onclick="this.closest('.node').remove()">✕</span></div><div class="node-body">${data.html || inner}</div>`;
  const header = node.querySelector('.node-header');
  header.addEventListener('mousedown', e => {
    e.stopPropagation();
    let px = e.clientX, py = e.clientY;
    let nx = parseInt(node.style.left), ny = parseInt(node.style.top);
    const onMove = ev => {
      node.style.left = (nx + (ev.clientX - px) / canvasScale) + 'px';
      node.style.top = (ny + (ev.clientY - py) / canvasScale) + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  document.getElementById('nodes-layer').appendChild(node);
}

window.nodeAssets = new Map();

function nodeUploadImage(btn) {
  const node = btn.closest('.node');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async () => {
    const list = window.nodeAssets.get(node) || [];
    for (const f of input.files) {
      if (!f.type.startsWith('image/')) continue;
      list.push({ name: f.name, base64: await fileToBase64(f) });
    }
    window.nodeAssets.set(node, list);
    renderNodeAssets(node);
    input.value = '';
  };
  input.click();
}

function renderNodeAssets(node) {
  const list = window.nodeAssets.get(node) || [];
  const el = node.querySelector('.node-assets');
  if (!el) return;
  el.innerHTML = '';
  el.style.display = 'flex';
  el.style.flexWrap = 'wrap';
  el.style.gap = '6px';
  list.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.style.position = 'relative';
    chip.style.width = '34px';
    chip.style.height = '34px';
    chip.style.borderRadius = '5px';
    chip.style.overflow = 'hidden';
    chip.style.border = '1px solid #333';
    chip.innerHTML = `<img src="${a.base64}" style="width:100%;height:100%;object-fit:cover;"><div style="position:absolute;top:-2px;right:-2px;background:rgba(0,0,0,.65);color:#fff;font-size:9px;width:13px;height:13px;line-height:13px;text-align:center;border-radius:50%;cursor:pointer;">✕</div>`;
    chip.querySelector('div').onclick = () => {
      list.splice(i, 1);
      window.nodeAssets.set(node, list);
      renderNodeAssets(node);
    };
    el.appendChild(chip);
  });
}

async function nodeGenImage(btn) {
  const node = btn.closest('.node');
  const prompt = node.querySelector('textarea').value.trim();
  if (!prompt) return;
  const list = window.nodeAssets.get(node) || [];
  const images = list.map(a => a.base64);
  btn.disabled = true; btn.textContent = '生成中...';
  const res = await window.pywebview.api.generate_image(prompt, '2K', '1:1', images.length ? images : null);
  btn.disabled = false; btn.textContent = '生成图片';
  if (res.status === 'success') {
    let img = node.querySelector('.node-body > img');
    if (!img) { img = document.createElement('img'); node.querySelector('.node-body').appendChild(img); }
    img.src = res.url;
    if (currentProjectId) autoSave();
  } else {
    alert('失败：' + res.message);
  }
}

async function saveCanvas() {
  if (!currentProjectId) { alert('请先新建画布任务'); return; }
  await autoSave();
  alert('已保存');
}

// ===== 设置 =====
function openSettings() { document.getElementById('settings-modal').classList.add('show'); }
function closeSettings() { document.getElementById('settings-modal').classList.remove('show'); }

function fillSettings(cfg) {
  document.getElementById('set-base').value = cfg.api_base || '';
  document.getElementById('set-key').value = cfg.api_key || '';
  const map = [['set-model-text', cfg.model_text], ['set-model-image', cfg.model_image], ['set-model-video', cfg.model_video]];
  map.forEach(([id, cur]) => {
    const sel = document.getElementById(id);
    sel.innerHTML = '';
    if (cur) {
      const opt = document.createElement('option');
      opt.value = cur; opt.textContent = cur;
      sel.appendChild(opt);
      sel.value = cur;
    }
  });
}

async function fetchModels() {
  const status = document.getElementById('fetch-status');
  status.textContent = '拉取中...';
  const cfg = {
    api_base: document.getElementById('set-base').value.trim(),
    api_key: document.getElementById('set-key').value.trim(),
    model_text: document.getElementById('set-model-text').value,
    model_image: document.getElementById('set-model-image').value,
    model_video: document.getElementById('set-model-video').value
  };
  await window.pywebview.api.save_config(cfg);
  const res = await window.pywebview.api.list_models();
  if (res.status !== 'success') {
    status.textContent = '失败：' + res.message;
    return;
  }
  const models = res.models || [];
  allModelsCache = models;
  const textModels = filterModelsByType('text');
  const imageModels = filterModelsByType('image');
  const videoModels = filterModelsByType('video');
  status.textContent = `成功拉取 ${models.length} 个模型（文本 ${textModels.length} / 图片 ${imageModels.length} / 视频 ${videoModels.length}）`;
  fillSelectWithModels('set-model-text', textModels, document.getElementById('set-model-text').value);
  fillSelectWithModels('set-model-image', imageModels, document.getElementById('set-model-image').value);
  fillSelectWithModels('set-model-video', videoModels, document.getElementById('set-model-video').value);
  populateModelSelect('chat-model', textModels, document.getElementById('chat-model').value);
  populateModelSelect('img-model', imageModels, document.getElementById('img-model').value);
  populateModelSelect('vid-model', videoModels, document.getElementById('vid-model').value);
}

function fillSelectWithModels(id, models, cur) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = '';
  const listToUse = models.slice();
  if (cur && !listToUse.includes(cur)) listToUse.unshift(cur);
  if (!listToUse.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '（无匹配模型）';
    sel.appendChild(opt);
    return;
  }
  listToUse.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  });
  if (cur && listToUse.includes(cur)) sel.value = cur;
}

async function diagnose() {
  const cfg = {
    api_base: document.getElementById('set-base').value.trim(),
    api_key: document.getElementById('set-key').value.trim(),
    model_text: document.getElementById('set-model-text').value,
    model_image: document.getElementById('set-model-image').value,
    model_video: document.getElementById('set-model-video').value
  };
  await window.pywebview.api.save_config(cfg);
  const box = document.getElementById('diag-result');
  box.style.display = 'block';
  box.textContent = '诊断中...';
  const res = await window.pywebview.api.diagnose();
  if (res.status !== 'success') { box.textContent = '诊断失败：' + res.message; return; }
  const info = res.info;
  box.textContent =
    '=== 诊断结果 ===\n' + info.result + '\n\n' +
    'API Base（原始）: ' + info.api_base_raw + '\n' +
    'API Base（最终）: ' + info.api_base_final + '\n' +
    '实际请求 URL: ' + info.url_to_try + '\n\n' +
    'Key 长度: ' + info.key_length + '\n' +
    'Key 前8位: ' + info.key_prefix + '...\n' +
    'Key 后4位: ...' + info.key_suffix + '\n' +
    'Key 含空格/换行: ' + (info.key_has_space ? '⚠️ 有！这就是问题所在' : '否') + '\n\n' +
    '【Bearer 认证】\n' +
    'HTTP 状态: ' + info.http_status + '\n' +
    '原始响应:\n' + (info.response_preview || '(无)') + '\n\n' +
    '【x-api-key 认证】\n' +
    'HTTP 状态: ' + info.xapikey_status + '\n' +
    '原始响应:\n' + (info.xapikey_preview || '(无)');
}

async function saveSettings() {
  const cfg = {
    api_base: document.getElementById('set-base').value.trim(),
    api_key: document.getElementById('set-key').value.trim(),
    model_text: document.getElementById('set-model-text').value,
    model_image: document.getElementById('set-model-image').value,
    model_video: document.getElementById('set-model-video').value
  };
  if (!cfg.api_base) return alert('API Base URL 不能为空');
  const r = await window.pywebview.api.save_config(cfg);
  if (r.status === 'success') {
    populateModelSelect('chat-model', [cfg.model_text].filter(Boolean), cfg.model_text);
    populateModelSelect('img-model', [cfg.model_image].filter(Boolean), cfg.model_image);
    populateModelSelect('vid-model', [cfg.model_video].filter(Boolean), cfg.model_video);
    if (!window._modelsLoaded) loadAllModelLists();
    window._modelsLoaded = true;
    alert('已保存');
    closeSettings();
  } else alert('保存失败');
}

// ===== 工具 =====
function fileToBase64(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.readAsDataURL(file);
  });
}

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (!files.length) return;
  if (currentModule === 'chat' || currentModule === 'image' || currentModule === 'video') {
    await handleUpload(currentModule, files);
  }
});
