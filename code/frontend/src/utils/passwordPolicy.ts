// Mirrors backend/src/utils/password.ts. The backend is the real check; this
// only lets forms show the rules as the user types.
export function passwordChecks(password: string) {
  return {
    length: password.length >= 8,
    letter: /[a-zA-Z]/.test(password),
    digit: /[0-9]/.test(password),
  }
}

export function isPasswordValid(password: string): boolean {
  const checks = passwordChecks(password)
  return checks.length && checks.letter && checks.digit
}
