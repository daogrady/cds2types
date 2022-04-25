export const last = <T>(xs: Array<T>): T => xs[xs.length - 1];

export const min = (xs: Array<number>): number => Math.min(...xs);

export const split = (
    str: string,
    separator: string,
    limit: number | undefined
) => str.split(separator, limit);

export const isEmpty = <T>(xs: Array<T>): boolean => xs.length === 0;

export const replace = (
    string: string,
    pattern: string | RegExp,
    replacement: string
): string => string.replace(pattern, replacement);

export const startCase = (str: string): string =>
    str
        .split(/(?=[A-Z\s])/)
        .map((s) => s.trim())
        .filter((s) => !!s)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ");

export const join = <T>(xs: Array<T>, glue: string) => xs.join(glue);

export const takeRight = <T>(xs: Array<T>, n: number): Array<T> => xs.slice(-n);

export const flatten = <T>(xss: Array<Array<T>>): Array<T> =>
    xss.reduce((prev, current) => prev.concat(current), []);
