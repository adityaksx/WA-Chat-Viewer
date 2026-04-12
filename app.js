// ══════════════════════════════════════════════
//  IndexedDB — persist chats locally in browser
// ══════════════════════════════════════════════
const DB_NAME = 'wa_archive_v1';
const DB_VER  = 1;
let idb;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      const cs = db.createObjectStore('chats',    { keyPath:'id', autoIncrement:true });
      cs.createIndex('createdAt','createdAt');
      const ms = db.createObjectStore('messages', { keyPath:'id', autoIncrement:true });
      ms.createIndex('chatId','chatId');
    };
    req.onsuccess = e => { idb = e.target.result; res(idb); };
    req.onerror   = e => rej(e.target.error);
  });
}

function tx(store, mode='readonly') {
  return idb.transaction(store, mode).objectStore(store);
}

function dbGetAll(store, indexName, key) {
  return new Promise((res, rej) => {
    const s = tx(store);
    const req = indexName ? s.index(indexName).getAll(key) : s.getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function dbAdd(store, data) {
  return new Promise((res, rej) => {
    const req = tx(store,'readwrite').add(data);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function dbPut(store, data) {
  return new Promise((res, rej) => {
    const req = tx(store,'readwrite').put(data);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function dbDelete(store, id) {
  return new Promise((res, rej) => {
    const req = tx(store,'readwrite').delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

function dbDeleteByIndex(store, indexName, key) {
  return new Promise((res, rej) => {
    const s = tx(store,'readwrite');
    const idx = s.index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(key));
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else res();
    };
    req.onerror = e => rej(e.target.error);
  });
}

// ══════════════════════════════════════════════
//  WhatsApp .txt Parser
// ══════════════════════════════════════════════
const MSG_RE = /^(\d{1,2}\/\d{1,2}\/\d{4}),\s(\d{1,2}:\d{2}\s[ap]m)\s-\s([\s\S]+?)(?::\s([\s\S]*))?$/i;

function parseDateTime(date, time) {
  const [d,m,y] = date.split('/');
  let [hm, ampm] = time.split(' ');
  let [h, min] = hm.split(':').map(Number);
  if (ampm.toLowerCase() === 'pm' && h !== 12) h += 12;
  if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
  return new Date(+y, +m-1, +d, h, min).getTime();
}

function parseChat(text) {
  const lines = text.split(/\r?\n/);
  const msgs = [];
  let cur = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(MSG_RE);
    if (m) {
      if (cur) msgs.push(cur);
      const [, date, time, senderOrSystem, content] = m;
      const isSystem = content === undefined;
      cur = {
        timestamp: parseDateTime(date, time),
        dateStr: date,
        timeStr: time,
        sender: isSystem ? null : senderOrSystem.trim(),
        content: isSystem ? senderOrSystem.trim() : content.trim(),
        isSystem,
        isMedia: !isSystem && content && content.trim() === '<Media omitted>'
      };
    } else if (cur) {
      cur.content += '\n' + line;
    }
  }
  if (cur) msgs.push(cur);
  return msgs;
}

function extractParticipants(msgs) {
  const counts = {};
  msgs.forEach(m => {
    if (!m.isSystem && m.sender) {
      counts[m.sender] = (counts[m.sender] || 0) + 1;
    }
  });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(e=>e[0]);
}

// ══════════════════════════════════════════════
//  UI State
// ══════════════════════════════════════════════
let allChats       = [];
let currentChatId  = null;
let currentMsgs    = [];
let myName         = '';
let searchResults  = [];
let searchIdx      = 0;
let pendingFile    = null;
let pendingParsed  = null;
let ctxTargetId    = null;

// ══════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════
function toast(msg, type='') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' '+type : '');
  el.textContent = msg;
  const c = document.getElementById('toastContainer');
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function avatarInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  return parts.length > 1
    ? (parts[0][0] + parts[parts.length-1][0]).toUpperCase()
    : name[0].toUpperCase();
}

const AVATAR_COLORS = ['#00A884','#128C7E','#075E54','#25D366','#0078D4','#6264A4','#A0522D','#CD5C5C','#4682B4'];
function avatarColor(name) {
  let h = 0; for (const c of (name||'')) h = (h*31 + c.charCodeAt(0)) & 0xFFFFFFFF;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
  if (d.toDateString() === today.toDateString())     return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});
}

function fmtTimeShort(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'});
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════
//  Render sidebar chat list
// ══════════════════════════════════════════════
function renderChatList(filter='') {
  const list = document.getElementById('chatList');
  const fl = filter.toLowerCase();
  const filtered = allChats.filter(c => c.name.toLowerCase().includes(fl));

  if (!allChats.length) {
    list.innerHTML = `
      <div class="empty-chat-list">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <p>No chats yet.<br>Import a WhatsApp export to get started.</p>
      </div>
      <div style="padding:0 var(--space-4) var(--space-4)">
        <label class="upload-zone" id="sidebarDropZone" for="sidebarFileInput" style="margin:0">
          <input type="file" id="sidebarFileInput" accept=".txt" style="display:none">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="12" y2="12"/><line x1="15" y1="15" x2="12" y2="12"/></svg>
          <p><span>Import your first chat</span></p>
        </label>
      </div>`;
    // FIX: reset input value so same file can be re-selected
    const sf = document.getElementById('sidebarFileInput');
    if (sf) sf.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      openImportModal(file);
    });
    return;
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-chat-list"><p>No chats match "<em>${escHtml(filter)}</em>"</p></div>`;
    return;
  }

  list.innerHTML = filtered.map(c => {
    const active = c.id === currentChatId ? ' active' : '';
    const init   = avatarInitials(c.name);
    const color  = avatarColor(c.name);
    const prev   = escHtml((c.lastMessage || '').substring(0,60));
    return `<div class="chat-item${active}" data-id="${c.id}" data-name="${escHtml(c.name)}">
      <div class="chat-avatar" style="background:${color}">${init}</div>
      <div class="chat-info">
        <div class="chat-meta">
          <span class="chat-name">${escHtml(c.name)}</span>
          <span class="chat-time">${fmtTimeShort(c.lastDate||c.createdAt)}</span>
        </div>
        <div class="chat-preview">${prev}</div>
      </div>
      <div class="chat-badge">${c.messageCount||''}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', () => loadChat(+el.dataset.id));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      ctxTargetId = +el.dataset.id;
      showCtxMenu(e.clientX, e.clientY);
    });
  });
}

// ══════════════════════════════════════════════
//  Load & render chat messages
// ══════════════════════════════════════════════
async function loadChat(chatId) {
  currentChatId = chatId;
  const chat = allChats.find(c => c.id === chatId);
  if (!chat) return;
  myName = chat.myName || '';

  const msgs = await dbGetAll('messages','chatId', chatId);
  msgs.sort((a,b) => a.timestamp - b.timestamp);
  currentMsgs = msgs;

  const color = avatarColor(chat.name);
  document.getElementById('headerAvatar').style.background = color;
  document.getElementById('headerAvatar').textContent = avatarInitials(chat.name);
  document.getElementById('headerName').textContent = chat.name;
  document.getElementById('headerSub').textContent =
    `${chat.participants?.join(', ')||''} · ${msgs.length.toLocaleString()} messages`;
  document.getElementById('footerStats').textContent =
    `${msgs.length.toLocaleString()} msgs · ${chat.participants?.length||0} participants`;

  renderMessages(msgs);
  document.getElementById('chatPlaceholder').style.display = 'none';
  document.getElementById('chatView').style.display = 'flex';
  document.getElementById('chatView').style.height = '100%';

  renderChatList(document.getElementById('sidebarSearch').value);

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.add('hidden-mobile');
  }

  setTimeout(() => {
    const area = document.getElementById('messagesArea');
    area.scrollTop = area.scrollHeight;
  }, 50);
}

// ══════════════════════════════════════════════
//  Render messages
// ══════════════════════════════════════════════
function renderMessages(msgs, highlightQuery='') {
  const area = document.getElementById('messagesArea');
  let html = '';
  let lastDate = '';
  let lastSender = '';
  const q = highlightQuery.toLowerCase();

  msgs.forEach((msg, i) => {
    const dateLabel = fmtDate(msg.timestamp);
    if (dateLabel !== lastDate) {
      html += `<div class="date-sep"><span>${escHtml(dateLabel)}</span></div>`;
      lastDate = dateLabel;
      lastSender = '';
    }

    if (msg.isSystem) {
      html += `<div class="msg-system"><span>${escHtml(msg.content)}</span></div>`;
      lastSender = '';
      return;
    }

    const isSent  = msg.sender === myName;
    const side    = isSent ? 'sent' : 'recv';
    const isFirst = msg.sender !== lastSender;
    lastSender = msg.sender;

    let contentHtml = '';
    if (msg.isMedia) {
      contentHtml = `<div class="media-badge">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Media omitted</div>`;
    } else {
      let txt = escHtml(msg.content);
      if (q && txt.toLowerCase().includes(q)) {
        const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
        txt = txt.replace(re, '<mark>$1</mark>');
      }
      contentHtml = `<span class="msg-text">${txt}</span>`;
    }

    const senderLabel = (!isSent && isFirst)
      ? `<span class="sender-name">${escHtml(msg.sender||'')}</span>` : '';

    html += `<div class="msg-row ${side}${isFirst?' first-in-group':''}" data-idx="${i}">
      <div class="bubble" data-idx="${i}">
        ${senderLabel}
        ${contentHtml}
        <div class="msg-time"><span>${fmtTime(msg.timestamp)}</span></div>
      </div>
    </div>`;
  });

  area.innerHTML = html || `<div style="text-align:center;padding:var(--space-8);color:var(--text-muted);font-size:var(--text-sm)">No messages</div>`;
}

// ══════════════════════════════════════════════
//  In-chat search
// ══════════════════════════════════════════════
function doSearch(q) {
  if (!q.trim()) { clearSearch(); return; }
  const ql = q.toLowerCase();
  searchResults = currentMsgs
    .map((m,i) => ({ i, match: !m.isSystem && m.content && m.content.toLowerCase().includes(ql) }))
    .filter(x => x.match).map(x => x.i);
  searchIdx = searchResults.length - 1;
  renderMessages(currentMsgs, q);
  updateSearchNav();
  if (searchResults.length) scrollToResult();
}

function clearSearch() {
  searchResults = []; searchIdx = 0;
  renderMessages(currentMsgs);
  document.getElementById('searchCount').textContent = '';
}

function updateSearchNav() {
  const c = document.getElementById('searchCount');
  if (!searchResults.length) { c.textContent = 'No results'; return; }
  c.textContent = `${searchIdx+1} / ${searchResults.length}`;
}

function scrollToResult() {
  if (!searchResults.length) return;
  const idx = searchResults[searchIdx];
  const el = document.querySelector(`.bubble[data-idx="${idx}"]`);
  if (el) {
    el.scrollIntoView({ behavior:'smooth', block:'center' });
    el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 1200);
  }
}

// ══════════════════════════════════════════════
//  Import flow — FIXED
//  Modal opens ONLY after file is selected.
//  pendingParsed guaranteed set before Import enables.
// ══════════════════════════════════════════════
function openImportModal(file) {
  pendingFile   = file;
  pendingParsed = null;

  document.getElementById('senderSelect').innerHTML = '<option value="">Parsing…</option>';
  document.getElementById('importConfirm').disabled = true;
  document.getElementById('filePreview').style.display = 'none';
  document.getElementById('importChatName').value = '';

  openModal('importModal');

  const reader = new FileReader();

  // FIX: handle read errors explicitly
  reader.onerror = () => {
    toast('Could not read file', 'error');
    document.getElementById('senderSelect').innerHTML = '<option value="">Read error</option>';
  };

  reader.onload = e => {
    try {
      const text = e.target.result;
      pendingParsed = parseChat(text);

      // FIX: guard for empty parse result
      if (!pendingParsed || pendingParsed.length === 0) {
        toast('No messages found — make sure this is a WhatsApp export .txt', 'error');
        document.getElementById('senderSelect').innerHTML = '<option value="">No messages found</option>';
        return;
      }

      const participants = extractParticipants(pendingParsed);
      const nonSys = pendingParsed.filter(m => !m.isSystem).length;

      const sel = document.getElementById('senderSelect');
      sel.innerHTML = '<option value="">— Select your name —</option>' +
        participants.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');

      document.getElementById('importChatName').value = file.name.replace(/\.txt$/i,'').replace(/_/g,' ');
      document.getElementById('previewName').textContent = file.name + '  ';
      document.getElementById('previewMeta').textContent =
        `${nonSys.toLocaleString()} messages · ${participants.length} participants`;
      document.getElementById('filePreview').style.display = 'block';

      checkImportReady();

    } catch (err) {
      console.error('Parse error:', err);
      toast('Parsing error: ' + err.message, 'error');
      document.getElementById('senderSelect').innerHTML = '<option value="">Parse failed</option>';
    }
  };

  reader.readAsText(file, 'utf-8');
}

// FIX: guard pendingParsed length, not just truthiness
function checkImportReady() {
  const ready = pendingParsed &&
                pendingParsed.length > 0 &&
                document.getElementById('senderSelect').value !== '';
  document.getElementById('importConfirm').disabled = !ready;
}

async function confirmImport() {
  if (!pendingParsed || pendingParsed.length === 0) return;
  const name = document.getElementById('importChatName').value.trim() || 'Unnamed Chat';
  const myN  = document.getElementById('senderSelect').value;
  const participants = extractParticipants(pendingParsed);

  closeModal('importModal');
  document.getElementById('loading').classList.remove('hidden');

  const lastMsg = [...pendingParsed].reverse().find(m => !m.isSystem);
  const chatData = {
    name, myName: myN, participants,
    messageCount: pendingParsed.filter(m=>!m.isSystem).length,
    lastMessage: lastMsg ? (lastMsg.isMedia ? '📷 Media' : lastMsg.content.substring(0,80)) : '',
    lastDate: lastMsg ? lastMsg.timestamp : Date.now(),
    createdAt: Date.now()
  };

  const chatId = await dbAdd('chats', chatData);
  chatData.id  = chatId;

  const CHUNK = 500;
  for (let i = 0; i < pendingParsed.length; i += CHUNK) {
    const chunk = pendingParsed.slice(i, i+CHUNK);
    await Promise.all(chunk.map(m => dbAdd('messages', { ...m, chatId })));
  }

  allChats.unshift(chatData);
  renderChatList();
  document.getElementById('loading').classList.add('hidden');
  toast(`Imported "${name}" · ${chatData.messageCount.toLocaleString()} messages`);
  loadChat(chatId);
  pendingFile = null; pendingParsed = null;
}

// ══════════════════════════════════════════════
//  Modal helpers
// ══════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ══════════════════════════════════════════════
//  Context menu
// ══════════════════════════════════════════════
function showCtxMenu(x, y) {
  const m = document.getElementById('ctxMenu');
  m.style.left = x + 'px';
  m.style.top  = Math.min(y, window.innerHeight - 100) + 'px';
  m.classList.add('open');
}
function hideCtxMenu() { document.getElementById('ctxMenu').classList.remove('open'); }

async function deleteChat(chatId) {
  await dbDelete('chats', chatId);
  await dbDeleteByIndex('messages','chatId', chatId);
  allChats = allChats.filter(c => c.id !== chatId);
  if (currentChatId === chatId) {
    currentChatId = null; currentMsgs = [];
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('chatPlaceholder').style.display = '';
  }
  renderChatList();
  toast('Chat deleted');
}

// ══════════════════════════════════════════════
//  Theme toggle
// ══════════════════════════════════════════════
let darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
function applyTheme() {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  const btn = document.getElementById('themeToggleBtn');
  btn.innerHTML = darkMode
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
}
applyTheme();

// ══════════════════════════════════════════════
//  Event listeners
// ══════════════════════════════════════════════
document.getElementById('themeToggleBtn').addEventListener('click', () => { darkMode = !darkMode; applyTheme(); });

// FIX: upload buttons only trigger file picker — modal opens inside openImportModal()
document.getElementById('uploadBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});
document.getElementById('emptyUploadBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

// FIX: file input fires AFTER user picks file → then open modal and parse
document.getElementById('fileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be re-imported
  openImportModal(file);
});

const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('click', () => document.getElementById('fileInput').click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.name.endsWith('.txt')) openImportModal(f);
  else toast('Please drop a .txt file', 'error');
});

// FIX: removed redundant openModal() call — openImportModal() handles it
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.name.endsWith('.txt')) openImportModal(f);
});

document.getElementById('senderSelect').addEventListener('change', checkImportReady);
document.getElementById('importChatName').addEventListener('input', checkImportReady);
document.getElementById('importConfirm').addEventListener('click', confirmImport);
document.getElementById('importCancel').addEventListener('click', () => closeModal('importModal'));
document.querySelectorAll('.modal-overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); })
);

document.getElementById('sidebarSearch').addEventListener('input', e => renderChatList(e.target.value));

document.getElementById('chatSearchBtn').addEventListener('click', () => {
  const bar = document.getElementById('chatSearchBar');
  bar.classList.toggle('visible');
  if (bar.classList.contains('visible')) document.getElementById('chatSearchInput').focus();
  else clearSearch();
});
document.getElementById('chatSearchClose').addEventListener('click', () => {
  document.getElementById('chatSearchBar').classList.remove('visible');
  document.getElementById('chatSearchInput').value = '';
  clearSearch();
});
document.getElementById('chatSearchInput').addEventListener('input', e => doSearch(e.target.value));
document.getElementById('chatSearchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { searchIdx = (searchIdx+1) % (searchResults.length||1); updateSearchNav(); scrollToResult(); }
});
document.getElementById('searchNext').addEventListener('click', () => {
  if (!searchResults.length) return;
  searchIdx = (searchIdx+1) % searchResults.length; updateSearchNav(); scrollToResult();
});
document.getElementById('searchPrev').addEventListener('click', () => {
  if (!searchResults.length) return;
  searchIdx = (searchIdx-1+searchResults.length) % searchResults.length; updateSearchNav(); scrollToResult();
});

document.getElementById('backBtn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('hidden-mobile');
  document.getElementById('chatArea').classList.add('hidden-mobile');
  currentChatId = null;
  document.getElementById('chatView').style.display = 'none';
  document.getElementById('chatPlaceholder').style.display = '';
  renderChatList();
});

document.getElementById('ctxDelete').addEventListener('click', () => {
  if (ctxTargetId) deleteChat(ctxTargetId);
  hideCtxMenu();
});
document.getElementById('ctxRename').addEventListener('click', () => {
  const chat = allChats.find(c => c.id === ctxTargetId);
  if (chat) { document.getElementById('renameInput').value = chat.name; openModal('renameModal'); }
  hideCtxMenu();
});
document.getElementById('renameCancel').addEventListener('click', () => closeModal('renameModal'));
document.getElementById('renameConfirm').addEventListener('click', async () => {
  const n = document.getElementById('renameInput').value.trim();
  if (!n || !ctxTargetId) { closeModal('renameModal'); return; }
  const chat = allChats.find(c => c.id === ctxTargetId);
  if (chat) { chat.name = n; await dbPut('chats', chat); renderChatList(); if (currentChatId===ctxTargetId) { document.getElementById('headerName').textContent=n; } }
  closeModal('renameModal'); toast('Renamed');
});

document.getElementById('chatMenuBtn').addEventListener('click', e => {
  if (currentChatId) { ctxTargetId = currentChatId; showCtxMenu(e.clientX, e.clientY); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('#ctxMenu')) hideCtxMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideCtxMenu(); closeModal('importModal'); closeModal('renameModal'); }
});

// ══════════════════════════════════════════════
//  Boot
// ══════════════════════════════════════════════
(async () => {
  try {
    await openDB();
    allChats = await dbGetAll('chats');
    allChats.sort((a,b) => (b.lastDate||b.createdAt) - (a.lastDate||a.createdAt));
    renderChatList();
  } catch(err) {
    console.error('DB init error:', err);
    toast('Storage unavailable — chats won\'t persist', 'error');
  }
})();
