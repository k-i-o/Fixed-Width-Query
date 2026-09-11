/**
 * Recursive-descent parser with Pratt-style precedence for expressions.
 *
 * Grammar (v1):
 *   SELECT (* | col [, col]*) [FROM rows] [WHERE expr] [ORDER BY col [ASC|DESC]] [LIMIT n [OFFSET m]]
 *
 * FROM is accepted and ignored: there is exactly one table, the open file. Accepting it
 * means queries pasted from a SQL client work unchanged.
 */

import type { ComparisonOp, Expr, ParseResult, SelectStatement } from './ast.js';
import { collectColumns } from './ast.js';
import { TokenizeError, tokenize, type Token } from './tokenizer.js';

const PRECEDENCE_OR = 1;
const PRECEDENCE_AND = 2;
const PRECEDENCE_NOT = 3;
const PRECEDENCE_COMPARISON = 4;

class ParseError extends Error {
  constructor(message: string, readonly at: number, readonly length: number) {
    super(message);
    this.name = 'ParseError';
  }
}

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  private get current(): Token {
    return this.tokens[this.position] as Token;
  }

  private matchKeyword(...keywords: string[]): boolean {
    const token = this.current;
    if (token.type === 'keyword' && keywords.includes(token.value)) {
      this.position++;
      return true;
    }
    return false;
  }

  private expectKeyword(keyword: string): void {
    if (!this.matchKeyword(keyword)) {
      throw new ParseError(`Expected ${keyword}, found "${this.current.raw || 'end of query'}".`, this.current.at, Math.max(1, this.current.length));
    }
  }

  private matchPunctuation(value: string): boolean {
    if (this.current.type === 'punctuation' && this.current.value === value) {
      this.position++;
      return true;
    }
    return false;
  }

  private expectPunctuation(value: string): void {
    if (!this.matchPunctuation(value)) {
      throw new ParseError(`Expected "${value}", found "${this.current.raw || 'end of query'}".`, this.current.at, Math.max(1, this.current.length));
    }
  }

  private expectIdentifier(): string {
    const token = this.current;
    // A keyword used unquoted as a column name is a common paste artifact; allow it where
    // the grammar leaves no ambiguity.
    if (token.type === 'identifier' || token.type === 'keyword') {
      this.position++;
      return token.raw;
    }
    throw new ParseError(`Expected a column name, found "${token.raw || 'end of query'}".`, token.at, Math.max(1, token.length));
  }

  parseSelect(): SelectStatement {
    this.expectKeyword('SELECT');

    let columns: string[] | null = null;
    if (this.matchPunctuation('*')) {
      columns = null;
    } else {
      columns = [this.expectIdentifier()];
      while (this.matchPunctuation(',')) {
        columns.push(this.expectIdentifier());
      }
    }

    if (this.matchKeyword('FROM')) {
      this.expectIdentifier(); // table name, ignored: there is only the open file
    }

    let where: Expr | null = null;
    if (this.matchKeyword('WHERE')) {
      where = this.parseExpression(0);
    }

    let orderBy: SelectStatement['orderBy'] = null;
    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY');
      const column = this.expectIdentifier();
      let direction: 'asc' | 'desc' = 'asc';
      if (this.matchKeyword('DESC')) {
        direction = 'desc';
      } else {
        this.matchKeyword('ASC');
      }
      orderBy = { column, direction };
    }

    let limit: number | null = null;
    let offset = 0;
    if (this.matchKeyword('LIMIT')) {
      limit = this.parseInteger('LIMIT');
      if (this.matchKeyword('OFFSET')) {
        offset = this.parseInteger('OFFSET');
      }
    }

    if (this.current.type !== 'eof') {
      throw new ParseError(`Unexpected "${this.current.raw}" after the end of the query.`, this.current.at, Math.max(1, this.current.length));
    }

    return { columns, where, orderBy, limit, offset };
  }

  private parseInteger(clause: string): number {
    const token = this.current;
    if (token.type !== 'number') {
      throw new ParseError(`${clause} expects a number, found "${token.raw || 'end of query'}".`, token.at, Math.max(1, token.length));
    }
    this.position++;
    const value = Number(token.value);
    if (!Number.isInteger(value) || value < 0) {
      throw new ParseError(`${clause} expects a non-negative integer.`, token.at, token.length);
    }
    return value;
  }

  /** Pratt loop: parse a prefix, then absorb operators while they bind tightly enough. */
  private parseExpression(minPrecedence: number): Expr {
    let left = this.parsePrefix();

    for (;;) {
      const token = this.current;

      if (token.type === 'keyword' && token.value === 'OR' && PRECEDENCE_OR >= minPrecedence) {
        this.position++;
        const right = this.parseExpression(PRECEDENCE_OR + 1);
        left = { kind: 'logical', op: 'OR', left, right };
        continue;
      }

      if (token.type === 'keyword' && token.value === 'AND' && PRECEDENCE_AND >= minPrecedence) {
        this.position++;
        const right = this.parseExpression(PRECEDENCE_AND + 1);
        left = { kind: 'logical', op: 'AND', left, right };
        continue;
      }

      if (PRECEDENCE_COMPARISON >= minPrecedence) {
        const absorbed = this.tryParsePostfix(left);
        if (absorbed) {
          left = absorbed;
          continue;
        }
      }

      return left;
    }
  }

  /** Everything that binds at comparison precedence: =, LIKE, IN, BETWEEN, IS NULL, MATCHES. */
  private tryParsePostfix(left: Expr): Expr | null {
    const token = this.current;

    if (token.type === 'operator') {
      this.position++;
      const right = this.parseExpression(PRECEDENCE_COMPARISON + 1);
      return { kind: 'comparison', op: token.value as ComparisonOp, left, right };
    }

    if (token.type === 'keyword') {
      let negated = false;
      let cursor = this.position;
      if (token.value === 'NOT') {
        const next = this.tokens[cursor + 1];
        if (next?.type === 'keyword' && (next.value === 'LIKE' || next.value === 'IN' || next.value === 'BETWEEN' || next.value === 'MATCHES' || next.value === 'ILIKE')) {
          negated = true;
          cursor++;
        } else {
          return null;
        }
      }

      const keyword = this.tokens[cursor] as Token;

      if (keyword.value === 'LIKE' || keyword.value === 'ILIKE') {
        this.position = cursor + 1;
        const pattern = this.expectStringLiteral('LIKE');
        return { kind: 'like', left, pattern, negated, caseInsensitive: keyword.value === 'ILIKE' };
      }

      if (keyword.value === 'MATCHES') {
        this.position = cursor + 1;
        const regexToken = this.current;
        if (regexToken.type !== 'regex') {
          throw new ParseError('MATCHES expects a /regular expression/.', regexToken.at, Math.max(1, regexToken.length));
        }
        this.position++;
        const pattern = regexToken.value;
        const flags = regexToken.flags ?? '';
        try {
          new RegExp(pattern, flags);
        } catch (error) {
          throw new ParseError(`Invalid regular expression: ${(error as Error).message}`, regexToken.at, regexToken.length);
        }
        return { kind: 'matches', left, pattern, flags, negated };
      }

      if (keyword.value === 'IN') {
        this.position = cursor + 1;
        this.expectPunctuation('(');
        const items: Expr[] = [this.parsePrimary()];
        while (this.matchPunctuation(',')) {
          items.push(this.parsePrimary());
        }
        this.expectPunctuation(')');
        return { kind: 'in', left, items, negated };
      }

      if (keyword.value === 'BETWEEN') {
        this.position = cursor + 1;
        const low = this.parsePrimary();
        this.expectKeyword('AND');
        const high = this.parsePrimary();
        return { kind: 'between', left, low, high, negated };
      }

      if (keyword.value === 'IS') {
        this.position = cursor + 1;
        const isNegated = this.matchKeyword('NOT');
        this.expectKeyword('NULL');
        return { kind: 'isNull', left, negated: isNegated };
      }
    }

    return null;
  }

  private expectStringLiteral(clause: string): string {
    const token = this.current;
    if (token.type !== 'string') {
      throw new ParseError(`${clause} expects a quoted pattern, found "${token.raw || 'end of query'}".`, token.at, Math.max(1, token.length));
    }
    this.position++;
    return token.value;
  }

  private parsePrefix(): Expr {
    if (this.matchKeyword('NOT')) {
      return { kind: 'not', operand: this.parseExpression(PRECEDENCE_NOT) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.current;

    if (this.matchPunctuation('(')) {
      const inner = this.parseExpression(0);
      this.expectPunctuation(')');
      return inner;
    }

    if (token.type === 'string') {
      this.position++;
      return { kind: 'literal', value: token.value, isString: true };
    }

    if (token.type === 'number') {
      this.position++;
      return { kind: 'literal', value: Number(token.value), isString: false };
    }

    if (token.type === 'identifier' || (token.type === 'keyword' && token.value === 'NULL')) {
      this.position++;
      if (token.value === 'NULL') {
        return { kind: 'literal', value: '', isString: true };
      }
      return { kind: 'column', name: token.raw };
    }

    throw new ParseError(`Unexpected "${token.raw || 'end of query'}".`, token.at, Math.max(1, token.length));
  }
}

export function parseQuery(sql: string): ParseResult {
  try {
    const statement = new Parser(tokenize(sql)).parseSelect();
    return { ok: true, statement };
  } catch (error) {
    if (error instanceof ParseError || error instanceof TokenizeError) {
      return { ok: false, error: { message: error.message, at: error.at, length: error.length } };
    }
    return { ok: false, error: { message: (error as Error).message, at: 0, length: sql.length } };
  }
}

/** Levenshtein-ish closest match, so a typo suggests the column the user meant. */
function closestName(target: string, candidates: readonly string[]): string | null {
  const lower = target.toLowerCase();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const other = candidate.toLowerCase();
    if (other.startsWith(lower) || lower.startsWith(other)) {
      return candidate;
    }
    let score = Math.abs(other.length - lower.length);
    for (let i = 0; i < Math.min(other.length, lower.length); i++) {
      if (other[i] !== lower[i]) {
        score++;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= 3 ? best : null;
}

/**
 * Semantic validation, kept separate from parsing: a query can be perfectly well-formed
 * and still reference a column that does not exist in the current schema.
 */
export function validateStatement(
  statement: SelectStatement,
  columnNames: readonly string[],
  sql: string,
): { ok: true } | { ok: false; error: { message: string; at: number; length: number } } {
  const known = new Map(columnNames.map((name) => [name.toLowerCase(), name]));

  const referenced = collectColumns(statement.where);
  for (const name of statement.columns ?? []) {
    referenced.add(name);
  }
  if (statement.orderBy) {
    referenced.add(statement.orderBy.column);
  }

  for (const name of referenced) {
    if (!known.has(name.toLowerCase())) {
      const suggestion = closestName(name, columnNames);
      const at = Math.max(0, sql.toLowerCase().indexOf(name.toLowerCase()));
      return {
        ok: false,
        error: {
          message: `Unknown column "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
          at,
          length: name.length,
        },
      };
    }
  }

  if (statement.orderBy && statement.limit === null) {
    return {
      ok: false,
      error: {
        message: 'ORDER BY requires a LIMIT. Sorting an unbounded result over a file this size would not fit in memory.',
        at: Math.max(0, sql.toUpperCase().indexOf('ORDER')),
        length: 5,
      },
    };
  }

  return { ok: true };
}
