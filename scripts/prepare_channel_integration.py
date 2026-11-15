#!/usr/bin/env python3
"""Prepare a reviewable, minimal transport patch; do not restart services or change modes."""
import argparse
import hashlib
from pathlib import Path

MARKER='# CF_MUSE_RELAY_TRANSPORT_V1'
HOOK='''    # CF_MUSE_RELAY_TRANSPORT_V1
    if os.environ.get("MUSE_CF_RELAY_CONFIG"):
        _ensure_muse_cli_path()
        source = os.environ.get("MUSE_CF_RELAY_SOURCE")
        if not source:
            raise ValueError("MUSE_CF_RELAY_SOURCE is required when CF relay is enabled")
        spec = importlib.util.spec_from_file_location("_channel_cf_relay", source)
        if spec is None or spec.loader is None:
            raise ImportError("CF relay transport unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.connect(os.environ["MUSE_CF_RELAY_CONFIG"])
'''
def patch_source(text):
    if MARKER in text:return text
    lines=text.splitlines(keepends=True)
    start=next((i for i,line in enumerate(lines)if line.startswith('def connect():')),None)
    if start is None:raise ValueError('Expected native bridge connect boundary not found')
    # Existing transport uses a one-line docstring; reject unexpected format instead of guessing.
    if '"""'not in lines[start+1]or lines[start+1].count('"""')!=2:raise ValueError('Unexpected connect docstring')
    return ''.join(lines[:start+2])+HOOK+''.join(lines[start+2:])
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bridge',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();original=args.bridge.read_text();updated=patch_source(original)
    compile(updated,str(args.bridge),'exec')
    if args.output.exists():raise FileExistsError('Output already exists')
    args.output.write_text(updated)
    print('Prepared source; original SHA256:',hashlib.sha256(original.encode()).hexdigest())
if __name__=='__main__':main()
