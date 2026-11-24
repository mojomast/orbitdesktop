import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { BUNDLEBEES_WORKER_RECIPE } from './host-recipes.mjs';

// Pin the actual standalone client, not the host recipe's placeholder OCI
// reference. Changing the client requires reviewing and updating this pin.
export const CLIENT_SHA256 = '6a2739e5569083280c2398050e8849db33c9e3c67e7be4884e8af1a5734e97d4';
export const clientSource = new URL('../scripts/worker-join/client.mjs', import.meta.url);
export function verifiedClientBytes(file = clientSource) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > 64 * 1024) throw Error('unsafe_client_file');
    const bytes = Buffer.alloc(st.size + 1);
    let off = 0;
    while (off < bytes.length) {
      const n = fs.readSync(fd,bytes,off,bytes.length-off,null);
      if (!n) break;
      off += n;
    }
    const data = bytes.subarray(0,off);
    if (off !== st.size || createHash('sha256').update(data).digest('hex') !== CLIENT_SHA256) throw Error('client_digest_mismatch');
    return data;
  } finally { fs.closeSync(fd); }
}
export function workerInstallDryRun() {
  const data = verifiedClientBytes();
  return { recipe: BUNDLEBEES_WORKER_RECIPE.id, artifact: 'worker-join/client.mjs', bytes: data.length, sha256: CLIENT_SHA256,
    image: null, nativeInstall: 'not_run', sourceVerification: 'matched' };
}
