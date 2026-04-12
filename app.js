// ══════════════════════════════════════════════
//  IndexedDB
// ══════════════════════════════════════════════
const DB_NAME = 'wa_archive_v2';
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
    const req = s.index(indexName).openCursor(IDBKeyRange.only(key));
    req.onsuccess = e => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); } else res();
    };
    req.onerror = e => rej(e.target.error);
  });
}

// ══════════════════════════════════════════════
//  Parser
// ══════════════════════════════════════════════
const MSG_PATTERNS = [
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?[AaPp][Mm])\]\s([\s\S]+?)(?::\s([\s\S]*))?$/,
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?)\]\s([\s\S]+?)(?::\s([\s\S]*))?$/,
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?[AaPp][Mm])\s-\s([\s\S]+?)(?::\s([\s\S]*))?$/,
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}:\d{2})\s-\s([\s\S]+?)(?::\s([\s\S]*))?$/,
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2})\s-\s([\s\S]+?)(?::\s([\s\S]*))?$/,
];
function matchMsgLine(line) {
  for (const re of MSG_PATTERNS) { const m = line.match(re); if (m) return m; }
  return null;
}

function parseDateTime(dateStr, timeStr) {
  try {
    const [dStr, mStr, yStr] = dateStr.split('/');
    const d = parseInt(dStr, 10), m = parseInt(mStr, 10);
    let y = parseInt(yStr, 10);
    if (y < 100) y += 2000;
    const t = timeStr.trim();
    const ampmMatch = t.match(/([AaPp][Mm])\s*$/);
    const timePart = t.replace(/\s*[AaPp][Mm]\s*$/, '').trim();
    const parts = timePart.split(':');
    let h = parseInt(parts[0], 10);
    const min = parseInt(parts[1], 10);
    if (ampmMatch) {
      const ap = ampmMatch[1].toLowerCase();
      if (ap === 'pm' && h !== 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
    }
    return new Date(y, m - 1, d, h, min).getTime();
  } catch (_) { return Date.now(); }
}

// ── Media type detection ──
function detectMediaType(content) {
  const c = (content || '').trim();
  if (c === '<Media omitted>') return { type: 'media_omitted' };
  // Document: e.g. "file.pdf (file attached)"
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|txt|csv|apk)\s*\(file attached\)/i.test(c))
    return { type: 'document', name: c.replace(/\s*\(file attached\)/i,'').trim() };
  // Voice/Audio: .opus, .m4a, .aac, .mp3 attached
  if (/\.(opus|m4a|aac|mp3|ogg|wav)\s*\(file attached\)/i.test(c))
    return { type: 'audio', name: c.replace(/\s*\(file attached\)/i,'').trim() };
  // Image/Video: .jpg .png .mp4 .mov etc attached
  if (/\.(jpe?g|png|gif|webp|mp4|mov|avi|mkv|3gp)\s*\(file attached\)/i.test(c))
    return { type: 'image_attached', name: c.replace(/\s*\(file attached\)/i,'').trim() };
  // Sticker
  if (/sticker omitted/i.test(c)) return { type: 'sticker' };
  // GIF
  if (/GIF omitted/i.test(c)) return { type: 'gif' };
  // Location: "Location: https://maps.google..."
  if (/^location:\s*https?:\/\//i.test(c) || /maps\.google|goo\.gl\/maps/i.test(c))
    return { type: 'location', url: c.replace(/^location:\s*/i,'') };
  // Live location
  if (/live location shared/i.test(c)) return { type: 'live_location' };
  // Contact card
  if (/^\u{1F464}|^Contact card/u.test(c) || /\.vcf\s*\(file attached\)/i.test(c))
    return { type: 'contact', name: c.replace(/\.vcf\s*\(file attached\)/i,'').trim() };
  // Poll
  if (/^POLL:/i.test(c)) return { type: 'poll', raw: c };
  // Missed call
  if (/missed (voice|video) call/i.test(c)) return { type: 'missed_call', raw: c };
  return null;
}

// ── Reply detection (quoted text in WA starts with "> ") ──
function parseReply(content) {
  const lines = content.split('\n');
  const quoteLines = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('> ')) { quoteLines.push(lines[i].slice(2)); bodyStart = i + 1; }
    else break;
  }
  if (!quoteLines.length) return { quote: null, body: content };
  return { quote: quoteLines.join('\n'), body: lines.slice(bodyStart).join('\n').trim() };
}

// ── Single emoji detection ──
const EMOJI_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}){1,3}$/u;
function isSingleEmoji(text) {
  return EMOJI_RE.test(text.trim());
}

function parseChat(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/[\u200E\u200F\u202A\u202C]/g, '');
  const lines = clean.split(/\r?\n/);
  const msgs  = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = matchMsgLine(line);
    if (m) {
      if (cur) msgs.push(cur);
      const [, dateStr, timeStr, senderOrSystem, content] = m;
      const isSystem = content === undefined;
      const rawContent = isSystem ? senderOrSystem.trim() : (content || '').trim();
      const mediaInfo = !isSystem ? detectMediaType(rawContent) : null;
      cur = {
        timestamp: parseDateTime(dateStr, timeStr),
        sender:    isSystem ? null : senderOrSystem.trim(),
        content:   rawContent,
        isSystem,
        isMedia:   !!mediaInfo,
        mediaType: mediaInfo
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
  msgs.forEach(m => { if (!m.isSystem && m.sender) counts[m.sender] = (counts[m.sender]||0)+1; });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(e=>e[0]);
}

// ══════════════════════════════════════════════
//  UI State
// ══════════════════════════════════════════════
let allChats      = [];
let currentChatId = null;
let currentMsgs   = [];
let myName        = '';
let searchResults = [];
let searchIdx     = 0;
let pendingFile   = null;
let pendingParsed = null;
let ctxTargetId   = null;

// ══════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════
function toast(msg, type='') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' '+type : '');
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function avatarInitials(name) {
  if (!name) return '?';
  const p = name.trim().split(' ');
  return p.length > 1 ? (p[0][0]+p[p.length-1][0]).toUpperCase() : name[0].toUpperCase();
}
const AVATAR_COLORS = ['#00A884','#128C7E','#075E54','#25D366','#0078D4','#6264A4','#A0522D','#CD5C5C','#4682B4'];
function avatarColor(name) {
  let h = 0; for (const c of (name||'')) h = (h*31 + c.charCodeAt(0)) & 0xFFFFFFFF;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function fmtDate(ts) {
  const d = new Date(ts), today = new Date(), yest = new Date(today);
  yest.setDate(today.getDate()-1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString())  return 'Yesterday';
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}).toLowerCase();
}
function fmtTimeShort(ts) {
  const d = new Date(ts), today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'});
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Double-tick SVG (grey) ──
const TICK_SENT = `<span class="tick">
  <svg width="16" height="11" viewBox="0 0 16 11" fill="none">
    <path d="M1 5.5l3.5 3.5L12 1" stroke="#8696A0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M5 5.5l3.5 3.5L16 1" stroke="#8696A0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</span>`;

// ── Build meta row ──
function metaHtml(ts, isSent) {
  const time = `<span class="msg-time-txt">${fmtTime(ts)}</span>`;
  const tick = isSent ? TICK_SENT : '';
  return `<div class="msg-meta">${time}${tick}</div>`;
}

// ══════════════════════════════════════════════
//  Render sidebar
// ══════════════════════════════════════════════
function renderChatList(filter='') {
  const list = document.getElementById('chatList');
  const fl   = filter.toLowerCase();
  const filtered = allChats.filter(c => c.name.toLowerCase().includes(fl));

  if (!allChats.length) {
    list.innerHTML = `
      <div class="empty-chat-list">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <p>No chats yet.<br>Import a WhatsApp export to get started.</p>
      </div>
      <div style="padding:0 16px 16px">
        <label class="upload-zone" id="sidebarDropZone" for="sidebarFileInput" style="margin:0">
          <input type="file" id="sidebarFileInput" accept=".txt" style="display:none">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="12" y2="12"/><line x1="15" y1="15" x2="12" y2="12"/></svg>
          <p><span>Import your first chat</span></p>
        </label>
      </div>`;
    const sf = document.getElementById('sidebarFileInput');
    if (sf) sf.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return; e.target.value = ''; openImportModal(f);
    });
    return;
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-chat-list"><p>No chats match "<em>${escHtml(filter)}</em>"</p></div>`;
    return;
  }

  list.innerHTML = filtered.map(c => {
    const active = c.id === currentChatId ? ' active' : '';
    return `<div class="chat-item${active}" data-id="${c.id}">
      <div class="chat-avatar" style="background:${avatarColor(c.name)}">${avatarInitials(c.name)}</div>
      <div class="chat-info">
        <div class="chat-meta">
          <span class="chat-name">${escHtml(c.name)}</span>
          <span class="chat-time">${fmtTimeShort(c.lastDate||c.createdAt)}</span>
        </div>
        <div class="chat-preview">${escHtml((c.lastMessage||'').substring(0,60))}</div>
      </div>
      <div class="chat-badge">${c.messageCount||''}</div>
    </div>`;
  }).join('');

  list.querySelectorAll('.chat-item').forEach(el => {
    el.addEventListener('click', () => loadChat(+el.dataset.id));
    el.addEventListener('contextmenu', e => {
      e.preventDefault(); ctxTargetId = +el.dataset.id; showCtxMenu(e.clientX, e.clientY);
    });
  });
}

// ══════════════════════════════════════════════
//  Load chat
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
  const hav = document.getElementById('headerAvatar');
  hav.style.background = color;
  hav.textContent = avatarInitials(chat.name);
  document.getElementById('headerName').textContent = chat.name;
  document.getElementById('headerSub').textContent =
    `${chat.participants?.join(', ')||''} · ${msgs.length.toLocaleString()} messages`;
  document.getElementById('footerStats').textContent =
    `${msgs.length.toLocaleString()} msgs · ${chat.participants?.length||0} participants`;

  renderMessages(msgs);
  document.getElementById('chatPlaceholder').style.display = 'none';
  const cv = document.getElementById('chatView');
  cv.style.display = 'flex'; cv.style.height = '100%';

  renderChatList(document.getElementById('sidebarSearch').value);
  if (window.innerWidth <= 768) document.getElementById('sidebar').classList.add('hidden-mobile');
  setTimeout(() => {
    const a = document.getElementById('messagesArea'); a.scrollTop = a.scrollHeight;
  }, 60);
}

// ══════════════════════════════════════════════
//  Render messages — full WA-accurate output
// ══════════════════════════════════════════════
function renderMessages(msgs, highlightQuery='') {
  const area = document.getElementById('messagesArea');
  const q    = highlightQuery.toLowerCase();
  let html = '', lastDate = '', lastSender = '';

  msgs.forEach((msg, i) => {
    const dateLabel = fmtDate(msg.timestamp);
    if (dateLabel !== lastDate) {
      html += `<div class="date-sep"><span>${escHtml(dateLabel)}</span></div>`;
      lastDate = dateLabel; lastSender = '';
    }

    if (msg.isSystem) {
      html += `<div class="msg-system"><span>${escHtml(msg.content)}</span></div>`;
      lastSender = ''; return;
    }

    const isSent  = msg.sender === myName;
    const side    = isSent ? 'sent' : 'recv';
    const isFirst = msg.sender !== lastSender;
    lastSender = msg.sender;

    const senderLabel = (!isSent && isFirst)
      ? `<span class="sender-name" style="color:${avatarColor(msg.sender||'')}">${escHtml(msg.sender||'')}</span>` : '';

    let innerHtml  = '';
    let extraClass = '';

    // ─── Media types ───
    if (msg.isMedia && msg.mediaType) {
      const mt = msg.mediaType;

      if (mt.type === 'media_omitted') {
        innerHtml = `<div class="media-omitted">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          Photo/Video omitted
        </div>`;
        extraClass = ' media-bubble';

      } else if (mt.type === 'document') {
        const ext = (mt.name.split('.').pop()||'').toUpperCase().substring(0,4);
        innerHtml = `<div class="doc-bubble">
          <div class="doc-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
          <div class="doc-info">
            <div class="doc-name">${escHtml(mt.name)}</div>
            <div class="doc-size">${ext} Document</div>
          </div>
        </div>`;

      } else if (mt.type === 'audio') {
        const bars = Array.from({length:28},(_,k)=>`<div class="audio-bar" style="height:${4+Math.abs(Math.sin(k*0.7+1)*14)|0}px"></div>`).join('');
        innerHtml = `<div class="audio-bubble">
          <div class="audio-play"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
          <div class="audio-waveform">${bars}</div>
          <div class="audio-dur">0:00</div>
        </div>`;

      } else if (mt.type === 'image_attached') {
        innerHtml = `<div class="media-omitted">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          ${escHtml(mt.name)}
        </div>`;
        extraClass = ' media-bubble';

      } else if (mt.type === 'sticker') {
        innerHtml = `<div style="font-size:3.5rem;line-height:1;padding:2px">🌟</div>`;
        extraClass = ' sticker-bubble';

      } else if (mt.type === 'gif') {
        innerHtml = `<div class="media-omitted">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h4"/><path d="M10 10v4"/><text x="14" y="14" font-size="7" fill="currentColor">GIF</text></svg>
          GIF omitted
        </div>`;
        extraClass = ' media-bubble';

      } else if (mt.type === 'location' || mt.type === 'live_location') {
        const label = mt.type === 'live_location' ? 'Live Location' : 'Location';
        innerHtml = `<div class="location-bubble">
          <div class="location-map">
            <svg class="location-pin" width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>
          </div>
          <div class="location-label">${label}</div>
        </div>`;

      } else if (mt.type === 'contact') {
        const cname = mt.name || 'Contact';
        innerHtml = `<div>
          <div class="contact-bubble">
            <div class="contact-avatar"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
            <div><div class="contact-name">${escHtml(cname)}</div></div>
          </div>
          <div class="contact-action">View Contact</div>
        </div>`;

      } else if (mt.type === 'poll') {
        const pollLines = mt.raw.replace(/^POLL:\s*/i,'').split('\n');
        const pollQ = pollLines[0]||'Poll';
        const opts  = pollLines.slice(1).filter(l=>l.trim().startsWith('OPTION:')).map(l=>l.replace(/^OPTION:\s*/i,''));
        innerHtml = `<div class="poll-bubble">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2"><rect x="3" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="17" y="5" width="4" height="16" rx="1"/></svg>
            <span style="font-size:.6875rem;font-weight:600;color:var(--green)">POLL</span>
          </div>
          <div class="poll-title">${escHtml(pollQ)}</div>
          ${opts.map(o=>`<div class="poll-option"><div class="poll-dot"></div><span class="poll-opt-text">${escHtml(o)}</span></div>`).join('')}
          <div class="poll-footer">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>
            Tap to vote
          </div>
        </div>`;

      } else if (mt.type === 'missed_call') {
        const isVideo = /video/i.test(mt.raw);
        innerHtml = `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;color:#EF4444;font-size:.875rem">
          ${isVideo
            ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`
            : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.24h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`}
          Missed ${isVideo?'video ':''}call
        </div>`;
      }

    } else {
      // ─── Normal text message ───
      const { quote, body } = parseReply(msg.content);
      let quoteHtml = '';
      if (quote) {
        quoteHtml = `<div class="reply-quote">
          <div class="rq-sender">${isSent ? 'You' : escHtml(msg.sender||'')}</div>
          <div class="rq-text">${escHtml(quote.substring(0,120))}</div>
        </div>`;
      }

      const textToRender = body || msg.content;

      if (!quote && isSingleEmoji(textToRender)) {
        extraClass = ' emoji-only';
        innerHtml  = `${senderLabel}<span class="msg-text">${escHtml(textToRender.trim())}</span>`;
      } else {
        let txt = escHtml(textToRender);
        if (q && txt.toLowerCase().includes(q)) {
          const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
          txt = txt.replace(re, '<mark>$1</mark>');
        }
        innerHtml = `${senderLabel}${quoteHtml}<span class="msg-text">${txt}</span>`;
      }
    }

    html += `<div class="msg-row ${side}${isFirst?' first-in-group':''}" data-idx="${i}">
      <div class="bubble-wrap">
        <div class="bubble${extraClass}" data-idx="${i}">
          ${!msg.isMedia || msg.mediaType?.type === 'media_omitted' || msg.mediaType?.type === 'image_attached' || msg.mediaType?.type === 'gif' ? (msg.isMedia ? '' : '') : ''}
          ${innerHtml}
          ${metaHtml(msg.timestamp, isSent)}
        </div>
      </div>
    </div>`;
  });

  area.innerHTML = html || `<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:.8125rem">No messages</div>`;
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
  c.textContent = searchResults.length ? `${searchIdx+1} / ${searchResults.length}` : 'No results';
}
function scrollToResult() {
  if (!searchResults.length) return;
  const el = document.querySelector(`.bubble[data-idx="${searchResults[searchIdx]}"]`);
  if (el) { el.scrollIntoView({ behavior:'smooth', block:'center' }); el.classList.add('highlight'); setTimeout(()=>el.classList.remove('highlight'),1200); }
}

// ══════════════════════════════════════════════
//  Import flow
// ══════════════════════════════════════════════
function openImportModal(file) {
  pendingFile = file; pendingParsed = null;
  document.getElementById('senderSelect').innerHTML = '<option value="">Parsing…</option>';
  document.getElementById('importConfirm').disabled = true;
  document.getElementById('filePreview').style.display = 'none';
  document.getElementById('importChatName').value = '';
  openModal('importModal');

  const reader = new FileReader();
  reader.onerror = () => { toast('Could not read file', 'error'); };
  reader.onload = e => {
    try {
      pendingParsed = parseChat(e.target.result);
      if (!pendingParsed || !pendingParsed.length) {
        toast('No messages found', 'error');
        document.getElementById('senderSelect').innerHTML = '<option value="">No messages found</option>';
        return;
      }
      const participants = extractParticipants(pendingParsed);
      const nonSys = pendingParsed.filter(m=>!m.isSystem).length;
      document.getElementById('senderSelect').innerHTML =
        '<option value="">— Select your name —</option>' +
        participants.map(p=>`<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('');
      document.getElementById('importChatName').value = file.name.replace(/\.txt$/i,'').replace(/_/g,' ');
      document.getElementById('previewName').textContent = file.name + '  ';
      document.getElementById('previewMeta').textContent = `${nonSys.toLocaleString()} messages · ${participants.length} participants`;
      document.getElementById('filePreview').style.display = 'block';
      checkImportReady();
    } catch(err) {
      console.error(err);
      toast('Parsing error: '+err.message, 'error');
    }
  };
  reader.readAsText(file, 'utf-8');
}
function checkImportReady() {
  document.getElementById('importConfirm').disabled =
    !(pendingParsed && pendingParsed.length && document.getElementById('senderSelect').value !== '');
}
async function confirmImport() {
  if (!pendingParsed || !pendingParsed.length) return;
  const name = document.getElementById('importChatName').value.trim() || 'Unnamed Chat';
  const myN  = document.getElementById('senderSelect').value;
  const participants = extractParticipants(pendingParsed);
  closeModal('importModal');
  document.getElementById('loading').classList.remove('hidden');
  const lastMsg = [...pendingParsed].reverse().find(m=>!m.isSystem);
  const chatData = {
    name, myName:myN, participants,
    messageCount: pendingParsed.filter(m=>!m.isSystem).length,
    lastMessage: lastMsg ? (lastMsg.isMedia ? '📷 Media' : lastMsg.content.substring(0,80)) : '',
    lastDate: lastMsg ? lastMsg.timestamp : Date.now(),
    createdAt: Date.now()
  };
  const chatId = await dbAdd('chats', chatData);
  chatData.id  = chatId;
  const CHUNK = 500;
  for (let i=0;i<pendingParsed.length;i+=CHUNK)
    await Promise.all(pendingParsed.slice(i,i+CHUNK).map(m=>dbAdd('messages',{...m,chatId})));
  allChats.unshift(chatData);
  renderChatList();
  document.getElementById('loading').classList.add('hidden');
  toast(`Imported "${name}" · ${chatData.messageCount.toLocaleString()} messages`);
  loadChat(chatId);
  pendingFile = null; pendingParsed = null;
}

// ══════════════════════════════════════════════
//  Modal & context menu helpers
// ══════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function showCtxMenu(x,y) {
  const m = document.getElementById('ctxMenu');
  m.style.left = x+'px'; m.style.top = Math.min(y,window.innerHeight-100)+'px';
  m.classList.add('open');
}
function hideCtxMenu() { document.getElementById('ctxMenu').classList.remove('open'); }

async function deleteChat(chatId) {
  await dbDelete('chats', chatId);
  await dbDeleteByIndex('messages','chatId', chatId);
  allChats = allChats.filter(c=>c.id!==chatId);
  if (currentChatId===chatId) {
    currentChatId=null; currentMsgs=[];
    document.getElementById('chatView').style.display='none';
    document.getElementById('chatPlaceholder').style.display='';
  }
  renderChatList(); toast('Chat deleted');
}

// ══════════════════════════════════════════════
//  Theme
// ══════════════════════════════════════════════
let darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
function applyTheme() {
  document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  document.getElementById('themeToggleBtn').innerHTML = darkMode
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
}
applyTheme();

// ══════════════════════════════════════════════
//  Event Listeners
// ══════════════════════════════════════════════
document.getElementById('themeToggleBtn').addEventListener('click', () => { darkMode=!darkMode; applyTheme(); });
document.getElementById('uploadBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('emptyUploadBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', e => {
  const f=e.target.files[0]; if(!f) return; e.target.value=''; openImportModal(f);
});

const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('click', () => document.getElementById('fileInput').click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const f=e.dataTransfer.files[0];
  if(f&&f.name.endsWith('.txt')) openImportModal(f); else toast('Please drop a .txt file','error');
});
document.addEventListener('dragover', e=>e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); const f=e.dataTransfer.files[0];
  if(f&&f.name.endsWith('.txt')) openImportModal(f);
});

document.getElementById('senderSelect').addEventListener('change', checkImportReady);
document.getElementById('importChatName').addEventListener('input', checkImportReady);
document.getElementById('importConfirm').addEventListener('click', confirmImport);
document.getElementById('importCancel').addEventListener('click', () => closeModal('importModal'));
document.querySelectorAll('.modal-overlay').forEach(o =>
  o.addEventListener('click', e => { if(e.target===o) o.classList.remove('open'); })
);

document.getElementById('sidebarSearch').addEventListener('input', e => renderChatList(e.target.value));

document.getElementById('chatSearchBtn').addEventListener('click', () => {
  const bar = document.getElementById('chatSearchBar');
  bar.classList.toggle('visible');
  if(bar.classList.contains('visible')) document.getElementById('chatSearchInput').focus();
  else clearSearch();
});
document.getElementById('chatSearchClose').addEventListener('click', () => {
  document.getElementById('chatSearchBar').classList.remove('visible');
  document.getElementById('chatSearchInput').value = '';
  clearSearch();
});
document.getElementById('chatSearchInput').addEventListener('input', e => doSearch(e.target.value));
document.getElementById('chatSearchInput').addEventListener('keydown', e => {
  if(e.key==='Enter') { searchIdx=(searchIdx+1)%(searchResults.length||1); updateSearchNav(); scrollToResult(); }
});
document.getElementById('searchNext').addEventListener('click', () => {
  if(!searchResults.length) return; searchIdx=(searchIdx+1)%searchResults.length; updateSearchNav(); scrollToResult();
});
document.getElementById('searchPrev').addEventListener('click', () => {
  if(!searchResults.length) return; searchIdx=(searchIdx-1+searchResults.length)%searchResults.length; updateSearchNav(); scrollToResult();
});

document.getElementById('backBtn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('hidden-mobile');
  document.getElementById('chatArea').classList.add('hidden-mobile');
  currentChatId=null; currentMsgs=[];
  document.getElementById('chatView').style.display='none';
  document.getElementById('chatPlaceholder').style.display='';
  renderChatList();
});

document.getElementById('ctxDelete').addEventListener('click', () => { if(ctxTargetId) deleteChat(ctxTargetId); hideCtxMenu(); });
document.getElementById('ctxRename').addEventListener('click', () => {
  const chat=allChats.find(c=>c.id===ctxTargetId);
  if(chat) { document.getElementById('renameInput').value=chat.name; openModal('renameModal'); }
  hideCtxMenu();
});
document.getElementById('renameCancel').addEventListener('click', () => closeModal('renameModal'));
document.getElementById('renameConfirm').addEventListener('click', async () => {
  const n=document.getElementById('renameInput').value.trim();
  if(!n||!ctxTargetId) { closeModal('renameModal'); return; }
  const chat=allChats.find(c=>c.id===ctxTargetId);
  if(chat) { chat.name=n; await dbPut('chats',chat); renderChatList(); if(currentChatId===ctxTargetId) document.getElementById('headerName').textContent=n; }
  closeModal('renameModal'); toast('Renamed');
});

document.getElementById('chatMenuBtn').addEventListener('click', e => {
  if(currentChatId) { ctxTargetId=currentChatId; showCtxMenu(e.clientX, e.clientY); }
});
document.addEventListener('click', e => { if(!e.target.closest('#ctxMenu')) hideCtxMenu(); });
document.addEventListener('keydown', e => {
  if(e.key==='Escape') { hideCtxMenu(); closeModal('importModal'); closeModal('renameModal'); }
});

// Call buttons (archive = read-only, just show toast)
document.getElementById('btnVideoCall').addEventListener('click', () => toast('This is a read-only archive'));
document.getElementById('btnVoiceCall').addEventListener('click', () => toast('This is a read-only archive'));

// Lightbox
const lightbox    = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
document.addEventListener('click', e => {
  const img = e.target.closest('.msg-media-img, .msg-media-multi img');
  if(img) { lightboxImg.src=img.src; lightbox.classList.add('open'); }
});
document.getElementById('lightbox-close').addEventListener('click', () => lightbox.classList.remove('open'));
lightbox.addEventListener('click', e => { if(e.target===lightbox) lightbox.classList.remove('open'); });

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
    toast("Storage unavailable — chats won't persist", 'error');
  }
})();
