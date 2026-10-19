/**
 * Dev-only: parse the bundle patch with the same loader dialect DSH uses, and
 * print what survived. The runtime composes this file itself; this script
 * exists so a wrong field or a mistyped expression fails here instead of at
 * boot.
 * @module @local/dsh-remote-access/tools/check-patch
 */
import { fileURLToPath } from 'node:url';

import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';

const file = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
const patches = loadOverlayPatches('dsh', file);
process.stdout.write(`${JSON.stringify(patches, null, 2)}\n`);
