import _ from "lodash";
import cds from "@sap/cds";
import * as fs from "fs-extra";
import * as morph from "ts-morph";
import path from "path";

import { IOptions, IParsed } from "./utils/types";
import { CDSParser } from "./cds.parser";
import { ICsn } from "./utils/cds.types";
import { Namespace } from "./types/namespace";
import { Formatter } from "./formatter/formatter";
import { NoopFormatter } from "./formatter/noop.formatter";
import { PrettierFormatter } from "./formatter/prettier.formatter";

/**
 * Main porgram class.
 *
 * @export
 * @class Program
 */
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
                const tokens = fqAncestorName.split(".");
                const namespaceName = tokens.slice(0, -1).join(".");
                const ancestorName = tokens.slice(-1).join("");
                (namespaceName === ""
                    ? context.getInterfaces()
                    : context.getNamespace(namespaceName)?.getInterfaces()
                )
                    ?.find((i) => i.getName() === ancestorName)
                    ?.getProperties()
                    .forEach((prop) => {
                        const existing = clazz.properties?.find(
                            (p) => p.name === prop.getName()
                        );
                        if (existing) {
                            const sep = " | ";
                            const tt = getTypeText(prop);
                            if (
                                !(existing.type as string)
                                    .split(sep)
                                    .includes(tt)
                            ) {
                                existing.type += sep + tt;
                            }
                        } else {
                            clazz.properties?.push({
                                name: prop.getName(),
                                type: getTypeText(prop),
                            });
                        }
                    });
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
        // remove types for JS compliance
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
export class Program {
    /**
     * Main method.
     *
     * @param {Command} options Parsed CLI options.
     * @memberof Program
     */
    public async run(options: IOptions): Promise<void> {
        // Load compiled CDS.
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
            source.getNamespaces().forEach(async (ns) => {
                // generate .d.ts
                // collect required imports
                const nsParts = ns.getName().split(".");
                const rel = path.join(...nsParts);
                const directory = path.join(options.output, rel);

                const imports = new Set(
                    ns
                        .getInterfaces()
                        .map((i) =>
                            i
                                .getExtends()
                                .map((ex) => splitNamespace(ex.getText())[0])
                        ) // retrieve namespace part
                        .reduce((prev, curr) => prev.concat(curr), []) // flatten
                        .map((p) => "../".repeat(nsParts.length - 1) + rel) // to relative path
                );
                console.log(imports);

                // unwrap from namespace (it is its own file now)

                /*
                const text = ns
                    .getInterfaces()
                    .map((i) => i.getText())
                    .join("\n");
                const formattedText = await formatter.format(text);
                

                console.log(`imports in ${ns.getName()}: `, imports);

                await fs.mkdir(directory, { recursive: true });
                console.log(directory);
                await this.writeSource(
                    path.join(directory, "index.d.ts"),
                    formattedText
                );
                */

                const dTsFile = source
                    .getProject()
                    .createSourceFile(path.join(directory, "index.d.ts"));

                imports.forEach((imp) =>
                    dTsFile.addImportDeclaration({
                        moduleSpecifier: imp,
                    })
                );
                imports.forEach((imp) => console.log(imp));

                ns.getInterfaces().forEach((i) =>
                    dTsFile.addInterface({
                        name: i.getName(),
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
            });
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
