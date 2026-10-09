# Native dependency distribution status

This candidate is NOT cleared for external distribution.

Installed sharp: 0.35.5 (Apache-2.0). Installed Windows native package:
@img/sharp-win32-x64 0.35.5, metadata license Apache-2.0 AND LGPL-3.0-or-later.
The included native-versions.json identifies libvips 8.18.7 and its bundled components.
Local package LICENSE files are retained alongside each dependency; sharp's actual
local LICENSE is also copied here. These files do not establish that all native
component distribution obligations have been fulfilled.

Official notices inspected via supported read-only web tool:
https://raw.githubusercontent.com/lovell/sharp-libvips/v1.3.4/THIRD-PARTY-NOTICES.md
Official Windows packaging source:
https://raw.githubusercontent.com/lovell/sharp-libvips/v1.3.4/build/win.sh
Official native build release:
https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.7

Notices identify LGPL, MPL and other component licenses. Full applicable component
license/copyright texts, matching corresponding-source/build materials and the
required replacement/relinking arrangements have not been verified for these exact
DLLs. A license-name table is not a substitute for that verification.

Attempt to download the official NOTICE with normal Windows HTTPS failed with
TLS authentication failure. No certificate checks, credentials or security settings
were bypassed. The referenced NOTICE is not falsely represented as included.

Do not distribute this binary candidate until the remaining materials and obligations
are checked. Real-ESRGAN is not bundled or installed by this package.

The portable candidate additionally includes the official Node.js Windows runtime,
with its release archive verified against the official SHA-256 list and LICENSE retained.
It also includes the existing Windows WinGet Gyan.FFmpeg.Essentials 8.1.1 tools,
with package LICENSE, README, documentation, binary hash and version retained.
The latter is a GPL build; its complete matching source and dependency/build materials
have not yet been verified. tools/provenance.json records the exact preparation sources.
Bundling these tools removes installation requirements but does not clear this candidate
for external distribution.
