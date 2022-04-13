import _ from "lodash";
import cds from "@sap/cds";
import * as fs from "fs-extra";
import * as morph from "ts-morph";
import * as path from "path";

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

class JSVisitor {
    private interfacesToClasses(
        closure: morph.NamespaceDeclaration | morph.SourceFile
    ) {
        closure.getInterfaces().forEach((i) => {
            closure.addClass({
                name: i.getName(),
                properties: i.getProperties().map((p) => ({
                    name: p.getName(),
                    type: p.getType().getText(),
                })),
                extends: i
                    .getExtends()
                    .map((ancestor) => ancestor.getText())
                    .join(","),
            });
        });

        // have to do a second pass, or all interfaces after the first
        // will be marked as "forgotten" and cause trouble
        closure.getInterfaces().forEach((i) => i.remove());
    }

    public rectify(source: morph.SourceFile) {
        source.getNamespaces().forEach(this.interfacesToClasses);
        this.interfacesToClasses(source);
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
        const parsed = new CDSParser(options.javascript).parse(jsonObj as ICsn);

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
        this.generateCode(source, parsed, options.prefix, options.javascript);

        new JSVisitor().rectify(source);

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
        interfacePrefix = "",
        targetJavascript = false
    ): void {
        const namespaces: Namespace[] = [];
        if (parsed.namespaces) {
            const ns = parsed.namespaces.map(
                (n) =>
                    new Namespace(
                        n.definitions,
                        interfacePrefix,
                        n.name,
                        targetJavascript
                    )
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
            const ns = new Namespace(
                parsed.definitions,
                interfacePrefix,
                "",
                targetJavascript
            );

            namespaces.push(ns);
        }

        for (const namespace of namespaces) {
            const types = _.flatten(namespaces.map((n) => n.getTypes()));
            namespace.generateCode(source, types);
        }

        // rollout superclass properties if targetJS
        namespaces.forEach((ns) =>
            ns.pendingClasses.forEach((clazz) => {
                (clazz.extends as string)
                    .split(",")
                    .map((ancName) => {
                        const nsName = ancName
                            .split(".")
                            .slice(0, -1)
                            .join(".");
                        const clsName = ancName.split(".").slice(-1).join("");
                        const ancNamespace =
                            nsName === ""
                                ? ns
                                : namespaces.find((ns) => ns.name === nsName);
                        return ancNamespace?.pendingClasses.find(
                            (cls) => cls.name === clsName
                        );
                    })
                    .filter((ancestor) => !!ancestor && ancestor.properties)
                    .map((ancestor) => ancestor?.properties)
                    .forEach((heirlooms) =>
                        // flatMap not available before target: es2019 :/
                        heirlooms?.forEach((h) => {
                            const existing = clazz.properties?.find(
                                (p) => p.name === h.name
                            );
                            if (existing === undefined) {
                                // create a copy, since we might edit the type later
                                // and don't want to modify the parent classes' properties
                                // by reference then.
                                clazz.properties?.push({ ...h, docs: ["foo"] });
                            } else if (
                                // avoid T | T | T | ...
                                (existing.type as string).indexOf(
                                    h.type as string
                                ) < 0
                            ) {
                                existing.type += ` | ${h.type}`;
                                existing.docs = ["ipsum"];
                            }
                        })
                    );
                clazz.extends = "";
                source.addClass(clazz);
            })
        );
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
