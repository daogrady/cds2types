import * as morph from "ts-morph";
import path from "path";
import { Definition, IElement } from "./utils/types";
import { Kind } from "./utils/cds.types";
import { Namespace } from "./types/namespace";
import { CSN } from "@sap/cds/apis/csn";

/**
 * Bit of a hack. We need one namespace for entities on top level.
 * That namespace has no name. As creating a namespace with a falsey
 * value as name causes an error, we use a placeholder name. During printout,
 * we check for that placeholder and just don't print any name.
 */
const ROOT_NAMESPACE_NAME = "$ROOT$";

/**
 * Module Qualifier that points to either a module
 * or a class/ interface within the module. I.e.
 *
 * foo.bar
 * or
 * foo.bar.A
 *
 * Used to print out different flavours of a namespace,
 * e.g. as import, as path pointing to the containing file,
 * as convenient alias.
 */
class ModuleQualifier {
    private module: string;
    public readonly clazz: string | undefined;

    /**
     * @param path foo.bar, foo.bar.A, ...
     * @param containsClass if set to true, the last part will be considered a class name.
     */
    constructor(path: string, containsClass = false) {
        // TODO: collect imports from the using-directive, instead of using the extends parts
        if (containsClass) {
            [this.module, this.clazz] = splitNamespace(path);
        } else {
            this.module = path;
        }
    }

    /**
     * @returns only the namespace.
     */
    public getNamespace(): string {
        return this.module;
    }

    /**
     * @returns the namespace, but with path separators instead of dots.
     */
    public getDirectory(): string {
        return this.getNamespace().replace(/\./g, "/");
    }

    /**
     * @returns a name usable as alias in an import. I.e.
     * foo.bar.baz become _foo_bar_baz. The leading underscore
     * ensures that we never end up with an empty name for top level namespaces.
     */
    public getAlias(): string {
        return (
            // prepending an underscore helps with the top-level NS,
            // which would resolve to an empty string, leading to:
            // import * as  from foo
            "_" +
            [this.getNamespace().replace(/\./g, "_"), this.clazz]
                .filter((x) => !!x)
                .join(".")
        );
    }

    /**
     * @param rel the directory to which we try to find the relative path to.
     * @returns relative path to rel, i.e. "foo.bar.baz".getRelativePath("foo.bar.moo") === "../moo"
     */
    public getRelativePath(rel: string): string {
        return path.relative(rel, this.getDirectory());
    }
}

/**
 * TODO
 * @param name fully qualified import name.
 * @param rel path to resolve relative to.
 * @param cson CSON context.
 * @returns resolved path.
 */
const resolveImport = (name: string, rel: string, cson: CSN): string => {
    if (cson.definitions !== undefined) {
        type ExtDefinition = Definition & { $location };
        const def: ExtDefinition & { $location } = cson.definitions[
            name
        ] as unknown as ExtDefinition;
    }
    return name;
};

/**
 * Converts all interfaces (which don't exist in plain JS)
 * to classes.
 * @param sourceClosure either a namespace or a top level source to collect the interfaces from.
 * @param context top level source to resolve from.
 * @param destinationClosure namespace or top leve source to write the classes into.
 * @param removeFromSource if set to true, the interfaces will be removed from the source closure after conversion.
 */
const interfacesToClasses = (
    sourceClosure: morph.NamespaceDeclaration | morph.SourceFile,
    context: morph.SourceFile,
    destinationClosure:
        | morph.NamespaceDeclaration
        | morph.SourceFile = sourceClosure,
    removeFromSource = true
) => {
    sourceClosure.getInterfaces().forEach((i) => {
        const clazz: morph.ClassDeclarationStructure = {
            kind: morph.StructureKind.Class,
            name: i.getName(),
            isExported: true,
            properties: i.getProperties().map((p) => ({
                name: p.getName(),
                type: getTypeText(p),
            })),
            extends: i
                .getExtends()
                .map((ancestor) => ancestor.getText())
                .join(","),
        };

        const ancestors = (clazz.extends as string).split(",");
        ancestors.forEach((fqAncestorName) => {
            const [nsName, ancestorName] = splitNamespace(fqAncestorName);
            (nsName === ""
                ? context.getInterfaces()
                : context.getNamespace(nsName)?.getInterfaces()
            )
                ?.find((i) => i.getName() === ancestorName)
                ?.getProperties()
                .forEach((p) => addOrAmendProperty(clazz, p));
        });
        clazz.extends = "";

        destinationClosure.addClass(clazz);
    });

    // have to do a second pass, or all interfaces after the first
    // will be marked as "forgotten" and cause trouble
    if (removeFromSource) {
        sourceClosure.getInterfaces().forEach((i) => i.remove());
    }
};

/**
 * Converts TS compliant code to JS compliant code.
 * @param source source file to convert.
 */
const rectify = (source: morph.SourceFile) => {
    source.getNamespaces().forEach((ns) => interfacesToClasses(ns, source));
    interfacesToClasses(source, source);
};

/**
 * Creates JS class stubs. Removes all TS specific syntax.
 * @param ns namespace to create the classes for.
 * @param target source to generate the stubs into.
 * @param context context file.
 */
const generateStubs = (
    ns: morph.NamespaceDeclaration,
    target: morph.SourceFile,
    context: morph.SourceFile
) => {
    // FIXME: switch for commonjs vs esm
    interfacesToClasses(ns, context, target, false);
    // remove types and keywords for JS compliance
    const classes = target.getClasses();
    const exports = classes
        .filter((c) => c.isExported())
        .map((c) => c.getName());
    classes.forEach((c) => {
        c.getProperties().forEach((p) => p.setType(""));
        c.setIsExported(false);
    });

    target.addStatements(`module.exports = {${exports.join(",\n  ")}}`);
};

/**
 * Retrieves the type text from a property.
 * @param p Property to retrieve the type for.
 * @returns Type of property, if possible, else "any".
 */
const getTypeText = (p): string => {
    try {
        return p.getType().getText();
    } catch {
        return "any";
    }
};

/**
 * Splits namespace off an import.
 * @param fqName fully qualified import name, i.e. "foo.bar.A".
 * @returns tuple of the namespace and the import, i.e. ["foo.bar", "A"]
 */
const splitNamespace = (fqName: string): [string, string] => {
    const tokens = fqName.split(".");
    const namespaceName = tokens.slice(0, -1).join(".");
    const ancestorName = tokens.slice(-1).join("");
    return [namespaceName, ancestorName];
};

/**
 * Adds or amends a property to a class.
 * That is: if...
 * (1) the class does not know the property,
 * it will be added.
 * (2) the property is known by name but with another type,
 * its type will be added as option.
 * (3) the property is known by both name and type,
 * nothing will be done.
 * @param clazz The class to add the property to.
 * @param prop The property to add.
 */
const addOrAmendProperty = (
    clazz: morph.ClassDeclarationStructure,
    prop: morph.PropertySignature
) => {
    const existing = clazz.properties?.find((p) => p.name === prop.getName());
    if (existing) {
        const sep = " | ";
        const tt = getTypeText(prop);
        if (!(existing.type as string).split(sep).includes(tt)) {
            existing.type += sep + tt;
        }
    } else {
        clazz.properties?.push({
            name: prop.getName(),
            type: getTypeText(prop),
        });
    }
};

/**
 * Collects all required import paths from a namespace.
 * That is: browses through all extend clauses and properties
 * of all interfaces in the namespace and resolves them to import statements
 * if they are part of another namespace.
 * @param ns the namespace to collect the imports from.
 * @param rel relative path.
 * @param source source file in which to resolve the imports.
 * @param cson CSON context.
 * @returns a list of module qualifiers describing the imports for the namespace.
 */
// TODO: also resolve imports for properties from other namespaces
const getImportPaths = (
    ns: morph.NamespaceDeclaration,
    rel: string,
    source: morph.SourceFile,
    cson: CSN
): ModuleQualifier[] => {
    return [
        ...new Set(
            ns
                .getInterfaces()
                .map((i) =>
                    i
                        .getExtends()
                        .filter((e) => !!e.getText())
                        .map((e) => resolveImport(e.getText(), rel, cson))
                        .map((e) => splitNamespace(e)[0])
                )
                .reduce((prev, curr) => prev.concat(curr), []) // flatten
        ),
    ] // extract unique module paths
        .map((p) => new ModuleQualifier(p))
        .filter((q) => !!q.getRelativePath(rel)); // empty rel path == same namespace
};

/**
 * Writes the namespace to its own file.
 * @param ns namespace to write.
 * @param output root directory for all namespaces (prefix for path).
 * @param source context source.
 * @param cson context CSON.
 */
const writeNamespace = async (
    ns: morph.NamespaceDeclaration,
    output: string,
    source: morph.SourceFile,
    cson: CSN
) => {
    // generate .d.ts
    const nsParts = ns.getName().split(".");
    const rel = path.join(...nsParts);
    const directory =
        ns.getName() === ROOT_NAMESPACE_NAME ? output : path.join(output, rel);

    // unwrap from namespace (it is its own file now)
    const dTsFile = source
        .getProject()
        .createSourceFile(path.join(directory, "index.d.ts"));

    getImportPaths(ns, rel, source, cson).forEach((imp) =>
        dTsFile.addImportDeclaration({
            moduleSpecifier: imp.getRelativePath(rel),
            namespaceImport: imp.getAlias(),
        })
    );

    const nsmq = new ModuleQualifier(ns.getName());
    ns.getInterfaces().forEach((i) =>
        dTsFile.addInterface({
            name: i.getName(),
            extends: i.getExtends().map((e) => {
                const mq = new ModuleQualifier(e.getText(), true);
                return mq.getNamespace() === nsmq.getNamespace()
                    ? (mq.clazz as string)
                    : mq.getAlias();
            }),
            isExported: true,
            properties: i.getProperties().map((p) => ({
                name: p.getName(),
                type: getTypeText(p),
            })),
        })
    );
    dTsFile.save();

    // generate .js
    const jsFile = source
        .getProject()
        .createSourceFile(path.join(directory, "index.js"));
    generateStubs(ns, jsFile, source);
    jsFile.save();
};

export const emitJSCompliantFiles = (
    source: morph.SourceFile,
    options,
    cson
) => {
    const rootDefs = source.getInterfaces().reduce(
        (dict, inter) =>
            dict.set(inter.getName(), {
                kind: Kind.Entity,
                elements: inter.getProperties().reduce(
                    (dict, prop) =>
                        dict.set(prop.getName(), {
                            type: getTypeText(prop),
                            canBeNull: false,
                        }),
                    new Map<string, IElement>()
                ),
            }),
        new Map<string, Definition>()
    );

    const rootSourceFile: morph.SourceFile = source
        .getProject()
        .createSourceFile(options.output + "/index.d.ts");
    const rootNamespace: Namespace = new Namespace(rootDefs, "");
    rootNamespace.generateCode(rootSourceFile, []);
    rootSourceFile.save();

    source
        .getNamespaces()
        .forEach((ns) => writeNamespace(ns, options.output, source, cson));
};
