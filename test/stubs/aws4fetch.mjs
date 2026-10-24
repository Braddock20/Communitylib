// Test-only stand-in used when the real package is not installed (offline sandbox).
export class AwsClient { constructor() { throw new Error('aws4fetch stub: inject env.__storage in tests'); } }
