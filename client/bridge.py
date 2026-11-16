"""Transport boundary for existing Muse channels: connect via the fixed CF relay."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys


def connect(config_path=None):
    """Read an owner-private relay config and prove a real RPC before returning it."""
    path=Path(config_path or os.environ.get('MUSE_CF_RELAY_CONFIG','~/.config/cf-muse-channel/relay.json')).expanduser()
    info=path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise ValueError('CF relay config must be owner-private')
    if info.st_size>16384:raise ValueError('CF relay config too large')
    try:
        data=json.loads(path.read_text())
        url,key=data['url'],data['key']
        if not isinstance(key,str)or not 32<=len(key)<=512 or any(c.isspace()for c in key):raise ValueError()
    except (ValueError,KeyError,TypeError):raise ValueError('Invalid CF relay config')from None
    # Import the sibling SDK adapter without changing the host project's import path.
    module_name='_cf_muse_relay_probe'
    module=sys.modules.get(module_name)
    if module is None:
        spec=importlib.util.spec_from_file_location(module_name,Path(__file__).with_name('probe.py'))
        if spec is None or spec.loader is None:raise ImportError('CF relay adapter unavailable')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);sys.modules[module_name]=module
    module.worker_origin(url)
    client=module.RelayGateway(url,key)
    try:
        result=client.call_json('sessions.list',timeout=15)
        if not isinstance(result,(dict,list)) or isinstance(result,dict)and(result.get('ok')is False or result.get('error')):
            raise ConnectionError('CF relay RPC check failed')
        if os.environ.get("MUSE_CF_EVENT_STREAM") == "1":
            spec = importlib.util.spec_from_file_location("_cf_muse_events", Path(__file__).with_name("events.py"))
            events = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(events)
            return events.EventGateway(client, lambda: module.RelayGateway(url, key))
        return client
    except Exception:
        client.close();raise ConnectionError('CF relay connection failed')from None
