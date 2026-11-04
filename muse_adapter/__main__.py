"""Local Muse channel CLI; run is the only command that opens a network connection."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sqlite3
import sys

from .config import load_config
from .store import Store


def parser():
    """Keep deployment wrappers and platform prompts on one explicit command contract."""
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument('--config')
    commands = root.add_subparsers(dest='command', required=True)
    for name in ('run', 'poll', 'queue', 'status'):
        commands.add_parser(name)
    for name in ('start', 'update', 'reply', 'cancelled', 'cancel', 'recover', 'results'):
        command = commands.add_parser(name)
        command.add_argument('--msgid', required=name != 'results')
        if name == 'start':
            command.add_argument('--run-id', required=True)
        if name in ('update', 'reply'):
            content = command.add_mutually_exclusive_group(required=True)
            content.add_argument('--text')
            content.add_argument('--text-file', type=Path)
        if name == 'reply':
            command.add_argument('--cancelled', action='store_true')
        if name == 'recover':
            command.add_argument('--confirm-no-execution', action='store_true')
    return root


def main(argv=None):
    """Emit sanitized failures, never upstream errors or private configuration values."""
    args = parser().parse_args(argv)
    store = None
    try:
        config = load_config(args.config)
        if args.command == 'run':
            from .transport import run
            asyncio.run(run(config))
            return 0
        store = Store(config.state_dir, config.room)
        if args.command == 'poll':
            result = store.poll()
        elif args.command == 'start':
            result = store.start(args.msgid, args.run_id)
        elif args.command in ('update', 'reply'):
            text = args.text_file.read_text(encoding='utf-8') if args.text_file else args.text
            result = store.enqueue(args.msgid, text, 'result' if args.command == 'reply' else 'progress',
                                   getattr(args, 'cancelled', False))
        elif args.command == 'cancelled':
            result = {'msgid': args.msgid, 'cancel_requested': bool(store.task(args.msgid)['cancel_requested'])}
        elif args.command == 'cancel':
            result = store.cancel(args.msgid)
        elif args.command == 'recover':
            result = store.recover(args.msgid, args.confirm_no_execution)
        elif args.command == 'results':
            result = {'results': store.results(args.msgid)}
        elif args.command == 'queue':
            result = {'tasks': store.queue()}
        else:
            result = {'transport': store.transport(), 'tasks': store.queue()}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except KeyboardInterrupt:
        return 0
    except (OSError, ValueError, sqlite3.Error, RuntimeError, ImportError, TypeError, KeyError):
        print(json.dumps({'error': 'operation_failed', 'action': 'check_config_task_ownership_and_private_state'}), file=sys.stderr)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == '__main__':
    raise SystemExit(main())
