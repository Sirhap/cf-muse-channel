"""Side-session event notifications with an independent Noise reader."""
import json
import threading
import time


class EventGateway:
    """Delegate RPCs to one socket and consume subscriptions on a separate socket."""

    def __init__(self, client, factory):
        self._client = client
        self._factory = factory
        self._lock = threading.Lock()
        self._stopped = threading.Event()
        self._wake = threading.Event()
        self._session = None
        self._subscription = None
        self._thread = None
        self._revision = 0
        self._snapshot = None
        self._snapshot_revision = -1
        self._snapshot_at = 0.0
        self._snapshot_limit = 0

    def __getattr__(self, name):
        return getattr(self._client, name)

    def _changed(self):
        with self._lock:
            self._revision += 1
        self._wake.set()

    def _watch(self, session):
        with self._lock:
            if self._session == session:
                return
            self._session = session
            self._revision += 1
            previous = self._subscription
        if previous:
            previous.close()
        # The existing reader exits on session change. Its replacement starts here.
        thread = threading.Thread(target=self._observe, args=(session,), daemon=True)
        self._thread = thread
        thread.start()

    def _current(self, session):
        with self._lock:
            return not self._stopped.is_set() and self._session == session

    def _observe(self, session):
        while self._current(session):
            connection = None
            accepted = False
            try:
                connection = self._factory()
                with self._lock:
                    if self._session != session or self._stopped.is_set():
                        return
                    self._subscription = connection
                stream = connection._open("chat.subscribe", body={
                    "session_id": session, "capabilities": ["chat_cancel", "delta_stream"],
                })
                buffer = b""
                while self._current(session):
                    frame = connection._read_frame()
                    if frame.stream_id != stream:
                        continue
                    kind = frame.WhichOneof("kind")
                    if kind == "reset":
                        break
                    if kind not in ("response", "body_chunk"):
                        continue
                    response = getattr(frame, kind)
                    if kind == "response" and not 200 <= response.status < 300:
                        raise ConnectionError("Subscription refused")
                    if kind == "response":
                        accepted = True
                        self._changed()  # Reconcile any events missed before reconnect.
                        print("[cf-events] subscription accepted", flush=True)
                    buffer += bytes(response.body if kind == "response" else response.data)
                    if len(buffer) > 2 * 1024 * 1024:
                        raise ValueError("Subscription record too large")
                    while b"\n" in buffer:
                        raw, buffer = buffer.split(b"\n", 1)
                        self._record(raw, session)
                    if response.end_body:
                        if buffer.strip():
                            self._record(buffer, session)
                        break
            except Exception:
                # A notification failure never resubmits work. The history deadline remains active.
                pass
            finally:
                with self._lock:
                    if self._subscription is connection:
                        self._subscription = None
                if connection:
                    connection.close()
                if accepted and self._current(session):
                    self._changed()
            if self._stopped.wait(5):
                return

    def _record(self, raw, session):
        try:
            record = json.loads(raw)
        except (ValueError, UnicodeError):
            return
        if not isinstance(record, dict):
            return
        payload = record.get("payload")
        if not isinstance(payload, dict) or payload.get("session_id") != session:
            return
        event = record.get("event")
        if event in {"delta.message_start", "delta.message_done", "message.assistant", "sessions.updated"}:
            print("[cf-events] received " + event, flush=True)
            self._changed()

    def history_snapshot(self, session, limit=40, fresh=False):
        self._watch(session)
        with self._lock:
            revision = self._revision
            cached = (self._snapshot is not None and self._snapshot_revision == revision
                      and self._snapshot_limit >= limit and time.monotonic() - self._snapshot_at < 15)
            snapshot = self._snapshot
        if cached and not fresh:
            return snapshot
        result = self._client.call_json("chat.history", body={"session_id": session, "limit": limit})
        if not isinstance(result, dict) or not isinstance(result.get("chat_events"), list):
            raise ValueError("Invalid history snapshot")
        events = sorted(result["chat_events"], key=lambda row: row["seq"])
        reason = "preflight" if fresh else "event" if revision != self._snapshot_revision else "reconcile"
        print("[cf-events] history read reason=" + reason, flush=True)
        with self._lock:
            self._snapshot = events
            self._snapshot_revision = revision
            self._snapshot_at = time.monotonic()
            self._snapshot_limit = limit
        return events

    def wait_for_update(self, timeout):
        self._wake.wait(timeout)
        self._wake.clear()

    def close(self):
        self._stopped.set()
        self._wake.set()
        with self._lock:
            connection = self._subscription
        if connection:
            connection.close()
        self._client.close()
