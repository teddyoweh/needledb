"""NeedleDB — a self-hostable vector database with a Pinecone-shaped API.

    from needledb import NeedleDB, NeedleDBLocal

`NeedleDB` talks to a running server; `NeedleDBLocal` runs the same engine inside
your process. Both expose the same `Index` methods.
"""

__version__ = "0.1.0"
__all__ = ["NeedleDB", "NeedleDBLocal", "__version__"]


def __getattr__(name: str):
    # Imported lazily so `import needledb` stays cheap and the server does not pull
    # in the HTTP client (or the client the server).
    if name == "NeedleDB":
        from .client.http import NeedleDB
        return NeedleDB
    if name == "NeedleDBLocal":
        from .client.local import NeedleDBLocal
        return NeedleDBLocal
    raise AttributeError(f"module 'needledb' has no attribute {name!r}")
