import { fileURLToPath } from 'node:url';

const production = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(process.env.PORT) || 8080,
  production,
  // The photo list (a SQLite database) lives here: on a Fly volume in production. Without a
  // bucket the photos are saved here too, which makes trying the app out locally zero-setup.
  dataDir: process.env.DATA_DIR || fileURLToPath(new URL('../data', import.meta.url)),
  bucket: process.env.BUCKET_NAME || '',
  s3: {
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    region: process.env.AWS_REGION || 'auto',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  },
  // Guests need this code (it's baked into the QR code) to see or add photos. Leave unset for an open album.
  guestCode: process.env.GUEST_CODE || '',
  // Visiting /?code=<ADMIN_CODE> lets you remove any photo. Leave unset to disable.
  adminCode: process.env.ADMIN_CODE || '',
  maxUploadBytes: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024,
};

if (production && !config.bucket) {
  console.error('BUCKET_NAME is missing. Run `fly storage create` so photos are stored in Tigris.');
  process.exit(1);
}
