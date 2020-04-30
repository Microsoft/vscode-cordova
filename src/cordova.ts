// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as fs from "fs";
import * as path from "path";
import {SimulateOptions} from "cordova-simulate";
import * as vscode from "vscode";

import {CordovaProjectHelper} from "./utils/cordovaProjectHelper";
import {CordovaCommandHelper} from "./utils/cordovaCommandHelper";
// import {ExtensionServer} from "./extension/extensionServer";
import * as Q from "q";
import * as semver from "semver";
// import {PluginSimulator} from "./extension/simulate";
import {Telemetry} from "./utils/telemetry";
import {TelemetryHelper} from "./utils/telemetryHelper";
import {TsdHelper} from "./utils/tsdHelper";

import {IonicCompletionProvider} from "./extension/completionProviders";
import { CordovaDebugAdapterDescriptorFactory } from "./extension/cordovaDebugAdapterDescriptorFactory";
import { ProjectsStorage } from "./extension/projectStorage";
import { AppLauncher } from "./extension/appLauncher";

let PLUGIN_TYPE_DEFS_FILENAME = "pluginTypings.json";
let PLUGIN_TYPE_DEFS_PATH = path.resolve(__dirname, "..", "..", PLUGIN_TYPE_DEFS_FILENAME);
let CORDOVA_TYPINGS_QUERYSTRING = "cordova";
let JSCONFIG_FILENAME = "jsconfig.json";
let TSCONFIG_FILENAME = "tsconfig.json";


export function activate(context: vscode.ExtensionContext): void {
    // Asynchronously enable telemetry
    Telemetry.init("cordova-tools", require("./../../package.json").version, { isExtensionProcess: true, projectRoot: "" });

    let activateExtensionEvent = TelemetryHelper.createTelemetryActivity("activate");
    try {
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => onChangeWorkspaceFolders(context, event)));

        const cordovaFactory = new CordovaDebugAdapterDescriptorFactory();
        context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("cordova", cordovaFactory));

        const workspaceFolders: vscode.WorkspaceFolder[] | undefined = vscode.workspace.workspaceFolders;

        if (workspaceFolders) {
            registerCordovaCommands(context);
            workspaceFolders.forEach((folder: vscode.WorkspaceFolder) => {
                onFolderAdded(context, folder);
            });
        }
        activateExtensionEvent.properties["cordova.workspaceFoldersCount"] = workspaceFolders.length;
        Telemetry.send(activateExtensionEvent);
    } catch (e) {
        activateExtensionEvent.properties["cordova.error"] = true;
        Telemetry.send(activateExtensionEvent);
        throw e;
    }
}

export function deactivate(): void {
    console.log("Extension has been deactivated");
}

function onChangeWorkspaceFolders(context: vscode.ExtensionContext, event: vscode.WorkspaceFoldersChangeEvent) {
    if (event.removed.length) {
        event.removed.forEach((folder) => {
            onFolderRemoved(folder);
        });
    }

    if (event.added.length) {
        event.added.forEach((folder) => {
            onFolderAdded(context, folder);
        });
    }
}

function onFolderAdded(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): void {
    let workspaceRoot = folder.uri.fsPath;
    let cordovaProjectRoot = CordovaProjectHelper.getCordovaProjectRoot(workspaceRoot);

    if (!cordovaProjectRoot) {
        return;
    }

    if (path.resolve(cordovaProjectRoot) !== path.resolve(workspaceRoot)) {
        vscode.window.showWarningMessage("VSCode Cordova extension requires the workspace root to be your Cordova project's root. The extension hasn't been activated.");
        return;
    }

    // Send project type to telemetry for each workspace folder
    let cordovaProjectTypeEvent = TelemetryHelper.createTelemetryEvent("cordova.projectType");
    TelemetryHelper.determineProjectTypes(cordovaProjectRoot)
        .then((projType) => {
            cordovaProjectTypeEvent.properties["projectType"] = projType;
        })
        .finally(() => {
            Telemetry.send(cordovaProjectTypeEvent);
        })
        .done();

    // We need to update the type definitions added to the project
    // as and when plugins are added or removed. For this reason,
    // setup a file system watcher to watch changes to plugins in the Cordova project
    // Note that watching plugins/fetch.json file would suffice

    let watcher = vscode.workspace.createFileSystemWatcher("**/plugins/fetch.json", false /*ignoreCreateEvents*/, false /*ignoreChangeEvents*/, false /*ignoreDeleteEvents*/);
    watcher.onDidChange(() => updatePluginTypeDefinitions(cordovaProjectRoot));
    watcher.onDidDelete(() => updatePluginTypeDefinitions(cordovaProjectRoot));
    watcher.onDidCreate(() => updatePluginTypeDefinitions(cordovaProjectRoot));
    context.subscriptions.push(watcher);

    // let simulator: PluginSimulator = new PluginSimulator();
    // let extensionServer: ExtensionServer = new ExtensionServer(simulator, workspaceRoot);
    // extensionServer.setup();

    ProjectsStorage.addFolder(folder, new AppLauncher());

    // extensionServer takes care of disposing the simulator instance
    // context.subscriptions.push(extensionServer);

    const ionicVersions = CordovaProjectHelper.checkIonicVersions(cordovaProjectRoot);
    // In case of Ionic 1 project register completions providers for html and javascript snippets
    if (ionicVersions.isIonic1) {
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(
                IonicCompletionProvider.JS_DOCUMENT_SELECTOR,
                new IonicCompletionProvider(path.resolve(__dirname, "../../snippets/ionicJs.json"))));

        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(
                IonicCompletionProvider.HTML_DOCUMENT_SELECTOR,
                new IonicCompletionProvider(path.resolve(__dirname, "../../snippets/ionicHtml.json"))));
    }

    // Install Ionic type definitions if necessary
    if (CordovaProjectHelper.isIonicAngularProject(cordovaProjectRoot)) {
        let ionicTypings: string[] = [
            path.join("jquery", "jquery.d.ts"),
            path.join("cordova-ionic", "plugins", "keyboard.d.ts"),
        ];
        if (ionicVersions.isIonic1) {
            ionicTypings = ionicTypings.concat([
                path.join("angularjs", "angular.d.ts"),
                path.join("ionic", "ionic.d.ts"),
            ]);
        }
        TsdHelper.installTypings(CordovaProjectHelper.getOrCreateTypingsTargetPath(cordovaProjectRoot), ionicTypings, cordovaProjectRoot);
    }

    let pluginTypings = getPluginTypingsJson();
    if (!pluginTypings) {
        return;
    }

    // Skip adding typings for cordova in case of Typescript or Ionic (except v1) projects
    // to avoid conflicts between typings we install and user-installed ones.
    if (!ionicVersions.isIonic2 &&
        !ionicVersions.isIonic3 &&
        !ionicVersions.isIonic4 &&
        !ionicVersions.isIonic5 &&
        !CordovaProjectHelper.isTypescriptProject(cordovaProjectRoot)) {

        // Install the type defintion files for Cordova
        TsdHelper.installTypings(CordovaProjectHelper.getOrCreateTypingsTargetPath(cordovaProjectRoot),
            [pluginTypings[CORDOVA_TYPINGS_QUERYSTRING].typingFile], cordovaProjectRoot);
    }

    // Install type definition files for the currently installed plugins
    updatePluginTypeDefinitions(cordovaProjectRoot);

    let pluginFilePath = path.join(cordovaProjectRoot, ".vscode", "plugins.json");
    if (fs.existsSync(pluginFilePath)) {
        fs.unlinkSync(pluginFilePath);
    }

    TelemetryHelper.sendPluginsList(cordovaProjectRoot, CordovaProjectHelper.getInstalledPlugins(cordovaProjectRoot));

    // In VSCode 0.10.10+, if the root doesn't contain jsconfig.json or tsconfig.json, intellisense won't work for files without /// typing references, so add a jsconfig.json here if necessary
    let jsconfigPath: string = path.join(workspaceRoot, JSCONFIG_FILENAME);
    let tsconfigPath: string = path.join(workspaceRoot, TSCONFIG_FILENAME);

    Q.all([Q.nfcall(fs.exists, jsconfigPath), Q.nfcall(fs.exists, tsconfigPath)]).spread((jsExists: boolean, tsExists: boolean) => {
        if (!jsExists && !tsExists) {
            Q.nfcall(fs.writeFile, jsconfigPath, "{}").then(() => {
                // Any open file must be reloaded to enable intellisense on them, so inform the user
                vscode.window.showInformationMessage("A 'jsconfig.json' file was created to enable IntelliSense. You may need to reload your open JS file(s).");
            });
        }
    });
}

function onFolderRemoved(folder: vscode.WorkspaceFolder): void {
    ProjectsStorage.delFolder(folder);
}

function getPluginTypingsJson(): any {
    if (CordovaProjectHelper.existsSync(PLUGIN_TYPE_DEFS_PATH)) {
        return require(PLUGIN_TYPE_DEFS_PATH);
    }

    console.error("Cordova plugin type declaration mapping file 'pluginTypings.json' is missing from the extension folder.");
    return null;
}

function getNewTypeDefinitions(installedPlugins: string[]): string[] {
    let pluginTypings = getPluginTypingsJson();
    if (!pluginTypings) {
        return;
    }

    return installedPlugins.filter(pluginName => !!pluginTypings[pluginName])
        .map(pluginName => pluginTypings[pluginName].typingFile);
}

function addPluginTypeDefinitions(projectRoot: string, installedPlugins: string[], currentTypeDefs: string[]): void {
    let pluginTypings = getPluginTypingsJson();
    if (!pluginTypings) {
        return;
    }

    let typingsToAdd = installedPlugins.filter((pluginName: string) => {
        if (pluginTypings[pluginName]) {
            return currentTypeDefs.indexOf(pluginTypings[pluginName].typingFile) < 0;
        }

        // If we do not know the plugin, collect it anonymously for future prioritisation
        let unknownPluginEvent = TelemetryHelper.createTelemetryEvent("unknownPlugin");
        unknownPluginEvent.setPiiProperty("plugin", pluginName);
        Telemetry.send(unknownPluginEvent);
        return false;
    }).map((pluginName: string) => {
        return pluginTypings[pluginName].typingFile;
    });

    TsdHelper.installTypings(CordovaProjectHelper.getOrCreateTypingsTargetPath(projectRoot),
        typingsToAdd, projectRoot);
}

function removePluginTypeDefinitions(projectRoot: string, currentTypeDefs: string[], newTypeDefs: string[]): void {
    // Find the type definition files that need to be removed
    let typeDefsToRemove = currentTypeDefs
        .filter((typeDef: string) => newTypeDefs.indexOf(typeDef) < 0);

    TsdHelper.removeTypings(CordovaProjectHelper.getOrCreateTypingsTargetPath(projectRoot), typeDefsToRemove, projectRoot);
}

function getRelativeTypeDefinitionFilePath(projectRoot: string, parentPath: string, typeDefinitionFile: string) {
    return path.relative(CordovaProjectHelper.getOrCreateTypingsTargetPath(projectRoot), path.resolve(parentPath, typeDefinitionFile)).replace(/\\/g, "\/");
}

function updatePluginTypeDefinitions(cordovaProjectRoot: string): void {
    // We don't need to install typings for Ionic2 since it has own TS
    // wrapper around core plugins. We also won't try to manage typings
    // in typescript projects as it might break compilation due to conflicts
    // between typings we install and user-installed ones.
    const ionicVersions = CordovaProjectHelper.checkIonicVersions(cordovaProjectRoot);
    if (ionicVersions.isIonic2 ||
        ionicVersions.isIonic3 ||
        ionicVersions.isIonic4 ||
        ionicVersions.isIonic5 ||
        CordovaProjectHelper.isTypescriptProject(cordovaProjectRoot)) {

        return;
    }

    let installedPlugins: string[] = CordovaProjectHelper.getInstalledPlugins(cordovaProjectRoot);

    const nodeModulesDir = path.resolve(cordovaProjectRoot, "node_modules");
    if (semver.gte(vscode.version, "1.7.2-insider") && fs.existsSync(nodeModulesDir)) {
        // Read installed node modules and filter out plugins that have been already installed in node_modules
        // This happens if user has used '--fetch' option to install plugin. In this case VSCode will provide
        // own intellisense for these plugins using ATA (automatic typings acquisition)
        let installedNpmModules: string[] = [];
        try {
            installedNpmModules = fs.readdirSync(nodeModulesDir);
        } catch (e) { }

        const pluginTypingsJson = getPluginTypingsJson() || {};
        installedPlugins = installedPlugins.filter(pluginId => {
            // plugins with `forceInstallTypings` flag don't have typings on NPM yet,
            // so we still need to install these even if they present in 'node_modules'
            const forceInstallTypings = pluginTypingsJson[pluginId] &&
                pluginTypingsJson[pluginId].forceInstallTypings;

            return forceInstallTypings || installedNpmModules.indexOf(pluginId) === -1;
        });
    }

    let newTypeDefs = getNewTypeDefinitions(installedPlugins);
    let cordovaPluginTypesFolder = CordovaProjectHelper.getCordovaPluginTypeDefsPath(cordovaProjectRoot);
    let ionicPluginTypesFolder = CordovaProjectHelper.getIonicPluginTypeDefsPath(cordovaProjectRoot);

    if (!CordovaProjectHelper.existsSync(cordovaPluginTypesFolder)) {
        addPluginTypeDefinitions(cordovaProjectRoot, installedPlugins, []);
        return;
    }

    let currentTypeDefs: string[] = [];

    // Now read the type definitions of Cordova plugins
    fs.readdir(cordovaPluginTypesFolder, (err: Error, cordovaTypeDefs: string[]) => {
        if (err) {
            // ignore
        }
        if (cordovaTypeDefs) {
            currentTypeDefs = cordovaTypeDefs.map(typeDef => getRelativeTypeDefinitionFilePath(cordovaProjectRoot, cordovaPluginTypesFolder, typeDef));
        }

        // Now read the type definitions of Ionic plugins
        fs.readdir(ionicPluginTypesFolder, (err: Error, ionicTypeDefs: string[]) => {
            if (err) {
                // ignore
            }

            if (ionicTypeDefs) {
                currentTypeDefs.concat(ionicTypeDefs.map(typeDef => getRelativeTypeDefinitionFilePath(cordovaProjectRoot, ionicPluginTypesFolder, typeDef)));
            }

            addPluginTypeDefinitions(cordovaProjectRoot, installedPlugins, currentTypeDefs);
            removePluginTypeDefinitions(cordovaProjectRoot, currentTypeDefs, newTypeDefs);
        });
    });
}

/* Launches a simulate command and records telemetry for it */
function launchSimulateCommand(cordovaProjectRoot: string, options: SimulateOptions): Q.Promise<void> {
    return TelemetryHelper.generate("simulateCommand", (generator) => {
        return TelemetryHelper.determineProjectTypes(cordovaProjectRoot)
            .then((projectType) => {
                generator.add("simulateOptions", options, false);
                generator.add("projectType", projectType, false);
                // visibleTextEditors is null proof (returns empty array if no editors visible)
                generator.add("visibleTextEditorsCount", vscode.window.visibleTextEditors.length, false);
                return projectType;
            });
    }).then((projectType) => {
        const uri = vscode.Uri.file(cordovaProjectRoot);
        const workspaceFolder = <vscode.WorkspaceFolder>vscode.workspace.getWorkspaceFolder(uri);
        return ProjectsStorage.getFolder(workspaceFolder).pluginSimulator.simulate(cordovaProjectRoot, options, projectType);
    });
}

function registerCordovaCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand("cordova.prepare", () => commandWrapper(CordovaCommandHelper.executeCordovaCommand, ["prepare"])));
    context.subscriptions.push(vscode.commands.registerCommand("cordova.build", () => commandWrapper(CordovaCommandHelper.executeCordovaCommand, ["build"])));
    context.subscriptions.push(vscode.commands.registerCommand("cordova.run", () => commandWrapper(CordovaCommandHelper.executeCordovaCommand, ["run"])));
    context.subscriptions.push(vscode.commands.registerCommand("ionic.prepare", () => commandWrapper(CordovaCommandHelper.executeCordovaCommand, ["prepare", true])));
    context.subscriptions.push(vscode.commands.registerCommand("ionic.build", () => commandWrapper(CordovaCommandHelper.executeCordovaCommand, ["build", true])));
    context.subscriptions.push(vscode.commands.registerCommand("ionic.run", () => commandWrapper(CordovaCommandHelper.executeCordovaCommand, ["run", true])));
    context.subscriptions.push(vscode.commands.registerCommand("cordova.simulate.android", () => {
        return selectProject()
            .then((project) => {
                return launchSimulateCommand(project.cordovaProjectRoot,  { dir: project.folder.uri.fsPath, target: "chrome", platform: "android" });
            });
    }));
    context.subscriptions.push(vscode.commands.registerCommand("cordova.simulate.ios", () => {
        return selectProject()
            .then((project) => {
                return launchSimulateCommand(project.cordovaProjectRoot,  { dir: project.folder.uri.fsPath, target: "chrome", platform: "ios" });
            });
    }));
}

function selectProject(): Q.Promise<any> {
    let keys = Object.keys(ProjectsStorage.projectsCache);
    if (keys.length > 1) {
        return Q.Promise((resolve, reject) => {
            vscode.window.showQuickPick(keys)
                .then((selected) => {
                    if (selected) {
                        resolve(ProjectsStorage.projectsCache[selected]);
                    }
                }, reject);
        });
    } else if (keys.length === 1) {
        return Q.resolve(ProjectsStorage.projectsCache[keys[0]]);
    } else {
        return Q.reject(new Error("No Cordova project is found"));
    }
}

function commandWrapper(fn, args) {
    return selectProject()
        .then((project) => {
            return fn(project.cordovaProjectRoot, ...args);
        });
}
