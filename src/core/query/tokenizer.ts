/**
 * Hand-written tokenizer.
 *
 * Written by hand rather than with a global regex because every token needs its exact
 * source position: the query bar underlines the offending token, and "invalid query" with
 * no position is a useless error message.
 */

export type TokenType =
  | 'identifier'
  | 'string'
  | 'number'
  | 'operator'
  | 'punctuation'
  | 'regex'
  | 'keyword'
  | 'eof';

export interface Token {
  readonly type: TokenType;
  /** Identifiers and keywords are upper-cased here; `raw` keeps the original spelling. */
  readonly value: string;
  readonly raw: string;
  readonly at: number;
  readonly length: number;
  /** Regex literals only: the flags that followed the closing slash. */
  readonly flags?: string;
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'ORDER', 'BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET',
  'AND', 'OR', 'NOT', 'LIKE', 'ILIKE', 'IN', 'BETWEEN', 'IS', 'NULL', 'MATCHES',
]);

export class TokenizeError extends Error {
  constructor(message: string, readonly at: number, readonly length: number) {
    super(message);
    this.name = 'TokenizeError';
  }
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_.]/.test(char);
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, value: string, raw: string, at: number, flags?: string): void => {
    tokens.push({ type, value, raw, at, length: raw.length, ...(flags === undefined ? {} : { flags }) });
  };

  while (i < input.length) {
    const char = input[i] as string;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // Line comments, so a user can annotate a saved query.
    if (char === '-' && input[i + 1] === '-') {
      while (i < input.length && input[i] !== '\n') {
        i++;
      }
      continue;
    }

    const start = i;

    // Single-quoted string literal, '' escapes a quote.
    if (char === "'") {
      i++;
      let value = '';
      for (;;) {
        if (i >= input.length) {
          throw new TokenizeError('Unterminated string literal.', start, input.length - start);
        }
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += input[i];
        i++;
      }
      push('string', value, input.slice(start, i), start);
      continue;
    }

    // Double-quoted identifier, for column names with spaces or reserved words.
    if (char === '"') {
      i++;
      let value = '';
      while (i < input.length && input[i] !== '"') {
        value += input[i];
        i++;
      }
      if (i >= input.length) {
        throw new TokenizeError('Unterminated quoted identifier.', start, input.length - start);
      }
      i++;
      push('identifier', value, input.slice(start, i), start);
      continue;
    }

    // Regex literal for the MATCHES extension: /pattern/flags
    if (char === '/') {
      i++;
      let pattern = '';
      let closed = false;
      while (i < input.length) {
        if (input[i] === '\\') {
          pattern += input[i];
          pattern += input[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (input[i] === '/') {
          closed = true;
          i++;
          break;
        }
        pattern += input[i];
        i++;
      }
      if (!closed) {
        throw new TokenizeError('Unterminated regular expression literal.', start, i - start);
      }
      let flags = '';
      while (i < input.length && /[imsu]/.test(input[i] as string)) {
        flags += input[i];
        i++;
      }
      push('regex', pattern, input.slice(start, i), start, flags);
      continue;
    }

    if (isDigit(char) || (char === '.' && isDigit(input[i + 1] ?? ''))) {
      while (i < input.length && /[0-9._]/.test(input[i] as string)) {
        i++;
      }
      const raw = input.slice(start, i);
      push('number', raw.replace(/_/g, ''), raw, start);
      continue;
    }

    if (isIdentifierStart(char)) {
      while (i < input.length && isIdentifierPart(input[i] as string)) {
        i++;
      }
      const raw = input.slice(start, i);
      const upper = raw.toUpperCase();
      push(KEYWORDS.has(upper) ? 'keyword' : 'identifier', KEYWORDS.has(upper) ? upper : raw, raw, start);
      continue;
    }

    // Two-character operators first, so '<=' never tokenizes as '<' followed by '='.
    const two = input.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      i += 2;
      push('operator', two === '!=' ? '<>' : two, two, start);
      continue;
    }

    if ('=<>'.includes(char)) {
      i++;
      push('operator', char, char, start);
      continue;
    }

    if ('(),*'.includes(char)) {
      i++;
      push('punctuation', char, char, start);
      continue;
    }

    throw new TokenizeError(`Unexpected character "${char}".`, start, 1);
  }

  tokens.push({ type: 'eof', value: '', raw: '', at: input.length, length: 0 });
  return tokens;
}
