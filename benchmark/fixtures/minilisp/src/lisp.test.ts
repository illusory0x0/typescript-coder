import { describe, expect, test } from "bun:test";
import { run } from "./lisp";
import type { LispValue } from "./lisp";

function evaluate(program: string): LispValue {
  return run(program);
}

describe("minilisp literals and top-level forms", () => {
  test("numbers and booleans", () => {
    expect(evaluate("42")).toBe(42);
    expect(evaluate("-7")).toBe(-7);
    expect(evaluate("3.5")).toBe(3.5);
    expect(evaluate("true")).toBe(true);
    expect(evaluate("false")).toBe(false);
  });

  test("evaluates all top-level forms and returns the last value", () => {
    expect(evaluate("1 2 3")).toBe(3);
    expect(evaluate("(define x 5) x")).toBe(5);
  });

  test("symbols resolve in the environment", () => {
    expect(evaluate("(define x 21) x")).toBe(21);
  });
});

describe("minilisp builtins", () => {
  test("arithmetic", () => {
    expect(evaluate("(+ 1 2)")).toBe(3);
    expect(evaluate("(- 10 4)")).toBe(6);
    expect(evaluate("(* 3 4)")).toBe(12);
    expect(evaluate("(/ 10 2)")).toBe(5);
  });

  test("equality", () => {
    expect(evaluate("(= 3 3)")).toBe(true);
    expect(evaluate("(= 3 4)")).toBe(false);
  });

  test("builtins take exactly two arguments", () => {
    expect(() => run("(+ 1)")).toThrow();
    expect(() => run("(+ 1 2 3)")).toThrow();
  });
});

describe("minilisp special forms", () => {
  test("if chooses a branch", () => {
    expect(evaluate("(if (= 3 3) 10 20)")).toBe(10);
    expect(evaluate("(if true 1 2)")).toBe(1);
  });

  test("only false is falsy", () => {
    expect(evaluate("(if false 1 2)")).toBe(2);
    expect(evaluate("(if 0 1 2)")).toBe(1);
  });

  test("define binds a variable", () => {
    expect(evaluate("(define x 21) (+ x x)")).toBe(42);
  });

  test("lambda application", () => {
    expect(evaluate("((lambda (x) (* x x)) 9)")).toBe(81);
  });

  test("define function shorthand", () => {
    expect(evaluate("(define (square x) (* x x)) (square 6)")).toBe(36);
  });

  test("closures capture their defining environment", () => {
    expect(evaluate("(define (adder n) (lambda (x) (+ x n))) ((adder 10) 5)")).toBe(15);
    expect(
      evaluate(
        "(define (make-adder n) (lambda (x) (+ x n))) (define add10 (make-adder 10)) (define add1 (make-adder 1)) (+ (add10 5) (add1 5))",
      ),
    ).toBe(21);
  });

  test("recursion", () => {
    expect(evaluate("(define (fact n) (if (= n 0) 1 (* n (fact (- n 1))))) (fact 5)")).toBe(120);
  });
});

describe("minilisp pairs", () => {
  test("cons builds a pair", () => {
    expect(evaluate("(cons 1 (cons 2 3))")).toEqual([1, [2, 3]]);
  });

  test("car and cdr select pair parts", () => {
    expect(evaluate("(car (cons 1 (cons 2 3)))")).toBe(1);
    expect(evaluate("(cdr (cons 1 (cons 2 3)))")).toEqual([2, 3]);
    expect(evaluate("(cdr (cons 1 2))")).toBe(2);
  });
});

test("unknown symbols throw", () => {
  expect(() => run("(unknown 1)")).toThrow();
});
