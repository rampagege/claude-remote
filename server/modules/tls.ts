import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

interface TlsFiles {
  key: string;
  cert: string;
}

const CERTS_DIR = path.resolve(process.cwd(), '.certs');
const KEY_PATH = path.join(CERTS_DIR, 'server.key');
const CERT_PATH = path.join(CERTS_DIR, 'server.crt');

/**
 * Get TLS key/cert. Priority:
 * 1. Custom paths from env (TLS_KEY / TLS_CERT)
 * 2. Cached self-signed certs in .certs/
 * 3. Generate new self-signed certs
 */
export async function getTlsOptions(log: Logger): Promise<TlsFiles> {
  // 1. Custom cert files
  if (process.env.TLS_KEY && process.env.TLS_CERT) {
    log.info('Using custom TLS certificates');
    return {
      key: readFileSync(process.env.TLS_KEY, 'utf-8'),
      cert: readFileSync(process.env.TLS_CERT, 'utf-8'),
    };
  }

  // 2. Cached self-signed
  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) {
    log.info('Using cached self-signed certificate from .certs/');
    return {
      key: readFileSync(KEY_PATH, 'utf-8'),
      cert: readFileSync(CERT_PATH, 'utf-8'),
    };
  }

  // 3. Generate new self-signed
  log.info('Generating self-signed certificate…');
  const selfsigned = await import('selfsigned');

  const attrs = [{ name: 'commonName', value: 'TmuxFly' }];
  const notBeforeDate = new Date();
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 1);

  const pems = await selfsigned.generate(attrs, {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '0.0.0.0' },
        ],
      },
    ],
  });

  mkdirSync(CERTS_DIR, { recursive: true });
  writeFileSync(KEY_PATH, pems.private, { mode: 0o600 });
  writeFileSync(CERT_PATH, pems.cert, { mode: 0o644 });

  log.info('Self-signed certificate saved to .certs/');
  log.info('On first visit, accept the browser security warning');

  return { key: pems.private, cert: pems.cert };
}
