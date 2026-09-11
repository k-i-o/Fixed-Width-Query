/**
 * Turning an AST into a predicate.
 *
 * A predicate is a closure specialized once per query, not an interpreter walking the tree
 * per record. At a billion records the difference between a closure call and a switch on
 * `expr.kind` plus a megamorphic property load is most of the runtime.
 *
 * Deliberately NOT using `new Function`: user input reaches this code, and generated code
 * would also violate the webview CSP if this module were ever pulled into the UI bundle.
 * Composed closures are within noise of generated code here and stay debuggable.
 */

import type { RecordParser } from '../parse/columns.js';
import { likeToRegExp } from '../parse/decode.js';
import type { SchemaProfile } from '../../shared/schema.js';
import type { ComparisonOp, Expr, SelectStatement } from './ast.js';
import { estimateCost, requiredLiteral } from './ast.js';

export type Predicate = (record: RecordParser) => boolean;

export interface CompiledQuery {
  /** null means "match everything" — a query with no WHERE clause. */
  readonly predicate: Predicate | null;
  /** A substring every match must contain, usable to skip whole blocks. */
  readonly literalPrefilter: string | null;
  readonly selectedColumns: readonly number[];
  readonly orderColumn: number | null;
  readonly orderDirection: 'asc' | 'desc';
  readonly limit: number | null;
  readonly offset: number;
  readonly description: string;
}

export class CompileError extends Error {}

function columnIndexOf(name: string, schema: SchemaProfile): number {
  const lower = name.toLowerCase();
  const index = schema.columns.findIndex((column) => column.name.toLowerCase() === lower);
  if (index < 0) {
    throw new CompileError(`Unknown column "${name}".`);
  }
  return index;
}

function isNumericColumn(column: number, schema: SchemaProfile): boolean {
  const type = schema.columns[column]?.type;
  return type === 'number' || type === 'decimal';
}

/** Compare two ASCII/latin1 byte ranges without decoding either one. */
function bytesEqual(bytes: Uint8Array, literal: Uint8Array): boolean {
  if (bytes.length !== literal.length) {
    return false;
  }
  for (let i = 0; i < literal.length; i++) {
    if (bytes[i] !== literal[i]) {
      return false;
    }
  }
  return true;
}

function encodeLatin1(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function applyComparison(op: ComparisonOp, ordering: number): boolean {
  switch (op) {
    case '=':
      return ordering === 0;
    case '<>':
      return ordering !== 0;
    case '<':
      return ordering < 0;
    case '<=':
      return ordering <= 0;
    case '>':
      return ordering > 0;
    case '>=':
      return ordering >= 0;
  }
}

/** Flatten an AND chain so conjuncts can be reordered by cost, then rebuild it. */
function flattenAnd(expr: Expr): Expr[] {
  if (expr.kind === 'logical' && expr.op === 'AND') {
    return [...flattenAnd(expr.left), ...flattenAnd(expr.right)];
  }
  return [expr];
}

function literalValue(expr: Expr): { value: string | number; isString: boolean } {
  if (expr.kind !== 'literal') {
    throw new CompileError('Only literal values are supported on the right-hand side of a comparison.');
  }
  return { value: expr.value, isString: expr.isString };
}

function compileExpr(expr: Expr, schema: SchemaProfile): Predicate {
  switch (expr.kind) {
    case 'logical': {
      if (expr.op === 'AND') {
        // Cheapest and most selective first; every conjunct short-circuits the rest.
        const parts = flattenAnd(expr)
          .map((part) => ({ part, cost: estimateCost(part) }))
          .sort((a, b) => a.cost - b.cost)
          .map(({ part }) => compileExpr(part, schema));

        if (parts.length === 2) {
          // Specialize the common arity: two closure calls, no loop, no array bounds check.
          const [first, second] = parts as [Predicate, Predicate];
          return (record) => first(record) && second(record);
        }
        return (record) => {
          for (const part of parts) {
            if (!part(record)) {
              return false;
            }
          }
          return true;
        };
      }
      const left = compileExpr(expr.left, schema);
      const right = compileExpr(expr.right, schema);
      return (record) => left(record) || right(record);
    }

    case 'not': {
      const operand = compileExpr(expr.operand, schema);
      return (record) => !operand(record);
    }

    case 'comparison': {
      if (expr.left.kind !== 'column') {
        throw new CompileError('The left-hand side of a comparison must be a column.');
      }
      const column = columnIndexOf(expr.left.name, schema);
      const literal = literalValue(expr.right);
      const numeric = !literal.isString || isNumericColumn(column, schema);

      if (numeric) {
        const target = Number(literal.value);
        if (Number.isNaN(target)) {
          throw new CompileError(`Cannot compare column "${expr.left.name}" against a non-numeric value.`);
        }
        const op = expr.op;
        return (record) => {
          const value = record.number(column);
          // NaN means the field is not a number; such a record matches nothing.
          return Number.isNaN(value) ? false : applyComparison(op, value < target ? -1 : value > target ? 1 : 0);
        };
      }

      const text = String(literal.value);

      // Byte-level fast path: equality on a fixed-width column needs no decoding at all.
      if (expr.op === '=' || expr.op === '<>') {
        const literalBytes = encodeLatin1(text);
        const negated = expr.op === '<>';
        const isLatin1 = schema.encoding !== 'utf8';
        return (record) => {
          if (isLatin1) {
            const bytes = record.bytes(column);
            if (bytes) {
              return bytesEqual(bytes, literalBytes) !== negated;
            }
          }
          return (record.text(column) === text) !== negated;
        };
      }

      const op = expr.op;
      return (record) => applyComparison(op, compareStrings(record.text(column), text));
    }

    case 'like': {
      if (expr.left.kind !== 'column') {
        throw new CompileError('LIKE requires a column on the left-hand side.');
      }
      const column = columnIndexOf(expr.left.name, schema);
      const regex = likeToRegExp(expr.pattern, expr.caseInsensitive);
      const negated = expr.negated;
      return (record) => regex.test(record.text(column)) !== negated;
    }

    case 'matches': {
      if (expr.left.kind !== 'column') {
        throw new CompileError('MATCHES requires a column on the left-hand side.');
      }
      const column = columnIndexOf(expr.left.name, schema);
      // Strip global/sticky: lastIndex state across records would make results depend on
      // the order rows happen to be scanned in.
      const regex = new RegExp(expr.pattern, expr.flags.replace(/[gy]/g, ''));
      const negated = expr.negated;
      return (record) => regex.test(record.text(column)) !== negated;
    }

    case 'in': {
      if (expr.left.kind !== 'column') {
        throw new CompileError('IN requires a column on the left-hand side.');
      }
      const column = columnIndexOf(expr.left.name, schema);
      const negated = expr.negated;
      const numeric = isNumericColumn(column, schema) || expr.items.every((item) => item.kind === 'literal' && !item.isString);

      if (numeric) {
        const values = new Set(expr.items.map((item) => Number(literalValue(item).value)));
        return (record) => values.has(record.number(column)) !== negated;
      }
      const values = new Set(expr.items.map((item) => String(literalValue(item).value)));
      return (record) => values.has(record.text(column)) !== negated;
    }

    case 'between': {
      if (expr.left.kind !== 'column') {
        throw new CompileError('BETWEEN requires a column on the left-hand side.');
      }
      const column = columnIndexOf(expr.left.name, schema);
      const low = literalValue(expr.low);
      const high = literalValue(expr.high);
      const negated = expr.negated;
      const numeric = isNumericColumn(column, schema) || (!low.isString && !high.isString);

      if (numeric) {
        const lowValue = Number(low.value);
        const highValue = Number(high.value);
        return (record) => {
          const value = record.number(column);
          if (Number.isNaN(value)) {
            return false;
          }
          return (value >= lowValue && value <= highValue) !== negated;
        };
      }
      const lowText = String(low.value);
      const highText = String(high.value);
      return (record) => {
        const value = record.text(column);
        return (value >= lowText && value <= highText) !== negated;
      };
    }

    case 'isNull': {
      if (expr.left.kind !== 'column') {
        throw new CompileError('IS NULL requires a column on the left-hand side.');
      }
      const column = columnIndexOf(expr.left.name, schema);
      const negated = expr.negated;
      // In a fixed-width file "null" means the field is blank: there is no NULL on disk.
      return (record) => record.isEmpty(column) !== negated;
    }

    case 'column':
      throw new CompileError(`Column "${expr.name}" used as a condition. Write a comparison, for example ${expr.name} <> ''.`);

    case 'literal':
      throw new CompileError('A bare literal is not a condition.');
  }
}

export function compileQuery(statement: SelectStatement, schema: SchemaProfile): CompiledQuery {
  const predicate = statement.where ? compileExpr(statement.where, schema) : null;

  const selectedColumns = statement.columns
    ? statement.columns.map((name) => columnIndexOf(name, schema))
    : schema.columns.map((_, index) => index);

  const orderColumn = statement.orderBy ? columnIndexOf(statement.orderBy.column, schema) : null;
  const literal = requiredLiteral(statement.where);

  const description = [
    statement.where ? 'filter' : 'full scan',
    literal ? `block prefilter "${literal}"` : null,
    orderColumn !== null ? `top-${statement.limit} by ${statement.orderBy?.column}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    predicate,
    literalPrefilter: literal,
    selectedColumns,
    orderColumn,
    orderDirection: statement.orderBy?.direction ?? 'asc',
    limit: statement.limit,
    offset: statement.offset,
    description,
  };
}
