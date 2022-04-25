import _, { min, split } from "lodash";
import cds from "@sap/cds";
import * as fs from "fs-extra";
import * as morph from "ts-morph";
import path, { resolve } from "path";

import { Definition, IOptions, IParsed } from "./utils/types";
import { CDSParser } from "./cds.parser";
import { ICsn } from "./utils/cds.types";
import { Namespace } from "./types/namespace";
import { Formatter } from "./formatter/formatter";
import { NoopFormatter } from "./formatter/noop.formatter";
import { PrettierFormatter } from "./formatter/prettier.formatter";
import { CSN } from "@sap/cds/apis/csn";

const getTypeText = (p): string => {
    try {
        return p.getType().getText();
    } catch {
        return "any";
    }
};

const splitNamespace = (fqName: string): [string, string] => {
    const tokens = fqName.split(".");
    const namespaceName = tokens.slice(0, -1).join(".");
    const ancestorName = tokens.slice(-1).join("");
    return [namespaceName, ancestorName];
};

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

class ModuleQualifier {
    private module: string;
    public readonly clazz: string | undefined;

    constructor(path: string, containsClass = false) {
        // TODO: collect imports from the using-directive, instead of using the extends parts
        if (!path) {
            //throw Error("");
        }
        if (containsClass) {
            [this.module, this.clazz] = splitNamespace(path);
        } else {
            this.module = path;
        }
    }

    public getNamespace(): string {
        return this.module;
    }

    public getDirectory(): string {
        return this.getNamespace().replace(/\./g, "/");
    }

    public getAlias(): string {
        return [this.getNamespace().replace(/\./g, "_"), this.clazz]
            .filter((x) => !!x)
            .join(".");
    }

    public getRelativePath(rel: string): string {
        console.log(
            "RELATIVE",
            rel,
            " -> ",
            this.getDirectory(),
            ": ",
            path.relative(rel, this.getDirectory())
        );
        return path.relative(rel, this.getDirectory());
    }
}

const resolveImport = (name: string, rel: string, cson: CSN): string => {
    if (cson.definitions !== undefined) {
        type ExtDefinition = Definition & { $location };
        const def: ExtDefinition & { $location } = cson.definitions[
            name
        ] as unknown as ExtDefinition;
    }
    return name;
};

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
                .map(
                    (i) =>
                        i
                            .getExtends()
                            .filter((e) => !!e.getText())
                            .map((e) => resolveImport(e.getText(), rel, cson))
                            .map((e) => splitNamespace(e)[0])
                    //.map((e) => splitNamespace(e.getText())[0])
                )
                .reduce((prev, curr) => prev.concat(curr), []) // flatten
        ),
    ] // extract unique module paths
        .map((p) => new ModuleQualifier(p))
        .filter((q) => !!q.getRelativePath(rel)); // empty rel path == same namespace
};

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
        ns.getName() === rootNamespaceName ? output : path.join(output, rel);

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
    new JSVisitor().generateStubs(ns, jsFile, source);
    jsFile.save();
};

const rootNamespaceName = "ROOT";

class JSVisitor {
    private interfacesToClasses(
        sourceClosure: morph.NamespaceDeclaration | morph.SourceFile,
        context: morph.SourceFile,
        destinationClosure:
            | morph.NamespaceDeclaration
            | morph.SourceFile = sourceClosure,
        removeFromSource = true
    ) {
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
    }

    public rectify(source: morph.SourceFile) {
        source
            .getNamespaces()
            .forEach((ns) => this.interfacesToClasses(ns, source));
        this.interfacesToClasses(source, source);
    }

    public generateStubs(
        ns: morph.NamespaceDeclaration,
        target: morph.SourceFile,
        context: morph.SourceFile
    ) {
        // FIXME: switch for commonjs vs esm
        this.interfacesToClasses(ns, context, target, false);
        // remove types and keywords for JS compliance
        const classes = target.getClasses();
        const exports = classes
            .filter((c) => c.isExported())
            .map((c) => c.getName());
        classes.forEach((c) => {
            c.getProperties().forEach((p) => p.setType(""));
            c.setIsExported(false);
        });

        target.addStatements(`module.export = {${exports.join(",\n  ")}}`);
    }
}

/**
 * Main porgram class.
 *
 * @export
 * @class Program
 */
export class Program {
    /**
     * Main method.
     *
     * @param {Command} options Parsed CLI options.
     * @memberof Program
     */
    public async run(options: IOptions): Promise<void> {
        // Load compiled CDS.
        // FIXME: swap out
        const cson: CSN = await cds.load(options.cds);
        const jsonObj = await this.loadCdsAndConvertToJSON(options.cds);

        // Write the compiled CDS JSON to disc for debugging.
        if (options.json) {
            fs.writeFileSync(options.output + ".json", JSON.stringify(jsonObj));
        }

        // Parse compile CDS.
        const parsed = new CDSParser().parse(jsonObj as ICsn);

        // Remove the output file if it already exists.
        if (fs.existsSync(options.output)) {
            fs.removeSync(options.output);
        }

        // Initialize the formatter and retrieve its settings.
        const formatter = await this.createFormatter(options);
        const settings = formatter.getSettings();

        // Create ts-morph project and source file to write to.
        const project = new morph.Project({ manipulationSettings: settings });
        const source = project.createSourceFile(options.output);

        // Generate the actual source code.
        this.generateCode(source, parsed, options.prefix);

        // Do conversions to be available as JS intellisense, if required
        if (options.javascript) {
            //new JSVisitor().rectify(source);
            source.addNamespace({
                name: rootNamespaceName,
            });
            source.getInterfaces().forEach((i) =>
                source.getNamespace(rootNamespaceName)?.addInterface({
                    name: i.getName(),
                    extends: i.getExtends().map((e) => {
                        return "FOO";
                        /*
                    const mq = new ModuleQualifier(e.getText(), true);
                    return mq.getNamespace() === nsmq.getNamespace()
                        ? (mq.clazz as string)
                        : mq.getAlias();
                    */
                    }),
                    isExported: true,
                    properties: i.getProperties().map((p) => ({
                        name: p.getName(),
                        type: getTypeText(p),
                    })),
                })
            );

            source
                .getNamespaces()
                .forEach((ns) =>
                    writeNamespace(ns, options.output, source, cson)
                );
        } else {
            // Extract source code and format it.
            source.formatText();
            const text = source.getFullText();
            const formattedText = await formatter.format(text);

            // Write the actual source file.
            await this.writeSource(options.output, formattedText);
        }
    }

    /**
     * Creates a formatter based on given options.
     *
     * @private
     * @param {IOptions} options Options to create a formatter for
     * @returns {Promise<Formatter>} Created formatter
     * @memberof Program
     */
    private async createFormatter(options: IOptions): Promise<Formatter> {
        return options.format
            ? await new PrettierFormatter(options.output).init()
            : await new NoopFormatter(options.output).init();
    }

    /**
     * Loads a given CDS file and parses the compiled JSON to a object.
     *
     * @private
     * @param {string} path Path to load the CDS file from.
     * @returns {Promise<any>}
     * @memberof Program
     */
    private async loadCdsAndConvertToJSON(path: string): Promise<unknown> {
        const csn = await cds.load(path);
        return JSON.parse(cds.compile.to.json(csn));
    }

    /**
     * Extracts the types from a parsed service and generates the Typescript code.
     *
     * @private
     * @param {morph.SourceFile} source Source file to generate the typescript code in
     * @param {IParsed} parsed Parsed definitions, services and namespaces
     * @memberof Program
     */
    private generateCode(
        source: morph.SourceFile,
        parsed: IParsed,
        interfacePrefix = ""
    ): void {
        const namespaces: Namespace[] = [];
        if (parsed.namespaces) {
            const ns = parsed.namespaces.map(
                (n) => new Namespace(n.definitions, interfacePrefix, n.name)
            );

            namespaces.push(...ns);
        }

        if (parsed.services) {
            const ns = parsed.services.map(
                (s) => new Namespace(s.definitions, interfacePrefix, s.name)
            );

            namespaces.push(...ns);
        }

        if (parsed.definitions) {
            const ns = new Namespace(parsed.definitions, interfacePrefix, "");

            namespaces.push(ns);
        }

        for (const namespace of namespaces) {
            const types = _.flatten(namespaces.map((n) => n.getTypes()));
            namespace.generateCode(source, types);
        }
    }

    /**
     * Writes the types to disk.
     *
     * @private
     * @param {string} filepath File path to save the types at
     * @memberof Program
     */
    private async writeSource(filepath: string, source: string): Promise<void> {
        const dir = path.dirname(filepath);
        if (fs.existsSync(dir)) {
            await fs.writeFile(filepath, source);

            console.log(`Wrote types to '${filepath}'`);
        } else {
            console.error(
                `Unable to write types: '${dir}' is not a valid directory`
            );

            process.exit(-1);
        }
    }
}
