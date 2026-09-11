/** AST for the supported SQL subset. Produced by the parser, consumed by the compiler. */

export type ComparisonOp = '=' | '<>' | '<' | '<=' | '>' | '>=';
export type LogicalOp = 'AND' | 'OR';

export type Expr =
  | { readonly kind: 'column'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: string | number; readonly isString: boolean }
  | { readonly kind: 'comparison'; readonly op: ComparisonOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'logical'; readonly op: LogicalOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'not'; readonly operand: Expr }
  | { readonly kind: 'like'; readonly left: Expr; readonly pattern: string; readonly negated: boolean; readonly caseInsensitive: boolean }
  | { readonly kind: 'in'; readonly left: Expr; readonly items: readonly Expr[]; readonly negated: boolean }
  | { readonly kind: 'between'; readonly left: Expr; readonly low: Expr; readonly high: Expr; readonly negated: boolean }
  | { readonly kind: 'isNull'; readonly left: Expr; readonly negated: boolean }
  | { readonly kind: 'matches'; readonly left: Expr; readonly pattern: string; readonly flags: string; readonly negated: boolean };

export interface OrderBy {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

export interface SelectStatement {
  /** null means SELECT * */
  readonly columns: readonly string[] | null;
  readonly where: Expr | null;
  readonly orderBy: OrderBy | null;
  readonly limit: number | null;
  readonly offset: number;
}

/** Syntax and semantic errors are values, not exceptions: the UI underlines `at`. */
export interface QueryError {
  readonly message: string;
  /** Character offset into the query text where the problem begins. */
  readonly at: number;
  readonly length: number;
}

export type ParseResult =
  | { readonly ok: true; readonly statement: SelectStatement }
  | { readonly ok: false; readonly error: QueryError };

/** Collect every column referenced anywhere in an expression, for semantic validation. */
export function collectColumns(expr: Expr | null, into: Set<string> = new Set()): Set<string> {
  if (!expr) {
    return into;
  }
  switch (expr.kind) {
    case 'column':
      into.add(expr.name);
      break;
    case 'literal':
      break;
    case 'comparison':
    case 'logical':
      collectColumns(expr.left, into);
      collectColumns(expr.right, into);
      break;
    case 'not':
      collectColumns(expr.operand, into);
      break;
    case 'like':
    case 'isNull':
    case 'matches':
      collectColumns(expr.left, into);
      break;
    case 'in':
      collectColumns(expr.left, into);
      for (const item of expr.items) {
        collectColumns(item, into);
      }
      break;
    case 'between':
      collectColumns(expr.left, into);
      collectColumns(expr.low, into);
      collectColumns(expr.high, into);
      break;
  }
  return into;
}

/**
 * Rough cost of evaluating an expression, used by the planner to order conjuncts.
 * Byte comparisons are nearly free; regexes are two orders of magnitude worse.
 */
export function estimateCost(expr: Expr): number {
  switch (expr.kind) {
    case 'column':
    case 'literal':
      return 0;
    case 'comparison':
      return expr.op === '=' ? 1 : 2;
    case 'isNull':
      return 1;
    case 'in':
      return 2 + expr.items.length;
    case 'between':
      return 4;
    case 'like':
      // A pattern anchored with a literal prefix is far cheaper than a leading wildcard.
      return expr.pattern.startsWith('%') ? 40 : 20;
    case 'matches':
      return 100;
    case 'not':
      return 1 + estimateCost(expr.operand);
    case 'logical':
      return estimateCost(expr.left) + estimateCost(expr.right);
  }
}

/**
 * Longest literal substring that every matching record must contain.
 *
 * When one exists, the executor can run Buffer.indexOf over a whole 4 MB block and skip it
 * entirely on a miss, without ever splitting it into records. On selective queries this is
 * the difference between 200 MB/s and 2 GB/s.
 */
export function requiredLiteral(expr: Expr | null): string | null {
  if (!expr) {
    return null;
  }
  switch (expr.kind) {
    case 'comparison':
      if (expr.op === '=' && expr.right.kind === 'literal' && expr.right.isString) {
        const value = String(expr.right.value);
        return value.length >= 3 ? value : null;
      }
      return null;
    case 'like': {
      if (expr.negated) {
        return null;
      }
      // Longest run between wildcards; that run must appear verbatim in the record.
      const parts = expr.pattern.split(/[%_]/).filter((part) => part.length >= 3);
      if (parts.length === 0) {
        return null;
      }
      return parts.reduce((longest, part) => (part.length > longest.length ? part : longest), '');
    }
    case 'logical':
      if (expr.op === 'AND') {
        return requiredLiteral(expr.left) ?? requiredLiteral(expr.right);
      }
      // Under OR a literal is only required if both sides demand the same one.
      return null;
    default:
      return null;
  }
}
