#!/usr/bin/env python3
"""Launch the MCP module from any client working directory, without shell setup."""
from pathlib import Path
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if __name__ == '__main__':
    runpy.run_module('cf_mcp', run_name='__main__')
