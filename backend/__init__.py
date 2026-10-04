"""Hermes Kanban dependency graph plugin.

The runtime capability is exposed through dashboard/plugin_api.py. This
module intentionally registers no agent tools or hooks.
"""


def register(ctx):
    """Satisfy the Hermes plugin contract without registering agent tools."""
    return None
