export enum TransformationResultAuditAction {
  SAVE = 'save',
  DOWNLOAD = 'download',
}

export enum TransformationResultAuditOutcome {
  SUCCESS = 'success',
  CONVERSION_FAILED = 'conversion_failed',
  SIZE_EXCEEDED = 'size_exceeded',
  STORAGE_FAILED = 'storage_failed',
  ATTACH_FAILED = 'attach_failed',
  HISTORY_UNAVAILABLE = 'history_unavailable',
  DENIED = 'denied',
  NOT_FOUND = 'not_found',
  EXPIRED = 'expired',
  UNAVAILABLE = 'unavailable',
  READ_FAILED = 'read_failed',
  UNAUTHENTICATED = 'unauthenticated',
  INVALID = 'invalid',
  RATE_LIMITED = 'rate_limited',
}
