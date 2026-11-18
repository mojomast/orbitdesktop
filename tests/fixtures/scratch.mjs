import { tmpdir } from 'node:os';
import { join } from 'node:path';

// npm test supplies a fresh private TMPDIR. A directly invoked test also
// works using the platform temporary directory and its own mkdtemp prefix.
export const scratchPath = (...parts) => join(tmpdir(), ...parts);
