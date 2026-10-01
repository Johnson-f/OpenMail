# OpenMail Design

Date: 2026-10-01
Status: Draft

## What it is

OpenMail is a native macOS mail app for Gmail where AI is part of the inbox rather than a plugin. You connect one or more Google accounts, OpenMail syncs all of your mail to your Mac, and Claude helps you understand, sort and reply to it.

Two principles shape everything:

1. **Mail-first.** The inbox is still the main screen. AI changes how the inbox is organized and what you see, but you are always one glance away from your mail.
2. **Proactive, suggest-only.** The AI works in the background: it sorts, summarizes, extracts deadlines and prepares replies. It never sends, archives, deletes or labels anything unless you click to accept.

## Experience

### Main window

Three panes, plus an assistant:

- **Sidebar:** accounts, then the AI groups (Needs reply, Waiting on others, FYI, Noise), then the regular Gmail labels.
- **Thread list:** each row shows the sender, an AI one-line summary in place of the snippet, and badges for deadlines and prepared drafts.
- **Reading pane:** the thread, with a prepared reply (when there is one) pinned at the bottom, ready to edit and send.
- **Assistant panel:** an always-available side panel that already knows the open thread. You can ask about this thread or the whole mailbox.
- **⌘K command bar:** ask anything or jump anywhere ("what did the landlord say about the deposit?", "open the invoice from Stripe last month").

### Morning briefing

The first time you open the app each day, you see a briefing: what arrived, what needs you (with deadlines), and threads where you're waiting on a reply that is overdue. Every item links to its thread.

### Answers cite sources

Every assistant answer about your mail links to the messages it used. Clicking a citation opens that message.

## Architecture

```
┌──────────────────────── OpenMail.app (SwiftUI) ────────────────────────┐
│  Views: Sidebar · ThreadList · Reader · AssistantPanel · CommandBar      │
│                               │                                          │
│  ┌──────────── OpenMailKit (Swift package) ─────────────┐               │
│  │  Accounts   Gmail sync   Store   Search   AI          │               │
│  └──────┬───────────┬─────────┬───────┬──────┬───────────┘               │
└─────────┼───────────┼─────────┼───────┼──────┼───────────────────────────┘
          │           │         │       │      │
      Keychain    Gmail API   SQLite  Voyage  Claude API
```

- **OpenMailKit** is a Swift package with all non-UI logic. It is tested with `swift test` and has no SwiftUI dependency.
- **OpenMail.app** is a thin SwiftUI layer over OpenMailKit.
- Swift 6 with strict concurrency. Long-running work (sync, indexing, triage) runs in actors and never blocks the UI.
- Target: macOS 26 or later.

### Accounts and auth

- Google OAuth with PKCE through `ASWebAuthenticationSession`.
- Scope: `gmail.modify`, which covers reading, labels, drafts and sending.
- Refresh tokens are stored in the Keychain. Nothing secret is written to disk.
- Multiple accounts are supported from the start, and every record is scoped by account.

### Gmail sync

- **Initial sync:** page through `messages.list`, then fetch messages in batches with bounded concurrency, newest first, so recent mail is usable within seconds while older mail keeps arriving.
- **Incremental sync:** `history.list` from the last stored `historyId`, polled every 60 seconds while the app is open. If Gmail reports the history ID as expired, run a full resync.
- **Parsing:** MIME is parsed into plain text (for search and AI) and sanitized HTML (for display). Attachment metadata is stored; content is downloaded on demand.
- **Writes** (send, archive, label, accept draft) go straight to the Gmail API and are then reflected locally.

### Store

SQLite through GRDB, with one database file per installation.

| Table | Purpose |
|---|---|
| `accounts` | email, display name, last `historyId` |
| `threads` | Gmail thread ID, subject, participants, last message date, labels |
| `messages` | headers, plain-text body, HTML body, internal date |
| `attachments` | filename, MIME type, size, Gmail attachment ID |
| `messages_fts` | FTS5 index over subject, sender and body |
| `chunks` | message ID, text span, embedding (float32 BLOB), embedding model |
| `insights` | per thread: category, summary, deadlines, tasks, needs-reply, model, updated time |
| `suggested_drafts` | per thread: draft body, model, created time, state (pending / accepted / dismissed) |
| `briefings` | the generated daily briefings |

### Search

Hybrid search, entirely on the Mac apart from embedding the query:

1. **Keyword:** FTS5 with bm25 ranking. This is best for names, addresses, order numbers and exact phrases.
2. **Semantic:** the query is embedded with Voyage and compared by cosine similarity against chunk embeddings using Accelerate (`vDSP`), all in memory. This is fast enough for hundreds of thousands of chunks without a vector database.
3. **Fusion:** reciprocal rank fusion merges the two lists.

**Indexing:** each message is split into chunks (whole message if short, otherwise paragraph-based spans of about 400 tokens, with quoted replies and signatures stripped). Chunks are embedded with Voyage in batches as messages sync. Each chunk records its embedding model so the index can be rebuilt if the model changes.

### AI

All calls go directly to the Claude API, using the user's own API key stored in the Keychain.

| Job | Model | When |
|---|---|---|
| Triage: category, summary, deadlines, tasks | Haiku 4.5 | Each new thread or thread update, plus the last 30 days on first sync |
| Suggested reply | Sonnet 5.5 | Threads triaged as Needs reply |
| Assistant chat and ⌘K | Sonnet 5.5 | On request |
| Morning briefing | Sonnet 5.5 | First launch each day |

Triage returns structured JSON that is validated before it is stored.

**Assistant tools** (Claude tool use):

- `search_mail(query, account?, from?, after?, before?)` returns ranked excerpts with message IDs.
- `get_thread(thread_id)` returns the full thread text.
- `list_threads(category?, after?, before?)` lists threads by AI group or date.
- `propose_reply(thread_id, instructions)` returns a draft that the UI shows for the user to edit and send.

The assistant has no tools that send, archive, delete or label mail. Every such action is a button the user clicks. This is also the main defense against prompt injection: email content is only ever passed to Claude as data, and even a malicious email has no way to make it act.

### Privacy

- All mail is stored locally on the Mac.
- Message text is sent to Voyage to create embeddings.
- Message text is sent to Anthropic for triage, drafting and answering questions.
- Settings has a per-account switch to turn AI off. Mail still syncs and keyword search still works.

## Build order

1. **Mail client:** Google sign-in, multi-account sync, local store, three-pane UI, read / archive / send.
2. **Search and assistant:** FTS5 plus Voyage indexing, hybrid search, assistant panel and ⌘K with cited answers.
3. **AI inbox:** triage into groups, one-line summaries, deadlines, suggested replies.
4. **Briefing:** morning briefing and overdue follow-ups.

Each step ships as a usable app.

## Open questions

- **OAuth client type:** `ASWebAuthenticationSession` needs a custom URL scheme redirect, which Google supports for its "iOS" client type (this also works on macOS). A "Desktop app" client needs a loopback redirect server instead. Which client type is set up in Google Cloud?
- **Distribution:** `gmail.modify` is a restricted scope. Personal use with test users is fine; public distribution requires Google's security assessment.
- **Cost controls:** set a monthly budget for Claude and Voyage, and decide how far back to triage and embed on first sync.
