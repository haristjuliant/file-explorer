# Release artefacts — Finder 0.1.1

| File | What it is |
|---|---|
| `Finder_0.1.1_x64-setup.exe` | Installer. Per-user, no administrator rights. Adds a Start Menu entry and an uninstall entry. |
| `file-manager.exe` | The application on its own. Copy it anywhere and run it; nothing is installed. |

Windows 10 or 11, 64-bit.

Neither file is code-signed. Two different things follow from that, and they are
not the same severity:

- **SmartScreen** shows *"Windows protected your PC"* on first run. Click
  **More info** → **Run anyway**.
- **Smart App Control**, if it is enforced on the machine, refuses to run the
  file at all. There is no "run anyway" — it must be turned off in Windows
  Security, which is a one-way change on that machine.

Both go away only with an Authenticode certificate, which this project does not
have.

Rebuild both with `npm run tauri build` from the repository root.
