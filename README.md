# WhatsApp Archive

Turn your WhatsApp `.txt` exports into a beautiful, searchable archive.

## Two ways to use

### 1. Standalone HTML (Recommended — no install needed)
Open `whatsapp-archive.html` directly in your browser.
Uses **IndexedDB** for local persistent storage — no server required.

### 2. Python Flask + SQLite (Server mode)
```bash
pip install flask
python app.py
# Open http://localhost:5000
```

---

## How to export a WhatsApp chat

1. Open a chat in WhatsApp
2. Tap More (⋮) → More → Export chat
3. Choose **Without media**
4. Share/save the `.txt` file

---

## Features

| Feature | Details |
|---------|---------|
| WhatsApp UI | Authentic dark/light theme, bubbles, timestamps |
| IndexedDB | Chats persist in browser (standalone version) |
| SQLite | Server-side storage with Flask backend |
| Search | Full-text search within any chat |
| Multi-participant | Group chats with sender names on bubbles |
| Date separators | Today, Yesterday, or date |
| Media badges | <Media omitted> shown as media badge |
| Dark / Light | Matches WhatsApp Web colors |
| Delete & Rename | Right-click any chat to manage it |
| Drag & drop | Drag a .txt file anywhere onto the app |

---

## Flask API Reference

| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/chats | List all chats |
| POST | /api/chats | Import (multipart: file, name, my_name) |
| PATCH | /api/chats/:id | Rename |
| DELETE | /api/chats/:id | Delete |
| GET | /api/chats/:id/messages | Messages (q, limit, offset params) |
| POST | /api/parse-preview | Preview participants without saving |

---

## Project layout

```
whatsapp-archive/
├── whatsapp-archive.html  <- Standalone app (just open this)
├── app.py                 <- Flask + SQLite backend
├── README.md
└── wa_archive.db          <- auto-created by Flask on first run
```
