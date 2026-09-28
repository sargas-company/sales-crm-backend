export enum StorageBucket {
  INVOICES = 'INVOICES',
  CLIENT_REQUESTS = 'CLIENT_REQUESTS',
  DB_DUMPS = 'DB_DUMPS',
}

export interface StorageUploadOptions {
  bucket: StorageBucket;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}

export interface StorageUploadResult {
  fileId: string;
  url: string;
}

export interface StoredFileMetadata {
  originalName: string;
  fileName: string;
  fileId: string;
  url: string;
  mimetype: string;
  size: number;
}

export interface IncomingFileData {
  originalName: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}
