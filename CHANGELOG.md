## v0.1.7 - 10 May, 2023
- Show duplciate extension warning when the user has the regular "Go" extension installed.
- Bug fixes
  - Still detect test suites even if the variable declaration and call to suite.Run occur on separate lines.
  - Use correct test filters when debugging suite methods.

## v0.1.6 - 7 Apr, 2023
- Benchmarks can now be run via the test explorer.
- Support to view result output for subtests under a test suite method.
- Hide the "Go: Test..." commands when setting `testExplorer.useBazel` is enabled.
- When language server fails to start, show a prompt to try restarting it.
- More detailed error message for Bazel exit code 2.
- When test explorer is empty, add welcome message explaining how to get started.
- Rebase to upstream version 0.38.0

## v0.1.5 - 13 Mar, 2023
- Add a "Run with Coverage" button on each test, as well as on the context menu for the run arrow.
- Persist the user's Coverage Enabled selection across window refreshes.
- Update test filters and results processing to handle testify suites.
- Bug Fix: Anchor each section of the test filter regex, to avoid extra tests not selected by the user.

## v0.1.4 - 23 Feb, 2023
- Include test environment variables as defined in settings when running tests.
- After completion of debugging a test, the user will be directed back to the test explorer.

## v0.1.3 - 3 Feb, 2023

- Bug fixes
  - If a Bazel run does not output build events due to premature termination, ensure that the UI does not show that tests are still in progress.
  - Filter warn/debug/error logs out of the messages that get overlaid onto the code after a failed test.

## v0.1.2 - 24 Jan, 2023
- Hide welcome screen following a new install

## v0.1.1 - 12 Jan, 2023
- Rebase to upstream version 0.37.0
- Add support for running Bazel with code coverage:
  - Adds a `Coverage Enabled` / `Coverage Disabled` toggle button in the status bar.
  - When enabled, Bazel will run with coverage, parse the results, and overlay onto code.
  - A new coverage tree view panel will show the coverage percentages for each file in the package.
- Bug fixes
  - Keep test cases expanded when editing a test case.
  - Adjust output behavior for failure messages originating in generated files.

## v0.1.0 - 19 Dec, 2022

### Features
- Limited scope of test indexing:  When `"go.testExplorer.indexEntireWorkspace"` setting is false, the test explorer will discover tests only in the currently open package.  This improves performance in large monorepos as the extension will not attempt to index all tests in the entire repo, which may not be relevant to the user's project.
- When `go.testExplorer.useBazel`, the following new Bazel-specific features will be available:
  - Test using Bazel: When running a test, Bazel will be used.  Run results and test case outcomes will be analyzed from the resulting build event output, and pass/fail status will will be shown on the UI.  Error messages will be overlaid on the appropriate line number or test case.
  - Debug using Bazel: When debugging a test, Bazel will be used to identify the appropriate debug target for the file.  It will then be used to launch a debug server on an available port, and once it is running, a remote attach debugging session with be initiated.

## [Upstream Changelog](https://github.com/golang/vscode-go/blob/master/CHANGELOG.md)
