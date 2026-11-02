# Meridian Recorder for Windows x64

The first-use download served by Meridian is `public/recorder-tools/MeridianRecorderSetup.exe`. Run it on the **sensor computer**. The installer verifies pinned downloads, installs a private CPython runtime and the existing acquisition agent under the current user's LocalAppData, tests all driver imports, then registers the per-user `meridian-recorder:` URL handler. It does not require a system Python or administrator access. The executable is unsigned. Do not bypass organizational installation policy; review and sign it for managed distribution.

The instructor sends the **subject invitation** once, from Recording setup. On the subject PC, open it and confirm **Pair this subject computer** in the browser. After installation, return to the **subject display**, select **Connect recorder**, and confirm the displayed server and session in Windows. Use that same subject browser profile for future studies; it receives the next assignment automatically without a new link. A second recorder cannot start while the first is active. End the session normally; check the manifest in Recording review. Files and the recorder log are stored in **Documents/Meridian recordings**. Two-PC operation requires a shared HTTPS portal address, not localhost.

## Rebuild and verify

On Windows x64 with Python 3, internet access and the .NET Framework C# compiler:
```
python acquisition_agent/windows/build.py --verify
```
The Windows build embeds only the agent source ZIP and pinned download manifest. Verification stages the exact runtime in a temporary folder, imports the camera, audio, serial, and WebSocket packages, and exits without accessing sensors or registering any handler. Use `--refresh-lock` only for an intentional dependency update; review the official URLs and digests before distributing. The public executable must be rebuilt when the agent changes.

Pairing tickets are high-entropy, hashed at rest, single-use, replace any older ticket for the session, and expire after five minutes. Only an authorized instructor can issue one. Long-lived agent credentials are passed to the child process through its environment, not the URL or process arguments.
