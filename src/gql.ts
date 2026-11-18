// A small, dependency-free GraphQL document parser (lexer + recursive
// descent). It covers the language the suite's documents use — named
// operations, variables, arguments, aliases, fragments, inline fragments,
// directives, and literal values — and resolves values against the
// operation's variables. It is not a full spec validator; schema validation
// lives in graphql.ts, which walks this AST against the schema.

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface VariableDefinition {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VariableDefinition[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  definitions: Array<OperationNode | FragmentNode>;
}

export class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);
  while (i < len) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < len && source[i] !== '\n' && source[i] !== '\r') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // A string, or a block string (""").
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLSyntaxError('Unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < len) {
        const ch = source[j] as string;
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('Invalid unicode escape in string');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          if (!(esc in map)) throw new GraphQLSyntaxError(`Invalid escape \\${esc} in string`);
          out += map[esc] as string;
          j += 2;
          continue;
        }
        if (ch === '\n' || ch === '\r') throw new GraphQLSyntaxError('Unterminated string');
        out += ch;
        j += 1;
      }
      if (j >= len) throw new GraphQLSyntaxError('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < len && isDigit(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < len && isDigit(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < len && isDigit(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      if (text === '-' || text === '') throw new GraphQLSyntaxError(`Invalid number at offset ${i}`);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < len && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`Expected "${value}" but got ${describeToken(token)}`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`Expected ${what} but got ${describeToken(token)}`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private matchName(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'name' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const definitions: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'eof') {
      definitions.push(this.parseDefinition());
    }
    if (definitions.length === 0) throw new GraphQLSyntaxError('Syntax Error: Unexpected end of document.');
    return { definitions };
  }

  private parseDefinition(): OperationNode | FragmentNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return {
        kind: 'operation',
        operation: 'query',
        name: null,
        variableDefinitions: [],
        directives: [],
        selectionSet: this.parseSelectionSet(),
      };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      const directives = this.parseDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, directives, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName('a fragment name');
      if (name === 'on') throw new GraphQLSyntaxError('Syntax Error: Fragment name cannot be "on".');
      if (!this.matchName('on')) throw new GraphQLSyntaxError('Syntax Error: Expected "on" in a fragment definition.');
      const typeCondition = this.expectName('a type condition');
      const directives = this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    throw new GraphQLSyntaxError(`Syntax Error: Unexpected ${describeToken(token)}.`);
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const defs: VariableDefinition[] = [];
    if (!this.matchPunct('(')) return defs;
    while (!this.matchPunct(')')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Syntax Error: Unterminated variable definitions.');
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    let type: string;
    if (this.matchPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName('a type name');
    }
    if (this.matchPunct('!')) type += '!';
    return type;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.matchPunct('@')) {
      const name = this.expectName('a directive name');
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.matchPunct('(')) return args;
    while (!this.matchPunct(')')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Syntax Error: Unterminated arguments.');
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Syntax Error: Unterminated selection set.');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        const name = this.next().value;
        return { kind: 'spread', name, directives: this.parseDirectives() };
      }
      let typeCondition: string | null = null;
      if (this.matchName('on')) typeCondition = this.expectName('a type condition');
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    // A field: [alias:] name (args) directives selectionSet?
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new GraphQLSyntaxError('Syntax Error: Variable is not allowed in a constant value.');
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.matchPunct(']')) {
        if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Syntax Error: Unterminated list value.');
        items.push(this.parseValue(isConst));
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Syntax Error: Unterminated object value.');
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: 'object', fields };
    }
    throw new GraphQLSyntaxError(`Syntax Error: Unexpected ${describeToken(token)} as a value.`);
  }
}

function describeToken(token: Token): string {
  if (token.kind === 'eof') return 'end of document';
  return JSON.stringify(token.value);
}

/** Parse a GraphQL document string into an AST; throws GraphQLSyntaxError. */
export function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/**
 * Resolve a parsed value against the operation's variables. Enums resolve
 * to their name as a string; a missing variable resolves to undefined.
 */
export function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

/** Resolve every argument of a field against the variables. */
export function resolveArguments(
  args: Record<string, ValueNode>,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(args)) out[name] = resolveValue(node, variables);
  return out;
}
