# Go with Bazel for Visual Studio Code
This version of the VS Code Go extension adds support for test, debug, and coverage using Bazel.

> This is the Uber Go with Bazel extension (`uber.go-bazel`), which replaces the VS Code Go extension (`golang.go`). Both cannot be used at the same time. If you have installed both extensions, you **must disable or uninstall** one of them. For further guidance, read the [documentation on how to disable an extension](https://code.visualstudio.com/docs/editor/extension-gallery#_disable-an-extension).

## Getting Started
* This version includes all features of the upstream version, with added Bazel functionality. Please disable the version from the VS Code Marketplace (`golang.go`) in order to avoid conflicts.
* Update the following settings:
  * `"go.testExplorer.indexEntireWorkspace": false` (improves performance when working in a monorepo)
  * `"go.testExplorer.useBazel": true` (test and debug commands will use Bazel instead of the native Go toolchain)
* To use Bazel for testing and debugging, open any *_test.go file, then navigate to the testing view. Click on the test or debug buttons for a package, file, or test case to get started.
* To collect code coverage, toggle the `Coverage Enabled` / `Coverage Disabled` status bar button, then run the tests. Highlighting will appear on applicable files.
## Other Info
* This version has all features and settings of the upstream Go extension (currently up to version 0.37.0).
## [VS Code Go Readme](https://github.com/golang/vscode-go/blob/master/README.md)
