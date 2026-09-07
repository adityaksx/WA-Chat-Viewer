# WhatsApp Chat Viewer

A local web application for importing, viewing, and searching WhatsApp chat exports.

> **Status:** Work in progress — the project is functional, but several features and improvements are planned.

## Features

- Import WhatsApp `.txt` chat exports
- WhatsApp-style chat interface
- Dark and light themes
- Search chats and messages
- Group chat support
- Sender identification
- Message timestamps and date separators
- Media-omitted message detection
- Rename and delete imported chats
- Drag-and-drop chat import
- Standalone browser mode using IndexedDB
- Optional Flask + SQLite backend
- Read-only archive interface

The parser supports multiple common WhatsApp export formats, including 12-hour and 24-hour timestamps, bracketed iOS exports, seconds, and two-digit years.

## Project Structure

```text
whatsapp-chat-viewer/
├── index.html
├── style.css
├── app.js
├── app.py
├── requirements.txt
├── README.md
└── wa_archive.db        # created automatically in server mode
```

## Standalone Mode

The frontend can run without a backend and stores imported chats locally using IndexedDB.

Simply open:

```text
index.html
```

in a modern browser.

## Flask Server Mode

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Start the server

```bash
python app.py
```

### 3. Open the application

```text
http://localhost:5000
```

The Flask backend uses SQLite for storing chats and messages.

## Export a WhatsApp Chat

1. Open a chat in WhatsApp.
2. Select **More → Export chat**.
3. Choose **Without media**.
4. Save or share the generated `.txt` file.
5. Import the file into the application.



## API

The Flask server currently provides endpoints for:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/chats` | List imported chats |
| POST | `/api/chats` | Import a chat |
| PATCH | `/api/chats/:id` | Rename a chat |
| DELETE | `/api/chats/:id` | Delete a chat |
| GET | `/api/chats/:id/messages` | Retrieve/search messages |
| POST | `/api/parse-preview` | Preview an exported chat |



## Current Limitations

This project is still under development. Some areas that can be improved include:

- Better handling of different WhatsApp export formats
- Improved media support
- More reliable date/time parsing
- Advanced search and filtering
- Chat statistics and analytics
- Better mobile responsiveness
- Performance improvements for very large exports
- Improved error handling and validation
- Better separation between frontend and backend
- Additional testing

## Privacy

The project is designed for local use. Imported conversations are intended to remain on the user's local machine/browser rather than being uploaded to a third-party service.

**Do not upload or publish private WhatsApp exports to a public repository.**

## Technologies

- HTML
- CSS
- JavaScript
- IndexedDB
- Python
- Flask
- SQLite

## License

Add a license before distributing the project publicly.