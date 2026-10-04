// Upload a big file (over wrangler's 300 MiB limit) to an R2 bucket using multipart upload.
//
//   npm i --no-save @aws-sdk/client-s3 @aws-sdk/lib-storage     (once, in this folder)
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//     node upload-big.mjs <file> <bucket> <object-key>
//
// Create the access key in the dashboard: R2 → Manage API tokens → Create API token →
// "Object Read & Write", limited to the bucket. Set the three variables in your own terminal;
// never paste them into a chat or commit them.

import { createReadStream, statSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const [file, Bucket, Key] = process.argv.slice(2);
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
if (!file || !Bucket || !Key || !R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('Usage: R2_ACCOUNT_ID=.. R2_ACCESS_KEY_ID=.. R2_SECRET_ACCESS_KEY=.. node upload-big.mjs <file> <bucket> <key>');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const total = statSync(file).size;
const upload = new Upload({
  client,
  params: { Bucket, Key, Body: createReadStream(file), ContentType: 'application/zip' },
  partSize: 64 * 1024 * 1024,
  queueSize: 4,
});
upload.on('httpUploadProgress', ({ loaded }) => {
  if (loaded) process.stdout.write(`\r${Key}: ${Math.round((loaded / total) * 100)}%`);
});
await upload.done();
console.log(`\nUploaded ${Key} (${(total / 1048576).toFixed(0)} MiB) to ${Bucket}`);
