## 1.6.0

* Move to Azure pipelines builds instead of Travis CI for pull requests validation
* `previewHtml` will be deprecated in the future releases of VS Code and due to this the following changes were made:
  * Simulate window now opens in a browser instead of opening inside VS Code
  * `simulatorInExternalBrowser` and `cordova.simulatorInExternalBrowser` settings was removed

## 1.5.1

* Return extension name back to "Cordova Tools"

## 1.5.0

* Added Ionic 4 beta support
* Added support for cordovaExecutable, env, envFile as a launch parameters
* Extension title renamed from `Cordova Tools` to `Ionic and Cordova Tools`
* Fixed several bugs affecting debugging experience

## 1.4.0

* Migrate to [cordova-simulate@0.4.0](https://github.com/Microsoft/cordova-simulate/releases/tag/0.4.0)
* Added target platform selector for command palette commands
* Added cordova-simulate support for all known platform
* Added `.travis.yml`

## 1.3.10

* Added target type to telemetry request
* Added support for Ionic projects without Cordova integration
* Bug fixes and improvements

## 1.3.9

* Migrated CodePush functionality to App Center extension for VS Code

## 1.3.8

* Remove local file dependencies for code-push libs from package.json
* Bug fixes

## 1.3.7

* Bug fixes

## 1.3.6

* Added support for cordova-code-push commands

## 1.3.5

* Updated README

## 1.3.4

* Fixed issue with launch args in vscode 1.20.0
* Added survey to README

## 1.3.3

* Fix platforms detection according to new files structure
* Fix error message if browser simulation fails
* Fix Ionic projects launch and attach for iOS simulator
* Fix Ionic CLI version detection if CLI update is available
* Fix missing platform error message for Ionic

## 1.3.2

* Allow "non Ionic-CLI projects" to use the extension even with ionic-angular installed
* Adds `cordova.simulatorInExternalBrowser` setting that makes Cordova simulator to launch in default browser instead of tab in VS Code
* Support new path of AndroidManifest.xml in Cordova 8.0.0
* Fix ionic nightly version detection
* Fix Ionic 1 livereload server detection

## 1.3.1

* Granted permissions to scripts

## 1.3.0

* Multi-root workspaces support

## 1.2.13

* Added `runArguments` configuration option to allow passing custom arguments to `cordova run/build` or `ionic serve` commands
* Fixed problem with cordova/ionic check updates

## 1.2.12

* Fixed application debug port detection on Android Oreo

## 1.2.11

* Fixed attach failure when both device and emulator are connected
* Fixed problem with attaching debugger to apps with some specific names

## 1.2.10

* Fixed debugger can't find "localabstract name" issue by better parsing of `adb shell ps` output
* Cleaned up noisy Ionic output in debug console
* Improved detection of latest Ionic CLI to better handle 'ionic cordova' plugin/integration
* Improved handling of typings in typescript projects
* Fixed annoying `Debugger.setAsyncCallStackDepth` error appeared after upgrading vscode-chrome-debug-core

## 1.2.9

* Added chromium to valid "simulate" targets
* Fixed "Error processing "completions"" constantly popping up in debug console
* Fixed cordova-simulate tab to properly update

## 1.2.8

* Fixed debugging of Ionic CLIv3 projects
* Added launch.json configurations snippets
* Fixed numerous issues with debugging on iOS 10 devices/emulators
* Fixed numerous issues caused by changes in Ionic CLI
  - Fix running iOS on simulator with enabled livereload
  - Fixed Ionic run hang on Android
  - Show app launch logs continuously
  - Suppress irrelevant stderr output from Ionic

* Other usability improvements:
  - Now ignoring "cordova build/run" commands while debugging
  - Changed error messages format when platform is missing to be more informative
  - Android is now default platform for Ionic on Windows
  - Ionic snippets are now shown only for Ionic v1 projects


## 1.2.7
* Added telemetry reporting for which plugins are installed for the project
* Enabled logging ionic serve output to debug console
* Updated chrome-debug-core
* Fixed integration with ionic serve

## 1.2.6
* Updated to use newer chrome debugger
* Fixed an issue with launching apps on iOS 10.X devices

## 1.2.5
* Changed how we look for the webview debugging connection to work on devices with restricted permissions

## 1.2.4
* Changed how we add typings for intellisense to work with typescript 2 automatic typings acquisition
* Now all cordova command output will be included in the debug console
* Added support for debugging crosswalk webview on android (Thanks nicolashenry!)
* Added CHANGELOG.md!

## 1.2.3
* Updated to a newer version of Cordova Simulate
* Updated plist library to fix some bugs
* Updated documentation
