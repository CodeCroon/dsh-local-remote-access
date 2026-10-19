import { registerHooks } from 'node:module';

import { resolve } from './dev-resolver.mjs';

registerHooks({ resolve });
