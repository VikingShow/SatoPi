// User service with validation logic

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

const VALID_EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function validateUserEmail(email: string): boolean {
  if (!email || typeof email !== "string") {
    return false;
  }
  return VALID_EMAIL_REGEX.test(email);
}

export function validateUserAge(age: number): ValidationResult {
  if (age == null) {
    return { valid: false, message: "Age is required" };
  }
  // BUG: should reject age <= 0, but currently allows negative and zero
  return { valid: true };
}

export function validateUserName(name: string): ValidationResult {
  if (!name || name.trim().length === 0) {
    return { valid: false, message: "Name is required" };
  }
  if (name.trim().length < 2) {
    return { valid: false, message: "Name must be at least 2 characters" };
  }
  return { valid: true };
}
