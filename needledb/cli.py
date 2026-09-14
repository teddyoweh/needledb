"""`needledb serve` and `needledb version`."""
from __future__ import annotations

import argparse
import os
import sys

from . import __version__

_LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="needledb", description="A self-hostable vector database.")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the API server and dashboard")
    serve.add_argument("--data", default=os.environ.get("NEEDLEDB_DATA", "./data"),
                       help="data directory (default: ./data, or NEEDLEDB_DATA)")
    serve.add_argument("--host", default=os.environ.get("NEEDLEDB_HOST", "127.0.0.1"))
    serve.add_argument("--port", type=int, default=int(os.environ.get("NEEDLEDB_PORT", "8080")))
    serve.add_argument("--api-key", help="accepted API key (default: NEEDLEDB_API_KEY, comma-separated)")
    serve.add_argument("--no-auth", action="store_true", help="accept requests without a key")
    serve.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])

    sub.add_parser("version", help="print the version")
    args = parser.parse_args(argv)

    if args.command == "version":
        print(__version__)
        return 0

    import uvicorn

    from .server.app import create_app

    keys_env = args.api_key or os.environ.get("NEEDLEDB_API_KEY", "")
    keys = [k.strip() for k in keys_env.split(",") if k.strip()]
    no_auth = args.no_auth or os.environ.get("NEEDLEDB_ALLOW_NO_AUTH") == "1"
    if no_auth and not keys and args.host not in _LOOPBACK:
        print(f"warning: serving without auth on {args.host} — anyone who can reach this port "
              "can read and delete your data", file=sys.stderr)
    try:
        app = create_app(args.data, api_keys=keys, allow_no_auth=no_auth)
    except RuntimeError as exc:
        print(f"needledb: {exc}", file=sys.stderr)
        return 2
    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print(f"NeedleDB {__version__}  ·  data {os.path.abspath(args.data)}  ·  "
          f"auth {'on' if keys else 'off'}\n  API        http://{shown}:{args.port}\n"
          f"  Dashboard  http://{shown}:{args.port}/ui/\n  Docs       http://{shown}:{args.port}/docs",
          flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
