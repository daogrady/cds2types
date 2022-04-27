import * as au from "../../src/array.util";
import * as _ from "lodash";

const CHARS_LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "1234567890";
const SPECIAL = "-_ ";
const ALPHABET = CHARS_LOWER + CHARS_LOWER.toUpperCase() + DIGITS + SPECIAL;

const pick = <T>(xs: Array<T>): T => xs[Math.floor(Math.random() * xs.length)];

const randInt = (lo: number, hi: number): number =>
    Math.floor(Math.random() * (hi - lo + 1)) + lo;

const randStr = (l: number): string =>
    genArray(l, () => pick(ALPHABET.split(""))).join("");

const genArray = <T>(n: number, f: () => T): Array<T> => [...Array(n)].map(f);

const randInts = (n: number, lo: number, hi: number) =>
    genArray(n, () => randInt(lo, hi));

// output of _ === output of au
const equal = (
    s: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply: (lib: any, ...args: any) => unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any
) =>
    test(`${s}(${args})`, () =>
        expect(apply(au, args)).toStrictEqual(apply(_, args)));

equal("min", (lib, args) => lib.min(args), randInts(10, -100, 100));
equal("last", (lib, args) => lib.last(args), randInts(10, -100, 100));
equal("split", (lib, [xs, sep]) => lib.split(xs, sep), [randStr(1000), " "]);
equal("split with limit", (lib, [xs, sep, n]) => lib.split(xs, sep, n), [
    randStr(1000),
    " ",
    2,
]);
equal("isEmpty true", (lib, args) => lib.isEmpty(args), randInts(0, 1, 1));
equal("isEmpty false", (lib, args) => lib.isEmpty(args), randInts(10, 1, 1));
equal(
    "replace plain",
    (lib, [str, what, repl]) => lib.replace(str, what, repl),
    [randStr(1000), "a", "b"]
);
equal(
    "replace regex",
    (lib, [str, what, repl]) => lib.replace(str, what, repl),
    [randStr(100), /\s/, "b"]
);
equal("join", (lib, [xs, glue]) => lib.join(xs, glue), [
    randStr(1000).split(" "),
    "+",
]);
equal("takeRight", (lib, [xs, n]) => lib.takeRight(xs, n), [
    randInts(10, -10, 10),
    randInt(-2, 21),
]);
equal("takeRight", (lib, [xs, n]) => lib.takeRight(xs, n), [[1, 2, 3, 4], -2]);
equal("flatten", (lib, args) => lib.flatten(args), [
    randInts(10, -10, 10),
    randInts(10, -10, 10),
]);
equal("startcase", (lib, args) => lib.startCase(args), randStr(1000));
equal("startcase", (lib, args) => lib.startCase(args), "--foo-bar--");
equal("startcase", (lib, args) => lib.startCase(args), "fooBar");
equal("startcase", (lib, args) => lib.startCase(args), "__FOO_BAR__");

/*
_.startCase('--foo-bar--');
// => 'Foo Bar'
 
_.startCase('fooBar');
// => 'Foo Bar'
 
_.startCase('__FOO_BAR__');
// => 'FOO BAR'
*/
