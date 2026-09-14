"""`needledb serve`, `needledb keys` and `needledb version`."""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

from . import __version__

_LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def _serve(args) -> int:
    import uvicorn

    from .server.app import create_app

    keys_env = args.api_key or os.environ.get("NEEDLEDB_API_KEY", "")
    keys = [k.strip() for k in keys_env.split(",") if k.strip()]
    no_auth = args.no_auth or os.environ.get("NEEDLEDB_ALLOW_NO_AUTH") == "1"
    if no_auth and args.host not in _LOOPBACK:
        print(f"needledb: refusing to serve without auth on {args.host}. Anyone who can reach that address "
              "could read and delete every index. Bind to 127.0.0.1, or set NEEDLEDB_API_KEY.", file=sys.stderr)
        return 2
    if bool(args.tls_cert) != bool(args.tls_key):
        print("needledb: --tls-cert and --tls-key go together", file=sys.stderr)
        return 2
    if not no_auth and args.host not in _LOOPBACK and not args.tls_cert and not args.trust_proxy:
        print(f"warning: serving on {args.host} over plain HTTP. Put NeedleDB behind a TLS proxy "
              "(and pass --trust-proxy) or use --tls-cert/--tls-key, or API keys travel in the clear.",
              file=sys.stderr)
    try:
        app = create_app(args.data, api_keys=keys, allow_no_auth=no_auth, trust_proxy=args.trust_proxy or None)
    except RuntimeError as exc:
        print(f"needledb: {exc}", file=sys.stderr)
        return 2
    scheme = "https" if args.tls_cert else "http"
    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    base = f"{scheme}://{shown}:{args.port}"
    print(f"NeedleDB {__version__}  ·  data {os.path.abspath(args.data)}  ·  "
          f"auth {'off (localhost only)' if no_auth else 'on'}\n"
          f"  App   {base}/app/\n  API   {base}\n  Docs  {base}/docs", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level, access_log=False,
                ssl_certfile=args.tls_cert, ssl_keyfile=args.tls_key)
    return 0


def _keys(args) -> int:
    from .errors import NeedleError
    from .server.auth import KeyStore

    store = KeyStore(Path(args.data) / "_system", [])
    try:
        if args.keys_command == "create":
            info, key = store.create_key(args.name, args.role, args.index or None)
            print(f"Created {info['role']} key “{info['name']}” ({info['id']})"
                  + (f" for {', '.join(info['indexes'])}" if info["indexes"] else "")
                  + f".\n\n  {key}\n\nStore it now — it can't be shown again.")
        elif args.keys_command == "list":
            for k in store.list_keys():
                if not k["managed"]:
                    continue
                created = datetime.fromtimestamp(k["createdAt"]).strftime("%Y-%m-%d")
                scope = ", ".join(k["indexes"]) if k["indexes"] else "all indexes"
                print(f"{k['id']}  {k['prefix']}…  {k['role']:<5}  {scope:<24}  {created}  {k['name']}")
        elif args.keys_command == "revoke":
            store.revoke_key(args.id)
            print(f"Revoked {args.id}.")
    except NeedleError as exc:
        print(f"needledb: {exc.message}", file=sys.stderr)
        return 2
    finally:
        store.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="needledb", description="A self-hostable vector database.")
    sub = parser.add_subparsers(dest="command", required=True)
    data_default = os.environ.get("NEEDLEDB_DATA", "./data")

    serve = sub.add_parser("serve", help="run the API server and web app")
    serve.add_argument("--data", default=data_default, help="data directory (default: ./data, or NEEDLEDB_DATA)")
    serve.add_argument("--host", default=os.environ.get("NEEDLEDB_HOST", "127.0.0.1"))
    serve.add_argument("--port", type=int, default=int(os.environ.get("NEEDLEDB_PORT", "8080")))
    serve.add_argument("--api-key", help="admin API key (default: NEEDLEDB_API_KEY, comma-separated)")
    serve.add_argument("--no-auth", action="store_true", help="accept requests without a key (localhost only)")
    serve.add_argument("--tls-cert", help="serve HTTPS with this certificate (PEM)")
    serve.add_argument("--tls-key", help="private key for --tls-cert (PEM)")
    serve.add_argument("--trust-proxy", action="store_true",
                       help="trust X-Forwarded-For/Proto/Host from a reverse proxy (NEEDLEDB_TRUST_PROXY=1)")
    serve.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])

    keys = sub.add_parser("keys", help="create, list and revoke API keys")
    data_option = argparse.ArgumentParser(add_help=False)
    data_option.add_argument("--data", default=data_default, help="data directory (default: ./data, or NEEDLEDB_DATA)")
    keys_sub = keys.add_subparsers(dest="keys_command", required=True)
    create = keys_sub.add_parser("create", parents=[data_option], help="create a key and print it once")
    create.add_argument("--name", required=True)
    create.add_argument("--role", choices=["read", "write", "admin"], default="read")
    create.add_argument("--index", action="append", help="limit the key to this index (repeatable)")
    keys_sub.add_parser("list", parents=[data_option], help="list active keys")
    revoke = keys_sub.add_parser("revoke", parents=[data_option], help="revoke a key by id")
    revoke.add_argument("id")

    sub.add_parser("version", help="print the version")
    args = parser.parse_args(argv)

    if args.command == "version":
        print(__version__)
        return 0
    if args.command == "keys":
        return _keys(args)
    return _serve(args)


if __name__ == "__main__":
    raise SystemExit(main())
