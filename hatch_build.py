"""Build the web app into the package, so every install serves /app.

Runs for wheels, sdists and editable installs. When needledb/server/static is
missing (a fresh git checkout) and Node.js is available, it runs `npm ci` and
`npm run build`. Without Node it warns and the install still succeeds: the API
works and /app explains how to build the app.

NEEDLEDB_REBUILD_UI=1 rebuilds even when a build exists (used for releases).
NEEDLEDB_REQUIRE_UI=1 turns a missing web app into an error (used for releases).
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class WebAppBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        root = Path(self.root)
        ui = root / "ui"
        index = root / "needledb" / "server" / "static" / "index.html"
        rebuild = os.environ.get("NEEDLEDB_REBUILD_UI") == "1"

        if index.exists() and not rebuild:
            return
        npm = shutil.which("npm")
        if npm and (ui / "package.json").exists():
            self.app.display_info("Building the NeedleDB web app")
            install = "ci" if (ui / "package-lock.json").exists() else "install"
            try:
                subprocess.run([npm, install, "--no-audit", "--no-fund"], cwd=ui, check=True)
                subprocess.run([npm, "run", "build"], cwd=ui, check=True)
            except (OSError, subprocess.CalledProcessError) as exc:
                self._missing(f"building the web app failed ({exc})")
                return
        if not index.exists():
            self._missing("the web app isn't built and Node.js 20.19+ isn't available")

    def _missing(self, reason: str) -> None:
        message = f"{reason}. The API works; /app will show how to build the app."
        if os.environ.get("NEEDLEDB_REQUIRE_UI") == "1":
            raise RuntimeError(message)
        self.app.display_warning(message)
