/**
 * What the history contract calls the outcome of an attempt.
 *
 * Deliberately not `ConversionOutcome`, which persists `failure`: the API word
 * is `error`, and it is the one the `errorCode` field is named after. The two
 * are translated at the query boundary rather than kept in step by convention,
 * so renaming either never silently changes the other.
 */
export enum TransformationHistoryStatus {
  SUCCESS = 'success',
  ERROR = 'error',
}
