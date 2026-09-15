"""NeedleDB — a self-hostable vector database with a Pinecone-shaped API.

    from needledb import NeedleDB, AsyncNeedleDB, NeedleDBLocal

`NeedleDB` talks to a running server and `AsyncNeedleDB` does the same for asyncio code;
`NeedleDBLocal` runs the engine inside your process. All three expose the same `Index` methods.
"""

__version__ = "0.1.0"
__all__ = ["AsyncNeedleDB", "NeedleDB", "NeedleDBLocal", "__version__"]


def __getattr__(name: str):
    # Imported lazily so `import needledb` stays cheap and the server does not pull
    # in the HTTP client (or the client the server).
    if name == "NeedleDB":
        from .client.http import NeedleDB
        return NeedleDB
    if name == "AsyncNeedleDB":
        from .client.aio import AsyncNeedleDB
        return AsyncNeedleDB
    if name == "NeedleDBLocal":
        from .client.local import NeedleDBLocal
        return NeedleDBLocal
    raise AttributeError(f"module 'needledb' has no attribute {name!r}")
