import vscode = require('vscode');
import { ExtensionContext, Memento, TestController, workspace } from 'vscode';
import { BazelGoTestRunner } from '../bazel/bazelRun';
import { GoExtensionContext } from '../context';
import { GoDocumentSymbolProvider } from '../goDocumentSymbols';
import { outputChannel } from '../goStatus';
import { GoTestExplorer, isVscodeTestingAPIAvailable } from '../goTest/explore';
import { ProvideSymbols } from '../goTest/resolve';
import { isInTest, Workspace } from '../goTest/utils';
import { getFromGlobalState, updateGlobalState } from '../stateUtils';

const toggleBazelCoverageCommand = 'go.bazel.toggleCoverage';
const lastCoverageStatusKey = 'bazelCoverageLastStatus';

export class BazelGoTestExplorer extends GoTestExplorer {
	extensionCtx: ExtensionContext;
	static setup(context: ExtensionContext, goCtx: GoExtensionContext): BazelGoTestExplorer {
		if (!isVscodeTestingAPIAvailable) {
			const err = new Error('VSCode Testing API is unavailable');
			vscode.commands.executeCommand('go.reportErrorTrace', 'BazelGoTestExplorer.setup', err);
			throw err;
		}

		const ctrl = vscode.tests.createTestController('bazel', 'Bazel');
		const symProvider = GoDocumentSymbolProvider(goCtx, true);
		const inst = new this(
			goCtx,
			workspace,
			ctrl,
			context.workspaceState,
			(doc, token) => symProvider.provideDocumentSymbols(doc, token),
			context
		);

		context.subscriptions.push(ctrl);

		inst.setupUI();
		inst.setupListeners();
		inst.setupFileWatchers();
		inst.setupCoverageStatusBarItem();

		return inst;
	}

	constructor(
		goCtx: GoExtensionContext,
		workspace: Workspace,
		ctrl: TestController,
		workspaceState: Memento,
		provideDocumentSymbols: ProvideSymbols,
		extensionCtx: ExtensionContext
	) {
		super(goCtx, workspace, ctrl, workspaceState, provideDocumentSymbols, BazelGoTestRunner);
		this.extensionCtx = extensionCtx;
		const runner: BazelGoTestRunner = this.runner as BazelGoTestRunner;
		if (this.runner instanceof BazelGoTestRunner) {
			runner.registerCoverageCommand(extensionCtx);
			runner.registerTestPackageCommand(extensionCtx);
		} else {
			vscode.window.showErrorMessage('Failed to enable the Run Test With Coverage command.');
		}
	}

	setupUI(): void {
		// Process already open editors
		vscode.window.visibleTextEditors.forEach((ed) => {
			this.documentUpdate(ed.document);
		});

		this.extensionCtx.subscriptions.push(
			vscode.commands.registerCommand('go.test.refresh', async (item) => {
				if (!item) {
					await vscode.window.showErrorMessage('No test selected');
					return;
				}

				try {
					await this.resolver.resolve(item);
					this.resolver.updateGoTestContext();
				} catch (error) {
					const m = 'Failed to resolve tests';
					outputChannel.appendLine(`${m}: ${error}`);
					outputChannel.show();
					await vscode.window.showErrorMessage(m);
				}
			})
		);
	}

	setupListeners(): void {
		this.extensionCtx.subscriptions.push(
			workspace.onDidChangeConfiguration(async (x) => {
				try {
					await this.didChangeConfiguration(x);
				} catch (error) {
					if (isInTest()) throw error;
					else outputChannel.appendLine(`Failed while handling 'onDidChangeConfiguration': ${error}`);
				}
			})
		);

		this.extensionCtx.subscriptions.push(
			workspace.onDidOpenTextDocument(async (x) => {
				try {
					await this.didOpenTextDocument(x);
				} catch (error) {
					if (isInTest()) throw error;
					else outputChannel.appendLine(`Failed while handling 'onDidOpenTextDocument': ${error}`);
				}
			})
		);

		this.extensionCtx.subscriptions.push(
			workspace.onDidChangeTextDocument(async (x) => {
				try {
					await this.didChangeTextDocument(x);
				} catch (error) {
					if (isInTest()) throw error;
					else outputChannel.appendLine(`Failed while handling 'onDidChangeTextDocument': ${error}`);
				}
			})
		);

		this.extensionCtx.subscriptions.push(
			workspace.onDidChangeWorkspaceFolders(async (x) => {
				try {
					await this.didChangeWorkspaceFolders(x);
				} catch (error) {
					if (isInTest()) throw error;
					else outputChannel.appendLine(`Failed while handling 'onDidChangeWorkspaceFolders': ${error}`);
				}
			})
		);
	}

	setupFileWatchers(): void {
		const watcher = workspace.createFileSystemWatcher('**/*_test.go', false, true, false);
		this.extensionCtx.subscriptions.push(watcher);
		this.extensionCtx.subscriptions.push(
			watcher.onDidCreate(async (x) => {
				try {
					await this.didCreateFile(x);
				} catch (error) {
					if (isInTest()) throw error;
					else outputChannel.appendLine(`Failed while handling 'FileSystemWatcher.onDidCreate': ${error}`);
				}
			})
		);
		this.extensionCtx.subscriptions.push(
			watcher.onDidDelete(async (x) => {
				try {
					await this.didDeleteFile(x);
				} catch (error) {
					if (isInTest()) throw error;
					else outputChannel.appendLine(`Failed while handling 'FileSystemWatcher.onDidDelete': ${error}`);
				}
			})
		);
	}

	setupCoverageStatusBarItem(): void {
		const coverageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		coverageStatusBarItem.command = toggleBazelCoverageCommand;
		const updateStatusBarItem = () => {
			coverageStatusBarItem.text = `Coverage ${this.goCtx.coverageEnabled ? 'Enabled' : 'Disabled'}`;
			updateGlobalState(lastCoverageStatusKey, this.goCtx.coverageEnabled);
		};
		// use persisting coverage value if available
		const lastCoverageEnabled = getFromGlobalState(lastCoverageStatusKey);
		if (lastCoverageEnabled !== undefined) {
			this.goCtx.coverageEnabled = lastCoverageEnabled;
		}
		this.extensionCtx.subscriptions.push(coverageStatusBarItem);
		this.extensionCtx.subscriptions.push(
			vscode.commands.registerCommand(toggleBazelCoverageCommand, () => {
				this.goCtx.coverageEnabled = !this.goCtx.coverageEnabled;
				updateStatusBarItem();
				if (this.goCtx.coverageEnabled === false) vscode.commands.executeCommand('go.coverageTree.clear');
			})
		);
		updateStatusBarItem();
		coverageStatusBarItem.show();
	}
}

export function warnIfDuplicateGoExtension(): void {
	const extensionMatch = vscode.extensions.all.filter((extension) => extension.id === 'golang.go');
	if (extensionMatch.length > 0) {
		vscode.window.showErrorMessage(
			'Action Needed: Conflicting extension detected. In order for the "Go with Bazel" extension to work correctly, please uninstall the "Go" extension. Only one of these may be installed at a time.'
		);
	}
}
