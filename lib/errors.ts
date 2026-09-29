export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor() {
    super('UNAUTHORIZED')
    this.name = 'UnauthorizedError'
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ApiError'
  }
}