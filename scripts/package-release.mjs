#!/usr/bin/env node
/**
 * Zero-dependency Cross-Platform Release ZIP Packager.
 * Produces:
 *   dist/context-viewer-v<version>.zip
 *   dist/context-viewer-v<version>.zip.sha256
 *
 * Inside the ZIP, files sit under `context-viewer/` so users who unzip it can:
 *   1) Run `agy plugin install ./context-viewer`
 *   2) Or run `./context-viewer/install.sh` (macOS/Linux) / `.\context-viewer\install.ps1` (Windows)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Standard CRC-32 lookup table
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // Deterministic DOS timestamp (2026-01-01 00:00:00)
  const dosTime = 0x0000;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.zipPath, 'utf-8');
    const rawData = entry.data;
    const crc = crc32(rawData);
    const deflated = deflateRawSync(rawData, { level: 9 });
    const useDeflate = deflated.length < rawData.length;
    const compData = useDeflate ? deflated : rawData;
    const method = useDeflate ? 8 : 0;

    // Local File Header (30 bytes + name)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);        // version needed 2.0
    lfh.writeUInt16LE(0x0800, 6);    // UTF-8 flag
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compData.length, 18);
    lfh.writeUInt32LE(rawData.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, compData);

    // Central Directory Header (46 bytes + name)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4); // UNIX creator (3) + version 2.0
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compData.length, 20);
    cdh.writeUInt32LE(rawData.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    const unixMode = entry.executable ? 0o100755 : 0o100644;
    cdh.writeUInt32LE((unixMode << 16) >>> 0, 38);
    cdh.writeUInt32LE(offset, 42);

    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compData.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf-8'));
  const version = manifest.version;
  const prefix = 'context-viewer';

  // Explicit curated manifest of distributable files (guarantees zero junk/secrets)
  const relFiles = [
    ['plugin.json', false],
    ['README.md', false],
    ['README_EN.md', false],
    ['LICENSE', false],
    ['install.sh', true],
    ['install.ps1', false],
    ['assets/logo.svg', false],
    ['skills/context-viewer/SKILL.md', false],
    ['skills/context-viewer/scripts/status.mjs', true],
    ['sidecars/dashboard/sidecar.json', false],
    ['sidecars/dashboard/package.json', false],
    ['sidecars/dashboard/main.mjs', false],
    ['sidecars/dashboard/collector.mjs', false],
    ['sidecars/dashboard/pricing.mjs', false],
    ['sidecars/dashboard/float_window.mjs', true],
    ['sidecars/dashboard/native_float_macos.swift', false],
    ['sidecars/dashboard/cli.mjs', true],
    ['sidecars/dashboard/index.html', false],
    ['sidecars/dashboard/styles.css', false],
    ['sidecars/dashboard/app.js', false]
  ];

  const entries = relFiles.map(([rel, executable]) => {
    const abs = join(ROOT, rel);
    statSync(abs); // throws if missing
    return {
      zipPath: `${prefix}/${rel}`,
      data: readFileSync(abs),
      executable
    };
  });

  const distDir = join(ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });

  const zipName = `context-viewer-v${version}.zip`;
  const zipPath = join(distDir, zipName);
  const zipBuf = buildZipBuffer(entries);
  writeFileSync(zipPath, zipBuf);

  const sha256 = createHash('sha256').update(zipBuf).digest('hex');
  const shaPath = `${zipPath}.sha256`;
  writeFileSync(shaPath, `${sha256}  ${zipName}\n`, 'utf-8');

  console.log(`[package] 已生成发布包：${zipPath} (${(zipBuf.length / 1024).toFixed(1)} KB, ${entries.length} 个文件)`);
  console.log(`[package] SHA-256：${sha256}`);
}

main();
