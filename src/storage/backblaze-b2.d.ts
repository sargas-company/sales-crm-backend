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
    getDownloadAuthorization(args: {
      bucketId: string;
      fileNamePrefix: string;
      validDurationInSeconds: number;
    }): Promise<B2Response<{ authorizationToken: string; bucketId: string; fileNamePrefix: string }>>;
  }

  export = B2;
}
