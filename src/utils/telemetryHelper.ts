// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

/* tslint:disable:no-use-before-declare */
import { CordovaProjectHelper, IPluginDetails, IProjectType } from "./cordovaProjectHelper";
import * as fs from "fs";
import * as path from "path";
import { Telemetry } from "./telemetry";
import * as nls from "vscode-nls";
nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize = nls.loadMessageBundle();

export interface ITelemetryPropertyInfo {
    value: any;
    isPii: boolean;
}

export interface ICommandTelemetryProperties {
    [propertyName: string]: ITelemetryPropertyInfo;
}

export interface IExternalTelemetryProvider {
    sendTelemetry: (event: string, props: Telemetry.ITelemetryProperties, error?: Error) => void;
}

interface IDictionary<T> {
    [key: string]: T;
}

interface IHasErrorCode {
    errorCode: number;
}

export abstract class TelemetryGeneratorBase {
    protected telemetryProperties: ICommandTelemetryProperties = {};
    private componentName: string;
    private currentStepStartTime: [number, number];
    private currentStep: string = "initialStep";
    private errorIndex: number = -1; // In case we have more than one error (We start at -1 because we increment it before using it)

    constructor(componentName: string) {
        this.componentName = componentName;
        this.currentStepStartTime = process.hrtime();
    }

    public add(baseName: string, value: any, isPii: boolean): TelemetryGeneratorBase {
        return this.addWithPiiEvaluator(baseName, value, () => isPii);
    }

    public addWithPiiEvaluator(baseName: string, value: any, piiEvaluator: { (value: string, name: string): boolean }): TelemetryGeneratorBase {
        // We have 3 cases:
        //     * Object is an array, we add each element as baseNameNNN
        //     * Object is a hash, we add each element as baseName.KEY
        //     * Object is a value, we add the element as baseName
        try {
            if (Array.isArray(value)) {
                this.addArray(baseName, <any[]>value, piiEvaluator);
            } else if (!!value && (typeof value === "object" || typeof value === "function")) {
                this.addHash(baseName, <IDictionary<any>>value, piiEvaluator);
            } else {
                this.addString(baseName, String(value), piiEvaluator);
            }
        } catch (error) {
            // We don't want to crash the functionality if the telemetry fails.
            // This error message will be a javascript error message, so it's not pii
            this.addString("telemetryGenerationError." + baseName, String(error), () => false);
        }

        return this;
    }

    public addError(error: Error): TelemetryGeneratorBase {
        this.add("error.message" + ++this.errorIndex, error.message, /*isPii*/ true);
        let errorWithErrorCode: IHasErrorCode = <IHasErrorCode><Record<string, any>>error;
        if (errorWithErrorCode.errorCode) {
            this.add("error.code" + this.errorIndex, errorWithErrorCode.errorCode, /*isPii*/ false);
        }

        return this;
    }

    public time<T>(name: string, codeToMeasure: { (): Promise<T> }): Promise<T> {
        let startTime: [number, number] = process.hrtime();
        return codeToMeasure()
            .finally(() => this.finishTime(name, startTime))
            .catch((reason: any) => {
                this.addError(reason);
                throw reason;
            });
    }

    public step(name: string): TelemetryGeneratorBase {
        // First we finish measuring this step time, and we send a telemetry event for this step
        this.finishTime(this.currentStep, this.currentStepStartTime);
        this.sendCurrentStep();

        // Then we prepare to start gathering information about the next step
        this.currentStep = name;
        this.telemetryProperties = {};
        this.currentStepStartTime = process.hrtime();
        return this;
    }

    public send(): void {
        if (this.currentStep) {
            this.add("lastStepExecuted", this.currentStep, /*isPii*/ false);
        }

        this.step(null); // Send the last step
    }

    public getTelemetryProperties(): ICommandTelemetryProperties {
        return this.telemetryProperties;
    }

    protected abstract sendTelemetryEvent(telemetryEvent: Telemetry.TelemetryEvent): void;

    private sendCurrentStep(): void {
        this.add("step", this.currentStep, /*isPii*/ false);
        let telemetryEvent: Telemetry.TelemetryEvent = new Telemetry.TelemetryEvent(this.componentName);
        TelemetryHelper.addTelemetryEventProperties(telemetryEvent, this.telemetryProperties);
        this.sendTelemetryEvent(telemetryEvent);
    }

    private addArray(baseName: string, array: any[], piiEvaluator: { (value: string, name: string): boolean }): void {
        // Object is an array, we add each element as baseNameNNN
        let elementIndex: number = 1; // We send telemetry properties in a one-based index
        array.forEach((element: any) => this.addWithPiiEvaluator(baseName + elementIndex++, element, piiEvaluator));
    }

    private addHash(baseName: string, hash: IDictionary<any>, piiEvaluator: { (value: string, name: string): boolean }): void {
        // Object is a hash, we add each element as baseName.KEY
        Object.keys(hash).forEach((key: string) => this.addWithPiiEvaluator(baseName + "." + key, hash[key], piiEvaluator));
    }

    private addString(name: string, value: string, piiEvaluator: { (value: string, name: string): boolean }): void {
        this.telemetryProperties[name] = TelemetryHelper.telemetryProperty(value, piiEvaluator(value, name));
    }

    private combine(...components: string[]): string {
        let nonNullComponents: string[] = components.filter((component: string) => component !== null);
        return nonNullComponents.join(".");
    }

    private finishTime(name: string, startTime: [number, number]): void {
        let endTime: [number, number] = process.hrtime(startTime);
        this.add(this.combine(name, "time"), String(endTime[0] * 1000 + endTime[1] / 1000000), /*isPii*/ false);
    }
}

export class TelemetryGenerator extends TelemetryGeneratorBase {
    protected sendTelemetryEvent(telemetryEvent: Telemetry.TelemetryEvent): void {
        Telemetry.send(telemetryEvent);
    }
}

export class TelemetryHelper {
    public static createTelemetryEvent(eventName: string): Telemetry.TelemetryEvent {
        return new Telemetry.TelemetryEvent(eventName);
    }

    public static createTelemetryActivity(eventName: string): Telemetry.TelemetryActivity {
        return new Telemetry.TelemetryActivity(eventName);
    }

    public static determineProjectTypes(projectRoot: string): Promise<IProjectType> {
        let ionicVersions = CordovaProjectHelper.checkIonicVersions(projectRoot);
        let meteor = CordovaProjectHelper.exists(path.join(projectRoot, ".meteor"));
        let mobilefirst = CordovaProjectHelper.exists(path.join(projectRoot, ".project"));
        let phonegap = CordovaProjectHelper.exists(path.join(projectRoot, "www", "res", ".pgbomit"));
        let cordova = CordovaProjectHelper.exists(path.join(projectRoot, "config.xml"));
        return Promise.all([meteor, mobilefirst, phonegap, cordova])
            .then(([isMeteor, isMobilefirst, isPhonegap, isCordova]) => ({
                isIonic1: ionicVersions.isIonic1,
                isIonic2: ionicVersions.isIonic2,
                isIonic3: ionicVersions.isIonic3,
                isIonic4: ionicVersions.isIonic4,
                isIonic5: ionicVersions.isIonic5,
                isMeteor: isMeteor,
                isMobilefirst: isMobilefirst,
                isPhonegap: isPhonegap,
                isCordova: isCordova,
            }));
    }

    public static telemetryProperty(propertyValue: any, pii?: boolean): ITelemetryPropertyInfo {
        return { value: String(propertyValue), isPii: pii || false };
    }

    public static addTelemetryEventProperties(event: Telemetry.TelemetryEvent, properties: ICommandTelemetryProperties): void {
        if (!properties) {
            return;
        }

        Object.keys(properties).forEach(function (propertyName: string): void {
            TelemetryHelper.addTelemetryEventProperty(event, propertyName, properties[propertyName].value, properties[propertyName].isPii);
        });
    }

    public static addTelemetryEventProperty(event: Telemetry.TelemetryEvent, propertyName: string, propertyValue: any, isPii: boolean): void {
        if (Array.isArray(propertyValue)) {
            TelemetryHelper.addMultiValuedTelemetryEventProperty(event, propertyName, propertyValue, isPii);
        } else {
            TelemetryHelper.setTelemetryEventProperty(event, propertyName, propertyValue, isPii);
        }
    }

    public static generate<T>(name: string, codeGeneratingTelemetry: { (telemetry: TelemetryGenerator): Promise<T> }): Promise<T> {
        let generator: TelemetryGenerator = new TelemetryGenerator(name);
        return generator.time(null, () => codeGeneratingTelemetry(generator)).finally(() => generator.send());
    }

    public static sendPluginsList(projectRoot: string, pluginsList: string[]): void {
        // Load list of previously sent plugins = previousPlugins
        let pluginFilePath = path.join(projectRoot, ".vscode", "plugins.json");
        let pluginFileJson: any;

        if (CordovaProjectHelper.existsSync(pluginFilePath)) {
            try {
                let pluginFileJsonContents = fs.readFileSync(pluginFilePath, "utf8").toString();
                pluginFileJson = JSON.parse(pluginFileJsonContents);
            } catch (error) {
                console.error(error);
            }
        }

        // Get list of plugins in pluginsList but not in previousPlugins
        let pluginsFileList: string[] = new Array<string>();
        if (pluginFileJson && pluginFileJson.plugins) {
            pluginsFileList = pluginFileJson.plugins;
        } else {
            pluginFileJson = new Object();
        }

        let newPlugins: string[] = new Array<string>();
        pluginsList.forEach(plugin => {
            if (pluginsFileList.indexOf(plugin) < 0) {
                newPlugins.push(plugin);
                pluginsFileList.push(plugin);
            }
        });

        // If none, return
        if (newPlugins.length === 0) {
            return;
        }

        // Send telemetry event with list of new plugins
        let pluginDetails: IPluginDetails[] =
            newPlugins.map(pluginName => CordovaProjectHelper.getInstalledPluginDetails(projectRoot, pluginName))
                .filter(detail => !!detail);

        let pluginEvent = new Telemetry.TelemetryEvent("plugins", { plugins: JSON.stringify(pluginDetails) });
        Telemetry.send(pluginEvent);

        // Write out new list of previousPlugins
        pluginFileJson.plugins = pluginsFileList;
        try {
            fs.writeFileSync(pluginFilePath, JSON.stringify(pluginFileJson));
        } catch (err) {
            throw new Error(err.message + localize("CWDDoesntReferToTheWorkspaceRootDirectory", " It seems that 'cwd' parameter doesn't refer to the workspace root directory. Please make sure that 'cwd' contains the path to the workspace root directory."));
        }
    }

    private static setTelemetryEventProperty(event: Telemetry.TelemetryEvent, propertyName: string, propertyValue: string, isPii: boolean): void {
        if (isPii) {
            event.setPiiProperty(propertyName, String(propertyValue));
        } else {
            event.properties[propertyName] = String(propertyValue);
        }
    }

    private static addMultiValuedTelemetryEventProperty(event: Telemetry.TelemetryEvent, propertyName: string, propertyValue: string[], isPii: boolean): void {
        for (let i: number = 0; i < propertyValue.length; i++) {
            TelemetryHelper.setTelemetryEventProperty(event, propertyName + i, propertyValue[i], isPii);
        }
    }
}

export interface ISimulateTelemetryProperties {
    platform?: string;
    target: string;
    port: number;
    simulatePort?: number;
    livereload?: boolean;
    livereloadDelay?: number;
    forcePrepare?: boolean;
}
/* tslint:enable */
