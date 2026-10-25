class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Thrown by validators; carries per-field messages so forms can re-render with them. */
class ValidationError extends HttpError {
  constructor(errors, message = 'Please check the highlighted fields.') {
    super(422, message, errors);
    this.errors = errors;
  }
}

module.exports = { HttpError, ValidationError };
