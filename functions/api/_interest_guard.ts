// SQL predicate and fresh parameters for conditional writes by a leased sweep.
// Callers without a sweep keep their existing behavior.
export interface InterestWriteGuard {
  sql: string;
  args(): unknown[];
}
