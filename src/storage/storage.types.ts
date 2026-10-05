export enum StorageBucket {
  INVOICES = 'INVOICES',
  CLIENT_REQUESTS = 'CLIENT_REQUESTS',
  DB_DUMPS = 'DB_DUMPS',
  PORTFOLIO = 'PORTFOLIO',
  AVATARS = 'AVATARS',
}

export interface StorageUploadOptions {
  bucket: StorageBucket;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}

/**
 * Upload result exposed to the rest of the app. The authoritative
 * identifier for a stored object is its `key` (= B2 fileName). A
 * permanent public URL is intentionally NOT returned — buckets are
 * private, so URLs have to be signed on demand, after an authorized
 * read.
 */
export interface StorageUploadResult {
  fileId: string;
  key: string;
}

export interface StoredFileMetadata {
  originalName: string;
  fileName: string;
  fileId: string;
  mimetype: string;
  size: number;
  /** @deprecated — legacy rows only; new rows store `fileName` (key) only. */
  url?: string;
}

export interface IncomingFileData {
  originalName: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}
