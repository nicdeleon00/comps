// Precompress build output so the server can send .br/.gz directly.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dist = new URL('../dist/', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
let saved = 0;
for (const file of walk(dist)) {
  if (!/\.(js|css|html|svg|json|webmanifest)$/.test(file)) continue;
  const buf = readFileSync(file);
  if (buf.length < 512) continue;
  const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(file + '.br', br);
  writeFileSync(file + '.gz', gzipSync(buf, { level: 9 }));
  saved += buf.length - br.length;
}
console.log(`precompressed (brotli saves ${(saved / 1024).toFixed(1)} KB)`);
