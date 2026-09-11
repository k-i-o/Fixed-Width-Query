/**
 * Column filters from the UI compile into the same AST the SQL parser produces.
 *
 * One semantics, one test suite, one executor — and the user can be shown the SQL their
 * clicks amount to, which is the cheapest SQL tutorial we can ship.
 */

import type { UiFilter } from '../../shared/protocol.js';
import type { Expr } from './ast.js';

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (char) => `\\${char}`);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function filterToExpr(filter: UiFilter): Expr | null {
  const column: Expr = { kind: 'column', name: filter.column };
  const value = filter.value;

  switch (filter.op) {
    case 'empty':
      return { kind: 'isNull', left: column, negated: false };
    case 'notEmpty':
      return { kind: 'isNull', left: column, negated: true };
    default:
      break;
  }

  if (value === '') {
    return null; // An empty input is not a filter; it is an untouched box.
  }

  switch (filter.op) {
    case 'contains':
      return { kind: 'like', left: column, pattern: `%${escapeLike(value)}%`, negated: false, caseInsensitive: true };
    case 'startsWith':
      return { kind: 'like', left: column, pattern: `${escapeLike(value)}%`, negated: false, caseInsensitive: true };
    case 'endsWith':
      return { kind: 'like', left: column, pattern: `%${escapeLike(value)}`, negated: false, caseInsensitive: true };
    case 'equals':
      return { kind: 'comparison', op: '=', left: column, right: { kind: 'literal', value, isString: true } };
    case 'notEquals':
      return { kind: 'comparison', op: '<>', left: column, right: { kind: 'literal', value, isString: true } };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const op = filter.op === 'gt' ? '>' : filter.op === 'gte' ? '>=' : filter.op === 'lt' ? '<' : '<=';
      const numeric = Number(value.replace(',', '.'));
      const isNumber = value.trim() !== '' && Number.isFinite(numeric);
      return {
        kind: 'comparison',
        op,
        left: column,
        right: { kind: 'literal', value: isNumber ? numeric : value, isString: !isNumber },
      };
    }
    case 'regex':
      return { kind: 'matches', left: column, pattern: value, flags: 'i', negated: false };
    default:
      return null;
  }
}

/** Filters combine with AND, which is what a row of filter boxes visually implies. */
export function filtersToExpr(filters: readonly UiFilter[]): Expr | null {
  const parts = filters.map(filterToExpr).filter((expr): expr is Expr => expr !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.reduce((left, right) => ({ kind: 'logical', op: 'AND', left, right }));
}

/** Render the equivalent SQL, shown under the filter row so the two modes stay connected. */
export function filtersToSql(filters: readonly UiFilter[]): string {
  const clauses: string[] = [];
  for (const filter of filters) {
    const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(filter.column) ? filter.column : `"${filter.column}"`;
    switch (filter.op) {
      case 'empty':
        clauses.push(`${name} IS NULL`);
        break;
      case 'notEmpty':
        clauses.push(`${name} IS NOT NULL`);
        break;
      case 'contains':
        if (filter.value) clauses.push(`${name} ILIKE ${quote(`%${filter.value}%`)}`);
        break;
      case 'startsWith':
        if (filter.value) clauses.push(`${name} ILIKE ${quote(`${filter.value}%`)}`);
        break;
      case 'endsWith':
        if (filter.value) clauses.push(`${name} ILIKE ${quote(`%${filter.value}`)}`);
        break;
      case 'equals':
        if (filter.value) clauses.push(`${name} = ${quote(filter.value)}`);
        break;
      case 'notEquals':
        if (filter.value) clauses.push(`${name} <> ${quote(filter.value)}`);
        break;
      case 'regex':
        if (filter.value) clauses.push(`${name} MATCHES /${filter.value}/i`);
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        if (!filter.value) break;
        const op = filter.op === 'gt' ? '>' : filter.op === 'gte' ? '>=' : filter.op === 'lt' ? '<' : '<=';
        const numeric = Number(filter.value.replace(',', '.'));
        const rendered = Number.isFinite(numeric) && filter.value.trim() !== '' ? String(numeric) : quote(filter.value);
        clauses.push(`${name} ${op} ${rendered}`);
        break;
      }
    }
  }
  return clauses.length > 0 ? `SELECT * WHERE ${clauses.join(' AND ')}` : 'SELECT *';
}
