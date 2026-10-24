import { S3Client } from "@aws-sdk/client-s3";

import { getR2StorageConfig } from "@/platform/config";

export function createR2Client() {
  const config = getR2StorageConfig();

  return new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    region: "auto",
  });
}
