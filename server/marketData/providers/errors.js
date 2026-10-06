export class ProviderError extends Error {
  constructor(message, { status, code, auth = false, rateLimited = false } = {}) {
    super(message); this.name = 'ProviderError'; this.status = status; this.code = code; this.auth = auth; this.rateLimited = rateLimited;
  }
}
