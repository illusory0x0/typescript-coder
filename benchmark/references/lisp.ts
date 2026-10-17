export type LispValue = number | boolean | LispValue[];

type Form = number | boolean | string | Form[];

interface Builtin {
  readonly kind: "builtin";
  readonly name: string;
  readonly arity: number;
  readonly apply: (args: Value[]) => Value;
}

interface Closure {
  readonly kind: "lambda";
  readonly params: string[];
  readonly body: Form[];
  readonly env: Environment;
}

type Callable = Builtin | Closure;
type Value = LispValue | Callable;

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isDelimiter(char: string | undefined): boolean {
  return char === undefined || isWhitespace(char) || char === "(" || char === ")";
}

class LispParser {
  private position = 0;

  constructor(private readonly text: string) {}

  parseProgram(): Form[] {
    const forms: Form[] = [];
    this.skipWhitespace();
    while (this.position < this.text.length) {
      forms.push(this.parseForm());
      this.skipWhitespace();
    }
    return forms;
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.text[this.position])) {
      this.position += 1;
    }
  }

  private parseForm(): Form {
    const char = this.text[this.position];
    if (char === undefined) {
      throw new SyntaxError("unexpected end of input");
    }
    if (char === "(") {
      return this.parseList();
    }
    if (char === ")") {
      throw new SyntaxError(`unexpected ')' at position ${this.position}`);
    }
    return this.parseAtom();
  }

  private parseList(): Form[] {
    const forms: Form[] = [];
    this.position += 1;
    for (;;) {
      this.skipWhitespace();
      const char = this.text[this.position];
      if (char === undefined) {
        throw new SyntaxError("unterminated list");
      }
      if (char === ")") {
        this.position += 1;
        return forms;
      }
      forms.push(this.parseForm());
    }
  }

  private parseAtom(): Form {
    const start = this.position;
    while (!isDelimiter(this.text[this.position])) {
      this.position += 1;
    }
    const text = this.text.slice(start, this.position);
    if (text === "true") {
      return true;
    }
    if (text === "false") {
      return false;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      return Number(text);
    }
    return text;
  }
}

class Environment {
  private readonly bindings = new Map<string, Value>();

  constructor(private readonly parent: Environment | null = null) {}

  lookup(name: string): Value {
    let current: Environment | null = this;
    while (current !== null) {
      const value = current.bindings.get(name);
      if (value !== undefined) {
        return value;
      }
      current = current.parent;
    }
    throw new Error(`unbound symbol: ${name}`);
  }

  define(name: string, value: Value): void {
    this.bindings.set(name, value);
  }
}

function isCallable(value: Value): value is Callable {
  return typeof value === "object" && value !== null && "kind" in value;
}

function formAt(forms: Form[], index: number): Form {
  const form = forms[index];
  if (form === undefined) {
    throw new Error(`missing form at position ${index}`);
  }
  return form;
}

function valueAt(values: Value[], index: number): Value {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`missing argument at position ${index}`);
  }
  return value;
}

function parseParams(forms: Form[]): string[] {
  return forms.map((param) => {
    if (typeof param !== "string") {
      throw new Error("parameters must be symbols");
    }
    return param;
  });
}

function evaluateBody(body: Form[], env: Environment): Value {
  let result: Value | undefined;
  for (const form of body) {
    result = evaluate(form, env);
  }
  if (result === undefined) {
    throw new Error("empty body");
  }
  return result;
}

function evaluateIf(form: Form[], env: Environment): Value {
  if (form.length !== 4) {
    throw new Error("if expects exactly three operands");
  }
  if (evaluate(formAt(form, 1), env) === false) {
    return evaluate(formAt(form, 3), env);
  }
  return evaluate(formAt(form, 2), env);
}

function evaluateDefine(form: Form[], env: Environment): Value {
  if (form.length < 3) {
    throw new Error("define expects a target and a value");
  }
  const target = formAt(form, 1);
  if (typeof target === "string") {
    if (form.length !== 3) {
      throw new Error("define with a name expects exactly one value");
    }
    const value = evaluate(formAt(form, 2), env);
    env.define(target, value);
    return value;
  }
  if (Array.isArray(target)) {
    const name = formAt(target, 0);
    if (typeof name !== "string") {
      throw new Error("define expects a function name");
    }
    const params = parseParams(target.slice(1));
    const body = form.slice(2);
    if (body.length === 0) {
      throw new Error("define expects a function body");
    }
    const closure: Closure = { kind: "lambda", params, body, env };
    env.define(name, closure);
    return closure;
  }
  throw new Error("define expects a symbol or a function signature");
}

function evaluateLambda(form: Form[], env: Environment): Closure {
  if (form.length < 3) {
    throw new Error("lambda expects parameters and a body");
  }
  const params = formAt(form, 1);
  if (!Array.isArray(params)) {
    throw new Error("lambda parameters must be a list");
  }
  const body = form.slice(2);
  return { kind: "lambda", params: parseParams(params), body, env };
}

function applyCallable(callable: Callable, args: Value[]): Value {
  if (callable.kind === "builtin") {
    if (args.length !== callable.arity) {
      throw new Error(`${callable.name} expects exactly ${callable.arity} argument(s)`);
    }
    return callable.apply(args);
  }
  if (args.length !== callable.params.length) {
    throw new Error(`expected ${callable.params.length} argument(s), received ${args.length}`);
  }
  const callEnv = new Environment(callable.env);
  for (let index = 0; index < callable.params.length; index += 1) {
    const param = callable.params[index];
    if (param === undefined) {
      throw new Error(`missing parameter at position ${index}`);
    }
    callEnv.define(param, valueAt(args, index));
  }
  return evaluateBody(callable.body, callEnv);
}

function evaluate(form: Form, env: Environment): Value {
  if (typeof form === "number" || typeof form === "boolean") {
    return form;
  }
  if (typeof form === "string") {
    return env.lookup(form);
  }
  const head = form[0];
  if (head === undefined) {
    throw new Error("cannot evaluate an empty list");
  }
  if (typeof head === "string") {
    if (head === "if") {
      return evaluateIf(form, env);
    }
    if (head === "define") {
      return evaluateDefine(form, env);
    }
    if (head === "lambda") {
      return evaluateLambda(form, env);
    }
  }
  const callable = evaluate(head, env);
  if (!isCallable(callable)) {
    throw new Error("attempted to call a non-function");
  }
  const args = form.slice(1).map((argument) => evaluate(argument, env));
  return applyCallable(callable, args);
}

function toLispValue(value: Value): LispValue {
  if (isCallable(value)) {
    throw new Error("cannot use a function as a data value");
  }
  return value;
}

function expectNumber(value: Value, name: string): number {
  if (typeof value !== "number") {
    throw new Error(`${name} expects numbers`);
  }
  return value;
}

function builtinBinary(name: string, apply: (first: Value, second: Value) => Value): Builtin {
  return {
    kind: "builtin",
    name,
    arity: 2,
    apply: (args) => apply(valueAt(args, 0), valueAt(args, 1)),
  };
}

function builtinUnary(name: string, apply: (value: Value) => Value): Builtin {
  return {
    kind: "builtin",
    name,
    arity: 1,
    apply: (args) => apply(valueAt(args, 0)),
  };
}

function createGlobalEnvironment(): Environment {
  const env = new Environment();
  env.define(
    "+",
    builtinBinary("+", (first, second) => expectNumber(first, "+") + expectNumber(second, "+")),
  );
  env.define(
    "-",
    builtinBinary("-", (first, second) => expectNumber(first, "-") - expectNumber(second, "-")),
  );
  env.define(
    "*",
    builtinBinary("*", (first, second) => expectNumber(first, "*") * expectNumber(second, "*")),
  );
  env.define(
    "/",
    builtinBinary("/", (first, second) => expectNumber(first, "/") / expectNumber(second, "/")),
  );
  env.define(
    "=",
    builtinBinary("=", (first, second) => first === second),
  );
  env.define(
    "cons",
    builtinBinary("cons", (first, second) => [toLispValue(first), toLispValue(second)]),
  );
  env.define(
    "car",
    builtinUnary("car", (first) => {
      if (!Array.isArray(first) || first.length === 0) {
        throw new Error("car expects a non-empty pair");
      }
      const element = first[0];
      if (element === undefined) {
        throw new Error("car expects a non-empty pair");
      }
      return element;
    }),
  );
  env.define(
    "cdr",
    builtinUnary("cdr", (first) => {
      if (!Array.isArray(first) || first.length < 2) {
        throw new Error("cdr expects a pair with a second element");
      }
      const element = first[1];
      if (element === undefined) {
        throw new Error("cdr expects a pair with a second element");
      }
      return element;
    }),
  );
  return env;
}

export function run(program: string): LispValue {
  const forms = new LispParser(program).parseProgram();
  if (forms.length === 0) {
    throw new Error("program does not contain any forms");
  }
  const env = createGlobalEnvironment();
  let result: Value = false;
  for (const form of forms) {
    result = evaluate(form, env);
  }
  return toLispValue(result);
}
