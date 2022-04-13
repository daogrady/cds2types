import _ from "lodash";
import cds from "@sap/cds";
import * as fs from "fs-extra";
import * as morph from "ts-morph";
import * as path from "path";

import { IOptions, IParsed } from "./utils/types";
import { CDSParser } from "./cds.parser";
import { ICsn, Kind } from "./utils/cds.types";
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

class JSVisitor {
    private interfacesToClasses(
        closure: morph.NamespaceDeclaration | morph.SourceFile,
        context: morph.SourceFile
    ) {
        closure.getInterfaces().forEach((i) => {
            const clazz: morph.ClassDeclarationStructure = {
                kind: morph.StructureKind.Class,
                name: i.getName(),
                properties: i.getProperties().map((p) => ({
                    name: p.getName(),
                    type: p.getType().getText(),
                })),
                extends: i
                    .getExtends()
                    .map((ancestor) => ancestor.getText())
                    .join(","),
            };

            const tokens = (clazz.extends as string).split(",");
            const firstAncestor = tokens[0];
            const additionalAncestors = tokens.slice(1);

            // zero or one parent is fine, everything beyond that has to be rolled out
            additionalAncestors.forEach((fqAncestorName) => {
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
                            existing.type += `| ${prop.getType().getText()}`;
                        } else {
                            clazz.properties?.push({
                                name: prop.getName(),
                                type: prop.getType().getText(),
                            });
                        }
                    });
            });

            clazz.extends = firstAncestor;
            closure.addClass(clazz);
        });

        // have to do a second pass, or all interfaces after the first
        // will be marked as "forgotten" and cause trouble
        closure.getInterfaces().forEach((i) => i.remove());
    }

    public rectify(source: morph.SourceFile) {
        source
            .getNamespaces()
            .forEach((i) => this.interfacesToClasses(i, source));
        this.interfacesToClasses(source, source);
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
            new JSVisitor().rectify(source);
        }

        // Extract source code and format it.
        source.formatText();
        const text = source.getFullText();
        const formattedText = await formatter.format(text);

        // Write the actual source file.
        await this.writeSource(options.output, formattedText);
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
