/** Base class: callers can tell expected source problems from programming bugs. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly kind: "unavailable" | "rate_limited" | "auth" | "not_found" | "bad_response",
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
