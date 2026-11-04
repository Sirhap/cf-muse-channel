"""Transactional inbox ownership and stable outbound IDs for one Muse room."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

ID = re.compile(r'[A-Za-z0-9_.:-]{1,96}')


class Store:
    """Each CLI process owns one connection; SQLite serializes durable transitions."""

    def __init__(self, directory: Path, room: str):
        """Use private state permissions, strong commit durability and bounded lock waits."""
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        self.room = room
        path = directory / 'channel.sqlite3'
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        path.chmod(0o600)
        self.db = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS tasks (
              room TEXT NOT NULL,id TEXT NOT NULL,content TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'queued',run_id TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,
              created REAL NOT NULL,updated REAL NOT NULL,PRIMARY KEY(room,id));
            CREATE TABLE IF NOT EXISTS outbox (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,room TEXT NOT NULL,id TEXT NOT NULL,
              task_id TEXT NOT NULL,payload TEXT NOT NULL,cf_stored INTEGER NOT NULL DEFAULT 0,
              client_received INTEGER NOT NULL DEFAULT 0,UNIQUE(room,id));
            CREATE TABLE IF NOT EXISTS audit (
              room TEXT NOT NULL,task_id TEXT NOT NULL,event TEXT NOT NULL,ts REAL NOT NULL,run_id TEXT);
            CREATE TABLE IF NOT EXISTS controls (
              room TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(room,id));
            CREATE TABLE IF NOT EXISTS transport (room TEXT PRIMARY KEY,state TEXT,updated REAL);
        ''')

    def close(self):
        """Release the owned database handle."""
        self.db.close()

    @contextmanager
    def transaction(self):
        """Acquire the writer before reading state needed for a transition."""
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def task(self, task_id):
        """Return only a task in this configured room."""
        row = self.db.execute('SELECT * FROM tasks WHERE room=? AND id=?', (self.room, task_id)).fetchone()
        if row is None:
            raise ValueError('unknown task')
        return dict(row)

    def receive(self, frame):
        """Persist before ACK; replay never resets an already dispatched task."""
        if (not isinstance(frame, dict) or frame.get('source') != 'user' or frame.get('kind') != 'task'
                or not isinstance(frame.get('id'), str) or not ID.fullmatch(frame['id'])
                or not isinstance(frame.get('content'), str) or not frame['content'].strip()
                or len(json.dumps(frame, ensure_ascii=False).encode()) > 65536):
            raise ValueError('invalid inbound frame')
        with self.transaction():
            previous = self.db.execute('SELECT content FROM tasks WHERE room=? AND id=?', (self.room, frame['id'])).fetchone()
            if previous and previous['content'] != frame['content']:
                raise ValueError('conflicting task')
            if not previous:
                self.db.execute('INSERT INTO tasks(room,id,content,created,updated) VALUES (?,?,?,?,?)',
                                (self.room, frame['id'], frame['content'], time.time(), time.time()))

    def poll(self):
        """Claim one queued task; tasks in the same room run concurrently.

        A running task no longer blocks later tasks: each new message is
        dispatched on the next poll instead of waiting behind a long task.
        A single task is still claimed exactly once (queued -> dispatched in
        this transaction), and a second wake for the same task cannot take it
        over (see start()). Uncertain execution of one task therefore blocks
        only redispatch of that same task, never dispatch of other tasks.
        """
        with self.transaction():
            row = self.db.execute("SELECT * FROM tasks WHERE room=? AND status='queued' ORDER BY created,id LIMIT 1", (self.room,)).fetchone()
            if not row:
                return {'count': 0, 'messages': []}
            self.db.execute("UPDATE tasks SET status='dispatched',updated=? WHERE room=? AND id=?", (time.time(), self.room, row['id']))
            history = []
            completed = list(self.db.execute("SELECT id,content FROM tasks WHERE room=? AND status='completed' ORDER BY created DESC LIMIT 6", (self.room,)))
            for item in reversed(completed):
                history.append({'msgid': item['id'], 'role': 'user', 'text': item['content'][:1500]})
                reply = self.db.execute('SELECT payload FROM outbox WHERE room=? AND id=?',
                                        (self.room, 'result:' + item['id'])).fetchone()
                if reply:
                    history.append({'msgid': item['id'], 'role': 'assistant',
                                    'text': json.loads(reply['payload'])['content'][:2500]})
            return {'count': 1, 'messages': [{'msgid': row['id'], 'text': row['content'], 'room': self.room}], 'history': history}

    def start(self, task_id, run_id):
        """Bind to one actual platform run, without takeover by another wake."""
        if not isinstance(run_id, str) or not run_id.strip() or len(run_id) > 256:
            raise ValueError('run id required')
        with self.transaction():
            task = self.task(task_id)
            if task['status'] not in ('dispatched', 'running') or (task['run_id'] and task['run_id'] != run_id):
                raise ValueError('task already owned or unavailable')
            self.db.execute("UPDATE tasks SET status='running',run_id=?,updated=? WHERE room=? AND id=?", (run_id, time.time(), self.room, task_id))
        return {'msgid': task_id, 'status': 'running', 'run_id': run_id}

    def enqueue(self, task_id, content, kind, cancelled=False):
        """Commit task outcome and its stable formal message in one transaction."""
        if not isinstance(content, str) or not content.strip():
            raise ValueError('empty message')
        message_id = 'result:' + task_id if kind == 'result' else 'progress:' + uuid.uuid4().hex
        payload = {'type': 'message', 'id': message_id, 'kind': kind, 'content': content, 'reply_to': task_id}
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        if len(encoded.encode()) > 65000:
            raise ValueError('message too large')
        with self.transaction():
            task = self.task(task_id)
            previous = self.db.execute('SELECT payload FROM outbox WHERE room=? AND id=?', (self.room, message_id)).fetchone()
            if previous:
                if previous['payload'] != encoded:
                    raise ValueError('formal reply already exists with different content')
                return {'id': message_id, 'msgid': task_id, 'state': 'queued'}
            if task['status'] not in ('dispatched', 'running') or (task['cancel_requested'] and (kind != 'result' or not cancelled)):
                raise ValueError('task cannot accept this response')
            self.db.execute('INSERT INTO outbox(room,id,task_id,payload) VALUES (?,?,?,?)', (self.room, message_id, task_id, encoded))
            status = 'replying' if kind == 'result' else task['status']
            self.db.execute('UPDATE tasks SET status=?,updated=? WHERE room=? AND id=?', (status, time.time(), self.room, task_id))
        return {'id': message_id, 'msgid': task_id, 'state': 'queued'}

    def pending(self):
        """Reconcile unreceived stable frames, including missed delivery notifications."""
        return [json.loads(row['payload']) for row in self.db.execute('SELECT payload FROM outbox WHERE room=? AND client_received=0 ORDER BY seq', (self.room,))]

    def receipt(self, frame):
        """Keep CF storage separate from user-client reception evidence."""
        if frame.get('type') not in ('stored', 'delivered') or not isinstance(frame.get('id'), str):
            raise ValueError('invalid receipt')
        with self.transaction():
            row = self.db.execute('SELECT task_id,payload FROM outbox WHERE room=? AND id=?', (self.room, frame['id'])).fetchone()
            if row is None:
                raise ValueError('unknown receipt')
            delivered = frame['type'] == 'delivered' or frame.get('received') is True
            self.db.execute('UPDATE outbox SET cf_stored=1,client_received=MAX(client_received,?) WHERE room=? AND id=?', (int(delivered), self.room, frame['id']))
            if json.loads(row['payload'])['kind'] == 'result':
                self.db.execute("UPDATE tasks SET status='completed',updated=? WHERE room=? AND id=?", (time.time(), self.room, row['task_id']))

    def results(self, task_id=None):
        """Expose stage evidence without including secret config or message bodies."""
        condition = ' AND task_id=?' if task_id else ''
        params = (self.room, task_id) if task_id else (self.room,)
        return [dict(row) for row in self.db.execute('SELECT id,task_id,cf_stored,client_received FROM outbox WHERE room=?' + condition + ' ORDER BY seq', params)]

    def queue(self):
        """Report operational ownership without returning user message text."""
        return [dict(row) for row in self.db.execute('SELECT id,status,run_id,cancel_requested,updated FROM tasks WHERE room=? ORDER BY created', (self.room,))]

    def cancel(self, task_id):
        """Register cooperative cancellation; never claim an external operation stopped."""
        with self.transaction():
            if self.task(task_id)['status'] == 'completed':
                raise ValueError('task already completed')
            self._cancel_locked(task_id)
        return {'msgid': task_id, 'cancel_requested': True, 'stopped': False}

    def _cancel_locked(self, task_id):
        """Apply a cooperative cancellation inside the caller's transaction."""
        task = self.task(task_id)
        if task['status'] == 'completed':
            return  # A late replay cannot undo a committed formal result.
        self.db.execute('UPDATE tasks SET cancel_requested=1,updated=? WHERE room=? AND id=?', (time.time(), self.room, task_id))
        if task['status'] == 'queued':
            payload = json.dumps({'type': 'message', 'id': 'result:' + task_id, 'kind': 'result',
                                  'reply_to': task_id, 'content': '任务在开始执行前已登记取消。'},
                                 ensure_ascii=False, separators=(',', ':'))
            self.db.execute('INSERT INTO outbox(room,id,task_id,payload) VALUES (?,?,?,?)',
                            (self.room, 'result:' + task_id, task_id, payload))
            self.db.execute("UPDATE tasks SET status='replying' WHERE room=? AND id=?", (self.room, task_id))

    def receive_cancel(self, frame):
        """Commit control receipt and cancellation atomically before network ACK."""
        task_id = frame.get('reply_to')
        if (frame.get('source') != 'user' or frame.get('kind') != 'cancel'
                or not isinstance(task_id, str) or not ID.fullmatch(task_id)
                or frame.get('id') != 'cancel:' + task_id or frame.get('content') != 'cancel_requested'):
            raise ValueError('invalid cancellation')
        with self.transaction():
            previous = self.db.execute('SELECT task_id FROM controls WHERE room=? AND id=?', (self.room, frame['id'])).fetchone()
            if not previous:
                self._cancel_locked(task_id)
                self.db.execute('INSERT INTO controls VALUES (?,?,?)', (self.room, frame['id'], task_id))

    def recover(self, task_id, confirmed):
        """An explicit operator decision is required before retrying unknown execution."""
        if not confirmed:
            raise ValueError('must confirm original execution did not happen')
        with self.transaction():
            task = self.task(task_id)
            if task['status'] not in ('dispatched', 'running') or self.db.execute('SELECT 1 FROM outbox WHERE room=? AND id=?', (self.room, 'result:' + task_id)).fetchone():
                raise ValueError('task not recoverable')
            self.db.execute('INSERT INTO audit VALUES (?,?,?,?,?)', (self.room, task_id, 'operator_requeue', time.time(), task['run_id']))
            self.db.execute("UPDATE tasks SET status='queued',run_id=NULL,cancel_requested=0,updated=? WHERE room=? AND id=?", (time.time(), self.room, task_id))
        return {'msgid': task_id, 'status': 'queued'}

    def transport(self, state=None):
        """Persist a fixed connection state without raw exceptions or endpoints."""
        if state is not None:
            self.db.execute('INSERT INTO transport VALUES (?,?,?) ON CONFLICT(room) DO UPDATE SET state=excluded.state,updated=excluded.updated', (self.room, state, time.time()))
        row = self.db.execute('SELECT state,updated FROM transport WHERE room=?', (self.room,)).fetchone()
        return dict(row) if row else {'state': 'not_started', 'updated': None}
