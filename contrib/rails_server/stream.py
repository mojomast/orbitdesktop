"""Selector-bound invalidations. No long-lived SQLite transaction or event queue."""
import base64
import hashlib
import json
import re
import time


class ResetRequired(Exception):
    pass


def head(reader):
    return reader.query('SELECT COALESCE(MAX(ingest_seq),0) AS n FROM event_rows')[0]['n']


def cursor(ledger_uuid, selector, pos):
    digest = hashlib.sha256((selector['kind'] + ':' + selector['id']).encode()).hexdigest()
    encoded = json.dumps([ledger_uuid, digest, pos], separators=(',', ':')).encode()
    return base64.urlsafe_b64encode(encoded).rstrip(b'=').decode()


def resume(token, uid, selector, upper):
    if token is None:
        return upper
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,512}', token):
        raise ResetRequired
    try:
        pos = json.loads(base64.urlsafe_b64decode(token + '==='))[2]
    except (ValueError, IndexError, TypeError, KeyError, RecursionError):
        raise ResetRequired from None
    if type(pos) is not int or not 0 <= pos <= upper or cursor(uid, selector, pos) != token:
        raise ResetRequired
    return pos


def changed(reader, selector, lo, hi):
    """Check a bounded interval of local arrivals (including origin-import receipts).

    Imported rows have no local ingest_seq in the R02 schema. Their enclosing
    local source.checkpoint identifies the chain and committed origin interval.
    A page of matches produces one invalidation, never a synthetic mark.
    """
    kind = selector['kind']
    key = '$.event_id' if kind == 'event' else '$.scope.' + kind + '_id'
    rows = reader.query('''SELECT 1 FROM event_rows AS e
        WHERE ingest_seq > ? AND ingest_seq <= ? AND (
          json_extract(e.envelope_json, ?) = ? OR (
            e.kind = 'source.checkpoint' AND json_extract(e.envelope_json, '$.source.adapter')='rails_import'
            AND EXISTS (SELECT 1 FROM imported_origin_rows AS o
              WHERE o.chain_id=json_extract(e.envelope_json, '$.source.instance')
                AND o.seq BETWEEN coalesce(json_extract(e.envelope_json, '$.payload.range_start'),
                                           json_extract(e.envelope_json, '$.payload.range[0]'))
                              AND coalesce(json_extract(e.envelope_json, '$.payload.range_end'),
                                           json_extract(e.envelope_json, '$.payload.range[1]'))
                AND json_extract(o.origin_bytes, ?) = ?))) LIMIT 1''',
        (lo, hi, key, selector['id'], key, selector['id']))
    return bool(rows)


def send(handler, selector, last):
    server = handler.server
    with server.reader() as reader:
        uid = reader.ledger_uuid
        pos = resume(last, uid, selector, head(reader))

    handler.start_response(200, 'text/event-stream', {'X-Accel-Buffering': 'no'})

    def frame(name):
        stream_id = cursor(uid, selector, pos)
        handler.wfile.write(f'id: {stream_id}\nevent: {name}\ndata: {{}}\n\n'.encode('ascii'))
        handler.wfile.flush()

    frame('ready')
    now = time.monotonic()
    heartbeat = now + 15
    expires = now + server.stream_ttl
    while not server.stopping.is_set() and time.monotonic() < expires:
        if not handler.authorized():
            break
        with server.reader() as reader:
            high = head(reader)
            if reader.ledger_uuid != uid or high < pos:
                break  # On reconnect the old cursor gets a 409.
            end = min(high, pos + 64)
            invalidate = end > pos and changed(reader, selector, pos, end)
        pos = end
        if invalidate:
            frame('invalidate')
        if time.monotonic() >= heartbeat:
            handler.wfile.write(b': heartbeat\n\n')
            handler.wfile.flush()
            heartbeat = time.monotonic() + 15
        server.stopping.wait(.01 if pos < high else server.poll_interval)
