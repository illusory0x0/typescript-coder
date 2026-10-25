import { describe, expect, test } from "bun:test";
import { Workbook } from "./workbook";
import type { CellResult } from "./workbook";

type CellInput = string | number | boolean | null;

function withCells(cells: Record<string, CellInput>): Workbook {
  const workbook = new Workbook();
  for (const [address, input] of Object.entries(cells)) {
    workbook.setCell(address, input);
  }
  return workbook;
}

function formulaValue(formula: string): CellResult {
  return withCells({ A1: formula }).getValue("A1");
}

function expectFormula(formula: string, expected: CellResult): void {
  expect(formulaValue(formula)).toBe(expected);
}

function expectFormulaTable(table: ReadonlyArray<readonly [string, CellResult]>): void {
  for (const [formula, expected] of table) {
    expect(formulaValue(formula)).toBe(expected);
  }
}

describe("mini-spreadsheet literal cells and display", () => {
  test("stores numbers, strings, and booleans", () => {
    const workbook = withCells({
      A1: 42,
      A2: -3.5,
      B1: "hello",
      B2: "",
      C1: true,
      C2: false,
    });
    expect(workbook.getValue("A1")).toBe(42);
    expect(workbook.getValue("A2")).toBe(-3.5);
    expect(workbook.getValue("B1")).toBe("hello");
    expect(workbook.getValue("B2")).toBe("");
    expect(workbook.getValue("C1")).toBe(true);
    expect(workbook.getValue("C2")).toBe(false);
  });

  test("blank cells read as null and display as empty text", () => {
    const workbook = new Workbook();
    expect(workbook.getValue("A1")).toBeNull();
    expect(workbook.getDisplay("A1")).toBe("");
    expect(workbook.getValue("Z99")).toBeNull();
  });

  test("null clears a cell", () => {
    const workbook = withCells({ A1: "occupied" });
    workbook.setCell("A1", null);
    expect(workbook.getValue("A1")).toBeNull();
    expect(workbook.getDisplay("A1")).toBe("");
  });

  test("empty string is a literal, not a blank", () => {
    const workbook = withCells({ A1: "" });
    expect(workbook.getValue("A1")).toBe("");
    expect(workbook.getDisplay("A1")).toBe("");
  });

  test("display follows the public formatting rules", () => {
    const workbook = withCells({
      A1: 12.5,
      A2: 0,
      A3: true,
      A4: false,
      A5: "text",
      A6: null,
      A7: "=1/0",
    });
    expect(workbook.getDisplay("A1")).toBe("12.5");
    expect(workbook.getDisplay("A2")).toBe("0");
    expect(workbook.getDisplay("A3")).toBe("TRUE");
    expect(workbook.getDisplay("A4")).toBe("FALSE");
    expect(workbook.getDisplay("A5")).toBe("text");
    expect(workbook.getDisplay("A6")).toBe("");
    expect(workbook.getDisplay("A7")).toBe("#DIV/0!");
  });

  test("addresses are case-insensitive and normalize to one cell", () => {
    const workbook = new Workbook();
    workbook.setCell("aa10", 1);
    expect(workbook.getValue("AA10")).toBe(1);
    expect(workbook.getValue("aA10")).toBe(1);
    workbook.setCell("AA10", 2);
    expect(workbook.getValue("aa10")).toBe(2);

    workbook.setCell("a1", "=Aa10+1");
    expect(workbook.getValue("A1")).toBe(3);
  });

  test("invalid addresses throw", () => {
    const invalid = [
      "",
      "A",
      "1A",
      "A0",
      "A01",
      "A1B",
      "A 1",
      "A-1",
      "$A$1",
      "A1.2",
      "XFE1",
      "A1048577",
    ];
    for (const address of invalid) {
      expect(() => new Workbook().setCell(address, "x")).toThrow(Error);
    }
    expect(() => new Workbook().getValue("A0")).toThrow(Error);
    expect(() => new Workbook().getDisplay("1A")).toThrow(Error);
  });
});

describe("mini-spreadsheet formula literals", () => {
  test("numeric literal spellings", () => {
    expectFormulaTable([
      ["=42", 42],
      ["=-3.5", -3.5],
      ["=.5", 0.5],
      ["=1.", 1],
      ["=1e3", 1000],
      ["=2.5E-2", 0.025],
    ]);
  });

  test("quoted strings and escapes", () => {
    expectFormula('=""', "");
    expectFormula('="hello"', "hello");
    expectFormula('="a\\"b"', 'a"b');
    expectFormula('="a\\\\b"', "a\\b");
    expectFormula('="line\\nnext"', "line\nnext");
    expectFormula('="tab\\there"', "tab\there");
  });

  test("booleans are case-insensitive", () => {
    expectFormula("=TRUE", true);
    expectFormula("=true", true);
    expectFormula("=False", false);
    expectFormula("=fAlSe", false);
  });

  test("a quoted number is a string, not a number", () => {
    expectFormula('="123"', "123");
    expectFormula('="123"+1', "#VALUE!");
  });
});

describe("mini-spreadsheet arithmetic operators", () => {
  test("precedence and associativity", () => {
    expectFormulaTable([
      ["=1+2*3", 7],
      ["=(1+2)*3", 9],
      ["=10-3-2", 5],
      ["=100/10/2", 5],
      ["=2*3+4*5", 26],
      ["=2^3^2", 512],
      ["=-2^2", -4],
      ["=(-2)^2", 4],
      ["=2^-2", 0.25],
      ["=+5", 5],
      ["=--5", 5],
      ["=1+-2", -1],
    ]);
  });

  test("division by zero and non-finite results", () => {
    expectFormula("=1/0", "#DIV/0!");
    expectFormula("=0^-1", "#DIV/0!");
    expectFormula("=1e308*10", "#VALUE!");
    expectFormula("=1e309", "#VALUE!");
  });

  test("arithmetic requires numbers", () => {
    const workbook = withCells({ A1: "some text", A2: true });
    expect(workbook.getValue("A1")).toBe("some text");
    expect(formulaValue("=Z1+1")).toBe("#VALUE!");
    expect(formulaValue("=Z1*0")).toBe("#VALUE!");
    expect(formulaValue("=-Z1")).toBe("#VALUE!");
    expect(formulaValue('="1"+2')).toBe("#VALUE!");
    expect(formulaValue("=TRUE+1")).toBe("#VALUE!");
    expect(formulaValue('=-"x"')).toBe("#VALUE!");
    expect(formulaValue("=+TRUE")).toBe("#VALUE!");
  });
});

describe("mini-spreadsheet string concatenation", () => {
  test("concatenates values with the required formatting", () => {
    expectFormulaTable([
      ["=1&2", "12"],
      ['="a"&"b"', "ab"],
      ['="a"&1&TRUE', "a1TRUE"],
      ["=TRUE&FALSE", "TRUEFALSE"],
      ['=1.5&""', "1.5"],
      ['=Z1&"x"', "x"],
      ["=Z1&Z2", ""],
      ["=1+2&3", "33"],
      ["=1&2+3", "15"],
    ]);
  });

  test("errors propagate through concatenation", () => {
    expectFormula('=1/0&"x"', "#DIV/0!");
    expectFormula('="x"&(1/0)', "#DIV/0!");
  });
});

describe("mini-spreadsheet comparisons", () => {
  test("numeric comparisons", () => {
    expectFormulaTable([
      ["=1=1", true],
      ["=1=2", false],
      ["=1<>2", true],
      ["=1<>1", false],
      ["=1<2", true],
      ["=2<=2", true],
      ["=3>2", true],
      ["=2>=3", false],
    ]);
  });

  test("string comparisons", () => {
    expectFormulaTable([
      ['="a"="a"', true],
      ['="a"<>"b"', true],
      ['="a"<"b"', true],
      ['="b">"a"', true],
      ['="b"<="a"', false],
    ]);
  });

  test("boolean comparisons", () => {
    expectFormulaTable([
      ["=TRUE=TRUE", true],
      ["=TRUE=FALSE", false],
      ["=FALSE<>TRUE", true],
      ["=FALSE<TRUE", true],
      ["=TRUE>FALSE", true],
      ["=TRUE>=TRUE", true],
    ]);
  });

  test("blank equality is limited to blank-blank", () => {
    expectFormulaTable([
      ["=Z1=Z2", true],
      ["=Z1<>Z2", false],
      ["=Z1=1", "#VALUE!"],
      ['=Z1=""', "#VALUE!"],
      ["=Z1<Z2", "#VALUE!"],
    ]);
  });

  test("mixed types are value errors", () => {
    expectFormulaTable([
      ['=1="1"', "#VALUE!"],
      ["=TRUE=1", "#VALUE!"],
      ['="a"<1', "#VALUE!"],
      ["=FALSE<0", "#VALUE!"],
      ['=1<"2"', "#VALUE!"],
    ]);
  });

  test("comparisons chain left-to-right", () => {
    expectFormula("=1<2=TRUE", true);
    expectFormula("=1<2<3", "#VALUE!");
  });
});

describe("mini-spreadsheet references and forward references", () => {
  test("a formula can reference a later cell", () => {
    const workbook = withCells({ A1: "=B1+1", B1: 4 });
    expect(workbook.getValue("A1")).toBe(5);
  });

  test("forward chains resolve through formulas", () => {
    const workbook = withCells({
      A1: "=B1+1",
      B1: "=C1*2",
      C1: 3,
    });
    expect(workbook.getValue("B1")).toBe(6);
    expect(workbook.getValue("A1")).toBe(7);
  });

  test("formula references are case-insensitive", () => {
    const workbook = withCells({ A1: "=b1*2", b1: 5 });
    expect(workbook.getValue("A1")).toBe(10);
    expect(workbook.getValue("a1")).toBe(10);
  });

  test("blank references are null", () => {
    const workbook = withCells({ A1: "=B1" });
    expect(workbook.getValue("A1")).toBeNull();
    expect(workbook.getDisplay("A1")).toBe("");
  });

  test("invalid formula references are #REF!", () => {
    expectFormulaTable([
      ["=A0", "#REF!"],
      ["=A01", "#REF!"],
      ["=XFE1", "#REF!"],
      ["=A1048577", "#REF!"],
      ["=SUM(A1:B0)", "#REF!"],
      ["=SUM(XFE1:XFE2)", "#REF!"],
      ["=SUM(A01:A02)", "#REF!"],
    ]);
  });
});

describe("mini-spreadsheet ranges and aggregate functions", () => {
  const data = (): Workbook =>
    withCells({
      A1: 1,
      A2: 2,
      A3: 3,
      B1: 10,
      B2: null,
      B3: "x",
      C1: true,
      C2: 5,
    });

  test("SUM, AVERAGE, MIN, and MAX flatten ranges", () => {
    const workbook = data();
    expect(workbook.getValue("A1")).toBe(1);
    expect(workbook.getValue("B1")).toBe(10);
    expect(workbook.getValue("B2")).toBeNull();
    expect(workbook.getValue("B3")).toBe("x");
    expect(workbook.getValue("C1")).toBe(true);
    expect(workbook.getValue("C2")).toBe(5);

    workbook.setCell("D1", "=SUM(A1:A3)");
    workbook.setCell("D2", "=SUM(A1:B3)");
    workbook.setCell("D3", "=SUM(A1:C2)");
    workbook.setCell("D4", "=AVERAGE(A1:B3)");
    workbook.setCell("D5", "=MIN(A1:B3)");
    workbook.setCell("D6", "=MAX(A1:B3)");
    workbook.setCell("D7", "=SUM(A3:A1)");
    workbook.setCell("D8", "=SUM(B1:A3)");
    workbook.setCell("D9", "=SUM(A1:A3,10,B1)");

    expect(workbook.getValue("D1")).toBe(6);
    expect(workbook.getValue("D2")).toBe(16);
    expect(workbook.getValue("D3")).toBe(18);
    expect(workbook.getValue("D4")).toBe(4);
    expect(workbook.getValue("D5")).toBe(1);
    expect(workbook.getValue("D6")).toBe(10);
    expect(workbook.getValue("D7")).toBe(6);
    expect(workbook.getValue("D8")).toBe(16);
    expect(workbook.getValue("D9")).toBe(26);
  });

  test("range text and booleans are ignored by numeric aggregates", () => {
    const workbook = data();
    workbook.setCell("D1", "=SUM(B3:C3)");
    workbook.setCell("D2", "=COUNT(B3:C3)");
    expect(workbook.getValue("D1")).toBe(0);
    expect(workbook.getValue("D2")).toBe(0);
  });

  test("COUNT counts numeric values only", () => {
    const workbook = data();
    workbook.setCell("D1", "=COUNT(A1:B3)");
    workbook.setCell("D2", "=COUNT(A1:C2)");
    workbook.setCell("D3", '=COUNT(A1:B3,7,"9",TRUE,Z9)');
    workbook.setCell("D4", "=COUNT(A1:A3)");
    expect(workbook.getValue("D1")).toBe(4);
    expect(workbook.getValue("D2")).toBe(4);
    expect(workbook.getValue("D3")).toBe(5);
    expect(workbook.getValue("D4")).toBe(3);
  });

  test("aggregate functions ignore a blank scalar but reject other scalars", () => {
    expectFormula("=SUM(Z1)", 0);
    expectFormula("=SUM(1,2,3)", 6);
    expectFormula('=SUM("5")', "#VALUE!");
    expectFormula("=SUM(TRUE)", "#VALUE!");
    expectFormula("=SUM(1,2/0)", "#DIV/0!");
  });

  test("empty aggregate inputs follow the documented rules", () => {
    expectFormula("=SUM(Z1:Z5)", 0);
    expectFormula("=AVERAGE(Z1:Z5)", "#DIV/0!");
    expectFormula("=MIN(Z1:Z5)", "#VALUE!");
    expectFormula("=MAX(Z1:Z5)", "#VALUE!");
  });

  test("errors in a range propagate through every aggregate", () => {
    const workbook = withCells({
      A1: 1,
      A2: "=1/0",
      A3: 3,
      B1: "=SUM(A1:A3)",
      B2: "=AVERAGE(A1:A3)",
      B3: "=MIN(A1:A3)",
      C1: "=MAX(A1:A3)",
      C2: "=COUNT(A1:A3)",
    });
    for (const address of ["B1", "B2", "B3", "C1", "C2"]) {
      expect(workbook.getValue(address)).toBe("#DIV/0!");
    }
  });

  test("bad aggregate arity is #VALUE!", () => {
    for (const name of ["SUM", "AVERAGE", "MIN", "MAX", "COUNT"]) {
      expectFormula(`=${name}()`, "#VALUE!");
    }
  });

  test("function names and range references are case-insensitive", () => {
    const workbook = withCells({ A1: 1, A2: 2, A3: 3 });
    workbook.setCell("B1", "=sum(a1:a3)");
    workbook.setCell("B2", "=Average(A1:A3)");
    workbook.setCell("B3", "=MiN(a1:A3)");
    workbook.setCell("B4", "=MaX(a1:a3)");
    workbook.setCell("B5", "=count(a1:a3)");
    expect(workbook.getValue("B1")).toBe(6);
    expect(workbook.getValue("B2")).toBe(2);
    expect(workbook.getValue("B3")).toBe(1);
    expect(workbook.getValue("B4")).toBe(3);
    expect(workbook.getValue("B5")).toBe(3);
  });
});

describe("mini-spreadsheet IF", () => {
  test("selects a branch by value", () => {
    expectFormula("=IF(TRUE,1,2)", 1);
    expectFormula("=IF(FALSE,1,2)", 2);
    expectFormula('=IF(TRUE,"yes","no")', "yes");
    expectFormula('=IF(1<2,"yes","no")', "yes");
    expectFormula("=IF(FALSE,TRUE,FALSE)", false);
  });

  test("only the selected branch is evaluated", () => {
    expectFormula("=IF(TRUE,1,1/0)", 1);
    expectFormula("=IF(FALSE,1/0,2)", 2);
    expectFormula("=IF(TRUE,1,NOPE(1))", 1);
    expectFormula("=IF(FALSE,NOPE(1),2)", 2);
    expectFormula("=IF(FALSE,1,NOPE(1))", "#NAME?");
    expectFormula("=IF(TRUE,NOPE(1),2)", "#NAME?");
  });

  test("an unselected self-reference does not create a cycle", () => {
    const workbook = withCells({ A1: "=IF(FALSE,A1,2)" });
    expect(workbook.getValue("A1")).toBe(2);
    const selected = withCells({ A1: "=IF(TRUE,A1,2)" });
    expect(selected.getValue("A1")).toBe("#CYCLE!");
  });

  test("the condition must be a boolean", () => {
    expectFormula("=IF(1,2,3)", "#VALUE!");
    expectFormula("=IF(Z1,2,3)", "#VALUE!");
    expectFormula('=IF("TRUE",2,3)', "#VALUE!");
    expectFormula("=IF(1/0,2,3)", "#DIV/0!");
  });

  test("IF has exact arity and scalar branches", () => {
    expectFormula("=IF(TRUE,1)", "#VALUE!");
    expectFormula("=IF(TRUE,1,2,3)", "#VALUE!");
    expectFormula("=IF(TRUE,A1:B2,0)", "#VALUE!");
  });
});

describe("mini-spreadsheet ABS and ROUND", () => {
  test("ABS returns the magnitude of a number", () => {
    expectFormulaTable([
      ["=ABS(-3)", 3],
      ["=ABS(3)", 3],
      ["=ABS(0)", 0],
      ["=ABS(-2.5)", 2.5],
    ]);
  });

  test("ABS rejects non-numbers and bad arity", () => {
    expectFormulaTable([
      ['=ABS("3")', "#VALUE!"],
      ["=ABS(TRUE)", "#VALUE!"],
      ["=ABS(Z1)", "#VALUE!"],
      ["=ABS()", "#VALUE!"],
      ["=ABS(1,2)", "#VALUE!"],
      ["=ABS(1/0)", "#DIV/0!"],
    ]);
  });

  test("ROUND rounds half away from zero", () => {
    expectFormulaTable([
      ["=ROUND(2.5,0)", 3],
      ["=ROUND(-2.5,0)", -3],
      ["=ROUND(1.2345,2)", 1.23],
      ["=ROUND(1.235,2)", 1.24],
      ["=ROUND(1234,0)", 1234],
      ["=ROUND(1.2,8)", 1.2],
      ["=ROUND(0,0)", 0],
      ["=ROUND(-0.4,0)", 0],
    ]);
  });

  test("ROUND validates both arguments", () => {
    expectFormulaTable([
      ['=ROUND("2",0)', "#VALUE!"],
      ["=ROUND(TRUE,0)", "#VALUE!"],
      ["=ROUND(Z1,0)", "#VALUE!"],
      ["=ROUND(1,-1)", "#VALUE!"],
      ["=ROUND(1,9)", "#VALUE!"],
      ["=ROUND(1,1.5)", "#VALUE!"],
      ['=ROUND(1,"2")', "#VALUE!"],
      ["=ROUND(1,TRUE)", "#VALUE!"],
      ["=ROUND(1,Z1)", "#VALUE!"],
      ["=ROUND(1)", "#VALUE!"],
      ["=ROUND(1,2,3)", "#VALUE!"],
      ["=ROUND(1/0,0)", "#DIV/0!"],
      ["=ROUND(1,1/0)", "#DIV/0!"],
    ]);
  });
});

describe("mini-spreadsheet names and unknown functions", () => {
  test("unknown functions and bare identifiers are #NAME?", () => {
    expectFormulaTable([
      ["=NOPE(1)", "#NAME?"],
      ["=NOPE()", "#NAME?"],
      ["=FOO", "#NAME?"],
      ["=FOO+1", "#NAME?"],
      ["=SUM(FOO)", "#NAME?"],
    ]);
  });
});

describe("mini-spreadsheet parse errors", () => {
  test("malformed formulas become #PARSE!", () => {
    const formulas = [
      "=",
      "=  ",
      "=1+",
      "=1 2",
      "=SUM(1,",
      "=SUM(,1)",
      "=SUM(1,)",
      "=SUM(1 2)",
      "=)",
      "=()",
      "=1..2",
      "=1+*2",
      '="abc',
      '="a\\q"',
      "=A1:",
      "=A1:B2",
      "=SUM((A1:B2))",
      "=SUM(1:A2)",
      "=SUM(A1:)",
      "=SUM(A1:B2:C3)",
    ];
    for (const formula of formulas) {
      expectFormula(formula, "#PARSE!");
    }
  });

  test("a leading space means the input is a literal string", () => {
    const workbook = withCells({ A1: " =1+1" });
    expect(workbook.getValue("A1")).toBe(" =1+1");
    expect(workbook.getDisplay("A1")).toBe(" =1+1");
  });

  test("error-looking literal strings stay strings", () => {
    const workbook = withCells({
      A1: "#DIV/0!",
      A2: '=A1&"x"',
      A3: "=A1+1",
    });
    expect(workbook.getValue("A1")).toBe("#DIV/0!");
    expect(workbook.getValue("A2")).toBe("#DIV/0!x");
    expect(workbook.getValue("A3")).toBe("#VALUE!");
  });
});

describe("mini-spreadsheet cycles", () => {
  test("a self-reference is a cycle", () => {
    const workbook = withCells({ A1: "=A1" });
    expect(workbook.getValue("A1")).toBe("#CYCLE!");
    expect(workbook.getDisplay("A1")).toBe("#CYCLE!");
  });

  test("every cell in a cycle is marked and errors propagate outward", () => {
    const workbook = withCells({
      A1: "=B1",
      B1: "=A1",
      C1: "=A1+1",
      D1: "=1+1",
    });
    expect(workbook.getValue("A1")).toBe("#CYCLE!");
    expect(workbook.getValue("B1")).toBe("#CYCLE!");
    expect(workbook.getValue("C1")).toBe("#CYCLE!");
    expect(workbook.getValue("D1")).toBe(2);
  });

  test("a longer cycle is detected", () => {
    const workbook = withCells({
      A1: "=B1",
      B1: "=C1",
      C1: "=A1",
    });
    expect(workbook.getValue("A1")).toBe("#CYCLE!");
    expect(workbook.getValue("B1")).toBe("#CYCLE!");
    expect(workbook.getValue("C1")).toBe("#CYCLE!");
  });

  test("a range can participate in a cycle", () => {
    const workbook = withCells({
      A1: 1,
      A2: "=SUM(A1:A3)",
      A3: "=A2+1",
    });
    expect(workbook.getValue("A1")).toBe(1);
    expect(workbook.getValue("A2")).toBe("#CYCLE!");
    expect(workbook.getValue("A3")).toBe("#CYCLE!");
  });

  test("a self-including range is a cycle", () => {
    const workbook = withCells({ A1: "=SUM(A1)" });
    expect(workbook.getValue("A1")).toBe("#CYCLE!");
  });

  test("breaking a cycle restores every affected cell", () => {
    const workbook = withCells({
      A1: "=B1",
      B1: "=A1",
      C1: "=A1+1",
    });
    expect(workbook.getValue("C1")).toBe("#CYCLE!");
    workbook.setCell("B1", 5);
    expect(workbook.getValue("A1")).toBe(5);
    expect(workbook.getValue("B1")).toBe(5);
    expect(workbook.getValue("C1")).toBe(6);
  });
});

describe("mini-spreadsheet dependency invalidation", () => {
  test("changing a precedent immediately updates dependents", () => {
    const workbook = withCells({ A1: "=B1*2", B1: 3 });
    expect(workbook.getValue("A1")).toBe(6);
    workbook.setCell("B1", 4);
    expect(workbook.getValue("A1")).toBe(8);
  });

  test("a dependency chain updates transitively", () => {
    const workbook = withCells({
      A1: "=B1*2",
      B1: "=C1+1",
      C1: 1,
    });
    expect(workbook.getValue("A1")).toBe(4);
    workbook.setCell("C1", 5);
    expect(workbook.getValue("A1")).toBe(12);
  });

  test("replacing a formula with a literal stops dependency tracking", () => {
    const workbook = withCells({ A1: "=B1*2", B1: 3 });
    workbook.setCell("A1", 99);
    expect(workbook.getValue("A1")).toBe(99);
    workbook.setCell("B1", 10);
    expect(workbook.getValue("A1")).toBe(99);
  });

  test("clearing a precedent recalculates dependents", () => {
    const workbook = withCells({
      A1: "=B1*2",
      A2: '=B1&"x"',
      B1: 3,
    });
    expect(workbook.getValue("A1")).toBe(6);
    expect(workbook.getValue("A2")).toBe("3x");
    workbook.setCell("B1", null);
    expect(workbook.getValue("A1")).toBe("#VALUE!");
    expect(workbook.getValue("A2")).toBe("x");
  });

  test("recalculate keeps results consistent after changes", () => {
    const workbook = withCells({ A1: "=B1+1", A2: "=A1*2", B1: 1 });
    expect(workbook.getValue("A2")).toBe(4);
    workbook.setCell("B1", 9);
    workbook.recalculate();
    expect(workbook.getValue("A1")).toBe(10);
    expect(workbook.getValue("A2")).toBe(20);
  });

  test("recalculate after a cycle can observe the repaired state", () => {
    const workbook = withCells({ A1: "=B1", B1: "=A1" });
    expect(workbook.getValue("A1")).toBe("#CYCLE!");
    workbook.setCell("B1", 7);
    workbook.recalculate();
    expect(workbook.getValue("A1")).toBe(7);
  });
});
