/** Input the person can correct. `field` names the form field when there is one. */
export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** The record is not in a state that allows this action, for example shipping a quote. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}
