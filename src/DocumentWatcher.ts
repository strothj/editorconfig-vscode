import * as editorconfig from 'editorconfig';
import * as path from 'path';
import {
	window,
	workspace,
	Disposable,
	Selection,
	TextDocument,
	TextEditor,
	TextEditorOptions,
	TextEdit
} from 'vscode';
import languageExtensionMap from './languageExtensionMap';
import { fromEditorConfig } from './Utils';
import {
	InsertFinalNewline,
	PreSaveTransformation,
	SetEndOfLine,
	TrimTrailingWhitespace
} from './transformations';
import {
	EditorConfigProvider
} from './interfaces/editorConfigProvider';

class DocumentWatcher implements EditorConfigProvider {

	private docToConfigMap: { [fileName: string]: editorconfig.knownProps };
	private disposable: Disposable;
	private defaults: TextEditorOptions;
	private preSaveTransformations: PreSaveTransformation[] = [
		new SetEndOfLine(),
		new TrimTrailingWhitespace(),
		new InsertFinalNewline()
	];

	constructor(
		private outputChannel = window.createOutputChannel('EditorConfig')
	) {
		this.log('Initializing document watcher...');

		const subscriptions: Disposable[] = [];

		subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
			if (editor && editor.document) {
				this.onDidOpenDocument(editor.document);
			}
		}));

		subscriptions.push(workspace.onDidChangeConfiguration(
			this.onConfigChanged.bind(this)
		));

		subscriptions.push(workspace.onDidSaveTextDocument(async doc => {
			if (path.basename(doc.fileName) === '.editorconfig') {
				this.log('.editorconfig file saved.');
				await this.rebuildConfigMap();
			}
		}));

		subscriptions.push(workspace.onWillSaveTextDocument(async e => {
			let selections: Selection[];
			if (window.activeTextEditor.document === e.document) {
				selections = window.activeTextEditor.selections;
			}
			const transformations = this.calculatePreSaveTransformations(e.document);
			e.waitUntil(transformations);
			if (selections) {
				transformations.then(() => {
					window.activeTextEditor.selections = selections;
				});
			}
		}));

		this.disposable = Disposable.from.apply(this, subscriptions);
		this.rebuildConfigMap();
		this.onConfigChanged();
	}

	private log(...messages: string[]) {
		this.outputChannel.appendLine(messages.join(' '));
	}

	public dispose() {
		this.disposable.dispose();
	}

	public getSettingsForDocument(doc: TextDocument) {
		return this.docToConfigMap[this.getFileName(doc)];
	}

	private getFileName(doc: TextDocument) {
		if (!doc.isUntitled) {
			return doc.fileName;
		}
		const ext = languageExtensionMap[doc.languageId] || doc.languageId;
		return path.join(workspace.rootPath, `${doc.fileName}.${ext}`);
	}

	public getDefaultSettings() {
		return this.defaults;
	}

	private async rebuildConfigMap() {
		this.log('Rebuilding config map...');
		this.docToConfigMap = {};
		return await Promise.all(workspace.textDocuments.map(
			doc => this.onDidOpenDocument(doc)
		));
	}

	private async onDidOpenDocument(doc: TextDocument) {
		if (doc.languageId === 'Log') {
			return;
		}
		const fileName = this.getFileName(doc);
		const relativePath = workspace.asRelativePath(fileName);
		this.log(`Applying configuration to ${relativePath}...`);

		if (this.docToConfigMap[fileName]) {
			this.log('Using configuration map...');
			await this.applyEditorConfigToTextEditor(window.activeTextEditor);
			return;
		}

		this.log('Using EditorConfig core...');
		return editorconfig.parse(fileName)
			.then(async (config: editorconfig.knownProps) => {
				if (config.indent_size === 'tab') {
					config.indent_size = config.tab_width;
				}

				this.docToConfigMap[fileName] = config;

				await this.applyEditorConfigToTextEditor(window.activeTextEditor);
			});
	}

	private async applyEditorConfigToTextEditor(
		editor: TextEditor,
	) {
		if (!editor) {
			this.log('No more open editors.');
			return Promise.resolve();
		}

		const doc = editor.document;
		const relativePath = workspace.asRelativePath(doc.fileName);
		const editorconfig = this.getSettingsForDocument(doc);

		if (!editorconfig) {
			this.log(`No configuration for ${relativePath}.`);
			return Promise.resolve();
		}

		const newOptions = fromEditorConfig(
			editorconfig,
			this.getDefaultSettings()
		);

		// tslint:disable-next-line:no-any
		editor.options = newOptions as any;

		this.log(`${relativePath}: ${JSON.stringify(newOptions)}`);
	}

	private onConfigChanged() {
		const workspaceConfig = workspace.getConfiguration('editor');
		const detectIndentation = workspaceConfig.get<boolean>('detectIndentation');

		this.defaults = (detectIndentation) ? {} : {
			tabSize: workspaceConfig.get<string | number>('tabSize'),
			insertSpaces: workspaceConfig.get<string | boolean>('insertSpaces')
		};
		this.log(
			'Detected change in configuration:',
			JSON.stringify(this.defaults)
		);
	}

	private async calculatePreSaveTransformations(
		doc: TextDocument
	): Promise<TextEdit[]> {
		const editorconfig = this.getSettingsForDocument(doc);
		const relativePath = workspace.asRelativePath(doc.fileName);

		if (!editorconfig) {
			this.log(`Pre-save: No configuration found for ${relativePath}.`);
			return [];
		}

		this.log(`Applying pre-save transformations to ${relativePath}.`);

		return Array.prototype.concat.call([],
			...this.preSaveTransformations.map(
				transformer => {
					const edits = transformer.transform(editorconfig, doc);
					if (edits instanceof Error) {
						this.log(edits.message);
					}
					return edits;
				}
			)
		);
	}
}

export default DocumentWatcher;
