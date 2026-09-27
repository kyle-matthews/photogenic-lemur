import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

export const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export const keys = {
  original: (id, contentType) => `originals/${id}.${EXTENSIONS[contentType] ?? 'bin'}`,
  preview: (id) => `previews/${id}.jpg`,
  thumb: (id) => `thumbs/${id}.jpg`,
};

// Photos go to Tigris (or any S3-compatible bucket) when BUCKET_NAME is set, and otherwise to a
// local folder so the app runs locally with no setup. getObject resolves to
// { stream, contentType, contentLength }, or null when there's no such object.
const localFolder = path.join(config.dataDir, 'files');
export const location = config.bucket ? `bucket "${config.bucket}"` : localFolder;
export const { putObject, getObject, deleteObjects } = config.bucket ? bucketStorage() : folderStorage(localFolder);

function bucketStorage() {
  // Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, which `fly storage create` sets.
  const s3 = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: config.s3.forcePathStyle,
    // Recent SDK versions add CRC32 checksums to every request by default, which not every
    // S3-compatible store accepts. Only send them when an operation actually requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = config.bucket;

  return {
    async putObject(key, body, { contentType, contentLength, signal } = {}) {
      const command = new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: contentLength });
      await s3.send(command, { abortSignal: signal });
    },

    async getObject(key) {
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
        return { stream: object.Body.transformToWebStream(), contentType: object.ContentType, contentLength: object.ContentLength };
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },

    async deleteObjects(keyList) {
      // One request per key: the batch DeleteObjects call needs a Content-MD5 header that
      // S3-compatible stores disagree about.
      await Promise.all(keyList.map((Key) => s3.send(new DeleteObjectCommand({ Bucket, Key }))));
    },
  };
}

function folderStorage(root) {
  const types = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));
  const file = (key) => path.join(root, key); // keys are built from server-generated UUIDs, never user input

  return {
    async putObject(key, body, { signal } = {}) {
      await mkdir(path.dirname(file(key)), { recursive: true });
      await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, createWriteStream(file(key)), { signal });
    },

    async getObject(key) {
      const info = await stat(file(key)).catch(() => null);
      if (!info) return null;
      return {
        stream: Readable.toWeb(createReadStream(file(key))),
        contentType: types[path.extname(key).slice(1)] ?? 'application/octet-stream',
        contentLength: info.size,
      };
    },

    async deleteObjects(keyList) {
      await Promise.all(keyList.map((key) => rm(file(key), { force: true })));
    },
  };
}
