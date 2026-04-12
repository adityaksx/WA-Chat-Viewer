#!/usr/bin/env python3

import re, sqlite3, json, os
from datetime import datetime
from flask import Flask, request, jsonify, g, send_from_directory

app = Flask(__name__, static_folder='static')
DB  = os.path.join(os.path.dirname(__file__), 'wa_archive.db')

# ================= DB =================
SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    my_name TEXT,
    participants TEXT,
    message_count INTEGER DEFAULT 0,
    last_message TEXT,
    last_date INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    sender TEXT,
    content TEXT,
    is_system INTEGER DEFAULT 0,
    is_media INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
"""

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(_):
    db = g.pop('db', None)
    if db:
        db.close()

def init_db():
    db = sqlite3.connect(DB)
    db.executescript(SCHEMA)
    db.commit()
    db.close()

# ================= PARSER =================

MSG_RE = re.compile(
    r'^(\d{1,2}/\d{1,2}/\d{2,4}),\s*([0-9:apm\s]+)\s*-\s*(.*)',
    re.IGNORECASE
)

def parse_datetime(date_str, time_str):
    date_formats = ["%d/%m/%Y", "%m/%d/%Y", "%d/%m/%y", "%m/%d/%y"]
    time_formats = ["%I:%M %p", "%H:%M"]

    for df in date_formats:
        for tf in time_formats:
            try:
                return int(datetime.strptime(
                    f"{date_str} {time_str.upper()}",
                    f"{df} {tf}"
                ).timestamp() * 1000)
            except:
                continue

    raise ValueError(f"Unrecognized date/time: {date_str} {time_str}")

def is_media(content):
    if not content:
        return False
    c = content.lower()
    return "media omitted" in c or "image omitted" in c or "video omitted" in c

def parse_chat(text):
    msgs = []
    cur = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        m = MSG_RE.match(line)

        if m:
            if cur:
                msgs.append(cur)

            date, time, rest = m.groups()

            try:
                ts = parse_datetime(date, time)
            except:
                continue  # skip bad lines instead of corrupting

            if ": " in rest:
                sender, content = rest.split(": ", 1)
                is_sys = False
            else:
                sender = None
                content = rest
                is_sys = True

            cur = {
                "timestamp": ts,
                "sender": sender.strip() if sender else None,
                "content": content.strip(),
                "is_system": is_sys,
                "is_media": is_media(content)
            }

        elif cur:
            cur["content"] += "\n" + line

    if cur:
        msgs.append(cur)

    return msgs

def extract_participants(msgs):
    counts = {}
    for m in msgs:
        if not m["is_system"] and m["sender"]:
            counts[m["sender"]] = counts.get(m["sender"], 0) + 1
    return sorted(counts, key=lambda x: -counts[x])

# ================= API =================

@app.route('/api/chats', methods=['GET'])
def list_chats():
    rows = get_db().execute(
        'SELECT * FROM chats ORDER BY COALESCE(last_date, created_at) DESC'
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/chats', methods=['POST'])
def create_chat():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'No file'}), 400

    text = f.read().decode('utf-8', errors='replace')
    msgs = parse_chat(text)
    parts = extract_participants(msgs)

    name = request.form.get('name', f.filename.replace('.txt', ''))
    my_name = request.form.get('my_name', parts[0] if parts else '')

    last_msg = next((m for m in reversed(msgs) if not m['is_system']), None)

    db = get_db()

    preview = ''
    if last_msg:
        preview = '📷 Media' if last_msg['is_media'] else last_msg['content'][:80]

    cur = db.execute(
        '''INSERT INTO chats(name,my_name,participants,message_count,last_message,last_date,created_at)
           VALUES(?,?,?,?,?,?,?)''',
        (
            name,
            my_name,
            json.dumps(parts),
            sum(1 for m in msgs if not m['is_system']),
            preview,
            last_msg['timestamp'] if last_msg else int(datetime.now().timestamp() * 1000),
            int(datetime.now().timestamp() * 1000)
        )
    )

    chat_id = cur.lastrowid

    db.executemany(
        '''INSERT INTO messages(chat_id,timestamp,sender,content,is_system,is_media)
           VALUES(?,?,?,?,?,?)''',
        [
            (
                chat_id,
                m['timestamp'],
                m['sender'],
                m['content'],
                int(m['is_system']),
                int(m['is_media'])
            )
            for m in msgs
        ]
    )

    db.commit()

    return jsonify({'id': chat_id, 'name': name})

@app.route('/api/chats/<int:chat_id>/messages')
def get_messages(chat_id):
    rows = get_db().execute(
        'SELECT * FROM messages WHERE chat_id=? ORDER BY timestamp',
        (chat_id,)
    ).fetchall()

    return jsonify([dict(r) for r in rows])

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

# ================= RUN =================

if __name__ == '__main__':
    init_db()
    app.run(debug=True)