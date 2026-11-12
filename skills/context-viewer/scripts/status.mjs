#!/usr/bin/env node
/**
 * Portable entry point inside `skills/context-viewer/scripts/status.mjs`.
 * Resolves `../../../sidecars/dashboard/cli.mjs` relative to `import.meta.url`
 * so the skill works on macOS, Linux, and Windows regardless of the plugin's
 * installation directory name (`context-viewer`, `antigravity-context-viewer`, etc.).
 */

import '../../../sidecars/dashboard/cli.mjs';
