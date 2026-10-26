declare module 'backblaze-b2' {
  interface B2Options {
    applicationKeyId: string;
    applicationKey: string;
  }

  interface B2Response<T> {
    status: number;
    data: T;
  }

  interface AuthorizeData {
    downloadUrl: string;
    recommendedPartSize: number;
    absoluteMinimumPartSize: number;
    authorizationToken: string;
  }

  interface UploadUrlData {
    uploadUrl: string;
    authorizationToken: string;
    bucketId: string;
  }

  interface UploadFileData {
    fileId: string;
    fileName: string;
    contentType: string;
    contentLength: number;
    contentSha1: string;
  }

  class B2 {
    constructor(options: B2Options);
    authorize(args?: object): Promise<B2Response<AuthorizeData>>;
    getUploadUrl(args: { bucketId: string }): Promise<B2Response<UploadUrlData>>;
    uploadFile(args: {
      uploadUrl: string;
      uploadAuthToken: string;
      fileName: string;
      data: Buffer;
      mime?: string;
      contentLength?: number;
      hash?: string;
      info?: Record<string, string>;
    }): Promise<B2Response<UploadFileData>>;
    deleteFileVersion(args: {
      fileId: string;
      fileName: string;
    }): Promise<B2Response<{ fileId: string; fileName: string }>>;
    listFileVersions(args: {
      bucketId: string;
      startFileName?: string;
      startFileId?: string;
      maxFileCount?: number;
      prefix?: string;
    }): Promise<B2Response<{ files: Array<{ fileId: string; fileName: string }>; nextFileName: string | null; nextFileId: string | null }>>;
    listFileNames(args: {
      bucketId: string;
      startFileName?: string;
      maxFileCount?: number;
      prefix?: string;
      delimiter?: string;
    }): Promise<
      B2Response<{
        files: Array<{
          fileId: string;
          fileName: string;
          contentType?: string;
          contentLength?: number;
        }>;
        nextFileName: string | null;
      }>
    >;
    downloadFileById(args: {
      fileId: string;
      responseType?: 'arraybuffer' | 'stream' | 'json';
    }): Promise<B2Response<ArrayBuffer | NodeJS.ReadableStream | unknown>>;
    downloadFileByName(args: {
      bucketName: string;
      fileName: string;
      responseType?: 'arraybuffer' | 'stream' | 'json';
    }): Promise<B2Response<ArrayBuffer | NodeJS.ReadableStream | unknown>>;
    listBuckets(args: {
      accountId: string;
    }): Promise<
      B2Response<{
        buckets: Array<{
          bucketId: string;
          bucketName: string;
          bucketType: string;
        }>;
      }>
    >;
    getDownloadAuthorization(args: {
      bucketId: string;
      fileNamePrefix: string;
      validDurationInSeconds: number;
    }): Promise<B2Response<{ authorizationToken: string; bucketId: string; fileNamePrefix: string }>>;

    /* ── Large-file multipart API ───────────────────────────────── */
    startLargeFile(args: {
      bucketId: string;
      fileName: string;
      contentType?: string;
      fileInfo?: Record<string, string>;
    }): Promise<
      B2Response<{
        fileId: string;
        fileName: string;
        contentType: string;
        bucketId: string;
      }>
    >;
    getUploadPartUrl(args: {
      fileId: string;
    }): Promise<
      B2Response<{
        fileId: string;
        uploadUrl: string;
        authorizationToken: string;
      }>
    >;
    uploadPart(args: {
      partNumber: number;
      uploadUrl: string;
      uploadAuthToken: string;
      data: Buffer;
      hash?: string;
    }): Promise<
      B2Response<{
        fileId: string;
        partNumber: number;
        contentLength: number;
        contentSha1: string;
      }>
    >;
    finishLargeFile(args: {
      fileId: string;
      partSha1Array: string[];
    }): Promise<
      B2Response<{
        fileId: string;
        fileName: string;
        contentType: string;
        contentLength: number;
      }>
    >;
    cancelLargeFile(args: {
      fileId: string;
    }): Promise<B2Response<{ fileId: string }>>;
    listParts(args: {
      fileId: string;
      startPartNumber?: number;
      maxPartCount?: number;
    }): Promise<
      B2Response<{
        parts: Array<{
          fileId: string;
          partNumber: number;
          contentLength: number;
          contentSha1: string;
        }>;
        nextPartNumber: number | null;
      }>
    >;
    listUnfinishedLargeFiles(args: {
      bucketId: string;
      startFileId?: string;
      maxFileCount?: number;
      namePrefix?: string;
    }): Promise<
      B2Response<{
        files: Array<{
          fileId: string;
          fileName: string;
          uploadTimestamp: number;
        }>;
        nextFileId: string | null;
      }>
    >;
  }

  export = B2;
}
