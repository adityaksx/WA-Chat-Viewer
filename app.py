#!/usr/bin/env python3
"""
WhatsApp Archive — Flask + SQLite backend
Run:  pip install flask && python app.py
Open: http://localhost:5000
"""

import re, sqlite3, json, os
from datetime import datetime
from flask import Flask, request, jsonify, g, send_from_directory

app  = Flask(__name__, static_folder='static')
DB   = os.path.join(os.path.dirname(__file__), 'wa_archive.db')

SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    my_name       TEXT,
    participants  TEXT,
    message_count INTEGER DEFAULT 0,
    last_message  TEXT,
    last_date     INTEGER,
    created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    timestamp  INTEGER NOT NULL,
    sender     TEXT,
    content    TEXT,
    is_system  INTEGER DEFAULT 0,
    is_media   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
"""

def init_db():
    db = sqlite3.connect(DB)
    db.executescript(SCHEMA)
    db.commit()
    db.close()

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA journal_mode=WAL')
        g.db.execute('PRAGMA foreign_keys=ON')
    return g.db

@app.teardown_appcontext
def close_db(_):
    db = g.pop('db', None)
    if db:
        db.close()

MSG_RE = re.compile(
    r'^(\d{1,2}/\d{1,2}/\d{4}),\s(\d{1,2}:\d{2}\s[ap]m)\s-\s([\s\S]+?)(?::\s([\s\S]*))?$',
    re.IGNORECASE
)

def parse_datetime(date_str, time_str):
    d, m, y = date_str.split('/')
    dt_str = f'{d.zfill(2)}/{m.zfill(2)}/{y} {time_str.upper()}'
    try:
        return int(datetime.strptime(dt_str, '%d/%m/%Y %I:%M %p').timestamp() * 1000)
    except ValueError:
        return int(datetime.now().timestamp() * 1000)

def parse_chat(text):
    msgs, cur = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = MSG_RE.match(line)
        if m:
            if cur:
                msgs.append(cur)
            date, time, sender_or_sys, content = m.groups()
            is_sys = content is None
            cur = dict(
                timestamp=parse_datetime(date, time),
                sender=None if is_sys else sender_or_sys.strip(),
                content=sender_or_sys.strip() if is_sys else (content or '').strip(),
                is_system=is_sys,
                is_media=not is_sys and (content or '').strip() == '<Media omitted>'
            )
        elif cur:
            cur['content'] += '\n' + line
    if cur:
        msgs.append(cur)
    return msgs

def extract_participants(msgs):
    counts = {}
    for m in msgs:
        if not m['is_system'] and m['sender']:
            counts[m['sender']] = counts.get(m['sender'], 0) + 1
    return [k for k, _ in sorted(counts.items(), key=lambda x: -x[1])]

@app.route('/api/chats', methods=['GET'])
def list_chats():
    rows = get_db().execute(
        'SELECT id,name,my_name,participants,message_count,last_message,last_date,created_at '
        'FROM chats ORDER BY COALESCE(last_date,created_at) DESC'
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/chats', methods=['POST'])
def create_chat():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'No file'}), 400
    text  = f.read().decode('utf-8', errors='replace')
    msgs  = parse_chat(text)
    parts = extract_participants(msgs)
    name    = request.form.get('name', f.filename.replace('.txt', ''))
    my_name = request.form.get('my_name', parts[0] if parts else '')
    last_msg = next((m for m in reversed(msgs) if not m['is_system']), None)
    db = get_db()
    preview = ''
    if last_msg:
        preview = '📷 Media' if last_msg['is_media'] else last_msg['content'][:80]
    cur = db.execute(
        'INSERT INTO chats(name,my_name,participants,message_count,last_message,last_date,created_at) '
        'VALUES(?,?,?,?,?,?,?)',
        (name, my_name, json.dumps(parts),
         sum(1 for m in msgs if not m['is_system']),
         preview,
         last_msg['timestamp'] if last_msg else int(datetime.now().timestamp() * 1000),
         int(datetime.now().timestamp() * 1000))
    )
    chat_id = cur.lastrowid
    db.executemany(
        'INSERT INTO messages(chat_id,timestamp,sender,content,is_system,is_media) VALUES(?,?,?,?,?,?)',
        [(chat_id, m['timestamp'], m['sender'], m['content'],
          int(m['is_system']), int(m['is_media'])) for m in msgs]
    )
    db.commit()
    return jsonify({'id': chat_id, 'name': name, 'participants': parts,
                    'message_count': len([m for m in msgs if not m['is_system']])}), 201

@app.route('/api/chats/<int:chat_id>', methods=['PATCH'])
def update_chat(chat_id):
    data = request.json or {}
    if 'name' in data:
        get_db().execute('UPDATE chats SET name=? WHERE id=?', (data['name'], chat_id))
        get_db().commit()
    return jsonify({'ok': True})

@app.route('/api/chats/<int:chat_id>', methods=['DELETE'])
def delete_chat(chat_id):
    get_db().execute('DELETE FROM chats WHERE id=?', (chat_id,))
    get_db().commit()
    return jsonify({'ok': True})

@app.route('/api/chats/<int:chat_id>/messages', methods=['GET'])
def get_messages(chat_id):
    q      = request.args.get('q', '').strip()
    limit  = min(int(request.args.get('limit', 2000)), 5000)
    offset = int(request.args.get('offset', 0))
    db = get_db()
    if q:
        rows = db.execute(
            'SELECT * FROM messages WHERE chat_id=? AND content LIKE ? '
            'ORDER BY timestamp LIMIT ? OFFSET ?',
            (chat_id, f'%{q}%', limit, offset)
        ).fetchall()
    else:
        rows = db.execute(
            'SELECT * FROM messages WHERE chat_id=? ORDER BY timestamp LIMIT ? OFFSET ?',
            (chat_id, limit, offset)
        ).fetchall()
    total = db.execute('SELECT COUNT(*) FROM messages WHERE chat_id=?', (chat_id,)).fetchone()[0]
    return jsonify({'messages': [dict(r) for r in rows], 'total': total})

@app.route('/api/parse-preview', methods=['POST'])
def parse_preview():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'No file'}), 400
    text  = f.read().decode('utf-8', errors='replace')
    msgs  = parse_chat(text)
    parts = extract_participants(msgs)
    return jsonify({
        'participants': parts,
        'total_messages': len(msgs),
        'non_system': sum(1 for m in msgs if not m['is_system']),
        'filename': f.filename
    })

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

if __name__ == '__main__':
    init_db()
    print('\n  WhatsApp Archive running at  http://localhost:5000\n')
    app.run(debug=True, port=5000)
