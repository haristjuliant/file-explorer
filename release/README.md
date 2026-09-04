# Release artefacts — Finder 0.1.0

| File | What it is |
|---|---|
| `Finder_0.1.0_x64-setup.exe` | Installer. Per-user, no administrator rights. Adds a Start Menu entry and an uninstall entry. |
| `file-manager.exe` | The application on its own. Copy it anywhere and run it; nothing is installed. |

Windows 10 or 11, 64-bit.

Neither file is code-signed, so SmartScreen shows *"Windows protected your PC"*
on first run. Click **More info** → **Run anyway**.

Rebuild both with `npm run tauri build` from the repository root.
