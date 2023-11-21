import lcovParse = require('lcov-parse');
import path = require('path');
import vscode = require('vscode');
import {
	clearCoverage,
	elaborate,
	emptyCoverageData,
	CoverageData,
	applyCodeCoverage,
	createCoverageData,
	setDecorators,
	decorators,
	decoratorConfig
} from '../goCover';
import { getGoConfig } from '../config';

class LCOVParseError extends Error {}

export type CoverageTreeNode = {
	displayName: string;
	absolutePath: string;
	hits: number;
	lines: number;
	children?: CoverageTreeNode[];
};

export type CoverageProcessingConfig = {
	coverProfilePath: string;
	bazelWorkspaceRoot: string;
	currentGoWorkspace: string;
	targetPackages: string[];
	generatedFilePrefix: string;
	generatedFileMapper?: (config: CoverageProcessingConfig, generatedFile: string) => string;
};

export class GoCoverageHandler {
	private coverageTreeRoots: CoverageTreeNode[] = [];
	private provider: CoverageTreeProvider;
	constructor() {
		this.provider = new CoverageTreeProvider(this.coverageTreeRoots);
		vscode.window.createTreeView('go.coverageTree', {
			treeDataProvider: this.provider
		});

		vscode.commands.registerCommand('go.coverageTree.refresh', () => this.provider.refresh());
		vscode.commands.registerCommand('go.coverageTree.clear', () => this.newRun(false));
	}

	/**
	 * Clears existing coverage data prior to a run.
	 * @param showPanel indicates whether the tree view panel should be visible.
	 */
	newRun(showPanel = true) {
		this.clearCoverageFromFiles();
		this.clearCoverageTree();
		vscode.commands.executeCommand('setContext', 'go.showCoverage', showPanel);
	}

	/**
	 * Extract the coverage data from the given cover profile & apply them on the files in the open editors.
	 * @param coverProfilePath Path to the file that has the cover profile data in LCOV format.
	 * @param bazelWorkspaceRoot Root of the Bazel workspace, used to determine absolute path to each file.
	 */
	processCoverProfile(config: CoverageProcessingConfig): Promise<void> {
		if (!config.generatedFileMapper) {
			// This section allows the Go extension to use a helper extension for cases that require a customized implementation.
			// The go.helperExtension setting must contain an extension that provides a mapGeneratedToSource function in its exports.
			// For now, this points to the current extension by default (uber.go-bazel), but can be decoupled in the future to a separate extension.
			const helperExtension = getGoConfig().get('helperExtension');
			config.generatedFileMapper = vscode.extensions.getExtension(
				helperExtension as string
			)?.exports?.bazel?.mapGeneratedToSource;
		}
		const parseLCOVPromise = new Promise<void>((resolve) => {
			lcovParse(config.coverProfilePath, (err, data) => {
				try {
					if (err) throw new LCOVParseError(`Unable to get coverage data for this run: ${err}`);
					this.processLcovFiles(data, config);
				} catch (e) {
					vscode.commands.executeCommand('go.reportErrorTrace', 'processCoverProfile', e as Error);
					if (e instanceof LCOVParseError) vscode.window.showErrorMessage(e.message);
					else if (e instanceof Error) {
						vscode.window.showErrorMessage(`Error while processing coverage data: ${e.message}`);
					} else {
						vscode.window.showErrorMessage('Unknown error while processing coverage data.');
					}
				}
				resolve();
			});
		});
		return parseLCOVPromise;
	}

	/**
	 * Analyze the LCOV Data for each file in the output report, and display to the user.
	 * @param data LcovFile[] containing coverage data for each file in the combined coverage report.
	 * @param config CoverageProcessingConfig for the current run.
	 */
	private processLcovFiles(data: lcovParse.LcovFile[] | undefined, config: CoverageProcessingConfig): void {
		if (!data) return;

		const showCounts = getGoConfig().get('coverShowCounts') as boolean;
		const coveragePath = new Map<string, CoverageData>(); // Map absolute file path to its CoverageData
		const resultsTree = new Map<string, CoverageTreeNode>();

		for (const coverageForFile of data) {
			// Track coverage paths based on absolute path to the file. This will indicate the path to which highlight will be applied.
			const fileAbsolutePath = this.getSourceFileAbsolutePath(config, coverageForFile.file);
			// For display purposes in the tree, use the package name relative to the Go workspace root.
			const fileRelativePath = path.relative(config.currentGoWorkspace, fileAbsolutePath);

			const pkg = path.dirname(fileRelativePath);
			// Skip this package if it is not an exact match to the current package being run.
			if (!config.targetPackages.includes(pkg)) continue;
			coveragePath.set(fileAbsolutePath, lcovLinesToEditorRanges(coverageForFile.lines, showCounts));
			// Add the results for this file under the appropriate package node.
			let pkgRootNode = resultsTree.get(pkg);
			if (!pkgRootNode) {
				// Create a root node for this package if it does not yet exist.
				pkgRootNode = {
					displayName: pkg,
					absolutePath: pkg,
					hits: 0,
					lines: 0,
					children: []
				};
				resultsTree.set(pkg, pkgRootNode);
			}
			// Package root node should contain cumulative total of all hits and found lines from each file within it.
			pkgRootNode.hits += coverageForFile.lines.hit;
			pkgRootNode.lines += coverageForFile.lines.found;
			pkgRootNode.children?.push({
				displayName: path.basename(fileRelativePath),
				absolutePath: fileAbsolutePath,
				hits: coverageForFile.lines.hit,
				lines: coverageForFile.lines.found
			});
		}

		createCoverageData(
			new Map<string, string>(), // No mapping is needed since coveragePath keys are already absolute paths
			coveragePath
		);
		Array.from(resultsTree.values()).forEach((val) => this.addTreeRoot(val));
		setBazelCoverageDecorators();
		vscode.window.visibleTextEditors.forEach(applyCodeCoverage);
	}

	/**
	 * Add a parent node to the tree data, then kick off a refresh. This will also add all children of the node.
	 * @param node Parent node for a given package, which can also contain children.
	 */
	private addTreeRoot(node: CoverageTreeNode) {
		this.coverageTreeRoots.push(node);
		vscode.commands.executeCommand('go.coverageTree.refresh');
	}

	/**
	 * Clears coverage highlighting from files.
	 * As coverage state is maintained within goCover, this simply calls the imported clearCoverage() function.
	 */
	private clearCoverageFromFiles() {
		clearCoverage();
	}

	/**
	 * Clears the contents of the coverage tree view.
	 */
	private clearCoverageTree() {
		// Clears coverage output panel.
		this.coverageTreeRoots.length = 0;
		vscode.commands.executeCommand('go.coverageTree.refresh');
	}

	/**
	 * Get the absolute path to a file. Also performs conversion of generated file paths back to source file if applicable.
	 * @param config CoverageProcessingConfig for the current run.
	 * @param coverageFile file path parsed from the coverage output, for which the absolute path will be provided.
	 * @returns absolute path to the file, with generated files converted back to source where possible.
	 */
	private getSourceFileAbsolutePath(config: CoverageProcessingConfig, coverageFile: string) {
		if (coverageFile.startsWith(config.generatedFilePrefix) && config.generatedFileMapper) {
			return config.generatedFileMapper(config, coverageFile);
		}
		return path.join(config.bazelWorkspaceRoot, coverageFile);
	}
}

export class CoverageTreeProvider implements vscode.TreeDataProvider<CoverageTreeNode> {
	private _onDidChangeTreeData: vscode.EventEmitter<null> = new vscode.EventEmitter<null>();
	readonly onDidChangeTreeData: vscode.Event<null> = this._onDidChangeTreeData.event;

	constructor(private readonly displayData: CoverageTreeNode[]) {}

	/**
	 * Refresh the tree with the latest data.
	 */
	refresh(): void {
		this._onDidChangeTreeData.fire(null);
	}

	/**
	 * Provides a TreeItem containing the data for a given node.
	 * @param element CoverageTreeNode containing the current element being added.
	 * @returns TreeItem with fields set to the appropriate behavior for this node.
	 */
	getTreeItem(element: CoverageTreeNode): vscode.TreeItem {
		const item = new vscode.TreeItem(`${element.displayName}`);
		const percent = `${(element.hits / element.lines).toLocaleString('en', { style: 'percent' })}`;
		item.description = `Coverage: ${percent}, Lines: ${element.lines}, Hits: ${element.hits}`;

		if (element.children) {
			// Package root node. Not clickable.
			item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		} else {
			// Individual file node. Opens corresponding file on click.
			item.command = {
				title: 'Open',
				command: 'vscode.open',
				arguments: [vscode.Uri.file(element.absolutePath)]
			};
		}

		return item;
	}

	/**
	 * Gets the children for a given element, or root nodes of the tree if no element is provided.
	 * @param element Element for which to get the children.
	 * @returns CoverageTreeNode[] containing the children for a given element.
	 */
	async getChildren(element?: CoverageTreeNode): Promise<CoverageTreeNode[]> {
		// Element will be undefined on the first call, in which case it will return all the root nodes.
		if (!element) return this.displayData;
		// It will then be called on each parent node, for which it will return the children if present.
		else if (element.children) return element.children;
		return [];
	}
}

/**
 * Convert LcovLine data into a CoverageData object containing the corresponding document decorations.
 * @param lines Data from the 'lines' key for a single entry of parsed LCOV data.
 * @param showCounts Boolean to determine whether execution counts will be shown to the left of text.
 * @returns CoverageData object containing the decoration options for all covered and uncovered lines in a single file.
 */
export function lcovLinesToEditorRanges(
	lines: lcovParse.LcovPart<lcovParse.LcovLine>,
	showCounts: boolean
): CoverageData {
	const coverage = emptyCoverageData();
	for (const lineDetails of lines.details) {
		const range = new vscode.Range(
			// Convert lines and columns to 0-based.
			// LCOV file does not provide specific column data for each line, so use 0 to 1000 to cover full line.
			lineDetails.line - 1,
			0,
			lineDetails.line - 1,
			1000
		);

		// 'hit' provides number of executions for the line, providing distinction between covered and uncovered lines.
		if (lineDetails.hit > 0) {
			coverage.coveredOptions.push(...elaborate(range, lineDetails.hit, showCounts));
		} else {
			coverage.uncoveredOptions.push(...elaborate(range, lineDetails.hit, showCounts));
		}
	}
	return coverage;
}

/**
 * Wraps the existing setDecorators function to initialize decorators object to default values, then make a few customizations.
 * Currently set to override the highlighting to produce a shaded background instead of highlighted text characters.
 */
export function setBazelCoverageDecorators() {
	setDecorators();
	const cov = {
		overviewRulerColor: 'green',
		backgroundColor: decoratorConfig.coveredHighlightColor,
		isWholeLine: true
	};
	const uncov = {
		overviewRulerColor: 'red',
		backgroundColor: decoratorConfig.uncoveredHighlightColor,
		isWholeLine: true
	};

	// Replace all four directions with whole line, borderless highlight. Appears as a light shaded background.
	['all', 'mid', 'top', 'bottom'].forEach((val) => {
		decorators.coveredHighlight[
			val as keyof typeof decorators.coveredHighlight
		] = vscode.window.createTextEditorDecorationType(cov);
		decorators.uncoveredHighlight[
			val as keyof typeof decorators.coveredHighlight
		] = vscode.window.createTextEditorDecorationType(uncov);
	});
}
